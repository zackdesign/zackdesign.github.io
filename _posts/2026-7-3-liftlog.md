---
layout: post
title: "LiftLog — I got fired as a customer, so I built the gym app myself"
description: "An offline-first training PWA with two workout modes, per-user Durable Object sync, R2 snapshots, and a Liquid Glass UI — born the day my eleven-year StrongLifts subscription was cancelled without me asking."
excerpt: "Eleven years and 1,221 workouts of loyalty ended with my grandfathered plan cancelled without my consent and a 6× price to come back. So I built my own — offline-first, two training modes, synced through Cloudflare."
image: /images/blog/liftlog.jpg
image_alt: A loaded barbell resting on the floor of a dark gym
date: 2026-07-03
last_modified_at: 2026-07-03
categories: [product]
tags: [nextjs, react, pwa, cloudflare, durable-objects, typescript, tdd, fitness, claude-code]
---

Zack Design has been building **LiftLog** — an offline-first strength-training PWA that replaces the app I logged eleven years of workouts in. It runs two completely different training styles on one engine, works in a gym with zero signal, syncs between devices through a per-user Durable Object, and snapshots every workout to R2. It's in closed beta (current user count: my household), so no link this time — this post is about why it exists and what's in it.

<!-- more -->

## Why this exists

I was a StrongLifts user from **2015 to 2026** — 1,221 logged workouts, a grandfathered subscription I'd held since 2018, and honestly no complaints for over a decade. It did the one thing a 5×5 app has to do: tell me what to lift today and remember what I lifted yesterday.

Then a sign-in bug locked me out of my own subscription. I did the support dance — reinstalled the app, removed and re-added every Google account on the phone, followed every step of every linked help article, sent screenshots. After a morning of back-and-forth, support resolved it their way: **they cancelled my subscription**. I hadn't asked for that. The legacy plan I'd been quietly grandfathered on for years ceased to exist the moment it was cancelled, and the only path back was the shiny new trial at roughly six times my old price.

Well — screw that. I write software for a living, my workout history exports to CSV, and it's 2026: with Claude Code in the loop, "I'll just build it myself" is no longer a threat you mutter in an email draft and delete. It's four hours on a Saturday.

## What it is

The interesting design constraint wasn't me — it was that my wife trains too, and her program is nothing like mine. That forced a better architecture than a clone would have had:

- **Program mode** (me): classic 5×5 A/B. The app prescribes — tap a plate-shaped circle to log a set, warmup ramps with per-side plate math, +2.5 kg linear progression, graduated deloads after time off, and the full stall protocol (5×5 → 3×5 → 1×5).
- **Routine mode** (her): a Strong-style layout — exercise cards with set rows (previous · kg · reps · ✓), everything prefilled from her last session, per-exercise rest timers, timed and bodyweight sets. She prescribes; the app remembers.

Same schema, same logging engine, same charts — the mode is just a flag on the program. Both of our full histories came in through CSV importers for the two incumbent apps' export formats, verified against the real files (all 1,221-plus workouts of mine, every set of hers).

<img src="/images/blog/liftlog-app.png" alt="LiftLog home screen: dark glass UI showing the next 5×5 workouts with working weights and a Start workout button" style="max-width: 320px; width: 100%; display: block; margin: 1.5rem auto; border-radius: 24px;" />

## The parts I'm fond of

- **Offline-first for real.** Gyms are Faraday cages. IndexedDB is the source of truth on-device; the service worker keeps the shell alive; a rest timer keeps counting on a wall-clock deadline even when the phone locks, then rings a WebAudio bell it synthesises itself. No signal just means sync happens later.
- **Sync without a database server.** Each person gets their own SQLite-backed Durable Object — a single-threaded, per-user journal that makes write ordering a non-problem instead of a distributed-systems problem. Finished workouts push as idempotent ops; fresh devices pull. R2 holds dated snapshots underneath as the disaster layer, with identity handled entirely by Cloudflare Access — the app itself contains zero auth code and zero personal data; the household config lives in a Worker secret.
- **TDD the whole way.** 137 tests: the progression engine, both CSV dialects, the sync journal, backup round-trips, even "a rest timer survives navigating away mid-countdown." Two multi-agent review passes (35 correctness findings, then a native-feel audit) each turned into failing specs before fixes.
- **It feels like an app.** Liquid-glass UI over OLED black, floating dock, haptic ticks on set logging, sheets that close with the Android back gesture, splash screens, home-screen shortcuts. The bar for "doesn't feel like a website" is a hundred small details, and a review fleet is very good at finding all hundred.

## Status

Closed beta — two users, one gym, every workout since 2015 intact. It cost four hours on a Saturday, review passes included, and it does the only two things I ever paid for: tells us what to lift today, and never forgets what we lifted yesterday.

There's a quiet lesson in it for anyone running a subscription product: your most loyal decade-long customers aren't locked in by your data export button being hard to find anymore. They're one bad support interaction away from an export file, a coding agent, and a very productive Saturday afternoon.
