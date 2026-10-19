---
layout: post
title: "Rampset — a free, open-source barbell app that feels native on your iPhone"
description: "Rampset is an open-source strength-training app you install from the browser: StrongLifts-style five-by-five, Madcow and freeform routines on one engine, plate math for your gym's plates, a rest timer that survives the phone locking, and it works with no signal at all. Passkey sign-in, sync through a Durable Object per user, import from StrongLifts, end-to-end tested online, offline and on a flaky connection. MIT, self-host free on Cloudflare."
excerpt: "A barbell app built for the gym floor: it works with zero reception, looks and moves like an iPhone app, colours every set by the plate on the bar, and runs three training programs on one engine. Free, open source, and yours to host."
image: /images/blog/rampset.jpg
image_alt: A loaded barbell resting on the floor of a dark gym
date: 2026-07-06
last_modified_at: 2026-10-19
categories: [open-source, product]
tags: [nextjs, react, pwa, cloudflare, durable-objects, passkeys, webauthn, typescript, tdd, playwright, fitness, open-source, claude-code]
---

Zack Design's **[Rampset](https://liftlog.zackdesign.biz)** is a free, open-source strength-training app for barbell lifters. You install it from the browser like an app, no app store involved, and it behaves like one: an iPhone-native look and feel, gestures that do what your thumb expects, and everything working in a gym with no signal at all. It runs three styles of training on one engine, does the plate math for the plates your gym actually has, and keeps every workout on your phone first. You sign in with a passkey (Face ID or a fingerprint, no password), and your workouts sync between your devices. Bring your history with you from StrongLifts or Strong. **MIT licensed**, free to self-host.

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://liftlog.zackdesign.biz" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Start using Rampset</a>
  <a href="https://github.com/isaacrowntree/rampset" target="_blank" rel="noopener" class="btn btn-outline-primary btn-lg">Source on GitHub</a>
</div>

Open it on your phone, create an account with Face ID or your fingerprint, and choose **Add to Home Screen**. It's free.

This post covers what it is like to train with, the engine behind the programs, how it stays useful with zero reception, how accounts work without a login server, and how to run your own.

<!-- more -->

