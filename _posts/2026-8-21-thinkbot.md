---
layout: post
title: "thinkbot — the ops agent that reads the 500 nobody was awake for"
description: "An open-source Cloudflare Worker that takes a monitoring alert or a failing CI run, correlates it against GitHub, Datadog, Sentry and Rollbar, and says what changed — in one paragraph, with the evidence cited, or says nothing at all."
excerpt: "A health endpoint returned a 500 whose body named the failing dependency, for five hours, while the alert carried only \"expected 200, got 500\". The cause was sitting in a response nobody kept, and nobody was awake to read it. thinkbot is the thing that reads it at 3am — and stays quiet when it has nothing worth saying."
image: /images/blog/thinkbot.jpg
image_alt: A red run of failing monitoring ticks feeding into a triage card that names a merged pull request as the cause, with source chips for GitHub, Datadog, Sentry and Rollbar
date: 2026-08-21 09:00:00 +1000
last_modified_at: 2026-08-21
categories: [open-source]
tags: [cloudflare, workers, ai-agents, monitoring, typescript, incident-response, security, open-source]
---

The companion piece to [clawdwatch](/clawdwatch/) — [`thinkbot`](https://github.com/triptechtravel/thinkbot) is a [Triptech Travel](https://github.com/triptechtravel) open-source project, authored and released by Isaac Rowntree in his Triptech engineering capacity and cross-posted here on the Zack Design blog. It is a single Cloudflare Worker that takes an alert, investigates it against GitHub, Datadog, Sentry and Rollbar, and reports what actually changed. **MIT licensed.**

<!-- more -->

**Source → [github.com/triptechtravel/thinkbot](https://github.com/triptechtravel/thinkbot)** · **Docs → [triptechtravel.github.io/thinkbot](https://triptechtravel.github.io/thinkbot/)**

## Why it exists

A health endpoint returned a 500 whose body named the failing dependency. It did that for five hours. The alert that fired carried `expected 200, got 500` and nothing else, because the monitor read the body to evaluate the assertion and then threw it away.

The cause was sitting in a response nobody kept, and nobody was awake to read it.

clawdwatch now keeps that body. thinkbot is the half that reads it at 3am — the step monitoring genuinely cannot do on its own. A check can tell you an endpoint returned 500. It cannot tell you that a pull request merged eleven minutes earlier, that a Sentry exception first appeared inside that window, and that a Datadog metric stepped rather than wobbled at the same moment.

## The division of labour

[The clawdwatch post](/clawdwatch/) made the case that detection should be deterministic — a threshold, a state machine, a maintenance window, and no model anywhere near the decision about whether you have a problem. thinkbot is what that decision buys you. It is the other side of a line drawn on purpose:

> **Detection is code you can read at 3am. Explanation is the part where a model earns its keep.**

Once something is definitely broken, the work is reading five systems and noticing what they have in common. That is genuinely well-suited to a model, and it is nobody's favourite job at 3am.

## What triage actually looks like

The system prompt is an ordered procedure, not a vibe:

1. **Confirm it is still failing.** `runCheckNow` is cheap and stops you explaining an outage that has already passed.
2. **Look at the history.** A single blip and a sustained outage call for different responses.
3. **Look for what changed.** Most outages follow a deploy, so recent merged PRs on the relevant repository is usually the highest-value call.
4. **Look for corroboration.** An exception that started inside the same window, or a metric that stepped rather than wobbled.
5. **Check whether this endpoint has failed before**, and what was concluded last time.

Then it says what it found, in one short paragraph, citing the specific thing — the PR number, the exception, the ratio. And if the evidence does not support a cause, it says the cause is unclear and lists what it ruled out.

That last clause is the one that matters:

> A confident wrong answer sends someone to the wrong service and costs more than an honest "unclear".

Conclusions worth keeping get written back to the incident with `annotateIncident`, using the short-lived signed links that arrived with the alert — so the agent records what it concluded without holding any standing credential.

## Silence is a valid outcome

If triage found nothing that explains the failure, thinkbot replies with the single word `NOTHING`, and the channel gets nothing at all.

This is the design decision I would defend hardest. An agent that always produces a paragraph will always produce a paragraph — and under an incident someone is actually trying to read, filler is worse than absence. It reads as commentary. It buries the alert. An empty channel is information: it means the automated pass found nothing, and a human should look.

Getting this right required saying it three times over — in the prompt, in the return contract (`text.trim()` empty means "nothing worth saying"), and in each channel's decision about whether to post. It is easy to accidentally build an agent that cannot shut up.

## Two transports, one triage path

**Service binding, preferred.** If clawdwatch runs on the same Cloudflare account, it calls thinkbot's `AlertInbox` entrypoint directly:

```jsonc
"services": [
  { "binding": "AGENT", "service": "thinkbot", "entrypoint": "AlertInbox" }
]
```

The platform authenticates the call. No shared secret to rotate, no public endpoint to defend.

**Signed webhook,** for anything that cannot use a binding. `POST /hooks/clawdwatch` verifies an HMAC over `timestamp.body` using clawdwatch's own `verifySignature` rather than a local reimplementation — because two implementations of one signature scheme is a bug with a delay fuse.

And the sharp edge, stated in both repos because it is exactly the sort of thing that quietly becomes a vulnerability: **an RPC call carries no signature.** Authenticity comes from the binding. So the shared triage path never assumes one was checked.

## Failing CI runs get triaged the same way

`POST /hooks/e2e` takes a signed report from a CI runner when an end-to-end suite fails.

A service binding is not available here — bindings are same-account only, and a GitHub runner is not on the account — so this is HMAC under thinkbot's own header names, keyed by `E2E_WEBHOOK_SECRET`. That is deliberately a **different key** from the monitoring inbox: a CI runner is a different sender in a different trust domain, and leaking one key must not grant the other.

The payload is deliberately *not* a clawdwatch `AlertEvent`. A test run is not a synthetic check — there is no incident to annotate and no signed links to act on — so forging one would hand the agent a prompt telling it to call `annotateIncident` against an incident that does not exist. It carries the repo, the commit, the run URL, and the failures the reporter saw.

The split is the point. The runner holds evidence no Worker can reach — which specs failed and what they asserted. thinkbot holds the credentials the runner should not, and answers what changed around that commit.

Two details earned the hard way:

- **`loadError` with no failures is a distinct incident.** The suite never ran, so it says nothing about whether the site is healthy. Reporting that as "0 tests failed" is how a real two-night outage read as noise.
- **This path always posts**, unlike monitoring triage. There is no second notifier behind it, so silence would mean a failing nightly suite simply disappears. The headline is the floor; the triage paragraph is what gets added on top.

## Exercising the path that is not exercised

Removing the CI workflow's own Slack step left exactly one delivery path and no way to tell whether it still works. You find that out during the outage the alert was meant to announce.

So a report may set `"probe": true`. It travels the same route and posts the same way — a probe down a *different* code path proves that path works and nothing whatsoever about the one a real failure takes — but it is labelled first and unmistakably, and it skips triage entirely.

That last part is not an optimisation. **An agent asked to explain a non-event will invent one.**

## A thing worth copying: keep the dumb notifier

From the production configuration on the clawdwatch side:

```ts
notifiers: [
  slack({ webhook: '${SLACK_WEBHOOK_URL}' }),
  rpc({ name: 'thinkbot', binding: (env) => env.AGENT }),
]
```

Slack is listed first and deliberately kept. If the assistant is the only alert path, then an assistant outage is a monitoring outage — and you find that out at the worst possible moment. A failing notifier cannot affect the other one, so the plain, stupid, model-free Slack message always goes out. The agent's paragraph is an addition to it, never a replacement for it.

If you take one idea from either of these projects, take that one.

## It has no public surface, and that took a second pass

thinkbot holds a GitHub PAT, Datadog and Sentry keys, and write access to monitoring incidents. `workers_dev` and `preview_urls` are off, and every inbound route verifies its caller before doing any work.

That was true of the routes and still not true of the deployment, which is the part worth writing down. The project was scaffolded from Cloudflare's agents starter, so `npm run deploy` was `vite build && wrangler deploy` — and while the chat UI had been disabled in code, the built client bundle was still being uploaded. **Static assets are matched before the Worker runs.** That single fact produced three separate bugs:

- an unauthenticated `GET` to the hostname served the chat shell, from a route guard's blind spot;
- `/health` answered `200` with `index.html` instead of the handler — a liveness endpoint that *cannot fail*, reporting healthy straight through an outage;
- and every signed inbox returned `405`, because the asset handler rejects non-GET rather than falling through. Monitoring never noticed, because it reaches thinkbot over the RPC binding, which does not pass through assets at all.

The fix is not another path in `run_worker_first`. It is having no assets at all: with the bundle gone, every request lands on the code that checks its caller. The chat UI, React, Tailwind and the entire Vite pipeline went with it — `wrangler deploy` bundles the Worker on its own.

There is a local trap attached, worth knowing if you ever mix Vite and Wrangler: `vite build` writes `.wrangler/deploy/config.json`, which redirects wrangler at `dist/`. Both are gitignored, so a stale redirect will keep deploying the old bundle while silently ignoring your edits to `wrangler.jsonc`.

## What it stopped being

It was scaffolded on Cloudflare's [Agents SDK](https://developers.cloudflare.com/agents/), which meant a chat agent backed by a Durable Object holding conversation state. Removing the UI made it obvious that nothing else had ever used it: Slack, Telegram, the monitoring inbox and the CI inbox all call one function that runs a single model turn with the ops tools. A Durable Object earns its keep when a conversation has a memory. Every conversation here is one turn long.

So the agent class, its DO, and the two packages behind it are gone, and the Worker bundle went from 2.8 MB to 1.2 MB. What remains is a `fetch` handler, an RPC entrypoint, and one `generateText` call with five tool families attached.

There is a version of this project that keeps the chat surface, and it is a reasonable thing to want — asking "what happened to payload-health last week?" in a thread is genuinely useful. But it is a different product with a different security posture, and it is not what the alert path needs.

## It is not about our estate

Every source is optional, and one with no token configured reports that it is not configured rather than failing the triage. There are no built-in defaults for the GitHub owner or the Sentry org — a default would mean an unconfigured deployment quietly querying somebody else's organisation.

What a deployment knows about itself lives in `ESTATE_NOTES`: free-form prose appended to the system prompt describing which repositories matter, what the Sentry projects are called, which service owns what. It is read by a model, not parsed, so plain sentences are fine.

Baking one organisation's inventory into the prompt is what makes an otherwise general tool unusable by anyone else — and stale for its original owner the first time the estate changes.

## Try it

```bash
git clone https://github.com/triptechtravel/thinkbot
npm install && npm test
```

Then give it tokens for whichever sources you use, tell it who you are with `GITHUB_OWNER` and `SENTRY_ORG`, and point [clawdwatch](/clawdwatch/) at it. [SETUP.md](https://github.com/triptechtravel/thinkbot/blob/main/SETUP.md) is the short version; [SECURITY.md](https://github.com/triptechtravel/thinkbot/blob/main/SECURITY.md) is worth reading first if you plan to turn on `captureBodyOnFailure` for endpoints whose error paths can return personal data.
