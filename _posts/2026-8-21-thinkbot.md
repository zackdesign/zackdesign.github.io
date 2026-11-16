---
layout: post
title: "thinkbot — the ops agent that reads the 500 nobody was awake for"
description: "An open-source Cloudflare Worker that takes a monitoring alert or a failing CI run, correlates it against GitHub, Datadog, Sentry and Worker telemetry, and says what changed in one paragraph — or the single word NOTHING. Also: how waitUntil silently cancelled every triage that ran long, why a static asset bundle was a second front door, and the token ceiling that two 'fixes' reasoned past."
excerpt: "A health endpoint returned a 500 whose body named the failing dependency, for five hours, while the alert said only \"expected 200, got 500\". thinkbot is the thing that reads that body at 3am. Building it produced a list of ways an agent silently fails: a waitUntil that cancels a 40-second turn with no error, an asset handler that answers 405 to every signed inbox, and a reasoning model spending all 2,048 output tokens thinking."
image: /images/blog/thinkbot.jpg
image_alt: A red run of failing monitoring ticks feeding into a triage card that names a merged pull request as the cause, with source chips for GitHub, Datadog, Sentry and Rollbar
date: 2026-08-21 09:00:00 +1000
last_modified_at: 2026-11-16
categories: [open-source]
tags: [cloudflare, workers, ai-agents, monitoring, typescript, incident-response, security, open-source]
---