**Self-hosting guide:** [isaacrowntree.github.io/rampset](https://isaacrowntree.github.io/rampset)

<div style="display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; margin: 1.5rem auto;">
  <img src="/images/blog/rampset-app.png" alt="Rampset's home screen: the next workout, Workout A, with two looping lifters benching and squatting, its five exercises with sets and weights, and a Start Workout A button" width="1170" height="2532" style="max-width: 280px; width: 100%; height: auto; border-radius: 24px;" />
  <img src="/images/blog/rampset-workout.png" alt="A workout in progress: finished squat and bench sets filled red for the 25 kg plates on the bar, a short bench set shown as an outlined 4 of 5, finished rows filled blue for 20 kg plates, and the next set of each lift ringed" width="1170" height="2532" style="max-width: 280px; width: 100%; height: auto; border-radius: 24px;" />
</div>

## Built for the gym floor

Rampset is designed around the moment between sets: chalky hands, the phone on a bench, a glance from arm's length.

- **Every set wears the plate on the bar.** A finished set fills with the colour of the heaviest plate you're lifting, using the competition colours: red for 25 kg, blue for 20, yellow for 15, green for 10, white for 5, and plain steel when it's just the bar. A session reads the way a loaded bar does from across the room. How the set went is shown by shape, not colour: a full disc is a completed set, an outline with "4/5" is a set that fell short, and a dashed ring is a set with no reps. The next set to do has a ring around it, so you can find it at a glance.
- **One tap logs a set.** Tap a plate to log the full target; tap again to count down a rep. Logging a set starts the rest timer straight away.
- **A rest timer you can read from the bench.** It sits at the bottom where your thumb is, in big rounded digits, and glows green when the rest is over. It rings a bell, keeps counting if you lock the phone or switch apps, and suggests a longer rest after a missed set.
- **Plate math for your gym.** Each lift shows exactly which plates go on each side, drawn to scale on the bar, from 25 kg down to 1.25 kg. If your gym tops out at 20 kg plates, one switch in Settings changes all the maths and pictures to match.
- **Warm-ups in whole plates.** Warm-up sets climb to your working weight in loads you can make without a pile of change plates: steps of 10 kg, or 5 kg where a step would otherwise land on the one before it.
- **It moves like an iPhone app.** Apple's own dark palette and type, large titles that collapse as you scroll, sheets that spring and drag down to close, swipe back from the edge, and a workout screen you pull down to minimise, like the Music app's Now Playing screen. Finishing a workout plays a short celebration: plates drop onto a bar and the total weight you moved counts up. It respects Reduce Motion and Reduce Transparency.
- **Fix a past workout in place.** Tap any workout in History and it opens in the same workout screen, with the weights you actually lifted that day, so you can add a set you forgot or correct a rep count.

## Three ways to train, one engine

Every program has a mode, and the engine branches on it:

```ts
export type ProgramMode = "progression" | "routine" | "madcow";
```

**Program mode** is StrongLifts-style training: five sets of five, alternating two workouts, A and B, with the familiar variants (Plus, Lite, Mini, Ultra, Ultra Max). The progression engine in `src/lib/progression.ts` is a pure function of your history:

- A successful workout adds weight: 2.5 kg on the main lifts and 5 kg on the deadlift. Assistance lifts like dips and pull-ups are yours to progress by hand.
- A workout only counts as a success if every set it started with is done at full reps. A skipped set is a failed set, and lowering the set count partway through doesn't change that, because each workout is judged against the sets it began with.
- Three failed workouts in a row at the same weight bring the lift down 10%, rounded to a loadable weight.
- Repeated stalls step a lift from five sets of five to three sets of five, then to one set of five.
- Squat appears in both workouts, and it's one lift: progress on Monday carries to Wednesday.

Warm-ups follow the classic ramp:

| Warm-up set | Fraction of the working weight | Reps |
|---|---|---|
| 1 | one half | 5 |
| 2 | two thirds | 5 |
| 3 | five sixths | 3 |
| 4 | eleven twelfths | 2 |

Squat, bench and overhead press start with two sets on the empty bar, and every step is rounded to whole plates, so a 62.5 kg bench warms up at 20, 20, 30, 40, 50 and 60 kg.

**Madcow mode** is five sets of five ramped up over the week. `src/lib/madcow.ts` encodes the three days directly:

| Day | What it does |
|---|---|
| Heavy | four sets climbing through 50%, 62.5%, 75% and 87.5% of the top weight, then a top set of five |
| Light | the same ramp, stopping at 75% |
| Intensity | climbs to a personal-record set of three reps at the top weight plus one increment, then a back-off set of eight at 75% |

Hit the personal-record set and next week's top weight goes up.

**Routine mode** takes the layout of the Strong app: exercise cards with a row per set, everything prefilled from last time, a rest time per exercise, timed sets and bodyweight sets. You build it in the app: add, rename, reorder and delete days, and move exercises between them. You prescribe; the app remembers.

You pick one when you sign up, StrongLifts 5×5, Madcow or a custom routine, and can switch in Settings.

Time away from the gym is handled too. Come back after a break and the app offers to take the weights down, scaled to how long you were gone. This is `src/lib/deload.ts`, and it's the whole file:

```ts
export function deloadPctForLayoff(daysAway: number): number {
  if (daysAway >= 56) return 0.3;
  if (daysAway >= 28) return 0.2;
  if (daysAway >= 14) return 0.1;
  return 0;
}
```

## Your history, in and out

Your history is yours, at any time, from **Settings → Your data**:

- **Import** a StrongLifts or Strong export. The app works out which one it is from the file, and importing the same file twice doesn't double anything.
- **Download a backup** of everything, and **restore** it on any phone, into any account.
- **Export** every set as a CSV for a spreadsheet.

## No signal, no problem

Gyms are Faraday cages, so Rampset treats being offline as the normal state. Your workouts live in IndexedDB, the browser's on-device database (used through the Dexie library), and the network is an optimisation on top. The service worker caches the app, and gives up on the network fast instead of hanging:

```js
/** Gym dead zones don't fail fetches — they hang them. Anything
 * network-first must give up quickly and fall back to cache. */
const NETWORK_TIMEOUT_MS = 3000;
```

The rest timer is built for the phone in your pocket. `src/components/RestTimer.tsx` doesn't count down; it saves the moment the rest started and works out the elapsed time on every tick (`Math.floor((Date.now() - startTs) / 1000)`), so locking the phone, switching apps or even reloading can't lose it. When it rings, it rings with a bell the app synthesises from two sine tones, because an audio file is one more thing that could fail to load offline:

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

The screen stays awake while a workout is open.

## Sync without a database server

Each lifter gets their own Durable Object: a single-instance server object on Cloudflare with its own SQLite database, which puts that lifter's writes in order without a Postgres server anywhere. Finished workouts are pushed as operations keyed by workout id, so applying one twice changes nothing, and a new phone catches up by pulling. A dated snapshot of everything goes to R2, Cloudflare's file storage, and the latest-snapshot pointer is merged with a write that only succeeds if nobody else changed it first, so two devices backing up at once can't overwrite each other.

The sync layer is [durable-sync](/durable-sync/), an open-source library built around four rules:

- a response that looks successful isn't proof the write landed, so the app checks the body before clearing its queue of unsent workouts;
- a device's read position in the log only counts against the version of the log it came from;
- pulling in changes from another device isn't always safe, so sync is push-only while a workout is open;
- every write goes through a single identity check, so a phone never sends workouts under an account it isn't signed in as.

Corrections sync too. Fix a rep count in History on one phone and the other phone gets the fix; if two phones correct the same workout while both are offline, they agree on the later edit, and a deleted workout stays deleted.

## Accounts without a login server

Anyone can open Rampset and start. There's no password: your account is a **passkey**, the Face ID or fingerprint login your phone already keeps in sync across your devices. Add a recovery email and a lost phone is a six-digit code away from getting back in, and signs the old phone out when you do.

All of it lives in one more Durable Object: accounts, passkeys, sessions and codes in its SQLite, with no auth service or user database behind it. That's [durable-auth](/durable-auth/), the open-source library this part of Rampset became. Codes and session tokens are stored only as hashes, every challenge works once for one purpose, sign-in and email routes are rate limited per address, and deleting your account or changing its recovery email asks for Face ID if you haven't used it in the last few minutes. The emails go out through Cloudflare's own email sending, so there's no API key to manage either.

A phone holds one account. Signing out wipes it, and signing back in brings the history back from sync.

## Tested

The suite to trust is the end-to-end one: 23 journeys in Playwright, driving the real built Worker in Chromium with nothing mocked. Each simulated phone signs up with a passkey on Chrome's virtual authenticator, then trains 5×5, Madcow and a custom routine, corrects history, imports from StrongLifts, changes settings, recovers a lost phone by email and deletes its account. The core sync journey runs four times, **online, offline, on a flappy connection and on a slow one**, and checks that each workout reaches the second phone exactly once.

```
  23 passed (2.2m)
```

Under that, the account Durable Object runs against real workerd SQLite, and 379 unit and component tests cover the engines in `src/lib/`: progression and the skipped-set rules, layoff deloads, Madcow, plate math for gyms with and without 25 kg plates, warm-up rounding, the estimated one-rep max, and the importers.

## Run your own

```bash
git clone https://github.com/isaacrowntree/rampset
cd rampset
npm install
npm run dev                    # → localhost:3000, on-device only
npm run preview                # → localhost:8787, the real Worker: accounts and sync
npm run test:e2e               # the journeys above
```

`npm run deploy` builds with the OpenNext adapter (which packages a Next.js app for Cloudflare) and ships to Cloudflare Workers. `wrangler.jsonc` declares the `AUTH` and `SYNC_JOURNAL` Durable Objects and the `BACKUPS` R2 bucket; there's nothing to set up in the dashboard for sign-in. For recovery emails, onboard your domain to Cloudflare Email Sending and set `EMAIL_FROM`; it only adds records on a `cf-bounce` subdomain, so a domain already on Gmail keeps working. Workers and Durable Objects are free for a household. The one paid gate is **R2**: the data sits well inside the 10 GB free tier, but Cloudflare wants a card on file to enable it. Without it, drop the `BACKUPS` binding; sync still works, and **Download backup** in Settings gives you a complete file whenever you want.

Then open it on your phone, choose **Add to Home Screen**, and it's an app. Two proven programs, plate maths for your gym and sync you can trust, in a public repo under a licence that says make it yours.

Rampset is one of three open-source pieces that fit together: the app, its offline-first sync ([durable-sync](/durable-sync/)) and its passkey sign-in ([durable-auth](/durable-auth/)). Together they're a Cloudflare app with no database server, no auth vendor and no container.
