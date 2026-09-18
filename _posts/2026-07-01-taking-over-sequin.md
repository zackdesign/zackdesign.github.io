---
layout: post
title: "Taking over Sequin: adopting an orphaned CDC engine, fixing the Dragonfly crash, and putting it behind Cloudflare Access"
description: "Every Dragonfly redeploy on Railway took down the Postgres change-data-capture pipeline behind CamperMate's search, and the company behind Sequin had wound down. The crash was an invalid return value from a state machine under a supervisor that stops every process when one dies. This is the fix, the test that passed for the wrong reason, and the Cloudflare Access plug that replaced Sequin's login screen on the fork I now maintain."
excerpt: "A routine Dragonfly redeploy was taking down Sequin, the change-data-capture engine behind CamperMate's search, and upstream had gone into maintenance mode. The crash turned out to be three lines in a state machine under a supervisor that stops every process when one dies. I forked it, fixed it, found my first test passed in CI without testing anything, and then put the console behind Cloudflare Access."
image: /images/blog/taking-over-sequin.jpg
image_alt: A long-exposure photograph of a river forcing its way through a channel of dark rock — the water never stops moving, finding a path around every obstruction
date: 2026-07-01
last_modified_at: 2026-07-01
categories: [engineering]
tags: [sequin, cdc, change-data-capture, postgres, elixir, redis, dragonfly, cloudflare-access, railway, open-source, campermate, typesense]
---