**[thinkbot](https://github.com/triptechtravel/thinkbot)** is a [Triptech Travel](https://github.com/triptechtravel) open-source project, authored and released by Isaac Rowntree in his Triptech engineering capacity and cross-posted here; it is the companion piece to [clawdwatch](/clawdwatch/). It is a single Cloudflare Worker (a small program that runs on Cloudflare's servers), written in TypeScript, that takes an alert, investigates it against **GitHub, Datadog, Sentry and Cloudflare's own Worker telemetry**, and reports what changed in one paragraph, or replies with the single word `NOTHING` and posts nothing. It exists because a health endpoint's HTTP 500 error named the failing dependency for five hours, while the alert said only `expected 200, got 500`. **MIT licensed.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/triptechtravel/thinkbot" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
  <a href="https://triptechtravel.github.io/thinkbot/" target="_blank" rel="noopener" class="btn btn-outline-primary btn-lg">Documentation</a>
</div>

This post covers:

- the ordered triage procedure in the prompt, and the rule that a failed tool may never read as an all-clear;
- three ways a Worker agent fails silently: background work cancelled with no error, static files answering "method not allowed" to every inbox, and a reasoning model using up its whole output budget before writing a word;
- the side-by-side model comparison that changed the default model;
- the tool that found a stalled site eight earlier triage turns had called a test flake;
- the outbox, a record of everything it said and everything it chose not to say;
- why the plain Slack notifier stays, and how to try it.

<!-- more -->

## Why it exists

[The clawdwatch post](/clawdwatch/) made the case that detection should be deterministic. A threshold, a state machine and a maintenance window decide whether you have a problem, with no model anywhere near that decision. thinkbot is what that decision buys you.

> **Detection is code you can read at 3am. Explanation is the part where a model earns its keep.**

Once something is definitely broken, the work is reading five systems and noticing what they have in common. A check can tell you an endpoint returned 500. It can't tell you that a pull request merged eleven minutes earlier. Or that a Sentry exception first appeared inside that window, and a Datadog metric stepped rather than wobbled at the same moment.

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

The clause that took a real incident to write is this one:

```
NEVER report the absence of evidence as evidence of absence. If a tool errored,
returned nothing, or was not configured, say so in those words — "Sentry was
unreachable" is useful and "no new Sentry errors" is a lie that reads exactly
like an all-clear.
```

Findings worth keeping are written back with `annotateIncident` to the clawdwatch API at `MONITORING_URL`. That call is authenticated with a Cloudflare Access service token. The clawdwatch docs describe signed per-incident action links, but they aren't attached to alerts yet. So this is the standing credential thinkbot holds: read access to the sources, write access to annotations.

## Silence is a valid outcome

If triage found nothing that explains the failure, the model replies `NOTHING` and the channel gets nothing. The return contract is `result.text.trim()`. An empty string means "nothing worth saying", and the caller decides whether that becomes silence or a log line. `triageAlert` logs `[alert] triage found nothing to report` and returns.

An agent that always produces a paragraph will always produce a paragraph. During an incident someone is trying to read, filler is worse than absence. Getting this right meant saying it three times: in the prompt, in the return contract, and in each channel's decision to post. Chat is the one exception, on purpose. A person waiting on a thread can't tell a silent bot from a broken one. So `answerChat` always replies, with "I could not finish that one" if it must.

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

Two details were earned the hard way:

- **`loadError` with no failures is a different incident.** The prompt says so in capitals: "E2E SUITE FAILED TO RUN … No tests executed, so this says nothing about whether the site is healthy." Reporting that as "0 tests failed" is how a real two-night outage read as noise.
- **This path always posts.** There's no second notifier behind it, and nobody opens the Actions tab. The headline is the floor; the paragraph is what gets added.

## Exercising the path that is not exercised

Removing the CI workflow's own Slack step left one delivery path and no way to tell whether it worked. So a report may set `"probe": true`. It travels the same route and posts the same way, because a probe down a different code path proves nothing about the one a real failure takes. But the headline comes first and is unmistakable: `🧪 … E2E alert path probe — delivery works, nothing is wrong`. The prompt short-circuits to "Reply with the single word NOTHING. Do not investigate."

That last part isn't an optimisation. An agent asked to explain a non-event will invent one.

## The first real report answered 200 and posted nothing

The probe worked. Then the first real failure came through. The runner got a `200`, the logs showed no error, and Slack showed nothing fifteen minutes later. The difference: a probe's model turn returns immediately, and a real one makes tool calls.

The message was built as headline plus finding. That happened inside `waitUntil`, the background work a Worker may keep doing after it has replied. So a slow turn swallowed the alert. The first fix split them. The headline is posted in the request itself, which is one Slack call taking milliseconds, and the finding follows as a second message. The worst case became a headline with no explanation, never an explanation nobody receives.

That wasn't the whole bug. I ran recorded reports through the live deployment. One turn finished in 28 s, and the rest were killed:

```
waitUntil() tasks did not complete within the allowed time after invocation
end and have been cancelled.
```

Background work gets about thirty seconds after the reply. A triage turn with four or five tool calls regularly needs more, and the runtime cancels it with no error and no message. The monitoring inbox had the same shape. So clawdwatch triage had been dropping silently whenever it ran long. That was invisible by construction, because the thing that failed was the thing that would have told you.

![Two timelines. Before: the Worker replies to the runner at once and keeps triaging in the background; the platform allows about thirty seconds after the reply, so a 28-second turn finishes but a 40-second turn is cancelled with no error and no message, and the finding is never posted. After: the reply posts a plain headline immediately, and the triage turn runs as a separate queue job with its own budget of 120 seconds, so the finding follows as a second message.](/images/blog/thinkbot-waituntil-timeline.svg)

Every model turn now runs as a job on a Cloudflare queue instead:

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

Moving to a queue had a knock-on effect. Everything an inbox receives now has to survive being written out as JSON. The channel parsers used to hand back a reply function that remembered its Slack thread or Telegram chat. A function can't go in a queue message. It's now a plain description of where to reply: the channel, plus either the Slack conversation and thread or the Telegram chat id. A test pins the one property that matters, that it survives the round trip through JSON.

## Static assets are a second front door

thinkbot holds a GitHub personal access token, Datadog and Sentry keys, and write access to monitoring incidents. `workers_dev` and `preview_urls` are off, and every route checks its caller before doing any work. That was true of the routes, and still not true of the deployment.

The Worker was scaffolded from Cloudflare's agent starter template, which has a React chat page. Even after the page was disabled, `deploy` still built it and uploaded the bundle of static files. **Static files are served before the Worker's code runs.** So the bundle answered requests no route guard ever saw. That single fact produced three bugs:

- An unauthenticated `GET` to the hostname returned the chat page.
- `/health` answered `200` with the chat page's HTML instead of reaching the health handler. A liveness endpoint that can't fail reports healthy through the outage it exists to catch.
- Every signed inbox returned `405`, "method not allowed". The static file handler rejects anything but `GET`, rather than passing it on to the Worker. I verified it against the live deployment: `POST` to `/hooks/clawdwatch`, `/hooks/slack` and `/health` alike. Monitoring never noticed, because it reaches thinkbot over the direct binding, which skips the static files.

The first fix listed the paths that should reach the Worker first (`"run_worker_first": ["/agents/*", "/oauth/*", "/hooks/*"]`), then added `/health`. That moves the boundary and leaves the rest in place. The real fix is having no static files at all. With the bundle gone, every request lands on the code that checks its caller. Deleting the chat page also dropped React, Tailwind, the Vite build and eleven packages. Removing the unused chat agent's Durable Object (Cloudflare's single-instance stateful object) took two more. The Worker bundle went from 2.8 MB to 1.2 MB.

