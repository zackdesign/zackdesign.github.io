---
layout: post
title: "clawdwatch — synthetic monitoring for Cloudflare Workers, with an inbox an AI agent can read"
description: "An open-source uptime monitor that runs inside one Cloudflare Worker: a pure, clock-injected state machine that can say 'still down', D1 as the only storage, `${REF}` secrets that are scrubbed before they are truncated, an API document generated from the route table, Access JWTs verified against JWKS rather than trusted on arrival, and a sent log of what every alert said."
excerpt: "An uptime monitor inside one Cloudflare Worker that keeps reminding you while an outage lasts, stores nothing but D1, never writes a secret to a row, and hands each incident to an AI agent with an API document generated from its own route table."
image: /images/blog/clawdwatch.jpg
image_alt: A strip of uptime ticks, one per check run, mostly cyan and broken by a red run of failures bracketed with "OPENED · 35m · RECOVERED"
date: 2026-08-21
last_modified_at: 2026-11-16
categories: [open-source]
tags: [cloudflare, workers, d1, monitoring, typescript, ai-agents, security, open-source]
---

Triptech's **[clawdwatch](https://github.com/triptechtravel/clawdwatch)** is an uptime monitor that requests your endpoints on a schedule, and it runs entirely inside a **single Cloudflare Worker** (a small program on Cloudflare's servers). A timer runs the checks, a state machine with no hidden inputs decides when something is **genuinely broken** and **keeps reminding you while it stays broken**, and the result goes to Slack, a signed webhook, a direct call to another Worker, or **an AI agent**. Checks are editable in a dashboard, yet **no secret value ever lands in its database**, and every alert's exact wording is kept in a sent log. It is a [Triptech Travel](https://github.com/triptechtravel) open-source project, authored and released by Isaac Rowntree in his Triptech engineering capacity and cross-posted here on the Zack Design blog, alongside [clickup-cli](/clickup-cli/) and [slackbuzz-cli](/slackbuzz-cli/). **MIT licensed.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/triptechtravel/clawdwatch" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
  <a href="https://triptechtravel.github.io/clawdwatch/" target="_blank" rel="noopener" class="btn btn-outline-primary btn-lg">Documentation</a>
</div>

This post covers:

- where an AI model is allowed into monitoring, and where it is not;
- the "still unhealthy" transition that keeps an outage from going quiet;
- why one storage system, not three;
- how a secret can be referred to by name in a database anyone with the dashboard can edit without its value ever landing in a row, and why a failing response body is scrubbed of secrets *before* it is cut short;
- handing an incident to an agent: the test that keeps the API document it reads in step with the routes that exist, and the thing the docs claim about signed action links that the code does not yet do;
- verifying logins that arrive through Cloudflare Access, and a dashboard that records what every alert said and where it went;
- getting it running, and the lessons worth carrying to other projects.

<!-- more -->

## Why it exists

Triptech runs production APIs on Cloudflare Workers. The usual monitoring options are a SaaS that bills per check and knows nothing about your account, or a Worker you write yourself and never quite finish. clawdwatch is the finished Worker.

## Where the AI goes, and where it doesn't

There is an obvious version of an AI-era monitoring tool where a model looks at the response and decides whether you have a problem. clawdwatch doesn't do that. Detection is a threshold, a state machine and a maintenance window. That's code you can read in an afternoon and reason about at 3am. The AI gets the *other* half of the job: the part after "this is broken", where somebody has to work out why.

Everything below is either "make the detection boring and trustworthy" or "make the handoff useful".

## A state machine that can say "still down"

A monitor whose state machine has no word for "still broken" alerts exactly once on a multi-day outage, then goes silent while still down. clawdwatch's has one. It has unit tests beside it, and integration tests against a real database in workerd, the open-source runtime that Workers run on.

The transition function lives in `src/engine/transition.ts`, and its signature is the design:

```ts
export function computeTransition(
  state: CheckState,
  result: CheckResult,
  check: CheckConfig,
  now: number,
  nextIncidentId: string,
): { state: CheckState; transition: Transition } {
```

The current time is passed in, never read from the system clock. The caller supplies the incident id. That's what lets the test suite walk a check through a week of results without a clock. There are four states, `unknown`, `healthy`, `degraded` and `unhealthy`, and these moves between them:

![The four check states as circles: unknown, healthy, degraded and unhealthy. First success takes unknown to healthy silently; a failure takes healthy to degraded silently; three failures in a row take degraded to unhealthy and open an alert; a success takes degraded back to healthy silently, or unhealthy back to healthy with a recovered alert. The loop from unhealthy back to itself, which sends a reminder every hour while the check is still failing, is highlighted because without it a monitor goes quiet after the first alert.](/images/blog/clawdwatch-state-machine.svg)