[Sequin](https://github.com/sequinstream/sequin) is an open-source change-data-capture engine for Postgres, written in Elixir: it watches a database and streams every row change onward. It reads Postgres's own stream of changes (a logical replication slot) and sends every insert, update and delete to destinations such as Typesense (a search engine), webhooks, Kafka and SQS, with Elixir functions in the middle to transform or filter each row. I run it as the pipeline between the source Postgres database and the search index for [CamperMate](https://campermate.com), the free-camping and campground app across Australia and New Zealand ([iOS](https://apps.apple.com/app/campermate/id578975305) and [Android](https://play.google.com/store/apps/details?id=nz.co.campermate.app), over a million downloads). In March every consumer in that pipeline started stopping at once, with no deploy and no traffic change, and the only thing that cleared it was a restart. The trigger was a managed Dragonfly instance redeploying itself. The cause was three lines in a state machine.

<!-- more -->

This is the story of adopting a dependency whose maintainer had gone: what the crash actually was (`{:shutdown, :err_keeping_mutex}` is not a value a `GenStateMachine`, Elixir's state-machine process type, is allowed to return), why a supervisor configured to restart all of its children when one dies turned one process's death into a total outage, the fix and the second fix, the firewall-rule test that passed in CI for the wrong reason, and the Cloudflare Access plug (a piece of request middleware) that now signs people into the fork's console without Sequin's own login form.

## What Sequin does for CamperMate

The source of truth is Postgres on [Neon](https://neon.tech). Search is [Typesense](https://typesense.org). A translation workflow and a change cache for the mobile app need to know when a row changes. Sequin reads the database's write-ahead log through a replication slot and fans each change out with retries and backfills, so the index and the database cannot disagree for long.

The whole thing is one `sequin.yaml` in version control: 12 sinks over one database, each a mapping from a table to a destination with a named function in the middle. `poi_app` and `poi_public` go to Typesense collections through `poi-typesense`; the `poi_app_translations` table, which holds one row per translated field, goes through `poi-translations-typesense`, which turns one `{uuid, language, key, value}` row into a partial document like `{"id": ..., "name_fr": "Nom du POI"}` or `{"id": ..., "feature_names_de": ["Restaurant", "Outdoor Dining"]}` for Typesense to merge into the existing document; a `public-filter` function drops non-public rows before the public collection ever sees them; `translation-webhook` and `delta-webhook` sinks feed the two downstream services. The transforms are Elixir, and they have their own `mix test` suite in CI, which is the part of this setup I would keep even if I replaced everything else.

## Every consumer stopped at once

The symptom was all-or-nothing. Sequin would be processing normally, then every sink would go quiet in the same second, the index would fall behind, and the process would sit there until someone restarted it. There was no deploy and no spike. The correlation, once I lined up timestamps, was with Dragonfly, the Redis-compatible store Sequin uses for coordination, running as a managed service on [Railway](https://railway.app), redeploying for maintenance. A dependency's routine update was taking down the engine.

## Three lines in a state machine

Sequin elects a leader with a lock held in Redis. `Sequin.MutexOwner` is a `GenStateMachine` that writes a key with a random token and a five-second expiry (`lock_expiry`), then refreshes it every four seconds, at 80% of the expiry. It lives under `Sequin.MutexedSupervisor`, which is deliberately configured with `strategy: :one_for_all`, meaning that if any one child process dies, the supervisor stops every child. The intent is that if the owner loses the lock, every consumer under the same supervisor must stop too, because another node now holds it. That is correct for "lost the lock". It is catastrophic for "could not reach Redis", and the code before the fix treated them the same:

```elixir
:error ->
  Logger.error("MutexOwner had trouble reaching Redis.")
  # Unable to reach redis? Die.
  {:shutdown, :err_keeping_mutex}
```

Two things are wrong here. The intent was to stop, and stopping takes every sibling down. But `{:shutdown, reason}` is not a value a `GenStateMachine` event handler is allowed to return at all (the valid form is `{:stop, {:shutdown, reason}}`), so what actually happened was a crash with `{:bad_return_from_state_function, {:shutdown, :err_keeping_mutex}}`. Either way the supervisor did what it was told and every consumer and sink came down with it.

![Two panels of the same supervision tree: a one-for-all supervisor with the mutex owner and three consumers underneath, and Redis to the side. Before the fix, Redis becoming unreachable makes the mutex owner crash and the supervisor stops every consumer with it. After the fix the mutex owner keeps its state and retries with backoff, and the consumers keep running.](/images/blog/sequin-one-for-all-cascade.svg)

The Redis side is worth one sentence too: `eredis`, the Redis client library, keeps its connection process alive across an outage and answers every query with `{:error, :no_connection}`; `Sequin.Redis.command/2` maps that to a `ServiceError`, `Sequin.Mutex` maps it to `:error`, and `:error` was the branch above. A two-second connection blip was a full outage that only a human could clear.

## Nobody upstream to send it to

The normal move is to send the patch upstream. Upstream's README had been rewritten to say the project was in maintenance mode, the company behind Sequin had wound down, and the crash was already filed as issue #2072 with no fix behind it. The licence guarantees you the code. Nothing guarantees you a maintainer.

That leaves two options: rip out CDC and rebuild the sink pipeline, or adopt the project. Rebuilding would have been weeks to arrive back where I was. Adoption was the better trade.

## Owning it

The fork lives at [`github.com/triptechtravel/sequin`](https://github.com/triptechtravel/sequin) on a `tt/v0.14.6-patches` branch. Ownership is mostly unglamorous plumbing:

- `.github/workflows/tt-docker-build.yml` builds a Docker image for 64-bit Linux whenever a tag matching `v*-tt*` is pushed, and publishes it to `ghcr.io/triptechtravel/sequin:<tag>`, which Railway deploys.
- The Dockerfile needed `cmake`, because the `crc32cer` native extension inside the `kafka_protocol` library (C code called from Elixir) will not build without it.
- The release build assumed a Sentry DSN (the address an application reports its errors to) was baked in at build time, and raised an error at boot if it was not. The Dockerfile copies the `SENTRY_DSN` build argument into an environment variable unconditionally, so a build argument that was never supplied arrives as an empty string, which Sentry's configuration check rejects. `config/prod.exs` now turns an empty string into `nil`, and `lib/sequin/sentry.ex` treats a missing DSN as "Sentry off" instead of a bug.

None of it is interesting. All of it is the difference between being a user and being the maintainer.

## The fix, twice

The first fix made `MutexOwner` retry up to five times with a short wait between attempts and then give up with a proper `{:stop, {:shutdown, :err_keeping_mutex}}`. That is better, and it is still wrong: a Dragonfly redeploy can take longer than five short retries, and giving up still takes everything down. The second fix removed the limit. While holding the lock and unable to reach Redis, the owner now retries indefinitely, doubling the wait after each consecutive error (starting from the lock expiry and capped at one hour), and resets the counter on the first successful refresh:

{% raw %}
```elixir
:error ->
  errors = data.consecutive_redis_errors + 1
  # Exponential backoff: lock_expiry * 2^errors, capped at 1 hour
  retry_interval = min(data.lock_expiry * Integer.pow(2, errors), @max_retry_interval)
  {:keep_state, %{data | consecutive_redis_errors: errors},
   [{{:timeout, :keep_mutex}, retry_interval, nil}]}
```
{% endraw %}

Losing the lock to another owner still stops the process, because that case is real. The trade-off is documented in the module's documentation: while Redis is unreachable the key expires, so on a deployment with several nodes another node can acquire it, and the stale node only finds out on its next retry. For a single-instance deployment that window is fine. The metrics pages (built with Phoenix LiveView) got the same treatment; a Redis error now draws a flat zero line instead of crashing on a pattern-match error.

## The test that passed for the wrong reason

My first tests for this were the convincing kind: integration tests that ran `iptables -A OUTPUT -p tcp --dport 6379 -j REJECT`, a firewall rule blocking the Redis port, in the middle of the run, so the process saw a real connection-refused error exactly as it would during a Dragonfly redeploy, then removed the rule and asserted recovery. They passed locally. They also passed in CI, and that should have bothered me sooner: the CI runner lacks the `NET_ADMIN` capability needed to change firewall rules, so `iptables` failed silently, Redis was never blocked, and the tests asserted that a process nobody had disturbed was still alive. The accompanying unit tests re-implemented the backoff arithmetic on local variables and would have passed if the fix regressed.

The replacement in `test/sequin/mutex_owner_test.exs` swaps the `Sequin.Redis.RedisClient` application env for a stub that returns the exact production failure:

```elixir
defmodule DownClient do
  def q(_connection, _command), do: {:error, :no_connection}
  def qp(_connection, commands), do: Enum.map(commands, fn _ -> {:error, :no_connection} end)
end
```

The process test starts a real `MutexOwner` with a 50-millisecond lock expiry, waits for it to acquire the lock, swaps in `DownClient`, waits until the process state shows at least one consecutive Redis error, asserts the process is still alive with no exit message, restores the real client, and asserts it re-acquires the lock with the counter back at zero. Four handler-level tests pin the state transitions against the real `handle_event/4`. I cannot put the production outcome in a repository; this test is the part I can.

## Putting the console behind Cloudflare Access

Out of the box, self-hosted Sequin authenticates with an email and password in its own users table. For an internal console that a team touches, and with Google sign-in and [Cloudflare Zero Trust](https://www.cloudflare.com/zero-trust/) already in front of everything else, that is a second login nobody wants. So the console went behind Cloudflare Access, and Sequin learned to trust it, using the same trusted-header pattern I used for a [Payload CMS](https://payloadcms.com).

Cloudflare enforces the Google single-sign-on policy at the hostname and adds a signed token (a JWT) in the `Cf-Access-Jwt-Assertion` header of every request it forwards. `SequinWeb.Plugs.CloudflareAccess` runs in the `:browser` pipeline before `fetch_current_user/2`. It does nothing when the feature is off or the session already has a user token; otherwise it reads the header and hands the token to `Sequin.CloudflareAccess`, a long-lived process that caches the public keys Cloudflare publishes for the Access application at `/cdn-cgi/access/certs`, verifies the signature with `JOSE.JWT.verify_strict` accepting only the RS256 algorithm, checks the issuer, audience, expiry and not-before time with five seconds of allowance for clock drift, and refetches the keys at most once every five minutes when a token references a key id it has not seen, which is how Cloudflare's key rotation shows up.

A verified email then goes through `Accounts.find_or_create_cloudflare_access_user/1`, which looks the address up across every sign-in method first, so an existing password user is adopted rather than duplicated, and only registers a new `:cloudflare_access` user, keyed on Cloudflare's subject identifier, if nobody matches. Nobody sees Sequin's sign-in screen. Machine callers are unaffected: the `/api` pipeline still authenticates with `VerifyApiToken`, and the plug never runs there.

The settings page needed to catch up. Any account that does not sign in with a password now shows an "Authentication method" card and disables the email and password fields, because an editable email on a single-sign-on account would create a second user on the next login. The whole feature is behind `CF_ACCESS_ENABLED`, with `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` from the Access application, so password login stays the default for anyone else running the code.

## Owning a fork you didn't write

The lesson is not "don't depend on startups". Sequin is a good piece of engineering, and the only reason it could be read, fixed and extended is that it was open source; a closed service shutting down leaves a migration deadline and nothing else. The lesson is that using open source and owning it are different commitments, the gap can close overnight, and the code you can take over under pressure is the code written clearly enough to read under pressure. Sequin was: the supervision tree says "stop everyone when one dies", the state machine returns a value it is not allowed to, and the bug is right there.

If you're travelling Australia or New Zealand, the search that lands you at the right campsite is riding on this pipeline. [Grab CamperMate on iOS](https://apps.apple.com/app/campermate/id578975305) or [Android](https://play.google.com/store/apps/details?id=nz.co.campermate.app) — free, no account required.

---

*Header photo by [v2osk](https://unsplash.com/@v2osk) on [Unsplash](https://unsplash.com).*