One local trap is recorded only in the commit message. It matters if you mix Vite (the front-end build tool) and Wrangler (Cloudflare's deploy tool). The front-end build writes a small config file under `.wrangler/deploy/` that points Wrangler at the built `dist/` folder instead of your source. Git ignores both. So a stale redirect keeps deploying the old bundle and ignores your edits to `wrangler.jsonc`. Remove `.wrangler/deploy` and `dist` before the next deploy.

## The model posted 256 exclamation marks

`npm test` mocks the model, so it's free and offline. That's the right default, and it means the suite goes green whatever the model emits. On 2026-08-22 a collapsed generation put 256 exclamation marks into the alert channel. They sat under a live headline about three failing specs, where they read as the alerting itself having broken.

Nothing stood between the model's output and Slack except an empty-string check and the word `NOTHING`. Now `usableFinding()` in `src/triage-output.ts` judges the output on simple properties, not quality. It prefers silence in three cases:

- one character makes up more than 40% of the output;
- letters make up less than 35% of it;
- it's shorter than 24 characters.

It can't tell a correct diagnosis from a confident wrong one; no rule can.

The wall was exactly 256 characters, and `!` is one token. That's Workers AI's default output cap, not a content limit. So `maxOutputTokens` is now set explicitly. That makes a collapse *longer*, and is only safe because the guard drops it first.

To exercise the model half at all, there's `POST /hooks/e2e/dry-run`. It runs the same prompt through the same turn behind the same signature, and returns the result instead of posting it. `test/fixtures/` holds real payloads, recovered from the workflow logs of the runs that produced them. Invented reports correlate with nothing. The integration test's header is explicit about what it can check: that the output is prose, finished, hedged when the evidence is thin, and silent on a probe. Not that the diagnosis is right.

## Two models on the same incident, and what neither found

`scripts/triage-harness.mjs` runs two models against the same recorded report. On 2026-08-22, six turns each:

| | `gpt-oss-120b` | `kimi-k2.6` |
|---|---|---|
| Collapsed into exclamation marks | once in six turns | never |
| When a tool had errored | wrote "no new Sentry/Rollbar errors", a made-up all-clear | said the tool was inaccessible |
| Named the test framework | called Playwright "Cypress" | correctly |
| Tool calls to reach an answer | 9 to 11 | 3 to 5 |
| Time per turn | 20 to 32 s | 46 to 74 s |

In an incident channel, a made-up negative looks exactly like a real all-clear. That decided it. The second model is about twice as slow per turn, but this runs on a nightly, so the cost is nothing. `DEFAULT_MODEL` has been `@cf/moonshotai/kimi-k2.6` since that run.

What the comparison didn't show is either model finding the cause. Both concluded "test flake, site healthy" about an incident that was a server-side render stall. No tool reached the place the evidence was. A better model would have been confidently wrong too.

## The one source that would have been right

The site was stalling for 40–60 s on roughly a third of cold renders, and cutting the HTML stream short. Every source the agent could reach said it was healthy. Nothing had merged in the window. There was no new Sentry issue and no Datadog alert. The uptime checks, which fetch a page and read the first byte, were green. A response that starts in 100 ms and never finishes is invisible to all of them. In the Worker's own invocation telemetry it reads:

```
wallTime 59971ms, cpuTime 117ms, outcome canceled
```

A minute of elapsed time against a tenth of a second of processor time can only be a request stuck waiting on something else. So `workerHealth` in `src/tools/workers.ts` queries Cloudflare's Worker telemetry and states the verdict, rather than leaving it as arithmetic:

```ts
const STALL_WALL_MS = 10_000;
const STALL_RATIO = 20;
```

Over the real incident window it returns `STALLED: p99 wall 52572ms against p99 CPU 1172ms — 45:1. That is a request waiting on I/O that never returns, NOT slow code.` (The "p99" figures are the slowest one per cent of requests.) Over the window after the fix, it returns `Healthy`, with the slowest one per cent taking 6,538 ms.

It returns totals and percentiles only, never log lines. Those run to thousands a minute, and carry request URLs and headers you then pay for in context on every later turn. Its first version asked the API for `p50`. Cloudflare rejects that with a failure flag and an empty error list, so it failed silently while every unit test passed. `median` is the supported spelling. `workers.itest.ts` drives the real API to catch the next rename.

With the window supplied, triage reached the conclusion eight earlier turns had missed: "requests are starting and then stalling on I/O, not slow code. The uptime checks are all green because they measure first byte only. This is a failing site, not a failing test."

## The empty turns were the token ceiling

Even with the right tool, two runs in three did the most work and then ended without writing the paragraph. They'd queried GitHub, Datadog and Worker telemetry across four or five steps. Two fixes were reasoned to rather than measured. The first assumed a conversation-continuation problem, the second a malformed tool-call exchange. Both were plausible. Each was declared a fix on a sample too small to show otherwise.

Logging `finishReason` and `usage` settled it in one run:

```
finishReason=stop    outputTokens=153     1 turn
finishReason=length  outputTokens=2048    4 turns, both retries included
```

2,048 was the output budget. A reasoning model was spending all of it thinking and had nothing left to write, and the retry hit the same wall. With the budget raised to 8,192, five runs out of five answered. The galling detail is now recorded beside `MAX_OUTPUT_TOKENS`, so the number is never guessed at again. The comment on the old value already said the headroom was for "a reasoning model's hidden tokens". Right worry, wrong number.

## A tool that cannot answer costs a step and a sentence

This deployment carried a Rollbar tool with an invalid token for months. Every triage turn spent one of its twelve steps to be told "forbidden". Once the prompt required reporting sources that failed, every write-up carried "Rollbar could not be checked" as though it were a finding. Rollbar left the estate on 2026-08-22, and the tool went with it.

The general fix is structural. `src/tools/registry.ts` declares each provider as a name, the environment variables it can't work without, and a builder. A provider missing any of them isn't offered at all. Not offered and failing: not offered. `GITHUB_OWNER` and `SENTRY_ORG` have no defaults, because a default would mean an unconfigured deployment quietly querying somebody else's organisation.

What a deployment knows about itself lives in `ESTATE_NOTES`. That's free-form prose appended to the system prompt, read by the model rather than parsed. Baking one organisation's inventory into the prompt would make a general tool unusable by anyone else. It would also go stale for its owner the first time the estate changed.

## The outbox: what it said, and what it chose not to say

Until November 2026, the only record of what thinkbot told people was the channel itself. The only record of what it chose *not* to say was a log line that Workers Observability drops after a few days. "Why did triage go quiet on that incident?" had no answer.

Now every send path writes a row to a D1 table, `outbox`, kept for 30 days. A row holds:

- what prompted it: the alert, the failing run or the question;
- where it went, never the webhook address;
- what it said, and the model's raw output when the guard dropped or changed it;
- the tools the turn called, how many steps it took and how long;
- the reason for silence, or the channel's error.

The root page renders it, and `/api/outbox` serves the same rows as JSON. The page is drawn on the server, so it adds no static files to the front door closed above. It sits behind Cloudflare Access, and the Worker verifies the Access login token itself, with clawdwatch's `verifyAccessJwt`. Until `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are both set, it serves nothing, so a missing Access application fails closed.

The new test suite runs the real Worker in workerd on a local D1 with the shipped migration. It signs real RS256 Access tokens, and checks that forged and wrong-audience tokens are refused and that model output is escaped on the page.

## Keep the dumb notifier

From the production configuration on the clawdwatch side:

```ts
notifiers: [
  slack({ webhook: '${SLACK_WEBHOOK_URL}' }),
  rpc({ name: 'thinkbot', binding: (env) => env.AGENT }),
]
```

Slack is listed first and deliberately kept. If the agent is the only alert path, an agent outage is a monitoring outage. Every failure above would have been one: the cancelled background work, the "method not allowed" from the static files, the exhausted token budget. A failing notifier can't affect the other, so the plain, model-free Slack message always goes out. If you take one idea from either project, take that one.

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

- **Measure before diagnosing.** Two of the fixes above were reasoned to, and wrong.
- **An agent's worst failures are silent ones.** Every path needs a floor that doesn't depend on the model.
- **The tool set should be the estate's, not the author's.**

The next open item is on the clawdwatch side: attaching the signed action links, so `annotateIncident` can drop its standing credential.
