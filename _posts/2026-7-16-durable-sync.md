---
layout: post
title: "durable-sync — offline-first sync for Cloudflare Durable Objects, no Postgres and no container"
description: "A zero-dependency TypeScript library that gives Cloudflare Durable Objects an offline-first sync loop: an append-only op log in the Durable Object's SQLite, called over typed RPC, and a durable outbox on the client that never drops a write it can't prove landed. 27 KB of JavaScript, 71 unit tests and 16 more against workerd, MIT, on npm."
excerpt: "A Durable Object is already the single-threaded ordering point that every other sync engine runs Postgres to get. durable-sync adds the rest: an op log in its SQLite, an outbox on the device, a cursor that knows which log it belongs to, and a strict idea of what 'success' means — so a phone with no signal never loses a write."
image: /images/blog/durable-sync.jpg
image_alt: A dimly lit underground mine tunnel receding into darkness, a single lamp glowing in the distance
date: 2026-07-16
last_modified_at: 2026-10-17
categories: [open-source]
tags: [cloudflare, durable-objects, typescript, offline-first, local-first, sync, pwa, event-sourcing, open-source, claude-code]
---

Zack Design's **[durable-sync](https://github.com/isaacrowntree/durable-sync)** is offline-first sync for apps built entirely on Cloudflare. The server is an append-only op log inside a Durable Object's SQLite, which you call over typed RPC. The client is a durable outbox on the device that keeps every write until the server has demonstrably stored it. It's 983 lines of TypeScript and 26,969 bytes of JavaScript, with no runtime dependencies, and **no Postgres, no long-running container and no WebSocket**. It runs in production behind [Rampset](/rampset/), an offline-first barbell app used in gyms with no reception. **MIT licensed**, on npm.

This post covers why a Durable Object is already the ordering point sync engines run Postgres to get, the four guarantees the library makes and the code behind each, how it's tested against a real Durable Object, and when you want something else.

<!-- more -->

