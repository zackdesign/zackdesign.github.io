---
layout: post
title: "thinkbot — the ops agent that reads the 500 nobody was awake for"
description: "An open-source Cloudflare Worker that takes a monitoring alert or a failing CI run, correlates it against GitHub, Datadog, Sentry and Worker telemetry, and says what changed in one paragraph, or the single word NOTHING. It tells a request stalled on I/O from slow code, keeps an outbox of what it said and chose not to say, and guards against the ways a Worker agent fails silently: cancelled background work, static files as a second front door, and an exhausted token budget."
excerpt: "thinkbot reads the alert nobody was awake for. It checks GitHub, Datadog, Sentry and Cloudflare's Worker telemetry, then posts one paragraph naming what changed, or nothing at all. Its telemetry tool spots a site stalling on I/O while uptime checks, Sentry and Datadog all say healthy, and an outbox records what it said and what it chose not to say."
image: /images/blog/thinkbot.jpg
image_alt: A red run of failing monitoring ticks feeding into a triage card that names a merged pull request as the cause, with source chips for GitHub, Datadog, Sentry and Rollbar
date: 2026-08-21 09:00:00 +1000
last_modified_at: 2026-11-16
categories: [open-source]
tags: [cloudflare, workers, ai-agents, monitoring, typescript, incident-response, security, open-source]
---

