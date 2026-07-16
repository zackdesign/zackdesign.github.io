---
layout: post
title: "durable-sync — offline-first sync for Cloudflare Durable Objects, no Postgres and no container"
description: "A small, zero-dependency TypeScript library that gives Cloudflare Durable Objects an offline-first sync loop: an append-only op log on the server, a durable outbox on the client. No Postgres, no long-running container, no WebSocket. Extracted from Rampset, MIT licensed, on npm."
excerpt: "Every credible offline-first sync engine wants Postgres and a long-running container. But a Durable Object is already a single-threaded ordering point per user — the exact thing they need Postgres for. So I pulled the sync layer out of Rampset, and what makes it worth packaging isn't the code. It's the four production bugs it encodes."
image: /images/blog/durable-sync.jpg
image_alt: A dimly lit underground mine tunnel receding into darkness, a single lamp glowing in the distance
date: 2026-07-16
last_modified_at: 2026-07-16
categories: [open-source]
tags: [cloudflare, durable-objects, typescript, offline-first, local-first, sync, pwa, event-sourcing, open-source, claude-code]
---

Zack Design has published **[durable-sync](https://github.com/isaacrowntree/durable-sync)** — a small, zero-dependency library that gives Cloudflare Durable Objects an offline-first sync loop. An append-only op log on the server, a durable outbox on the client, and an honest status you can show users. **No Postgres, no long-running container, no WebSocket.** It's the sync layer extracted from [Rampset](/rampset/), the offline-first gym app, cleaned up and shipped on its own. **MIT licensed**, on npm, and it depends on nothing.

<!-- more -->

**Docs & live demo → [isaacrowntree.com/durable-sync](https://isaacrowntree.com/durable-sync/)** · **Source → [github.com/isaacrowntree/durable-sync](https://github.com/isaacrowntree/durable-sync)** (MIT) · **npm → [`durable-sync`](https://www.npmjs.com/package/durable-sync)**

## Why this exists

If you want offline-first sync in 2026, the credible engines — Zero, Electric, PowerSync — all want **Postgres and a long-running container**. On an all-Cloudflare stack that's a second backend to run, forever. They're genuinely better than this at almost everything; that's not the point. The point is the tax.

Meanwhile the platform already hands you the hard part for free: **a Durable Object is a single-threaded ordering point, per user.** That's the exact thing everyone else reaches for Postgres to get. Give each user their own DO with `idFromName(userKey)` and write-ordering stops being a distributed-systems problem and becomes a language feature. Once you have that, the rest of "sync" is just an outbox, a cursor, and a great deal of care about what "success" means.

So durable-sync is small on purpose. It's a **primitive, not a database.** No conflict resolution — ops are immutable facts appended to a log, and if your writes are *events* ("this workout happened") rather than edits, you don't have a conflict problem. HTTP, not WebSocket — a socket is useless in a basement, and gyms are Faraday cages, so sync happens when the app is open and the network exists. Bring your own IndexedDB.

## The four things that are easy to get wrong

Here's the honest reason this is a package and not a gist. Sync that *looks* like it works and sync that *actually* works are separated by a handful of failures that are individually obvious and collectively brutal — because every one of them fails **silently**. Each of these shipped to production in the app this came from:

- **`res.ok` is not evidence.** Behind an auth proxy like Cloudflare Access, an expired session redirects to a *same-origin* login page — which `fetch` quietly follows and reports as a **200**. Drain your outbox on `res.ok` and you've just deleted writes that never reached the server. durable-sync validates that a reply actually came from the journal before it touches the queue.
- **A cursor only means something against the log that issued it.** Reset the log and every client is holding a sequence number from a log that no longer exists — usually pointing *past* the rebuilt one, so `seq > cursor` matches nothing and the client **silently never syncs again.** Every pull carries an `epoch`; a client that sees a new one replays from zero. Apply is idempotent, so replay is cheap.
- **Pulling is not always safe.** In Rampset, a remote op landing *mid-workout* rewrote the working weight that the finish logic reads back — and silently dropped a 5×5 to a 3×5. Pushing is always safe; pulling isn't. A `canPull()` gate defers the pull while the user is in the middle of something, and eventual consistency makes waiting free.
- **The gate has to be the only door.** The journal is addressed by a *server-side* identity while the ops carry whatever the client selected — so writing as the wrong one files data under someone else, permanently, in an append-only log. The engine has a `canWrite()` gate; the transport that could bypass it simply **isn't exported.** There is one way in.

None of these are things you'd think to test for until they've bitten you. That scar tissue is the actual product.

## What you write

The server is a Durable Object you extend and export. Its methods are native DO RPC — you call them on the stub, typed, with no request-building in between:

```ts
// worker.ts
import { SyncJournal } from "durable-sync/server";
export class Journal extends SyncJournal {}

// your route — forward exactly the methods a client should reach
export async function POST(req: Request) {
  const { ops } = await req.json();
  const journal = env.JOURNAL.get(env.JOURNAL.idFromName(userKey));
  return Response.json(await journal.push(ops));
}
```

Note what you *don't* forward: `reset()`. The DO has it, but a client reaches only the methods you wire to a route — that's the whole access model, no router second-guessing you. The client is local-first: commit to IndexedDB, queue the op, let the network catch up.

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

There's a **[runnable example](https://github.com/isaacrowntree/durable-sync/tree/main/examples/notes)** in the repo — a Worker plus a browser client with a real IndexedDB outbox — and a **[live demo on the docs site](https://isaacrowntree.com/durable-sync/)** where you can cut the network, watch writes pile up in the outbox with no sequence number, then reconnect and watch them drain. That widget *is* the library.

## When to use something else

Being clear so you don't adopt it and find out: no conflict resolution, no pagination (a pull returns everything after the cursor in one response — fine for thousands of ops, not millions), no live push, no auth, and nothing runs while the app is closed because Safari has no Background Sync. If you need those, you want a real sync engine and the Postgres that comes with it — there's an [honest comparison](https://isaacrowntree.com/durable-sync/vs.html) against Zero, Electric, PowerSync and Cloudflare's own partysync on the docs site. If you need two people editing the same record to *merge*, you want a CRDT — Yjs or Automerge.

The slice where durable-sync is the right answer is narrow: you're all-Cloudflare, your writes are events, and the app has to keep working on a train. Inside that slice, it's a few kilobytes and no second backend.

## The lesson

Extracting a library from a working app is a good forcing function: it makes you separate the parts that are genuinely reusable from the parts that were only ever about your problem. What surprised me is how little of the value was in the code. The op log is a hundred lines. The outbox is an interface. Anyone could write those in an afternoon — and then spend the next year discovering, one silent data-loss bug at a time, the four things above.

That year is what's in the package. The code is small; the scar tissue is the product.