**Docs & live demo → [isaacrowntree.com/durable-sync](https://isaacrowntree.com/durable-sync/)** · **Source → [github.com/isaacrowntree/durable-sync](https://github.com/isaacrowntree/durable-sync)** (MIT) · **npm → [`durable-sync`](https://www.npmjs.com/package/durable-sync)**

## The ordering point is already there

The credible offline-first engines, Zero, Electric and PowerSync, all want Postgres and a service in front of it. On an all-Cloudflare stack that's a second backend, run forever, to get one property: a single place that decides the order of one user's writes. A Durable Object is that place by construction. It's single-threaded, it has its own SQLite, and `env.JOURNAL.idFromName(userKey)` gives every user their own. The header comment in `src/server/journal.ts` is the whole design:

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

`op_id` is the idempotency key, so a client that isn't sure a push landed retries it and the log ignores the duplicate. Because the Durable Object is single-threaded, the check-then-insert has no race. There's no conflict resolution, on purpose: when writes are events ("this workout happened") rather than edits, two devices appending don't conflict, they interleave. It uses HTTP rather than a WebSocket, because a phone in a basement gym can't hold a socket open.

## The server is a class and a route

The journal is a native Durable Object with typed RPC methods: `push`, `pull`, `putSnapshot`, `opsByKind` and `reset`. You extend it, export it, and forward the methods you want public from your own route:

```js
// examples/notes/worker.js
import { SyncJournal } from "durable-sync/server";
export class Journal extends SyncJournal {}

const journal = env.JOURNAL.get(env.JOURNAL.idFromName(userKey));
if (req.method === "POST") {
  const { ops } = await req.json();
  return Response.json(await journal.push(ops));
}
```

That's the whole access model. A Durable Object stub is reachable only from your own Worker, so a client can touch exactly what your routes forward. `reset()` exists on the class and is private because nothing routes to it. No router inside the library second-guesses you, and every call is typed end to end.

## Four guarantees

Each of these is a way offline sync loses data silently, with the status light still green. The library makes each one impossible rather than unlikely.

**1. A successful status code is not proof.** Behind an auth proxy such as Cloudflare Access, an expired session redirects to a login page on the same origin, and `fetch` follows the redirect and reports a 200 with an HTML body. A client that clears its queue on `res.ok` deletes writes the server never saw. durable-sync only trusts a reply the journal demonstrably wrote:

![Without the check: the phone posts its queued writes, the expired Cloudflare Access session answers with a redirect to the login page, fetch follows it and reports a 200 with an HTML body, the client treats that as success and deletes the queue, and the workout is gone. With the check: the same redirect arrives, the client checks the body is the server's own reply shape before trusting it, keeps the queue, and retries after sign-in.](/images/blog/durable-sync-redirect-200.svg)

```ts
/** Did this response really come from the journal?
 *
 * Behind an auth proxy (Cloudflare Access, and others), an expired session
 * redirects to a same-origin login page — which fetch FOLLOWS, and reports as
 * a 200. `res.ok` is therefore not evidence of anything. The outbox may hold
 * the only copy of a write, so it may only be drained against a reply the
 * journal demonstrably wrote. */
function isJournalReply<T extends { seq?: unknown }>(
  body: T | null,
): body is T & { seq: number } {
  return typeof body?.seq === "number";
}
```

It goes one layer further. A push reply lists `stored`, the ids the log now holds, and the client removes exactly those from its queue. An op the journal refuses (one with a blank `opId` or `kind`) stays queued. A count of accepted ops couldn't carry that: "one of two accepted" could mean one stored and one refused, or one stored and one already there, and those need opposite handling.

```ts
const stored = Array.isArray(reply.stored) ? new Set(reply.stored as unknown[]) : null;
const drain = stored ? rows.filter((r) => stored.has(r.opId)) : rows;
await outbox.remove(drain.map((r) => r.id));
```

The client also sends `x-requested-with: XMLHttpRequest`, so a well-behaved proxy answers an expired session with a 401 instead of a login page.

**2. A cursor only means something against the log that issued it.** Each device stores the highest sequence number it has applied and pulls everything after it. If the log is ever rebuilt, every device's cursor points past the new log's end, and a naive client silently never syncs again. Every log carries an epoch, a random id that changes on `reset()`, and every pull reply names it. A device that sees a new epoch replays from zero:

```ts
const epoch = body.epoch;
if (epoch && epoch !== current.epoch) {
  // The replay a reset forces is the most expensive pull there is, so
  // it's the one that most wants a fold.
  body = await fetchPull(0, !!snapshot);
```

![Left: without an epoch, the client remembers the last sequence number it applied, 120; after the journal is rebuilt the new log only reaches 8, so a pull for everything after 120 matches nothing and the client never syncs again. Right: the log carries a random epoch id; when a pull reply names a different epoch from the one the client stored, the cursor resets to zero and the log is replayed, which is safe because applying an op twice is required to be harmless.](/images/blog/durable-sync-cursor-epoch.svg)

`apply` is required to be idempotent, so a replay is safe. A reply that omits the epoch never overwrites the one the client knows, so it can't trigger a needless replay.

**3. Pulling isn't always safe; pushing always is.** Applying someone else's op can disturb work in progress, such as a workout that's still being logged. The engine has two gates, and they're asymmetric:

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

Return `false` from `canPull()` and the device keeps pushing and pulls later. Eventual consistency makes the wait free.

**4. The identity check is the only door.** The journal is addressed by the server-side identity, while ops carry whatever user the client selected. If a caller could reach the transport directly, it could post one user's writes into another's log, get a valid reply, and clear its queue. In an append-only log that's permanent. So the transport isn't exported at all. The top of `src/client/index.ts`:

```ts
// createTransport is deliberately NOT exported. Reaching past createSync to
// the transport bypasses canWrite() — which is exactly how the app this came
// from posted one user's workouts to another's journal and drained the outbox
// against the ack. The gate is the only door.
```

`sync.now({ force })` skips the ten-second throttle, but never the gate.

## Snapshots, for logs that get long

A pull replays every op after the cursor. That's instant for a year of data and a real wait after several. The journal can't fold the log itself, because it never reads a payload, so the client does: give `createSync` a `snapshot` adapter with `capture()` and `restore(blob)`, call `sync.capture()` when your state is settled, and the journal stores the result opaquely. A new device then gets the snapshot plus the tail of the log instead of the whole history. The log is never pruned, so a snapshot is only ever an accelerator, and the journal refuses one from a log generation that no longer exists.

## Tested where it ships

The unit suite runs the logic against an in-memory store and the real `SqlOpStore` against SQLite through `node:sqlite`. An opt-in integration suite then boots workerd through `@cloudflare/vitest-plugin` and drives a real `SyncJournal` the way a consumer does, HTTP into a Worker and RPC into the Durable Object: push and the `stored` reply, pull, the snapshot upsert, reset, and the stale-epoch refusal.

```
npx vitest run
 Test Files  4 passed (4)
      Tests  71 passed (71)

npm run test:integration
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

The integration suite tests `src/`, not `dist/`, so a regression is caught before a publish. It's built with TypeScript 7 and tested on Vitest 5.

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

The outbox must be IndexedDB, not memory: until a push is acknowledged it may be the only copy of the write in existence, and iOS kills backgrounded web apps. `start()` syncs on `visibilitychange`, `focus`, `online` and `pageshow` (a tab restored from the back-forward cache doesn't fire `visibilitychange`), with a 10-second minimum interval to collapse the burst a single foregrounding produces, and a 5-minute poll as a safety net. The repo has a [runnable example](https://github.com/isaacrowntree/durable-sync/tree/main/examples/notes), a Worker plus a browser client with a real IndexedDB outbox, and the docs site has a [live demo](https://isaacrowntree.com/durable-sync/) whose Offline button cuts the network so you can watch ops queue up and then drain. There's also an honest [comparison](https://isaacrowntree.com/durable-sync/vs.html) with Zero, Electric, PowerSync and Cloudflare's partysync, checked against their own docs.

## When to use something else

A pull returns everything after the cursor in one response, which is fine for thousands of ops and not for millions. There's no live push; another device converges the next time it comes to the foreground. There's no auth built in: the Durable Object key is your isolation boundary, so put Cloudflare Access or your own sign-in in front of the route. Use one `createSync` per identity, memoised, because the throttle lives in its closure. Nothing runs while the app is closed, because Safari has no Background Sync. If two people need to edit the same record and have it merge, you want a CRDT such as Yjs or Automerge. If you already run Postgres, Zero, Electric and PowerSync are better engineered for the general case.

The slice where durable-sync is the right answer is specific: all-Cloudflare, writes that are events, and an app that has to keep working on a train, in a gym or anywhere else the signal drops.
