---
layout: post
title: "Rampset — I got fired as a customer, so I built the gym app myself and open-sourced it"
description: "An open-source, offline-first barbell training PWA — guided 5×5 and Madcow programs, freeform routines, per-user Durable Object sync, R2 snapshots — born the day my eleven-year StrongLifts subscription was cancelled without me asking. MIT licensed, self-host it in about ten minutes."
excerpt: "Eleven years and 1,221 workouts of loyalty ended with my grandfathered plan cancelled without my consent and a 6× price to come back. So I built my own — offline-first, three ways to train, self-hosted on Cloudflare. It's MIT open source: run your own copy."
image: /images/blog/rampset.jpg
image_alt: A loaded barbell resting on the floor of a dark gym
date: 2026-07-06
last_modified_at: 2026-07-06
categories: [open-source, product]
tags: [nextjs, react, pwa, cloudflare, durable-objects, typescript, tdd, fitness, open-source, claude-code]
---

Zack Design has published **[Rampset](https://github.com/isaacrowntree/rampset)** — an open-source, offline-first strength-training PWA that replaces the app I logged eleven years of workouts in. It runs three different training styles on one engine, works in a gym with zero signal, optionally syncs between devices through a per-user Durable Object, and snapshots every workout to R2. It's **MIT licensed** and built to self-host: your lifters, your data, your Cloudflare account, up in about ten minutes.

<!-- more -->

**Site & guide → [isaacrowntree.github.io/rampset](https://isaacrowntree.github.io/rampset)** · **Source → [github.com/isaacrowntree/rampset](https://github.com/isaacrowntree/rampset)** (MIT)

## Why this exists

I was a StrongLifts user from **2015 to 2026** — 1,221 logged workouts, a grandfathered subscription I'd held since 2018, and honestly no complaints for over a decade. It did the one thing a 5×5 app has to do: tell me what to lift today and remember what I lifted yesterday.

Then a sign-in bug locked me out of my own subscription. I did the support dance — reinstalled the app, removed and re-added every Google account on the phone, followed every step of every linked help article, sent screenshots. After a morning of back-and-forth, support resolved it their way: **they cancelled my subscription.** I hadn't asked for that. The legacy plan I'd been quietly grandfathered on for years ceased to exist the moment it was cancelled, and the only path back was the shiny new trial at roughly six times my old price.

Well — screw that. I write software for a living, my workout history exports to CSV, and it's 2026: with Claude Code in the loop, "I'll just build it myself" is no longer a threat you mutter into an email draft and delete. It's a Saturday.

## Three ways to train

The interesting design constraint wasn't me — it was that my wife trains too, and her program is nothing like mine. That forced a better architecture than a clone would have had, and it's why Rampset ships with three shapes on one engine:

- **Program mode** — classic StrongLifts-style **5×5**, A/B, with variants from Lite to Ultra Max. The app prescribes: tap a plate-shaped circle to log a set, warm-ups ramp with per-side plate math, +2.5 kg linear progression, graduated deloads after time off, and the full stall protocol (5×5 → 3×5 → 1×5).
- **Madcow mode** — weekly ramped 5×5: heavy / light / intensity days, back-off sets, and a Friday PR set that sets next week's top weight.
- **Routine mode** — a Strong-style layout: exercise cards with set rows (previous · kg · reps · ✓), everything prefilled from the last session, per-exercise rest timers, timed and bodyweight sets. You prescribe; the app remembers.

Same schema, same logging engine, same charts — the mode is just a flag on the program. Both of our full histories came in through CSV importers for the two incumbent apps' export formats, auto-detected and idempotent, verified against the real files. And export gives it all back whenever you want — no lock-in is the whole point.

<img src="/images/blog/rampset-app.png" alt="Rampset home screen: dark OLED UI showing the next 5×5 workouts with working weights and a Start workout button" style="max-width: 320px; width: 100%; display: block; margin: 1.5rem auto; border-radius: 24px;" />

## The parts I'm fond of

- **Offline-first for real.** Gyms are Faraday cages. IndexedDB is the source of truth on-device; the service worker keeps the shell alive; a screen wake-lock holds the display on mid-workout; and a rest timer keeps counting on a wall-clock deadline even when the phone locks, then rings a WebAudio bell it synthesises itself. No signal just means sync happens later.
- **Sync without a database server.** Each person gets their own SQLite-backed Durable Object — a single-threaded, per-user journal that makes write ordering a non-problem instead of a distributed-systems problem. Finished workouts push as idempotent ops; fresh devices pull. R2 holds dated snapshots underneath as the disaster layer.
- **No auth code, no personal data in the repo.** Identity is handled entirely by **Cloudflare Access** (a free zero-trust login) — the app itself contains zero auth code. Lifters are defined by an env var that's gitignored; the committed code carries only generic program templates. Nothing about you or your training lives in the source.
- **TDD the whole way.** 240 tests: the progression engine, both CSV dialects, the sync journal, backup round-trips, even "a rest timer survives navigating away mid-countdown." The engines are pure functions in `src/lib/`, each with a failing-test-first workflow waiting — because editing them is the point.
- **It feels like an app.** OLED-black UI, floating dock, haptic ticks on set logging, sheets that close with the Android back gesture, splash screens, home-screen shortcuts. The bar for "doesn't feel like a website" is a hundred small details, and a multi-agent review fleet is very good at finding all hundred.

## Run your own

Rampset is built to be yours. Clone it, point it at your lifters, and either use it locally or deploy your own copy to Cloudflare:

```bash
git clone https://github.com/isaacrowntree/rampset
cd rampset
npm install
cp .env.example .env.local     # your lifters, units, starting weights
npm run dev                    # → http://localhost:3000
npm test                       # the engines, importers, store, components
```

To put it online, `npm run deploy` ships it to Cloudflare Workers via the OpenNext adapter; then you add a **Cloudflare Access** application in front of your Worker and allow your lifters' emails. Workers and Access are free for a household. The one paid gate is **R2** for cloud backups — the data sits inside R2's 10 GB free tier, but Cloudflare wants a card on file to enable it. Don't want to add one? Drop the `BACKUPS` binding: the app is fully offline-first on local IndexedDB, and **Settings → Export** hands you a complete CSV backup whenever you want.

## The lesson

There's a quiet lesson in this for anyone running a subscription product: your most loyal decade-long customers aren't locked in by your data-export button being hard to find anymore. They're one bad support interaction away from an export file, a coding agent, and a very productive Saturday afternoon.

And here's the part that should really keep you up at night. This time they don't even have to build it. The export importers, the two proven programs, the offline sync, the plate math — it's all sitting in a public repo under a licence that says *make it yours*. Take it to the gym. Take it somewhere no subscription can reach you.
