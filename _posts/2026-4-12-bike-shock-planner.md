---
layout: post
title: "bike-shock-planner — test-driven MTB shock fitment modelling"
description: "A TypeScript framework for modelling rear-shock fitment, coil conversions, ebike spring rates, and global parts sourcing for any mountain bike — starting with a 2013 Trek Fuel EX 5."
excerpt: "A TypeScript framework for modelling rear-shock fitment, coil conversions, ebike spring rates, and global parts sourcing for any mountain bike — tests, recipes, and real catalog data."
image: /images/blog/bike-shock-planner.jpg
image_alt: Mountain biker riding a trail through a lush green forest
date: 2026-04-12
last_modified_at: 2026-04-12
categories: [open-source]
tags: [typescript, bikes, mtb, suspension, testing, open-source]
---

Zack Design has published [`bike-shock-planner`](https://github.com/isaacrowntree/bike-shock-planner) — a **test-driven, code-as-data** planner for mountain bike rear shock replacements, coil conversions, and ebike suspension builds. It began as "can I fit a coil shock to a 2013 Trek Fuel EX 5 ebike conversion?" and grew into a reusable framework that models rear suspension geometry, shock fitment, spring rates, frame clearance, conversion hardware, and global sourcing paths for *any* bike.

<!-- more -->

## It is not a bike-specific script

The 2013 Fuel EX 5 is the first "recipe" — a self-contained config describing one bike, one rider, and a set of candidate parts. Everything is written so you can drop in a new recipe for your own frame and the same fit-check and spring-rate logic runs against it. That is the whole point of the project: a single, testable model of rear-shock dimensions and fitment rules, with as many recipes layered on top as people are willing to contribute.

## Who it is for

- **DIY mechanics** restoring an old MTB frame and trying to work out whether a modern shock will bolt up.
- **Ebike converters** putting a mid-drive motor on a non-ebike frame and needing to recalculate spring rates for the extra mass and torque.
- **Frame hunters** cross-checking a secondhand frame's shock spec against catalog reality before buying.
- **Bike shops** who want a reusable, forkable model of rear-shock dimensions — the catalog is just TypeScript, extend it for whatever you stock and rerun the tests to lint your inventory against real frames.
- **Anyone** who has spent hours in a Trek fitment PDF trying to work out whether a shock advertised as "7.25×2.0 imperial" fits their old DRCV mount. (Spoiler: only via a conversion kit.)

## What it does

- **Bike model.** Eye-to-eye, stroke, mount styles, eyelet widths, bolt sizes, leverage ratio, progression, and the frame clearance envelope — all captured in code.
- **Shock catalog.** Aftermarket shocks modelled as code, with body dimensions, piggyback status, coil spring rate range, Australian sourcing notes, and verified product URLs.
- **Fit check.** Frame slot × candidate shock returns each dimensional mismatch separately — eye-to-eye, stroke, upper/lower eyelet width, bolt sizes, mount styles, body length, body diameter, reservoir clearance. No yes/no black boxes.
- **Conversion kits.** Kits that rewrite a shock's mounting hardware are modelled as functions that transform a candidate. So you can ask "does this imperial shock fit if I use the Shockcraft Deaktiv kit?" and get a real answer.
- **Spring-rate calculator.** A *practical* formula that accounts for rear weight distribution — not the theoretical Fox "quick formula" that overshoots real-world spring picks by 40%.
- **Ebike load correction.** Weights 40% of battery + motor mass onto the rear shock and adds a high-torque correction for ≥100 Nm motors.
- **Progression flag.** Warns when a frame's linkage does not really want a coil — e.g. Trek's Full Floater is only ~13% progressive and is tuned for a DRCV air spring, so a linear coil will bottom harshly.
- **Documented-build flag.** If no published build exists for the exact frame generation, every candidate gets an *experimental* warning.
- **Research library.** Verified references to conversion kits, manufacturer product pages, global retailers, used-market venues, forum threads, and vendor email contacts — with tests enforcing that every link is HTTPS and every group is populated.
- **Pivot hardware model.** OEM bearing/bolt spec plus a four-step health check so you can decide whether a full frame rebuild is required alongside the shock swap.

## Status today

Primarily a **2013 Trek Fuel EX 5** model. The coil catalog includes Push ElevenSix (the only currently-buildable imperial 7.25×2.0 coil in April 2026), plus Marzocchi Bomber CR, Fox DHX2, DVO Jade X, MRP Hazzard Coil, and Cane Creek DB Coil IL entries marked used-market-only. The air catalog includes Fox Float X2, RockShox Super Deluxe Ultimate, and Marzocchi Bomber Air. Real VALT Progressive sizes are captured with the 45 mm stroke that fits inside a 50 mm shock; Sprindex 55 mm is flagged as not-fitting. The conversion kit catalog covers Offset Bushings, Shockcraft Deaktiv, an unpublished custom-machine path for Huber Bushings, plus a speculative metric-to-Trek kit flagged `publishedSku: false` so the test suite warns on it.

## Why code-as-data

Because every existing shock "compatibility chart" is a PDF, and PDFs cannot be run against a test suite. If you model the data in TypeScript, the test suite can assert things like "no reservoir clash on any frame in the catalog", "every link in the research library is reachable", and "every catalog entry has a spring rate range if it is a coil". That turns a messy research task into something a contributor can submit a pull request against. Source on [GitHub](https://github.com/isaacrowntree/bike-shock-planner).
