---
layout: post
title: "clawdwatch — synthetic monitoring for Cloudflare Workers, with an inbox an AI agent can read"
description: "An open-source uptime monitor that runs entirely inside a Cloudflare Worker: deterministic detection in a state machine, D1 as the only storage, secrets that never reach the database, and alerts that carry signed action links an agent can use without holding a credential."
excerpt: "An uptime monitor that lives inside one Cloudflare Worker. No model decides whether your site is down — a threshold and a state machine do. But every alert carries signed, short-lived action links, so the agent that receives it can acknowledge, annotate, and re-run without holding a standing credential."
image: /images/blog/clawdwatch.jpg
image_alt: A strip of uptime ticks, one per check run, mostly cyan and broken by a red run of failures bracketed with "OPENED · 35m · RECOVERED"
date: 2026-08-21
last_modified_at: 2026-08-21
categories: [open-source]
tags: [cloudflare, workers, d1, monitoring, typescript, ai-agents, security, open-source]
---

[`clawdwatch`](https://github.com/triptechtravel/clawdwatch) is a [Triptech Travel](https://github.com/triptechtravel) open-source project — authored and released by Isaac Rowntree in his Triptech engineering capacity, and cross-posted here on the Zack Design blog, alongside [clickup-cli](/clickup-cli/) and [slackbuzz-cli](/slackbuzz-cli/). It is synthetic monitoring that runs entirely inside a single Cloudflare Worker: it checks your endpoints on a cron, decides — deterministically — when something is genuinely broken, and hands that off to Slack, a signed webhook, an RPC service binding, or an AI agent. **MIT licensed.**

<!-- more -->

**Source → [github.com/triptechtravel/clawdwatch](https://github.com/triptechtravel/clawdwatch)** · **Docs → [triptechtravel.github.io/clawdwatch](https://triptechtravel.github.io/clawdwatch/)**

## The line this draws

There is an obvious, tempting version of an AI-era monitoring tool where a model looks at the response and decides whether you have a problem. clawdwatch deliberately does not do that. Detection is a threshold, a state machine, and a maintenance window — code you can read in an afternoon and reason about at 3am. What the AI gets is the *other* half of the job: the part after "this is broken," where somebody has to work out why.

That split is the whole design. Everything below is either "make the detection boring and trustworthy" or "make the handoff useful."

## Detection is a state machine

One check, one result, one transition — pure, with the clock injected as a parameter rather than read from `Date.now()`:

```
unknown   → healthy     first success                      — silent
healthy   → degraded    failure, threshold not yet met     — silent
degraded  → unhealthy   consecutive failures >= threshold  — OPENED
unhealthy → unhealthy   still failing, reminder due        — REMINDER
unhealthy → healthy     first success again                — RECOVERED
degraded  → healthy     recovered before opening           — silent
```

The `unhealthy → unhealthy` edge is the one that matters and the one the previous generation of this tool could not express at all: it returned nothing forever, which meant a multi-day outage alerted exactly once, on day one, and then went quiet while still being down. Reminders are only sayable if your state machine has a name for "still broken, and it has been a while."

Alerts are batched per run, so a ten-endpoint outage is one notification rather than ten.

## One storage system

D1. That is the entire persistence story — checks, hot state, results, deliveries, incidents.

The version before this one split hot state into an R2 JSON blob and history into an Analytics Engine dataset that nothing ever read. Two storage systems, two consistency stories, and a whole class of "which one is right?" bugs, in exchange for a dataset nobody queried. Collapsing it into D1 removed more code than it added, and the integration suite now applies the shipped migration and runs in workerd — so the SQL is genuinely exercised rather than mocked.

## Public code, private config

Checks live in the database and are editable through the UI. That is only safe if a secret can never land in a row, so:

```json
{ "headers": { "X-Api-Key": "${MY_API_KEY}" } }
```

The reference is what is stored. Substitution happens at exactly one point — building the outbound request — and every path *leaving* the system (API responses, alert payloads, logs, config exports) goes through redaction first. Writing a check that contains a literal secret value is rejected with a 400, and a property test asserts that no resolved value appears in any outbound representation.

That single guard is what makes a UI-editable, database-backed monitor safe to open-source at all.

For a token that belongs to a whole domain rather than one check — a WAF bypass, say — there are `headerRules` keyed by host pattern.

## Keeping the thing that explains the outage

By default, response bodies are read to evaluate assertions and then discarded; what gets stored is the assertion failure message, truncated to 256 characters. A monitored endpoint that returns personal data does not leak it into the monitoring database.

But "expected 200, got 500" throws away the one thing that usually explains the outage. The motivating case was a health endpoint whose 500 body named the failing dependency by name — and the alert carried none of it. So a check can opt in:

```json
{ "id": "api-health", "captureBodyOnFailure": true }
```

The excerpt is capped at 512 characters, taken only from textual content types, run through the same secret scrubber as everything else *before* truncation (so a secret straddling the cut is masked, not half-printed), never taken from a passing check, and deliberately never posted to Slack. It reaches the webhook notifier and the dashboard — both of which are already trusted with the monitoring database. Slack is not.

## Handing an incident to an agent

An agent inbox is just a URL, so `webhook()` is the whole integration. Nothing is installed into the agent:

- Every alert carries a `links` object — incident, ack, annotate, run-now — as **short-lived signed URLs**. The receiving agent can act on the alert it was handed without holding any standing credential. If the alert leaks, what leaked expires.
- `GET /api/agent.md` describes the full API, generated from the route table so it cannot drift. Point an agent at that URL and the setup is done.
- An agent that has triaged something writes its findings back with `POST /api/incidents/:id/annotate`, and the note appears on the incident in the dashboard next to the human comments.

The `agent.md` route replaced an earlier idea: shipping a skill file for agents to install. A static file that duplicates a live API drifts, and in practice never gets installed — the previous version's skill claimed 90-day retention for a system that kept 48 hours, and had never actually been copied into the container it was meant for. Generating the document from the route table, with a test asserting the two never diverge, is the version that stays true.

There is a worked receiver: [thinkbot](https://github.com/triptechtravel/thinkbot), an ops agent that takes clawdwatch alerts and correlates them against GitHub, Datadog, Sentry and Rollbar to report what changed.

## When the receiver is a Worker, skip the webhook

If the thing receiving alerts lives on the same Cloudflare account, a service binding beats HTTP: the platform authenticates the call, so there is no shared HMAC secret to distribute or rotate, and no public inbox to defend.

```ts
notifiers: [rpc({ binding: (env) => env.AGENT })]
```

One sharp edge worth stating out loud, because it is the kind of thing that quietly becomes a vulnerability: an RPC call carries **no signature**. Authenticity comes from the binding itself. Keep signature verification in your HTTP handler, and do not let shared downstream code assume it ran.

Service bindings are same-account only, so `webhook()` with `hmac()` remains the option for everyone else.

## A versioned payload, so a release is not an outage

Every alert carries `schemaVersion`, exported as `ALERT_SCHEMA_VERSION`, and the contract is narrow enough to be useful:

- adding an **optional** field does not bump it — `bodySnippet` was added exactly this way;
- removing or renaming a field, or changing its meaning or type, does.

Receivers should ignore unknown fields and must not hard-fail on a version higher than they know. A receiver that rejects unknown versions turns every clawdwatch release into a monitoring outage, which is a genuinely embarrassing way to lose visibility.

## Auth, and the thing it refuses to do

Mount it behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/). Reads are open by default; writes always require a principal — a signed-in person, a service token, or a capability link.

There is no query-parameter API key, on purpose. URLs leak into logs, analytics, and referrer headers, and a shared static secret has no identity, no expiry, and no revocation. Arriving through Access is also not treated as evidence in itself: JWTs are verified against the team's JWKS, the expected `aud`, the issuer, and the clock — because anyone who learns the Worker's direct route bypasses the Access edge entirely.

No identity is stored. The JWT is verified for the authorization decision and discarded; there are no email, IP, or user-agent columns.

## A dashboard you will actually read

One mark per check run. A five-minute cron looks like five-minute samples, not a smoothed line — because the smoothing is exactly where a two-run blip goes to hide. Every delivery is recorded too, so the dashboard can answer the question monitoring tools are worst at: *did the last alert actually arrive?*

## Getting it running

```bash
npm create cloudflare@latest my-monitor -- \
  --template clawdwatch/clawdwatch/examples/worker
cd my-monitor

wrangler d1 create clawdwatch          # paste the id into wrangler.jsonc
npm run migrate
wrangler secret put SLACK_WEBHOOK_URL   # optional, and all Slack needs
npm run deploy
```

Or use it as a library, if you would rather it be a route inside a Worker you already run:

```ts
import { createMonitor, slack } from 'clawdwatch';

const monitor = createMonitor<Env>({
  d1: (env) => env.MONITORING_DB,
  secrets: (env) => ({ SLACK_WEBHOOK_URL: env.SLACK_WEBHOOK_URL }),
  notifiers: [slack({ webhook: '${SLACK_WEBHOOK_URL}' })],
});

export default { fetch: monitor.fetch, scheduled: monitor.scheduled };
```

Assertions cover status code, headers, body, response time, and `jsonPath` — the last of which is what turns a health endpoint that returns `{"db":"ok","queue":"degraded"}` into an actual signal rather than a 200.

## Why it exists

Triptech runs production APIs on Cloudflare Workers, and the monitoring options are roughly: a SaaS that bills per check and knows nothing about your account, or a Worker you write yourself and then never quite finish. clawdwatch is the finished version of the second one — small enough to read, deterministic where it needs to be, and built so the interesting half of an incident can be handed to something that will actually go and look.

[Read the source](https://github.com/triptechtravel/clawdwatch), or start at [getting started](https://triptechtravel.github.io/clawdwatch/guide/getting-started).