The threshold defaults to three failures in a row. The move that matters is the loop from unhealthy back to unhealthy. Without it, that case returns nothing, forever, so a multi-day outage alerts on day one and then goes quiet. Reminders need the state machine to have a name for "still broken, and it has been a while":

```ts
  // Already unhealthy: remind only when the cadence has elapsed.
  const interval = check.reminderIntervalMs;
  const lastAlert = state.lastAlertAt ? Date.parse(state.lastAlertAt) : null;
  const downSince = state.downSince ? Date.parse(state.downSince) : now;

  if (interval !== null && lastAlert !== null && now - lastAlert >= interval) {
    next.lastAlertAt = at;
    return {
      state: next,
      transition: { kind: 'reminder', downSinceMs: Math.max(0, now - downSince) },
    };
  }
```

The default cadence is one hour, and `null` turns reminders off. The test drives a sustained failure through the function and asserts the sequence `['opened', 'reminder', 'none', 'reminder']`.

The orchestrator's header names two more failure modes it avoids by construction:

- **Checks run six at a time.** Run one after another, ten checks with a 10 s timeout and retries can use up the time a scheduled run is allowed.
- **Alerts are collected per run.** Fired one per check inside the loop, a ten-endpoint outage is ten notifications. Instead each run gathers its transitions into opened, recovered and reminder events, plus a single summary. A quiet run sends nothing at all.

## One storage system

Everything lives in D1, Cloudflare's hosted SQLite. There are six tables: `checks`, `check_state`, `check_results`, `incidents`, `maintenance_windows` and `notifier_deliveries`. The first migration's header names the split it avoids:

```sql
-- One storage system: D1. (v2 split hot state into an R2 JSON blob and
-- history into Analytics Engine that nothing ever read.)
```

R2 is Cloudflare's file storage and Analytics Engine its time-series store. Writing a data point to Analytics Engine on every result, with nothing reading it back, is an easy trap. It costs two storage systems, two consistency stories and a whole class of "which one is right?" bugs, for a dataset with no reader.

All SQL sits in `store/d1.ts`, beside `transition.ts` and `secrets.ts`. The integration suite applies the shipped migrations and runs in workerd against a local stand-in for D1. So the SQL is exercised rather than mocked.

One schema decision is worth copying. `check_state` deliberately has no foreign key to `checks(id)`. A run writes every check's result and state in one batch. If a check were deleted mid-run, a foreign-key violation would fail the whole batch, and silently lose that tick for every other check too.

Check results are kept 48 hours (`historyRetentionHours: 48`) and pruned every run.

## Public code, private config

Checks live in the database and can be edited through the UI. That's only safe if a secret can never land in a row. So a check stores a reference instead:

```json
{ "headers": { "X-Api-Key": "${MY_API_KEY}" } }
```

A reference is a name in `${...}` braces. It's turned into the real value at exactly one point, where the runner builds the request headers. If a name is missing, that throws, rather than sending an empty header. Every path *leaving* the system goes through `scrub()` first, which does the substitution in reverse: each literal value is replaced with its `${NAME}`.

```ts
export function scrub(text: string, secrets: SecretMap): string {
  let out = text;
  for (const [name, value] of Object.entries(secrets)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    out = out.split(value).join(`\${${name}}`);
  }
  return out;
}
```

`MIN_SECRET_LENGTH` is 8; shorter values are too common to treat as secrets. Alert payloads go further. They carry a `CheckSummary` with headers and body dropped entirely, because what is absent can't leak.

Saving a check that contains a literal secret value fails with a 400. The message names the reference you should have used. The test posts a header of `hc-super-secret-value` and asserts the error contains `${HEALTHCHECK_SECRET}`.

There's also a test named `property: no resolved secret escapes`. It isn't a generated property-based test. It's a hand-written loop over five placements (a header, a `Bearer` authorisation header, a JSON body, a query string, all three at once) for every secret. First it asserts that the write guard throws. Then it asserts that if the value had somehow reached storage, the API view, the alert summary and a log line would all be clean.

That guard is what makes a dashboard-editable, database-backed monitor safe to open-source at all. Some tokens belong to a whole domain rather than one check, such as one that lets the monitor past a web application firewall. Header rules keyed by host pattern carry the same references.

## Keeping the thing that explains the outage

By default a response body is read to evaluate assertions, then discarded. What's stored is the assertion message, cut to 256 characters. So a monitored endpoint that returns personal data doesn't leak it into the monitoring database.

