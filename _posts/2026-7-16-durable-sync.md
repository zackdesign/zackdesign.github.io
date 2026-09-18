---
layout: post
title: "durable-sync — offline-first sync for Cloudflare Durable Objects, no Postgres and no container"
description: "A zero-dependency TypeScript library that gives Cloudflare Durable Objects an offline-first sync loop: an append-only op log in the DO's SQLite, a durable outbox on the client. Extracted from Rampset after a finished workout was silently destroyed in production. 27 KB of JavaScript, 71 unit tests, 16 more against workerd, MIT, on npm."
excerpt: "A finished workout was silently destroyed in production because fetch followed a Cloudflare Access login redirect and reported it as a 200. That bug, and three more like it, are why the sync layer came out of Rampset as a package. A Durable Object is already the single-threaded ordering point that everyone else runs Postgres to get; the rest is an outbox, a cursor, and being careful about what 'success' means."
image: /images/blog/durable-sync.jpg
image_alt: A dimly lit underground mine tunnel receding into darkness, a single lamp glowing in the distance
date: 2026-07-16
last_modified_at: 2026-07-16
categories: [open-source]
tags: [cloudflare, durable-objects, typescript, offline-first, local-first, sync, pwa, event-sourcing, open-source, claude-code]
---

Zack Design has published **[durable-sync](https://github.com/isaacrowntree/durable-sync)**, the sync layer from [Rampset](/rampset/) extracted into a library, after a week-long incident in which a finished workout was silently destroyed in production. The cause was one line: the client drained its outbox on `res.ok`, and behind Cloudflare Access an expired session redirects to a same-origin login page that `fetch` follows and reports as a 200. The write was deleted from the phone and had never reached the server. The package is an append-only op log inside a Durable Object's SQLite plus a durable outbox on the client: 983 lines of TypeScript, 26,969 bytes of JavaScript in `dist/`, no runtime dependencies, **no Postgres, no long-running container, no WebSocket**. Seventeen commits and five releases went out on 16 July 2026, most of them fixing something the previous one had shipped. **MIT licensed**, on npm.

This post walks through why a Durable Object already is the ordering point that sync engines run Postgres to get, the four silent data-loss bugs the code encodes (the `res.ok` one, a cursor pointing past a reset log, a pull landing mid-workout, and one user's writes filed under another's journal), a fifth found while writing tests for the SQL path that had never executed, the comparison table I got wrong in my own favour, and the 71 unit and 16 workerd tests that now stand in front of all of it.

<!-- more -->

**Docs & live demo → [isaacrowntree.com/durable-sync](https://isaacrowntree.com/durable-sync/)** · **Source → [github.com/isaacrowntree/durable-sync](https://github.com/isaacrowntree/durable-sync)** (MIT) · **npm → [`durable-sync`](https://www.npmjs.com/package/durable-sync)**

## The ordering point is already there

The credible offline-first engines in 2026, Zero, Electric, PowerSync, all want Postgres and a service in front of it. On an all-Cloudflare stack that is a second backend, run forever, to get one property: a single place that decides the order of one user's writes. A Durable Object is that place by construction. It is single-threaded, it has its own SQLite, and `env.JOURNAL.idFromName(userKey)` gives every user their own. The header comment in `src/server/journal.ts` is the whole design:

> The Durable Object is the single-threaded consistency point that orders one user's ops; this module is the pure logic, so it's testable without a Workers runtime. Ops are opaque: `{ opId, kind, payload }`. The log never interprets a payload, which is what keeps it a primitive rather than a database.

The schema is three tables:

```sql
CREATE TABLE IF NOT EXISTS ops (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, blob TEXT NOT NULL);
```

`op_id` is the idempotency key, so a client that is not sure a push landed retries it and the log ignores the duplicate. Because the DO is single-threaded the check-then-insert has no race. There is no conflict resolution on purpose: if writes are events ("this workout happened") rather than edits, two devices appending do not conflict, they interleave. HTTP rather than WebSocket, because gyms are Faraday cages and a socket that cannot connect is not a feature. The server is a class you extend and a route you write; what you do not forward, a client cannot reach:

```js
// examples/notes/worker.js
import { SyncJournal } from "durable-sync/server";
export class Journal extends SyncJournal {}

const journal = env.JOURNAL.get(env.JOURNAL.idFromName("demo"));
if (req.method === "POST") {
  const { ops } = await req.json();
  return Response.json(await journal.push(ops));
}
```

`reset()` exists on the DO. Nothing routes to it. That is the access model, and it is why 0.3.0 replaced the DO's internal `fetch` router with native RPC methods: the router was a layer I did not write, sitting between the Worker and the log, special-casing `DELETE`.

## Bug one: a successful status code is not evidence

The first version of the client in Rampset did what every example does: `POST` the outbox, and on `res.ok` delete the queued rows. Cloudflare Access sits in front of the Worker. When the Access session expired, the request was redirected to the login page on the same origin, `fetch` followed the redirect, and the response was a 200 with an HTML body. The outbox was drained against it. The fix in `src/client/transport.ts` is a type guard on the body, and the comment above it is the incident report:

![Before the fix: the phone posts its queued writes, the expired Cloudflare Access session answers with a redirect to the login page, fetch follows it and reports a 200 with an HTML body, the client treats that as success and deletes the queue, and the workout is gone. After the fix: the same redirect arrives, the client checks the body is the server's own reply shape before trusting it, keeps the queue, and retries after sign-in.](/images/blog/durable-sync-redirect-200.svg)

```ts
/** Did this response really come from the journal?
 *
 * Behind an auth proxy (Cloudflare Access, and others), an expired session
 * redirects to a same-origin login page — which fetch FOLLOWS, and reports as
 * a 200. `res.ok` is therefore not evidence of anything. The outbox may hold
 * the only copy of a write, so it may only be drained against a reply the
 * journal demonstrably wrote. */
function isJournalReply<T extends { seq?: unknown }>(body: T | null): body is T & { seq: number } {
  return typeof body?.seq === "number";
}
```

The client also sends `x-requested-with: XMLHttpRequest`, which makes a well-behaved proxy answer an expired session with a 401 instead of a login page. That is belt and braces; the guard is what protects the outbox.

## Bug two: a cursor only means something against the log that issued it

Each client stores the highest `seq` it has applied and pulls `seq > cursor`. During the incident I reset the journal. Every client was then holding a cursor from a log that no longer existed, usually pointing *past* the rebuilt one, so `seq > cursor` matched nothing, and every client silently never synced again. Now the `meta` table carries an `epoch`, a `crypto.randomUUID()` stamped on first use and replaced by `reset()`, and every pull reply carries it:

```ts
const epoch = body.epoch;
if (epoch && epoch !== current.epoch) {
  // The replay a reset forces is the most expensive pull there is, so
  // it's the one that most wants a fold.
  body = await fetchPull(0, !!snapshot);
```

![Left: the client remembers the last sequence number it applied, 120; after the journal is rebuilt from scratch the new log only reaches 8, so a pull for everything after 120 matches nothing and the client silently never syncs again. Right: the log now carries a random epoch id; when a pull reply names a different epoch from the one the client stored, the cursor resets to zero and the log is replayed, which is safe because applying an op twice is required to be harmless.](/images/blog/durable-sync-cursor-epoch.svg)

`apply` is required to be idempotent, so a replay from zero is cheap and safe. There is a smaller bug hiding next to this one: when a reply omits the epoch the client must keep the one it knows, not write `undefined`, or the next reply that has one looks like a new generation and triggers a needless full replay. Rampset guarded that. The extraction regressed it, and the second commit of the day put it back.

## Bug three: pulling is not always safe

Pushing never disturbs the device that pushes. Pulling applies someone else's op to local state, and in Rampset a remote op landing mid-workout rewrote the working weight the finish logic reads back, and turned a logged 5×5 into a 3×5. The engine therefore has two gates and they are asymmetric:

```ts
async function run(): Promise<number> {
  const pushed = await transport.push();
  if (!(await canPull())) {
    // A clean push is as synced as we can honestly claim right now.
    record(pushed.ok ? { lastOkAt: now() } : { ...snapshot, lastError: UNREACHABLE });
    return 0;
  }
  const pulled = await transport.pull();
```

Returning `false` from `canPull()` pushes and tries again later. Eventual consistency makes the wait free.

## Bug four: the gate has to be the only door

The journal is addressed by the server-side identity; the ops carry whatever lifter the client had selected. With `canWrite()` on the engine but `createTransport` exported, a caller could reach past the gate and push directly, which is exactly how Rampset posted one user's workouts to another's journal, got a valid ack, and drained the outbox against it. In an append-only log that is permanent. The fix is not a check, it is a missing export. The top of `src/client/index.ts`:

```ts
// createTransport is deliberately NOT exported. Reaching past createSync to
// the transport bypasses canWrite() — which is exactly how the app this came
// from posted one user's workouts to another's journal and drained the outbox
// against the ack. The gate is the only door.
```

`sync.now({ force })` skips the ten-second throttle and never the gate.

## Bug five arrived while writing tests for bug one

0.1.0 shipped with 33 tests, every one of them against `MemoryOpStore`. `SqlOpStore`, the class every production journal actually runs, had no tests, so no constraint or upsert in it had ever been executed by the suite. Writing them (against real SQLite through `node:sqlite`) surfaced a bug in the reply format. The journal refuses an op with a blank `opId` or `kind` and reported that in `accepted`, but the client drained the whole outbox against any well-formed reply and never looked. A count cannot carry the distinction: `accepted: 1` of two ops means one stored and one refused, or one stored and one duplicate, and those need opposite handling. 0.2.0 changed `push` to return `stored: string[]`, the ids the log now holds, and the client drains exactly those:

```ts
const stored = Array.isArray(reply.stored) ? new Set(reply.stored as unknown[]) : null;
const drain = stored ? rows.filter((r) => stored.has(r.opId)) : rows;
await outbox.remove(drain.map((r) => r.id));
```

A Worker older than the client sends no `stored`, and the client keeps the old behaviour rather than stall a rollout where the PWA leads the Worker. The same bug as trusting `res.ok`, one layer in.

## Proving the SQL runs where it ships

The unit suite proves the logic and that the SQL parses. It cannot prove the SQL behaves the same on the DO's own SQLite, which is the one place a divergence would only ever surface at runtime, in production. So there is an opt-in integration suite that boots workerd through `@cloudflare/vitest-pool-workers` and drives a real `SyncJournal`: push and the `stored[]` ack, pull, snapshot upsert, reset dropping the snapshot, the stale-epoch refusal.

```
npx vitest run
 Test Files  4 passed (4)
      Tests  71 passed (71)
   Duration  174ms

npx vitest run --config vitest.integration.config.ts
 Test Files  1 passed (1)
      Tests  16 passed (16)
   Duration  1.41s
```

It is `npm run test:integration`, not `npm test`, and its CI workflow is `workflow_dispatch` only, because it is an order of magnitude slower and never needs to block a publish. The integration worker imports `src/`, not `dist/`, so a regression is caught before a publish.

## What I got wrong about the competition

0.1.2 has no code changes. The docs site carries a [comparison](https://isaacrowntree.com/durable-sync/vs.html) against Zero, Electric, PowerSync and Cloudflare's partysync, and when I fact-checked it against their primary docs three of the four rival rows were wrong, every error in my favour. partysync is delta sync with an IndexedDB read cache, so the gap is a write queue and nothing else; Zero rejects writes while disconnected, which is an explicit non-goal rather than a shortcoming; PowerSync's "conflict resolution: yes" had been overstated. The commit is titled "Correct the rival claims — every error flattered us". The table now says, in its own caveat, that it was written by someone with an obvious interest.

## What you write

```ts
import { createSync, localStorageCursor } from "durable-sync/client";

export const sync = createSync({
  endpoint: "/api/sync",
  outbox: dexieOutbox(db.outbox),          // durable — it may hold the only copy
  cursor: localStorageCursor("myapp.cursor"),
  async apply(op) { /* idempotent: an op can arrive twice */ },
  canPull: async () => !(await somethingInProgress()),
});
```

The outbox must be IndexedDB, not memory: until a push is acknowledged it may be the only copy of the write in existence, and iOS kills backgrounded PWAs. `start()` syncs on `visibilitychange`, `focus`, `online` and `pageshow` (a tab restored from the bfcache does not fire `visibilitychange`), with a `minIntervalMs` of 10 s to collapse the burst a single foregrounding produces, and a 5-minute poll as a safety net that iOS will freeze anyway. There is a [runnable example](https://github.com/isaacrowntree/durable-sync/tree/main/examples/notes) in the repo, a Worker plus a browser client with a real IndexedDB outbox, and a [live demo](https://isaacrowntree.com/durable-sync/) whose Offline button flips `window.fetch` so you can watch ops queue with no sequence number and then drain.

## When to use something else

A pull returns everything after the cursor in one response, fine for thousands of ops and not for millions. There is no live push; the other device converges on its next foreground. There is no auth: the DO key is your isolation boundary. One `createSync` per identity, memoised, because the throttle lives in the closure. And nothing runs while the app is closed, because Safari has no Background Sync and pretending otherwise would be a lie. If two people need to edit the same record and have it merge, you want a CRDT, Yjs or Automerge. If you already run Postgres, Zero, Electric and PowerSync are better engineered for the general case. The slice where durable-sync is the right answer is narrow: all-Cloudflare, writes that are events, and an app that has to keep working on a train.

## What the extraction taught me

The op log is a hundred lines and the outbox is an interface; anyone could write those in an afternoon. Every non-obvious line in the package is a bug that shipped, and each of them failed silently with `lastOkAt` set and the status row green. The one that cost a workout was a redirect `fetch` followed on my behalf. The one that cost every client's sync was a `reset()` I ran myself. The fifth was found only because the class that runs in production finally had a test, which is the sentence I would put at the top of the README if I were starting again. The code is small; the scar tissue is the product.
