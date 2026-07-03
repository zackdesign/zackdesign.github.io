---
layout: post
title: "Taking over Sequin: adopting an orphaned CDC engine, fixing the Dragonfly crash, and putting it behind Cloudflare Access"
description: "Adopting Sequin — an open-source Postgres change-data-capture engine — after the company behind it wound down: what I use it for, the Redis mutex bug that let a Dragonfly redeploy take the whole thing down, the fix, and adding Cloudflare Access SSO to a fork I now help maintain."
excerpt: "A search pipeline I work on runs on Sequin, a Postgres CDC engine. Then a routine Dragonfly redeploy started taking it down — and the company behind Sequin had gone dark. So the project got forked, the crash got fixed, and it ended up behind Cloudflare Access."
image: /images/blog/taking-over-sequin.jpg
image_alt: A long-exposure photograph of a river forcing its way through a channel of dark rock — the water never stops moving, finding a path around every obstruction
date: 2026-07-01
last_modified_at: 2026-07-01
categories: [engineering]
tags: [sequin, cdc, change-data-capture, postgres, elixir, redis, dragonfly, cloudflare-access, railway, open-source, campermate, typesense]
---

[Sequin](https://github.com/sequinstream/sequin) is an open-source Postgres change-data-capture engine written in Elixir. It tails a Postgres logical replication slot and streams every insert, update, and delete out to sinks — Typesense, webhooks, Kafka, SQS — with Elixir functions in the middle to transform or filter each row. I use it to keep the search index and a few downstream services for [CamperMate](https://campermate.com) — the free-camping and campground app across Australia and New Zealand, [iOS](https://apps.apple.com/app/campermate/id578975305) and [Android](https://play.google.com/store/apps/details?id=nz.co.campermate.app), 1M+ downloads — in lockstep with the source-of-truth Postgres database.

This is the story of how a tool I adopted became a tool I help maintain: how I found it, ran it in production, watched it fall over for a reason that wasn't really its fault, went looking for help from a company that no longer existed, and ended up forking it, fixing it, and extending it.

<!-- more -->

## Why I reached for Sequin

The problem Sequin solves is the boring, load-bearing kind. The POI, review, and translation data lives in Postgres (on [Neon](https://neon.tech)). Search runs on [Typesense](https://typesense.org). Several other services — a translation workflow, a delta cache for the mobile app — need to know the instant a row changes. The naive version of this is a spray of application-level hooks and cron jobs that drift out of sync the moment anything fails silently.

CDC inverts that. Postgres already writes every change to its write-ahead log; Sequin reads the log and fans each change out reliably, with retries and backfills, so the index and the database can't disagree for long. The whole thing is a dozen sinks driven by a single declarative [`sequin.yaml`](https://github.com/sequinstream/sequin), version-controlled and applied from CI:

```
   Postgres (Neon)  →  Sequin  →  Typesense collections (POIs, reviews, translations)
   logical slot        transforms →  Webhooks (translation pipeline, delta sync)
```

The transforms are the nice part. A small Elixir function denormalises a POI's feature list into boolean columns, builds language-suffixed fields (`description_en`, `description_mi`) from a tall translations table, and filters out non-public rows before they ever reach the public index. It's the right amount of logic in the right place, and for a good while it just worked.

## The night Dragonfly took Sequin with it

Then came outages that made no sense. Sequin would be humming along, and then — with no deploy, no traffic spike, no obvious cause — every consumer would stop at once. The sinks would go cold, the index would fall behind, and the only fix was a restart.

The correlation, once I traced it, was infuriating: it happened whenever **Dragonfly** — the Redis-compatible store Sequin uses for coordination, running as a managed service on [Railway](https://railway.app) — redeployed itself. A routine maintenance update to a *dependency* was taking down the whole engine.

The mechanism is a textbook Erlang supervision-tree footgun. Sequin uses a Redis-backed mutex to elect a single leader across nodes — a `MutexOwner` GenServer that holds a lock and refreshes it before it expires. When Dragonfly restarted, the connection blipped, the mutex refresh failed, and `MutexOwner` did the most literal possible thing: it crashed. And because it sits under a supervisor with a `:one_for_all` restart strategy, its death took **every sibling down with it** — the entire runtime supervisor, all consumers, all sinks. A two-second Redis blip became a total outage that only a human restart would clear.

```
MutexedSupervisor (:one_for_all)
  └── MutexOwner  ✗  Redis blips → mutex refresh fails → crash
        ⇒ :one_for_all fires ⇒ every consumer & sink is torn down with it
```

That's not really Sequin doing something wrong so much as an assumption — "Redis is always there" — that doesn't hold on a platform where your Redis can redeploy under you at any moment.

## Upstream had gone dark

So I did the normal thing: went to fix it upstream, or at least to ask. And found the lights off. The project had moved into **maintenance mode**, the company behind Sequin had wound down, and there was no one on the other end of the issue tracker to merge a patch or ship a release. A tool at the centre of a data pipeline had, effectively, been orphaned.

This is the quiet risk of building on someone else's open source: the licence guarantees you the code, but nothing guarantees you a maintainer. When the maintainer disappears, you have exactly two choices — rip the dependency out, or adopt it.

## So I adopted it

Ripping out CDC and rebuilding the sink pipeline from scratch would have been weeks of work to end up back where I started. Adoption was the better trade. The project got forked into [`github.com/triptechtravel/sequin`](https://github.com/triptechtravel/sequin), with its own build and release pipeline, and from then on it was treated as what it now was: code I own.

That meant the unglamorous infrastructure of ownership. A GitHub Actions workflow that builds a patched image and pushes it to GHCR. Deployment to Railway. Fixing the parts of the build that assumed a corporate CI — a missing `cmake` for a Kafka NIF, a Sentry DSN that was baked in at build time and now had to be optional. None of it is exciting. All of it is the price of being the maintainer instead of a user.

## Fixing the crash properly

With the fork in hand, the Dragonfly bug got fixed at the root. `MutexOwner` no longer treats a Redis error as fatal. While it holds the mutex and Redis becomes unreachable, it now **retries indefinitely with exponential backoff** (capped at an hour) instead of crashing — Redis going down should degrade Sequin gracefully, never take it out. When Redis comes back, it re-acquires the lock and resumes as if nothing happened. The invalid GenStateMachine stop value that caused the original crash got corrected too, and the LiveView metrics pages were hardened so a Redis blip renders an empty chart instead of a `MatchError`.

The part I'm most pleased with is the test. It's easy to write a unit test that mocks a Redis error; it's much more convincing to simulate the actual failure. The integration test uses `iptables` to **REJECT** traffic to Redis mid-run — a real network partition, the same thing a Dragonfly redeploy looks like from the process's point of view — and asserts that the `MutexOwner` survives the outage and recovers when the rule is dropped. That's the difference between "handles a mocked error" and "survives the thing that was actually paging me."

The outages stopped.

## Then it went behind Cloudflare Access

Once you own a fork, you stop just patching it and start shaping it. The most recent addition: real SSO on the admin console.

Out of the box, self-hosted Sequin authenticates users with an email-and-password login sitting in its own Postgres table. For an internal tool that a whole team touches, that's the wrong model — there's already Google identity and [Cloudflare Zero Trust](https://www.cloudflare.com/zero-trust/) in front of everything else. So the Sequin console went behind **Cloudflare Access**, and Sequin learned to trust it.

The mechanics, mirroring the same trusted-header pattern I've used for a [Payload CMS](https://payloadcms.com):

- **Cloudflare Access** gates the console with a Google-SSO policy. On every request it forwards, it injects a signed JWT in the `Cf-Access-Jwt-Assertion` header.
- A new Elixir plug **verifies that JWT** — fetching the Access application's public keys (JWKS), checking the signature, issuer, audience, and expiry — and then transparently signs the user in. First time through, it **provisions the user just-in-time** from the verified email, adopting any existing account so nobody lands in an empty instance. You never see Sequin's own login screen.
- The tricky part is machine traffic. The search config is applied from CI, which authenticates with a token rather than a browser SSO session. Cloudflare Access lets you scope policies so interactive console traffic goes through Google while automated, token-authenticated callers are validated on their own credentials — so the SSO gate never breaks the deploy pipeline.
- Finally, the settings UI now reflects reality: it shows which identity provider you authenticated with and disables the email/password fields for SSO users, rather than presenting a dead form.

The whole thing is feature-flagged, so the upstream password-login behaviour is still the default for anyone else running the code. It ships as a normal patched image through the same GHCR-to-Railway pipeline as every other fix.

## Owning a fork you didn't write

There's a version of this story that reads as a cautionary tale about depending on startups. I don't think that's the lesson. Sequin was — is — a genuinely good piece of engineering, and the fact that it *could* be adopted, read, fixed, and extended with SSO is entirely because it was open source. A closed SaaS that shut down would have left nothing but a migration deadline.

The real lesson is that "using open source" and "owning open source" are different commitments, and the gap between them can close overnight. When it does, the codebases you can actually take over are the ones written clearly enough to understand under pressure. Sequin was. You read the supervision tree, see why a Redis blip cascaded, and fix it — in someone else's code that has quietly become yours.

If you're travelling Australia or New Zealand, the search that lands you at the right campsite is riding on this pipeline. [Grab CamperMate on iOS](https://apps.apple.com/app/campermate/id578975305) or [Android](https://play.google.com/store/apps/details?id=nz.co.campermate.app) — free, no account required.

---

*Header photo by [v2osk](https://unsplash.com/@v2osk) on [Unsplash](https://unsplash.com).*