But "expected 200, got 500" throws away the one thing that usually explains the outage. The motivating case is a health endpoint whose 500 body names the failing dependency for five hours, while the alert carries none of it. So a check can opt in with `"captureBodyOnFailure": true`, and `buildBodySnippet()` is deliberately ordered:

```ts
export function buildBodySnippet(raw: string, secrets: SecretMap): string | null {
  const collapsed = scrub(raw, secrets).replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.length <= MAX_BODY_SNIPPET_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_BODY_SNIPPET_LENGTH - 1)}…`;
}
```

It scrubs before truncating, so a secret straddling the cut is masked rather than half-printed. The cap is 512 characters. That's long enough for a JSON error or an HTML title, and short enough that it can't become a bulk exfiltration channel. Capture only runs when assertions failed, and only for textual content types. The check accepts `text/*`, JSON, XML, `problem+json` and `*+json`. It treats a missing content type as textual, because many error paths omit it.

The snippet reaches the webhook notifier and the dashboard, which are already trusted with the monitoring database. It never reaches Slack, which is a wide, retained audience. `bodySnippet` doesn't appear anywhere in `slack.ts`. A test sets one to `connection refused to db-primary` and asserts neither string is in the rendered payload.

## Handing an incident to an agent

An agent inbox is just a URL, so `webhook()` is the whole integration. Every alert carries a `links` object: `incident`, `ack`, `annotate`, `runNow`, `maintenance` and `capabilities`. `GET /api/agent.md` describes the API, so an agent can act on what it was handed.

The documentation overstates one thing. The docs say the action links "expire after about an hour". The signing machinery exists and is tested:

- `mintCapability()` signs an action and its expiry time, with the same keyed hash the webhook notifier uses;
- a verifier checks the expiry and compares the signature in constant time;
- the authentication layer accepts such a signature in the query string, scoped to one action.

But the orchestrator's link builder emits plain URLs, and nothing in the package calls `mintCapability()` outside the tests. As published, an agent that receives an alert needs an identity to write back: a Cloudflare Access service token. The signed links aren't wired in yet.

What is real is `agent.md`. It's generated from the `ROUTES` table in `src/routes/agent-md.ts`, which has 18 entries. Two tests keep it honest in both directions:

```ts
    const mounted = app(fakeDb().db).routes
      .filter((r) => r.path.startsWith('/api/'))
      .map((r) => `${r.method} ${r.path}`);

    const documented = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    const undocumented = [...new Set(mounted)].filter((m) => !documented.has(m));
    expect(undocumented).toEqual([]);
```

The mirror test is `documents no route that does not exist`. A route rather than a skill file for agents to install is deliberate, and the file header says why. A static file that copies a live API drifts, and in practice never gets installed. A hand-written skill for this kind of monitor claimed 90-day retention for a system that kept 48 hours, and was never copied into the container it was meant for.

An agent that has triaged something writes its findings back with `POST /api/incidents/:id/annotate`. The note appears on the incident next to the human comments. There's a worked receiver: [thinkbot](https://github.com/triptechtravel/thinkbot), which takes these alerts and checks them against GitHub, Datadog and Sentry.

## When the receiver is a Worker, skip the webhook

If the receiver lives on the same Cloudflare account, a service binding beats HTTP. The platform authenticates the call. So there's no shared signing secret to distribute or rotate, no public inbox to defend, and no replay window to reason about. The payload crosses as a structured value rather than a JSON string.

```ts
notifiers: [rpc({ binding: (env) => env.AGENT })]
```

The receiver is a `WorkerEntrypoint` with an `alert(event)` method. `rpc()` throws when the binding is missing, rather than returning quietly. Dispatch records delivery outcomes, and an unconfigured binding must show up there as a failure. A silent success is how a dead alert path stays invisible.

One sharp edge is stated in both repos: an RPC call carries **no signature**. Authenticity comes from the binding. Keep signature verification in the HTTP handler, and don't let shared downstream code assume it ran. Service bindings only work within one account. For everyone else there's `webhook()` with `hmac()`, whose verifier rejects signatures older than `DEFAULT_TOLERANCE_MS`, five minutes.

## A versioned payload, so a release is not an outage

Every alert carries `schemaVersion`, exported as `ALERT_SCHEMA_VERSION` and currently `1`. The type's comment gives receivers the rule. Adding an optional field doesn't bump it; `bodySnippet` is one such field. Removing, renaming or retyping one does. Receivers should ignore unknown fields, and must not fail outright on a version higher than they know. A receiver that rejects unknown versions turns every clawdwatch release into a monitoring outage.

## Arriving through the login proxy is not proof of identity

Mount it behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/), Cloudflare's login proxy. Reads are open by default; writes always need an identity.

There's no API key in the query string. URLs leak into logs, analytics and referrers. A shared static secret has no identity, no expiry and no revocation. And arriving through Access isn't proof in itself, because anyone who learns the Worker's direct address bypasses the proxy. So `src/auth/jwt.ts` checks the login token (a JWT) itself:

1. It fetches the team's public signing keys from Access, cached for five minutes.
2. It refuses any signing algorithm but RS256.
3. It verifies the token's signature against the named key.
4. It checks the expiry and not-before times, that the token was issued for this application, and that it was issued by this team.

A token minted for another Access application must not work here. That's what keeps a leaked token scoped to this app.

One detail is easy to get wrong. A **service token**, the kind of identity a machine caller gets, has no email address in its JWT. Its identity is in the `common_name` field. Code that only looks for an email silently rejects every machine caller, which is exactly the caller an agent integration needs. Both shapes are handled. Failures come back as a flat 403 without the reason, because the reason tells an attacker which check failed.

No identity is stored. The JWT is verified for the decision and discarded. There are no email, IP or user-agent columns.

## A dashboard that does not interpolate

The dashboard draws one mark per check run. The tick-strip component's header explains why. A scheduled check produces separate samples, and a smoothed line between them would claim measurements that were never taken. Colour is status. Height is response time against the check's own ceiling. The marks tell "responded badly" (a status code came back) apart from "unreachable" (no status code at all). Healthy marks are quieted, so amber and red carry the page.

Every delivery is recorded too, so the dashboard can answer the question monitoring tools are worst at: did the last alert actually arrive? That panel has a trap. Delivery rows are only written when an alert fires, so a failed delivery from initial setup can sit red for days with everything healthy: there is no next alert to overwrite it. So rows age out. After 24 hours a chip turns grey and reads "last delivery failed", which says what is actually known. `pruneDeliveries` runs on every scheduled run, not just in its unit tests; an exported, tested function that production never calls lets the table grow for the life of the deploy.

## The sent log

Knowing an alert arrived isn't the same as knowing what it said. The deliveries table holds the message as sent, where it went, and the check and incident it was about. A **Sent** tab in the dashboard draws Slack messages the way Slack showed them, and `GET /api/deliveries/log` pages through the same data. Deliveries are kept for 30 days (`deliveryRetentionHours`). Pruning always keeps each notifier's latest row, because alerts are sparse and deleting a notifier's only row would make it vanish from the dashboard.

Keeping the destination raises the secret problem again. Webhook URLs often carry their credential in the path, as Slack's do. So `redactUrl()` keeps the host and identifier-like segments, and never the last segment of a webhook path or the query. Two less obvious leaks are covered too:

- a failed webhook's error message holds its resolved URL, which can be the credential. The message is redacted before it is stored and shown.
- a delivery is only recorded as sent when it was posted. Slack's summary for a run that isn't all-clear is the case that shows why: it is easy to record without sending.

The payload stored for an agent notifier includes any body snippet a check opted into. So the migration's header says it plainly: mount the dashboard behind Access.

## Trying it

```bash
npm create cloudflare@latest my-monitor -- \
  --template clawdwatch/clawdwatch/examples/worker
cd my-monitor

wrangler d1 create clawdwatch          # paste the id into wrangler.jsonc
npm run migrate
wrangler secret put SLACK_WEBHOOK_URL   # optional, and all Slack needs
npm run deploy
```

Or use it as a library, as a route inside a Worker you already run:

```ts
import { createMonitor, slack } from 'clawdwatch';

const monitor = createMonitor<Env>({
  d1: (env) => env.MONITORING_DB,
  secrets: (env) => ({ SLACK_WEBHOOK_URL: env.SLACK_WEBHOOK_URL }),
  notifiers: [slack({ webhook: '${SLACK_WEBHOOK_URL}' })],
});

export default { fetch: monitor.fetch, scheduled: monitor.scheduled };
```

The defaults: a check every five minutes, a 10 s timeout, one retry after 5 s, three failures to open an alert, and hourly reminders. Assertions cover status code, headers, body, response time and a value picked out of a JSON body. That last one turns a health endpoint returning `{"db":"ok","queue":"degraded"}` into a signal rather than a 200.

## What carries over

Three things worth carrying to the next project:

- Inject the clock and the id generator, and the state machine can be tested without either.
- Scrub secrets before truncating, not after.
- Generate the document an agent reads from the same table that mounts the routes, with a test in each direction. It's the only kind of documentation that stays true.

The capability links are the open item. The docs describe them, the code signs them, and the orchestrator doesn't yet attach them.

[Read the source](https://github.com/triptechtravel/clawdwatch), or start at [getting started](https://triptechtravel.github.io/clawdwatch/guide/getting-started).
