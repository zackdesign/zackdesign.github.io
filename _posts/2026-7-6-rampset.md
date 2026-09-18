---
layout: post
title: "Rampset — I got fired as a customer, so I built the gym app myself and open-sourced it"
description: "An open-source barbell training web app that works offline first — guided five-by-five and Madcow programs, freeform routines, a per-user Durable Object with its own SQLite for sync, R2 snapshots — built after the app holding my StrongLifts history cancelled my subscription during a support ticket. 256 tests, MIT, self-host on Cloudflare."
excerpt: "A sign-in bug, a support ticket, and my grandfathered StrongLifts subscription was cancelled without me asking. The 1,270-workout export became the seed of Rampset: three training modes on one engine, the browser's on-device database as the source of truth, a per-user Durable Object for sync, and a rest timer that survives the phone locking. Then it lost a workout in production, and the interesting engineering started."
image: /images/blog/rampset.jpg
image_alt: A loaded barbell resting on the floor of a dark gym
date: 2026-07-06
last_modified_at: 2026-07-06
categories: [open-source, product]
tags: [nextjs, react, pwa, cloudflare, durable-objects, typescript, tdd, fitness, open-source, claude-code]
---

Zack Design has published **[Rampset](https://github.com/isaacrowntree/rampset)**, an open-source strength-training app that works offline first, built as a progressive web app (a website you install like an app), and it replaced the app I had logged my lifting in for years. A sign-in bug locked me out of that app; support's resolution, after a morning of screenshots, was to cancel my grandfathered subscription, and the only way back was a new plan at a much higher price. My history exported to CSV, 1,270 workouts, and that file became Rampset's first import. It runs three training styles on one engine, works in a gym with zero signal, syncs between devices through a Durable Object per user (Cloudflare's single-instance server object with its own SQLite database), and saves a snapshot of every workout to R2, Cloudflare's file storage. **MIT licensed**, built to self-host on your own Cloudflare account.

This post covers the engine (linear progression; the stall protocol that steps a lift from five sets of five down to three sets of five and then one set of five; weight reductions scaled to how long you were away; Madcow's ramp fractions), the offline mechanics (a three-second network timeout in the service worker, a rest timer based on a saved start time rather than a countdown, a bell synthesised from two sine tones), and the production incident on 14 and 15 July in which a finished workout was erased, which produced four fixes that later became the [durable-sync](/durable-sync/) library.

<!-- more -->

**Site and guide:** [isaacrowntree.github.io/rampset](https://isaacrowntree.github.io/rampset) · **Source:** [github.com/isaacrowntree/rampset](https://github.com/isaacrowntree/rampset) (MIT)

## Three ways to train, one engine

The constraint that shaped the architecture was not me. My wife trains too, and her program looks nothing like mine. So the `Program` row carries a mode, and `finishWorkout` branches on it:

```ts
export type ProgramMode = "progression" | "routine" | "madcow";
```

- **Program mode** is StrongLifts-style training: five sets of five, alternating two workouts (A and B), with the family of variants (Plus, Lite, Mini, Ultra, Ultra Max). The engine in `src/lib/progression.ts` is a pure function. A successful workout adds `incrementKg` to the lift: 2.5 kg on the main lifts, 5 kg on the deadlift, nothing on the assistance lifts. Three failures in a row subtract `deloadPct`, 10%, rounded to the nearest 2.5 kg. The stall protocol lives on the program slot as `deloadCount`: after the first deload the lift stays at five sets of five, after the second it drops to three sets of five, after the third to one set of five. Warm-up sets ramp up to the working weight like this:

  | Warm-up set | Fraction of the working weight | Reps |
  |---|---|---|
  | 1 | one half | 5 |
  | 2 | two thirds | 5 |
  | 3 | five sixths | 3 |
  | 4 | eleven twelfths | 2 |

  Plate math works out the plates for one side of the bar, largest first, from the 20, 15, 10, 5, 2.5 and 1.25 kg plates, and returns `null` rather than lie when a weight cannot be loaded exactly.
- **Madcow mode** is five sets of five ramped up over the week. `src/lib/madcow.ts` encodes the three days directly:

  | Day | What it does |
  |---|---|
  | Heavy | four sets climbing through 50%, 62.5%, 75% and 87.5% of the top weight, then a top set of five |
  | Light | the same ramp, stopping at 75% |
  | Intensity | climbs to a personal-record set of three reps at the top weight plus one increment, then a back-off set of eight at 75% |

  If the personal-record set succeeds, next week's top weight moves up.
- **Routine mode** uses the layout of the Strong app: exercise cards with a row per set, everything prefilled from the last session by `src/lib/prefill.ts`, a rest time per exercise, timed sets and bodyweight sets. You prescribe; the app remembers.

Coming back after time off is handled by `src/lib/deload.ts`, and it is the whole file:

```ts
export function deloadPctForLayoff(daysAway: number): number {
  if (daysAway >= 56) return 0.3;
  if (daysAway >= 28) return 0.2;
  if (daysAway >= 14) return 0.1;
  return 0;
}
```

Both of our histories came in through CSV importers for the two incumbent apps' export formats, detected from the header row (`"Set Order"` meant Strong; `"Workout,Workout Name"` or `"Date (yyyy/mm/dd)"` meant StrongLifts) and deduplicated by their order within each date and workout label, because two "Workout A"s on one day is common in real exports. Once the migration was done the importers, 633 lines including tests, were deleted; export gives everything back as CSV from Settings.

<img src="/images/blog/rampset-app.png" alt="Rampset home screen: dark OLED UI showing the next 5×5 workouts with working weights and a Start workout button" style="max-width: 320px; width: 100%; display: block; margin: 1.5rem auto; border-radius: 24px;" />

## Offline is the default state, not an error state

Gyms are Faraday cages. IndexedDB, the browser's on-device database (used through the Dexie library), is the source of truth on the device, and the network is an optimisation. The service worker in `public/sw.js` caches the app shell and five routes, and the one constant in it that matters is this:

```js
/** Gym dead zones don't fail fetches — they hang them. Anything
 * network-first must give up quickly and fall back to cache. */
const NETWORK_TIMEOUT_MS = 3000;
```

The rest timer is the other place where "offline" really means "the phone locked in your pocket". `src/components/RestTimer.tsx` does not count down; it saves the moment the rest started under `liftlog.restTimer` and, on every tick, works out how many seconds have passed since then (`Math.floor((Date.now() - startTs) / 1000)`), so sending the app to the background, navigating away, and a full reload cannot lose it. Closing the timer clears the tick but deliberately not the saved start time. A saved rest older than 30 minutes is treated as stale and discarded. When it rings, it rings with a bell the app synthesises, because a bundled audio file is one more thing to fail offline:

```ts
for (const [freq, at, dur] of [
  [1318.5, 0, 0.9], // E6
  [880, 0.12, 1.1], // A5
] as const) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.exponentialRampToValueAtTime(0.5, t0 + at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
```

Two tones per strike, struck twice, half a second apart. The `AudioContext` is created inside the tap that logs the set, because browsers only allow sound to start from a user gesture, and resumed before striking, because long workouts suspend it. The screen is kept awake while a workout is open, and the phone gives a 10-millisecond vibration on every logged set.

## Sync without a database server

Each lifter gets their own Durable Object, addressed by their lower-cased email, which comes from the `cf-access-authenticated-user-email` header that Cloudflare Access sets. The Durable Object handles one request at a time and has its own SQLite database, which makes it the place where that user's writes are put in order, with no Postgres anywhere. Finished workouts are pushed as operations keyed by workout id, so applying one twice changes nothing; fresh devices pull. Underneath, `src/server/backupStore.ts` writes a dated snapshot to R2 under `snapshots/<user>/<stamp>.json` and merges a `latest.json` pointer with a write that only succeeds if the file has not changed since it was read (an etag check), retried three times, because two devices can finish a backup at once.

Identity is handled entirely by Access, so the app contains no authentication code, and the list of lifters is an environment variable (`NEXT_PUBLIC_LIFTLOG_USERS` in `.env.example`, a `LIFTLOG_USERS` Worker secret in production) that never enters the repo.

## The week it lost a workout

On 14 July a real workout was erased from the R2 bucket. `docs/sync-repair-plan.md` is the write-up; the commit trail is the short version, and every step of it is a bug that looked like success.

The backup route overwrote `latest.json` instead of merging it, so a device with an older local copy wiped out a newer one (#17). The journal only holds workouts finished since it existed, so years of imported history lived in `latest.json` and the dated snapshots alone, and snapshots expire after 90 days. One overwrite plus three months is unrecoverable. That is why the merge is now a union, written with the etag check.

Then the outbox, the queue of writes waiting to be sent. Behind Cloudflare Access an expired session returns the login page with a success status (200) from the app's own domain, and `flushOutbox` emptied the queue as soon as the response looked successful, deleting writes the journal never saw (#11). The fix checks the shape of the response body before emptying the queue, and sends an `X-Requested-With` header so Access answers with a 401 instead of a login page. The same trap is in the service worker, which now caches a response only if it succeeded, was not redirected, and came from the app's own origin, because caching a login page poisons the offline shell.

The same commit fixed the reason pulls happen at all during a workout: `applyOp` writes `workingWeightKg` and `finishWorkout` reads it back to decide deloads, so a remote operation landing mid-session could step a lift from five sets of five to three sets of five. Sync is now push-only while a workout is active:

```ts
canPull: async () => !(await getActiveWorkout(user.id)),
```

Repairing the journal needed a reset (#12), and the reset shipped its own bug (#14). Each device remembers how far through the journal it has read as a cursor, the sequence number of the last entry it saw. Rebuilding the journal restarted its sequence numbers at 1 while every device still held a cursor from the old journal.

![Two panels: after the journal is rebuilt its sequence numbers restart at 1, but the device still holds a cursor at 912 from the old journal, so asking for entries newer than 912 returns nothing and the device silently never syncs again; with an epoch stamped on the journal, a device that sees a new epoch resets its cursor to zero and replays every entry.](/images/blog/rampset-cursor-epoch.svg)

The journal now carries an epoch number, and a device that sees a new one replays from zero.

Last, identity (#20). The identity check was on `cloudBackup` and `syncNow`, but `finishFlow` called `flushOutbox` directly, so finishing a workout as the other lifter on a shared phone posted it to the signed-in lifter's journal, got a valid acknowledgement, and emptied the outbox. In an append-only log that is permanent. The fix moved the check to the one door every write passes through, and #21 stopped an unreliable `/api/me` call (a two-second timeout that a cold mobile network blows routinely) from being read as "no identity, allow everything": the app now remembers the last identity it actually resolved and falls back to that.

Those four failure modes are what got extracted as [durable-sync](/durable-sync/):

- a successful-looking response is not evidence that the write landed;
- a cursor only means something against the epoch it came from;
- pulling remote changes is not always safe;
- the identity check must be the only door.

Rampset now uses the package; its own 329-line copy of the journal was deleted (#22), and the class name and SQL schema were kept identical so the live Durable Object carried over without a migration.

## Tests

```
 Test Files  34 passed (34)
      Tests  256 passed (256)
   Duration  5.22s
```

The engines are pure functions in `src/lib/` and each has a test file beside it: progression, deloads, Madcow, plates, estimated one-rep max (one case pins five reps at 115 kg to an estimate of 133.3 kg, a value taken from the real export), the sync journal, backup round-trips, and the `Sheet` component whose browser-history handling was the root cause of a finish-flow bug in #11 (`router.replace` overwrote the history entry the sheet had pushed, so consuming it on close walked the user back into a fresh workout). The count was 240 at the initial release and has moved with the incident fixes and the importer deletion; 256 is what runs today.

## Run your own

```bash
git clone https://github.com/isaacrowntree/rampset
cd rampset
npm install
cp .env.example .env.local     # your lifters, units, starting weights
npm run dev                    # → http://localhost:3000
npm test                       # vitest — the engines, store, sync, components
```

`npm run deploy` builds with the OpenNext adapter (which packages a Next.js app for Cloudflare) and ships to Cloudflare Workers; `wrangler.jsonc` declares the `SYNC_JOURNAL` Durable Object (a `new_sqlite_classes` migration) and the `BACKUPS` R2 bucket. Put a Cloudflare Access application in front of the Worker and allow your lifters' emails. Workers and Access are free for a household. The one paid gate is **R2**: the data sits well inside the 10 GB free tier, but Cloudflare wants a card on file to enable it. Without it, drop the `BACKUPS` binding; the app works fully offline on the local IndexedDB store, and the **Export** button in Settings hands you a complete CSV whenever you want.

## What I would tell the subscription app

The migration cost me a Saturday and the incident cost me a week, and the week was the useful part. Every bug in it returned a 200. A loyal customer with an export file is no longer locked in by anything, and with a coding agent in the loop "I'll build it myself" is a weekend, not a threat. The two proven programs, the plate math and the sync are all in a public repo under a licence that says make it yours. Take it somewhere no subscription can reach you.