**[thinkbot](https://github.com/triptechtravel/thinkbot)** is a [Triptech Travel](https://github.com/triptechtravel) open-source project, authored and released by Isaac Rowntree in his Triptech engineering capacity and cross-posted here; it is the companion piece to [clawdwatch](/clawdwatch/). It is a single Cloudflare Worker (a small program that runs on Cloudflare's servers), written in TypeScript, that takes an alert, investigates it against **GitHub, Datadog, Sentry and Cloudflare's own Worker telemetry**, and reports what changed in one paragraph, or replies with the single word `NOTHING` and posts nothing. It can tell a **request stalled on I/O from slow code**, which uptime checks can't see, and it keeps a record of what it said and what it chose not to say. **MIT licensed.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/triptechtravel/thinkbot" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
  <a href="https://triptechtravel.github.io/thinkbot/" target="_blank" rel="noopener" class="btn btn-outline-primary btn-lg">Documentation</a>
</div>

This post covers:

- the ordered triage procedure in the prompt, and the rule that a failed tool may never read as an all-clear;
- silence as a valid outcome, and the telemetry tool that spots a stalled site when every other source says healthy;
- alerts by service binding or signed webhook, failing CI runs, and a probe for the delivery path;
- why every triage turn runs as a queue job, the outbox, and offering only the tools a deployment can use;
- three silent failures it guards against: static files answering "method not allowed" to every inbox, collapsed model output, and a reasoning model using up its whole output budget before writing a word;
- the side-by-side comparison that picks the default model, why the plain Slack notifier stays, and how to try it.

<!-- more -->

## Why it exists

A health endpoint's HTTP 500 named the failing dependency for five hours, while the alert said only `expected 200, got 500`. [The clawdwatch post](/clawdwatch/) argues that detection should be deterministic: a threshold, a state machine and a maintenance window decide whether you have a problem, with no model near that decision. thinkbot is the other half. A check can tell you an endpoint returned 500; it can't tell you that a pull request merged eleven minutes earlier, that a Sentry exception first appeared inside that window, and that a Datadog metric stepped rather than wobbled at the same moment.

> **Detection is code you can read at 3am. Explanation is the part where a model earns its keep.**

## The procedure is in the prompt, in order

`OPS_SYSTEM_PROMPT` in `src/agent-ops.ts` is an ordered procedure, not a vibe:

```
When you are handed an alert, work in this order:
  1. Confirm it is still failing. runCheckNow is cheap and stops you
     explaining an outage that has already passed.
  2. Look at the check history. A single blip and a sustained outage call for
     different responses.
  3. Look for what changed. Most outages follow a deploy, so recentDeploys on
     the relevant repository is usually the highest-value call.
  4. Look for corroboration: a new Sentry error that started inside the same
     window, or a Datadog metric that stepped rather than wobbled.
  5. Check whether this endpoint has failed before and what was concluded.
```

A turn may make at most twelve tool calls and run for at most 120 s. Each tool result is trimmed to 1,500 characters before it goes back to the model. Then the model says what it found, citing the pull request number, the exception, the ratio. If the evidence doesn't support a cause, it says the cause is unclear and lists what it ruled out. A confident wrong answer sends someone to the wrong service, and costs more than an honest "unclear".

The most important clause is this one:

```
NEVER report the absence of evidence as evidence of absence. If a tool errored,
returned nothing, or was not configured, say so in those words — "Sentry was
unreachable" is useful and "no new Sentry errors" is a lie that reads exactly
like an all-clear.
```

Findings worth keeping are written back with `annotateIncident` to the clawdwatch API at `MONITORING_URL`. That call is authenticated with a Cloudflare Access service token. The clawdwatch docs describe signed per-incident action links, but they aren't attached to alerts yet. So this is the standing credential thinkbot holds: read access to the sources, write access to annotations.

## Silence is a valid outcome

If triage finds nothing that explains the failure, the model replies `NOTHING` and the channel gets nothing. The return contract is `result.text.trim()`. An empty string means "nothing worth saying", and the caller decides whether that becomes silence or a log line. `triageAlert` logs `[alert] triage found nothing to report` and returns.

An agent that always produces a paragraph will always produce a paragraph. During an incident someone is trying to read, filler is worse than absence. So it's said three times: in the prompt, in the return contract, and in each channel's decision to post. Chat is the one exception, on purpose. A person waiting on a thread can't tell a silent bot from a broken one. So `answerChat` always replies, with "I could not finish that one" if it must.

## Telling a stall from slow code

Some failures are invisible to every source but one. Take a site that stalls for 40–60 s on roughly a third of cold renders, and cuts the HTML stream short. Nothing has merged in the window. There's no new Sentry issue and no Datadog alert. The uptime checks, which fetch a page and read the first byte, are green. A response that starts in 100 ms and never finishes is invisible to all of them. In the Worker's own invocation telemetry it reads:

```
wallTime 59971ms, cpuTime 117ms, outcome canceled
```

A minute of elapsed time against a tenth of a second of processor time can only be a request stuck waiting on something else. So `workerHealth` in `src/tools/workers.ts` queries Cloudflare's Worker telemetry and states the verdict, rather than leaving it as arithmetic:

```ts
const STALL_WALL_MS = 10_000;
const STALL_RATIO = 20;
```

Over a real incident window it returns `STALLED: p99 wall 52572ms against p99 CPU 1172ms — 45:1. That is a request waiting on I/O that never returns, NOT slow code.` (The "p99" figures are the slowest one per cent of requests.) Over the window after the site was fixed, it returns `Healthy`, with the slowest one per cent taking 6,538 ms.

It returns totals and percentiles only, never log lines. Those run to thousands a minute, and carry request URLs and headers you then pay for in context on every later turn. The API's spelling matters: Cloudflare rejects `p50` with a failure flag and an empty error list, so a query using it fails silently while every unit test passes. `median` is the supported spelling. `workers.itest.ts` drives the real API to catch the next rename.

Eight triage turns without this tool called that incident a test flake. With the window supplied, triage concludes: "requests are starting and then stalling on I/O, not slow code. The uptime checks are all green because they measure first byte only. This is a failing site, not a failing test."

## Two transports, one triage path

**Service binding, preferred.** A service binding is a direct call from one Worker to another on the same Cloudflare account. clawdwatch calls the `AlertInbox` entry point that way:

```jsonc
"services": [
  { "binding": "AGENT", "service": "thinkbot", "entrypoint": "AlertInbox" }
]
```

The platform authenticates the call. There's no shared secret and no public endpoint.

**Signed webhook**, for anything that can't bind. `POST /hooks/clawdwatch` verifies a keyed hash (an HMAC) over the timestamp and the body. It uses clawdwatch's own exported verification function and header names, not a local copy. Two implementations of one signature scheme is a bug with a delay fuse.

And the sharp edge, stated in both repos: **a direct Worker-to-Worker call carries no signature.** The `AlertInbox` comment says there's no check there either. The check belongs to the HTTP adapter, and `triageAlert` is written not to assume it ran.

## Failing CI runs get triaged the same way

`POST /hooks/e2e` takes a signed report from a GitHub Actions runner when the nightly browser test suite (Playwright) fails. A binding isn't available, because bindings only work within one account and a runner isn't on it. So this is a keyed hash under thinkbot's own header names, `x-thinkbot-signature` and `x-thinkbot-timestamp`. It has its own key, `E2E_WEBHOOK_SECRET`, separate from the monitoring inbox's. A CI runner is a different sender in a different trust domain, and leaking one key must not grant the other.

The payload is deliberately not a clawdwatch `AlertEvent`. A test run isn't a synthetic check. There's no incident to annotate and no links to act on. Forging one would hand the agent a prompt telling it to call `annotateIncident` on an incident that doesn't exist. It carries `repo`, `sha`, `runUrl`, `loadError`, `failures`, `passed` and `skipped`. The type guard checks only that `repo` and `sha` are strings: the signature proves who sent it, not that the content is sensible.

Two details matter:

- **`loadError` with no failures is a different incident.** The prompt says so in capitals: "E2E SUITE FAILED TO RUN … No tests executed, so this says nothing about whether the site is healthy." Reported as "0 tests failed", a real two-night outage reads as noise.
- **This path always posts.** There's no second notifier behind it, and nobody opens the Actions tab. The headline is the floor; the paragraph is what gets added.

## Exercising the path that is not exercised

The CI workflow has no Slack step of its own, so this is its only delivery path, and nothing else shows whether it works. So a report may set `"probe": true`. It travels the same route and posts the same way, because a probe down a different code path proves nothing about the one a real failure takes. But the headline comes first and is unmistakable: `🧪 … E2E alert path probe — delivery works, nothing is wrong`. The prompt short-circuits to "Reply with the single word NOTHING. Do not investigate."

That last part isn't an optimisation. An agent asked to explain a non-event will invent one.

## Every triage turn runs as a queue job

The obvious shape for a webhook handler is to reply to the sender and keep triaging inside `waitUntil`, the background work a Worker may keep doing after it has replied. That fails silently. Background work gets about thirty seconds after the reply. A triage turn with four or five tool calls regularly needs more, and the runtime cancels it with no error and no message:

```
waitUntil() tasks did not complete within the allowed time after invocation
end and have been cancelled.
```

A probe passes, because its model turn returns immediately. A real report gets a `200`, clean logs, and nothing in Slack. Run recorded reports through the live deployment that way and one turn finishes in 28 s; the rest are killed. The monitoring inbox has the same shape, so long clawdwatch triage turns would drop silently too. That is invisible by construction, because the thing that fails is the thing that would have told you.

![Two timelines. Without the queue: the Worker replies to the runner at once and keeps triaging in the background; the platform allows about thirty seconds after the reply, so a 28-second turn finishes but a 40-second turn is cancelled with no error and no message, and the finding is never posted. With the queue: the reply posts a plain headline immediately, and the triage turn runs as a separate queue job with its own budget of 120 seconds, so the finding follows as a second message.](/images/blog/thinkbot-waituntil-timeline.svg)

So the headline is posted in the request itself, which is one Slack call taking milliseconds, and the finding follows as a second message. The worst case is a headline with no explanation, never an explanation nobody receives. And every model turn runs as a job on a Cloudflare queue:

```jsonc
  "queues": {
    "producers": [{ "queue": "thinkbot-triage", "binding": "TRIAGE_QUEUE" }],
    "consumers": [
      {
        "queue": "thinkbot-triage",
        "max_batch_size": 1,
        "max_batch_timeout": 0,
        "max_retries": 0,
        "dead_letter_queue": "thinkbot-triage-dlq"
      }
    ]
  },
```

Retries are off, and every job is acknowledged, including failed ones. A retried turn may already have posted its finding. A duplicate explanation under an incident someone is reading is worse than the missing one it recovers. The turn stays capped at 120 s, below the consumer's budget. So a hang leaves a log line saying so, which is the difference between "found nothing" and "never finished".

A queue means everything an inbox receives has to survive being written out as JSON. A reply function that remembers its Slack thread or Telegram chat can't go in a queue message. So the channel parsers hand back a plain description of where to reply: the channel, plus either the Slack conversation and thread or the Telegram chat id. A test pins the one property that matters, that it survives the round trip through JSON.

## The outbox: what it said, and what it chose not to say

Without an outbox, the only record of what thinkbot told people is the channel itself. The only record of what it chose *not* to say is a log line that Workers Observability drops after a few days. "Why did triage go quiet on that incident?" has no answer.

So every send path writes a row to a D1 table, `outbox`, kept for 30 days. A row holds:

- what prompted it: the alert, the failing run or the question;
- where it went, never the webhook address;
- what it said, and the model's raw output when the guard dropped or changed it;
- the tools the turn called, how many steps it took and how long;
- the reason for silence, or the channel's error.

The root page renders it, and `/api/outbox` serves the same rows as JSON. The page is drawn on the server, so it adds no static files to the front door described below. It sits behind Cloudflare Access, and the Worker verifies the Access login token itself, with clawdwatch's `verifyAccessJwt`. Until `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are both set, it serves nothing, so a missing Access application fails closed.

A second test suite runs the real Worker in workerd on a local D1 with the shipped migration. It signs real RS256 Access tokens, and checks that forged and wrong-audience tokens are refused and that model output is escaped on the page.

## Only the tools a deployment can use are offered

A tool that can't answer costs a step and a sentence. A Rollbar tool with an invalid token spends one of a turn's twelve steps being told "forbidden". And because the prompt requires reporting sources that failed, every write-up carries "Rollbar could not be checked" as though it were a finding.

So `src/tools/registry.ts` declares each provider as a name, the environment variables it can't work without, and a builder. A provider missing any of them isn't offered at all. Not offered and failing: not offered. `GITHUB_OWNER` and `SENTRY_ORG` have no defaults, because a default would mean an unconfigured deployment quietly querying somebody else's organisation.

What a deployment knows about itself lives in `ESTATE_NOTES`. That's free-form prose appended to the system prompt, read by the model rather than parsed. Baking one organisation's inventory into the prompt would make a general tool unusable by anyone else. It would also go stale for its owner the first time the estate changes.

## Static files are a second front door

thinkbot holds a GitHub personal access token, Datadog and Sentry keys, and write access to monitoring incidents. `workers_dev` and `preview_urls` are off, and every route checks its caller before doing any work. That protects the routes, but not necessarily the deployment.

Cloudflare's agent starter template comes with a React chat page. Disabling the page isn't enough: `deploy` still builds it and uploads the bundle of static files. **Static files are served before the Worker's code runs.** So the bundle answers requests no route guard ever sees, with three consequences:

- An unauthenticated `GET` to the hostname returns the chat page.
- `/health` answers `200` with the chat page's HTML instead of reaching the health handler. A liveness endpoint that can't fail reports healthy through the outage it exists to catch.
- Every signed inbox returns `405`, "method not allowed". The static file handler rejects anything but `GET`, rather than passing it on to the Worker. Checked against the live deployment: `POST` to `/hooks/clawdwatch`, `/hooks/slack` and `/health` alike. Monitoring doesn't notice, because it reaches thinkbot over the direct binding, which skips the static files.

Listing the paths that should reach the Worker first (`"run_worker_first": ["/agents/*", "/oauth/*", "/hooks/*"]`, plus `/health`) moves the boundary and leaves the rest in place. The real fix is having no static files at all. With no bundle, every request lands on the code that checks its caller. With no chat page there's no React, Tailwind or Vite build, and no unused chat agent's Durable Object (Cloudflare's single-instance stateful object), and the Worker bundle is 1.2 MB rather than 2.8 MB.

One local trap is recorded only in the commit message. It matters if you mix Vite (the front-end build tool) and Wrangler (Cloudflare's deploy tool). The front-end build writes a small config file under `.wrangler/deploy/` that points Wrangler at the built `dist/` folder instead of your source. Git ignores both. So a stale redirect keeps deploying the old bundle and ignores your edits to `wrangler.jsonc`. Remove `.wrangler/deploy` and `dist` before the next deploy.

## Collapsed output never reaches the channel

`npm test` mocks the model, so it's free and offline. That's the right default, and it means the suite goes green whatever the model emits. A collapsed generation can put 256 exclamation marks into the alert channel, under a live headline about three failing specs, where they read as the alerting itself having broken.

An empty-string check and the word `NOTHING` don't stop that. `usableFinding()` in `src/triage-output.ts` judges the output on simple properties, not quality. It prefers silence in three cases:

- one character makes up more than 40% of the output;
- letters make up less than 35% of it;
- it's shorter than 24 characters.

It can't tell a correct diagnosis from a confident wrong one; no rule can.

The wall of exclamation marks is exactly 256 characters, and `!` is one token. That's Workers AI's default output cap, not a content limit. So `maxOutputTokens` is set explicitly. That makes a collapse *longer*, and is only safe because the guard drops it first.

To exercise the model half at all, there's `POST /hooks/e2e/dry-run`. It runs the same prompt through the same turn behind the same signature, and returns the result instead of posting it. `test/fixtures/` holds real payloads, recovered from the workflow logs of the runs that produced them. Invented reports correlate with nothing. The integration test's header is explicit about what it can check: that the output is prose, finished, hedged when the evidence is thin, and silent on a probe. Not that the diagnosis is right.

## Two models on the same incident, and what neither finds

`scripts/triage-harness.mjs` runs two models against the same recorded report. Six turns each:

| | `gpt-oss-120b` | `kimi-k2.6` |
|---|---|---|
| Collapsed into exclamation marks | once in six turns | never |
| When a tool had errored | wrote "no new Sentry/Rollbar errors", a made-up all-clear | said the tool was inaccessible |
| Named the test framework | called Playwright "Cypress" | correctly |
| Tool calls to reach an answer | 9 to 11 | 3 to 5 |
| Time per turn | 20 to 32 s | 46 to 74 s |

In an incident channel, a made-up negative looks exactly like a real all-clear. That decides it. The second model is about twice as slow per turn, but this runs on a nightly, so the cost is nothing. `DEFAULT_MODEL` is `@cf/moonshotai/kimi-k2.6`.

What the comparison doesn't show is either model finding the cause. Both conclude "test flake, site healthy" about an incident that was a server-side render stall. Without a tool that reaches the evidence, the telemetry tool above, a better model is confidently wrong too.

## The output budget has to fit a reasoning model

Even with the right tool, two runs in three can do the most work and then end without writing the paragraph, after querying GitHub, Datadog and Worker telemetry across four or five steps. A conversation-continuation problem and a malformed tool-call exchange are both plausible causes. Each is easy to reason to, and to declare fixed on a sample too small to show otherwise.

Logging `finishReason` and `usage` settles it in one run:

```
finishReason=stop    outputTokens=153     1 turn
finishReason=length  outputTokens=2048    4 turns, both retries included
```

With an output budget of 2,048 tokens, a reasoning model spends all of it thinking and has nothing left to write, and the retry hits the same wall. With 8,192, five runs out of five answer. The measurement is recorded beside `MAX_OUTPUT_TOKENS`, so the number is never guessed at. Knowing the headroom is for "a reasoning model's hidden tokens" is the right worry; only measuring gives the right number.

## Keep the dumb notifier

From the production configuration on the clawdwatch side:

```ts
notifiers: [
  slack({ webhook: '${SLACK_WEBHOOK_URL}' }),
  rpc({ name: 'thinkbot', binding: (env) => env.AGENT }),
]
```

Slack is listed first and deliberately kept. If the agent is the only alert path, an agent outage is a monitoring outage. Every silent failure above would be one: cancelled background work, "method not allowed" from the static files, an exhausted token budget. A failing notifier can't affect the other, so the plain, model-free Slack message always goes out. If you take one idea from either project, take that one.

## Trying it

```bash
git clone https://github.com/triptechtravel/thinkbot
cd thinkbot
npm install && npm test
```

`npm test` runs the unit suite, then the workerd and D1 suite. Before the first deploy, create the queues and the outbox database:

```bash
wrangler queues create thinkbot-triage-dlq
wrangler queues create thinkbot-triage
wrangler d1 create thinkbot      # put the id in wrangler.jsonc
wrangler d1 migrations apply thinkbot --remote
```

Then give it tokens for whichever sources you use. Tell it who you are with `GITHUB_OWNER` and `SENTRY_ORG`, deploy with `npm run deploy`, and point [clawdwatch](/clawdwatch/) at it. [SETUP.md](https://github.com/triptechtravel/thinkbot/blob/main/SETUP.md) is the short version. Read [SECURITY.md](https://github.com/triptechtravel/thinkbot/blob/main/SECURITY.md) first if you plan to turn on `captureBodyOnFailure` for endpoints whose error paths can return personal data.

## What it taught me

In order of cost:

- **Measure before diagnosing.** The reasoned explanations for the empty turns are plausible, and wrong.
- **An agent's worst failures are silent ones.** Every path needs a floor that doesn't depend on the model.
- **The tool set should be the estate's, not the author's.**

The next open item is on the clawdwatch side: attaching the signed action links, so `annotateIncident` can drop its standing credential.
