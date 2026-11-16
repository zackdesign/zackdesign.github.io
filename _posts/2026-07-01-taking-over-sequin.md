---
layout: post
title: "Taking over Sequin: adopting an orphaned CDC engine, fixing the Dragonfly crash, and putting it behind Cloudflare Access"
description: "A Dragonfly redeploy on Railway takes down unpatched Sequin, the Postgres change-data-capture pipeline behind CamperMate's search, and the company behind it has wound down. The crash is an invalid return value from a state machine under a supervisor that stops every process when one dies. This is the fix in the fork I maintain, why a firewall-rule test proves nothing in CI, and the Cloudflare Access plug that replaces Sequin's login screen."
excerpt: "A routine Dragonfly redeploy takes down unpatched Sequin, the change-data-capture engine behind CamperMate's search, and upstream is in maintenance mode. The cause is three lines in a state machine under a supervisor that stops every process when one dies. This is the fork I maintain: the fix, a test that passes in CI without testing anything, and the console behind Cloudflare Access."
image: /images/blog/taking-over-sequin.jpg
image_alt: A long-exposure photograph of a river forcing its way through a channel of dark rock — the water never stops moving, finding a path around every obstruction
date: 2026-07-01
last_modified_at: 2026-11-16
categories: [engineering]
tags: [sequin, cdc, change-data-capture, postgres, elixir, redis, dragonfly, cloudflare-access, railway, open-source, campermate, typesense]
---

[Sequin](https://github.com/sequinstream/sequin) is an open-source change-data-capture engine for Postgres, written in Elixir. It watches a database and streams every row change onward. I run it as the pipeline between the source Postgres database and the search index for [CamperMate](https://campermate.com), the free-camping and campground app across Australia and New Zealand ([iOS](https://apps.apple.com/app/campermate-australia-nz/id465040067) and [Android](https://play.google.com/store/apps/details?id=nz.co.campermate), over a million downloads). Unpatched, every consumer in that pipeline stops at once whenever the managed Dragonfly instance behind it redeploys itself, with no deploy and no traffic change. Only a restart clears it. The cause is three lines in a state machine, which turn a two-second Redis blip into a total outage.

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/triptechtravel/sequin" target="_blank" rel="noopener" class="btn btn-primary btn-lg">The fork on GitHub</a>
</div>

This post covers adopting a dependency whose maintainer had gone:

- what the crash is: `{:shutdown, :err_keeping_mutex}` is not a value a `GenStateMachine`, Elixir's state-machine process type, is allowed to return;
- why a supervisor configured to restart all of its children when one dies turns one process's death into a total outage;
- why fork rather than patch upstream, and what maintaining the fork involves;
- why bounded retries aren't enough, and the same failure in the slot producer;
- why a firewall-rule test proves nothing in CI;
- the Cloudflare Access plug (a piece of request middleware) that signs people into the fork's console without Sequin's own login form;
- what else the fork carries, from backfills that match replication to a Postgres sink.

<!-- more -->

## What Sequin does for CamperMate

Sequin reads Postgres's own stream of changes through a logical replication slot. It sends every insert, update and delete to destinations such as Typesense (a search engine), webhooks, Kafka and SQS. Elixir functions in the middle can transform or filter each row.

The source of truth is Postgres on [Neon](https://neon.tech). Search is [Typesense](https://typesense.org). A translation workflow and a change cache for the mobile app also need to know when a row changes. Sequin reads the database's write-ahead log and fans each change out, with retries and backfills, so the index and the database cannot disagree for long.

The whole setup is one `sequin.yaml` in version control: 12 sinks over one database. Each sink maps a table to a destination, with a named function in the middle.

- `poi_app` and `poi_public` go to Typesense collections through `poi-typesense`.
- The `poi_app_translations` table holds one row per translated field. It goes through `poi-translations-typesense`, which turns one `{uuid, language, key, value}` row into a partial document, like `{"id": ..., "name_fr": "Nom du POI"}` or `{"id": ..., "feature_names_de": ["Restaurant", "Outdoor Dining"]}`. Typesense merges that into the existing document.
- A `public-filter` function drops non-public rows before the public collection ever sees them.
- `translation-webhook` and `delta-webhook` sinks feed the two downstream services.

The transforms are Elixir, with their own `mix test` suite in CI. That is the part of this setup I would keep even if I replaced everything else.

## Every consumer stops at once

The symptom is all-or-nothing. Sequin processes normally. Then every sink goes quiet in the same second, the index falls behind, and the process sits there until someone restarts it. There is no deploy and no spike.

Lined up by timestamp, each outage matches Dragonfly redeploying for maintenance. Dragonfly is the Redis-compatible store Sequin uses for coordination, running as a managed service on [Railway](https://railway.app). A dependency's routine update takes down the engine.

## Three lines in a state machine

Sequin elects a leader with a lock held in Redis. `Sequin.MutexOwner` is a `GenStateMachine` that writes a key with a random token and a five-second expiry (`lock_expiry`). It refreshes the key every four seconds, at 80% of the expiry.

It lives under `Sequin.MutexedSupervisor`, which is deliberately set to `strategy: :one_for_all`. If any one child process dies, the supervisor stops every child. The intent: if the owner loses the lock, another node now holds it, so every consumer under the same supervisor must stop too. That is correct for "lost the lock". It is catastrophic for "could not reach Redis", and upstream's code treats them the same:

```elixir
:error ->
  Logger.error("MutexOwner had trouble reaching Redis.")
  # Unable to reach redis? Die.
  {:shutdown, :err_keeping_mutex}
```

Two things are wrong here. First, the intent is to stop, and stopping takes every sibling down. Second, `{:shutdown, reason}` is not a value a `GenStateMachine` event handler may return at all. The valid form is `{:stop, {:shutdown, reason}}`. So what actually happens is a crash, with `{:bad_return_from_state_function, {:shutdown, :err_keeping_mutex}}`. Either way, the supervisor does what it is told, and every consumer and sink comes down with it.

![Two panels of the same supervision tree: a one-for-all supervisor with the mutex owner and three consumers underneath, and Redis to the side. Without the fix, Redis becoming unreachable makes the mutex owner crash and the supervisor stops every consumer with it. With the fix the mutex owner keeps its state and retries with backoff, and the consumers keep running.](/images/blog/sequin-one-for-all-cascade.svg)

The Redis side is a short chain. `eredis`, the Redis client library, keeps its connection process alive through an outage and answers every query with `{:error, :no_connection}`. `Sequin.Redis.command/2` maps that to a `ServiceError`. `Sequin.Mutex` maps that to `:error`, and `:error` is the branch above. A two-second connection blip becomes a full outage that only a human can clear.

## Why fork rather than patch upstream

The normal move is to send the patch upstream. But upstream's README says the project is in maintenance mode. The company behind Sequin was acquired in August 2025, and Sequin Cloud shut down that October. The crash is filed upstream as issue #2072, with no fix behind it. The licence guarantees you the code. Nothing guarantees you a maintainer.

That leaves two options: rip out change-data-capture and rebuild the sink pipeline, or adopt the project. Rebuilding takes weeks to arrive back at the same place. Adoption is the better trade.

## What maintaining the fork involves

The fork lives at [`github.com/triptechtravel/sequin`](https://github.com/triptechtravel/sequin). It is a full clone of upstream as of February 2026, with all its tags. The fixes are on `main`, and releases continue from upstream's last one as `v0.14.6-tt1`, `-tt2` and so on, with a changelog. Ownership is mostly unglamorous plumbing:

- `.github/workflows/tt-docker-build.yml` builds a Docker image for 64-bit Linux whenever a tag matching `v*-tt*` is pushed. It publishes to `ghcr.io/triptechtravel/sequin:<tag>`, which Railway deploys.
- The Dockerfile needs `cmake`. The `crc32cer` native extension inside the `kafka_protocol` library (C code called from Elixir) will not build without it.
- Upstream's release build assumes a Sentry DSN, the address an application reports its errors to, is baked in at build time, and raises an error at boot if not. The Dockerfile copies the `SENTRY_DSN` build argument into an environment variable unconditionally, so a missing argument arrives as an empty string, which Sentry's configuration check rejects. In the fork, `config/prod.exs` turns an empty string into `nil`, and `lib/sequin/sentry.ex` treats a missing DSN as "Sentry off" instead of a bug.

None of it is interesting. All of it is the difference between being a user and being the maintainer.

## Why bounded retries aren't enough

The obvious fix is to retry a few times, say five, with a short wait between attempts, then give up with a proper `{:stop, {:shutdown, :err_keeping_mutex}}`. That is better, and still wrong. A Dragonfly redeploy can outlast five short retries, and giving up still takes everything down.

So there is no limit. While it holds the lock and cannot reach Redis, the owner retries indefinitely. The wait starts from the lock expiry and doubles after each consecutive error, capped at one hour. The counter resets on the first successful refresh:

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

Losing the lock to another owner still stops the process, because that case is real. The trade-off is written into the module's documentation. While Redis is unreachable the key expires, so on a deployment with several nodes another node can take it. The stale node only finds out on its next retry. For a single-instance deployment, that window is fine.

The metrics pages, built with Phoenix LiveView, get the same treatment. A Redis error draws a flat zero line instead of crashing on a pattern-match error.

## The same failure in the slot producer

A Dragonfly major upgrade (1.40 to 2.0.0 on Railway) makes every Redis call fail for about 20 seconds. The mutex fix holds through that, but the mutex owner isn't the only process that calls Redis. `SlotProducer` reads the replication slot. A timer persists its restart position (the point in the write-ahead log it has safely handled) to Redis. With the raising form of the client, `Redis.command!`, a failed call crashes the producer and cancels every pipeline downstream of it.

So a failed persist logs and tries again on the next tick. It keeps the last position that was saved, so Postgres is never told the pipeline got further than it did. Every Redis call goes through one path, which also catches the `:exit` that the cluster client can throw while it refreshes its map of nodes. That exit kills sink pipelines on its own. Integration tests reproduce the crash against a real replication slot, and check that the pipeline survives and saves its position afterwards.

## Why a firewall-rule test proves nothing in CI

The convincing-looking test for the mutex fix is an integration test that runs `iptables -A OUTPUT -p tcp --dport 6379 -j REJECT` in the middle of the run: a firewall rule blocking the Redis port. The process sees a real connection-refused error, exactly as it would during a Dragonfly redeploy. Then the test removes the rule and asserts recovery.

It passes locally. It also passes in CI, and that is the warning sign. The CI runner lacks the `NET_ADMIN` capability needed to change firewall rules. So `iptables` fails silently, Redis is never blocked, and the test asserts that a process nobody disturbed is still alive. Unit tests that re-implement the backoff arithmetic on local variables have the same flaw: they pass even if the fix regresses.

The test in `test/sequin/mutex_owner_test.exs` instead swaps the `Sequin.Redis.RedisClient` setting for a stub that returns the exact production failure:

```elixir
defmodule DownClient do
  def q(_connection, _command), do: {:error, :no_connection}
  def qp(_connection, commands), do: Enum.map(commands, fn _ -> {:error, :no_connection} end)
end
```

The process test starts a real `MutexOwner` with a 50-millisecond lock expiry and waits for it to take the lock. Then it swaps in `DownClient` and waits until the process state shows at least one Redis error. It asserts the process is still alive, with no exit message. Then it restores the real client, and asserts the owner takes the lock again with the counter back at zero. Handler-level tests pin the state transitions against the real `handle_event/4`. I cannot put the production outcome in a repository; this test is the part I can.

## Putting the console behind Cloudflare Access

Out of the box, self-hosted Sequin signs people in with an email and password from its own users table. For an internal console a team touches, that is a second login nobody wants, when Google sign-in and [Cloudflare Zero Trust](https://www.cloudflare.com/zero-trust/) already sit in front of everything else. So in the fork the console sits behind Cloudflare Access, and Sequin trusts it. It uses the same trusted-header pattern I used for a [Payload CMS](https://payloadcms.com).

Cloudflare enforces the Google single-sign-on policy at the hostname. It adds a signed token (a JWT) in the `Cf-Access-Jwt-Assertion` header of every request it forwards. `SequinWeb.Plugs.CloudflareAccess` runs in the `:browser` pipeline, before `fetch_current_user/2`. It does nothing when the feature is off, or when the session already has a user. Otherwise it reads the header and hands the token to `Sequin.CloudflareAccess`.

That is a long-lived process, and it does four things:

- caches the public keys Cloudflare publishes for the Access application, at `/cdn-cgi/access/certs`;
- verifies the signature with `JOSE.JWT.verify_strict`, accepting only the RS256 algorithm;
- checks the issuer, audience, expiry and not-before time, allowing five seconds of clock drift;
- refetches the keys, at most once every five minutes, when a token names a key id it has not seen. That is how Cloudflare's key rotation shows up.

A verified email then goes through `Accounts.find_or_create_cloudflare_access_user/1`. It looks the address up across every sign-in method first, so an existing password user is adopted rather than duplicated. Only if nobody matches does it register a new `:cloudflare_access` user, keyed on Cloudflare's subject identifier. Nobody sees Sequin's sign-in screen. Machine callers are unaffected: the `/api` pipeline still authenticates with `VerifyApiToken`, and the plug never runs there.

On the settings page, any account that does not sign in with a password shows an "Authentication method" card, and its email and password fields are disabled. An editable email on a single-sign-on account would create a second user on the next login. The whole feature sits behind `CF_ACCESS_ENABLED`, with `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` from the Access application. Password login stays the default for anyone else running the code.

## What else the fork carries

The fork's scope is what we hit running Sequin in production: security fixes, crash fixes and bugs, not a feature roadmap. Backfills send exactly the same message as replication for every column type, rather than silently sending `null` for many, composite types among them. Large unchanged ("TOASTed") values don't arrive as the literal string `"unchanged_toast"`. There is also a Postgres sink and a `gzip` option for Typesense sinks. The changelog has the rest.

## Owning a fork you didn't write

The lesson is not "don't depend on startups". Sequin is a good piece of engineering. The only reason it could be read, fixed and extended is that it was open source. A closed service shutting down leaves you a migration deadline and nothing else.

The lesson is that using open source and owning it are different commitments, and the gap can close overnight. The code you can take over under pressure is code written clearly enough to read under pressure. Sequin is. The supervision tree says "stop everyone when one dies", the state machine returns a value it is not allowed to, and the bug is right there.

If you're travelling Australia or New Zealand, the search that lands you at the right campsite rides on this pipeline. [Grab CamperMate on iOS](https://apps.apple.com/app/campermate-australia-nz/id465040067) or [Android](https://play.google.com/store/apps/details?id=nz.co.campermate). It's free, and needs no account.

---

*Header photo by [v2osk](https://unsplash.com/@v2osk) on [Unsplash](https://unsplash.com).*
