---
layout: post
title: "bike-part-planner — test-driven MTB part fitment modelling"
description: "A zero-dependency TypeScript engine that answers 'will this part fit my bike?' with a list of reasons instead of a yes or no. It started as one rear-shock question on a 2013 Trek Fuel EX 5, whose honest answer turned out to be 'nobody has done this', and grew to 28 fitment checkers, 252 tests, and a spring-rate model that explains why the textbook formula overshoots."
excerpt: "The question was 'can I fit a coil shock to a 2013 Trek Fuel EX 5 ebike conversion?'. The answer the model produces is that a 184 mm by 50 mm imperial pin-mount shock is not a size any brand still makes, zero completed coil builds are documented on the frame, and the one buildable option is made to order. Modelling that in code, with tests, is why the project exists."
image: /images/blog/bike-part-planner.jpg
image_alt: Mountain biker riding a trail through a lush green forest
date: 2026-04-12
last_modified_at: 2026-04-12
categories: [open-source]
tags: [typescript, bikes, mtb, suspension, testing, open-source]
redirect_from:
  - /bike-shock-planner/
---

Zack Design has published [`bike-part-planner`](https://github.com/isaacrowntree/bike-part-planner), a **test-driven** engine in which every compatibility fact is code rather than a chart, for the question every rider searches before spending money: will this part actually fit my bike? It began as one question, "can I fit a coil shock to a 2013 Trek Fuel EX 5 that I've converted to an ebike with a Bafang BBS02 motor?", hence the original `bike-shock-planner` name, and the model's answer was not one I wanted. The frame takes a shock 184 mm long with 50 mm of stroke in the older imperial pin-mount fitting, which is not a size any mainstream brand still makes; exactly one new coil shock (the Push ElevenSix, built to order) exists in it; and there are zero documented coil builds anywhere online on the 2013 to 2016 frame with Trek's DRCV Full Floater suspension design. The rear-shock core was written in one day, 12 April 2026, including two same-day corrections to its own facts. The framework it became has 28 `check*` functions, no runtime dependencies, and 252 tests that run in 1.21 seconds.

This post walks through the fit checker that returns eleven separate mismatch reasons rather than a yes or no, the conversion kit modelled as a function that rewrites a shock's mounting hardware, why the spring-rate calculator carries a term for how much of the rider's weight sits on the rear wheel that the textbook formula omits, the assumption that 45% of an ebike's added mass rides on the rear wheel, the catalog's honest `publishedSku: false` entries, and the two tests that pin what forum research found.

<!-- more -->

## Verdicts, not yes or no

Every existing shock compatibility chart is a PDF, and a PDF cannot be run against a test suite. `checkShockFit` in `src/shock.ts` takes a frame's shock mount and a candidate shock and returns every dimensional mismatch separately:

```ts
export interface FitReason {
  category:
    | "eye-to-eye" | "stroke"
    | "upper-eyelet-width" | "upper-hardware" | "upper-style"
    | "lower-eyelet-width" | "lower-hardware" | "lower-style"
    | "body-length" | "body-diameter" | "reservoir";
  ok: boolean;
  detail: string;
}
```

The tolerances are explicit constants:

| Dimension | Tolerance |
|---|---|
| Eye-to-eye length (mounting hole to mounting hole) | 0.5 mm |
| Stroke (how far the shock compresses) | 1.0 mm |
| Eyelet width | 0.25 mm |
| Bolt diameter | 0.1 mm |

`fits` allows those tolerances; `dropIn` is stricter and demands exact equality on all six mounting dimensions. The stroke tolerance was 0.5 mm on the first commit and widened to plus or minus 1 mm the same afternoon, when I re-measured the stock shock's stroke from the label on its body as 50.8 mm. The stock shock model itself was corrected from a Monarch RL to a Monarch RT3 in the fifth commit. Both fixes are in the log because the data is code and the code is versioned; a chart would have just been wrong.

Every module added since uses a simpler shared shape from `src/fit.ts`: a `Reason` with a severity of `"block"`, `"warn"` or `"ok"`, and `resolve()` sets `fits` to true when no block remains. (The README example says `"pass"`; the helper is named `pass` but emits `"ok"`. The code is right, the README is not.)

## A conversion kit is a function

Trek sells no coil conversion for this frame. The realistic path is a 184 mm by 50 mm imperial shock plus replacement upper reducer hardware (the bushings that adapt the shock's eyelet to the frame) with a 10 mm bolt hole and a width of 39.89 mm. So a kit in `src/conversion.ts` is data that describes the hardware it supplies, and applying it is a pure transform of the candidate shock:

```ts
export const applyConversionKit = (shock: ShockSpec, kit: ConversionKit): ShockSpec => ({
  ...shock,
  eyeToEyeMm: shock.eyeToEyeMm + (kit.eyeToEyeAdjustmentMm ?? 0),
  upperMount: { ...shock.upperMount,
    eyeletWidthMm: kit.providesUpperReducer.widthMm,
    hardwareBoltMm: kit.providesUpperReducer.idMm },
  lowerMount: { ...shock.lowerMount,
    eyeletWidthMm: kit.providesLowerReducer.widthMm,
    hardwareBoltMm: kit.providesLowerReducer.idMm },
});
```

`recommendCoilConversion` fit-checks each catalog shock as it comes, and if it fails, tries each kit in turn until one makes it fit. Four kits are modelled: Offset Bushings and Shockcraft's "Deaktiv" (real products with part numbers, both advertised for air shocks, neither documented for coil), a custom-machined path through Huber Bushings, and one labelled `SPECULATIVE` whose description begins "NOT A PUBLISHED PRODUCT". That last one has `publishedSku: false` and `documentedForCoil: false`, and both flags produce warnings in the recommendation rather than being hidden. The catalog can reason about a path that does not exist yet without pretending it does.

## The spring rate the quick calculators get wrong

A coil spring's rate is how much force it takes to compress it by one inch, in pounds per inch. `src/springRate.ts` computes both the textbook rate and a practical one:

```ts
const quickLbIn = (riderLb * leverage) / (strokeIn * sag);
const practicalLbIn = (riderLb * rearShare * leverage) / (strokeIn * sag);
```

The difference is `rearShare`, defaulting to 0.58. The comment on that field is the finding: the fraction of the rider's static weight on the rear wheel "is the factor most quick calculators omit, and it is the reason the textbook formula overshoots real-world spring choices by ~40%". That figure is asserted in a comment, not pinned by a test. What is pinned is the result: `test/ebike.test.ts` asserts the practical rate for my 96 kg build lands between 580 and 680 pounds per inch, and `snapToAvailableSpring` rounds to the 25-pound-per-inch steps springs are actually sold in.

On an ebike the added mass does not sit where the rider sits, so applying one rear-share multiplier to the total is wrong. `src/rider.ts` computes the rear-wheel load directly:

```ts
const RIDER_REAR_SHARE = 0.58;
const EBIKE_REAR_SHARE = 0.45;
const HIGH_TORQUE_BUMP_KG = 3;
const HIGH_TORQUE_THRESHOLD_NM = 100;
```

A motor at the bottom bracket (the crank axle) puts about half its weight on the rear wheel and a battery on the down tube about 35%, so the ebike's added mass is counted at 45%, and a motor rated at 100 newton-metres or more adds 3 kg to account for the torque spikes a mid-drive motor puts through the rear suspension on climbs. The Bafang BBS02 in the recipe is 4.1 kg of motor, 4.8 kg of battery, 0.6 kg of wiring and fittings, and 120 newton-metres.

## The frame does not want a coil

`FUEL_EX_5_2013` in `src/bike.ts` carries `progression: 1.13`, meaning the suspension gets only 13% firmer as it moves through its travel. Trek tuned the Full Floater linkage around a DRCV air shock, and a coil spring, which is linear, on a linkage that progressive bottoms out harshly. Any bike with a progression below 1.2 gets a note recommending a progressive spring. Then the spring catalog has its own trap, verified live in April 2026: the Cane Creek VALT Progressive is made in 45, 55 and 65 mm strokes, not 50, and the figure shows what that means for a shock with 50 mm of stroke.

![Two panels of a shock with 50 millimetres of stroke drawn as a bar between two retainers: a 45 millimetre spring fits with 5 millimetres to spare at full extension, where the shock carries no load; a 55 millimetre spring is longer than the space between the retainers and would overrun them.](/images/blog/bike-part-planner-spring-stroke.svg)

The model records the 45 mm VALT as `fits50mmShock: true` and the 55 mm Sprindex as `false`, so the recommendation cannot suggest a spring that binds.

## What the forum research found, as tests

`test/forum-reality.test.ts` exists because the answer was uncomfortable and I wanted it to stay written down: nobody has documented a completed coil conversion on this generation of the frame. `documentedCoilBuildsOnFrame: 0` on the bike record triggers the warning that every candidate carries:

> EXPERIMENTAL: zero completed coil builds are documented on the 2013-2016 Fuel EX DRCV Full Floater frame. Every 'Fuel EX coil' build online is either pre-2010 (standard 12.7mm bushings) or Gen 5 2020+ (metric trunnion) — NOT this frame. You would be the first publicly-documented builder.

The pragmatic path the model surfaces instead is in the air-shock catalog: the Fox Float CTD DRCV and RockShox Monarch RT3 at 184 mm long with 44 mm of stroke, fitted as standard to thousands of 2010 to 2014 Fuel EX and Remedy bikes, cheap and everywhere. A shorter stroke is mechanically safe, the frame just loses travel (130 mm becomes about 113 mm), so it sits behind an explicit `allowShorterStroke` opt-in and the fit result states the reduction.

The research library in `src/references.ts` is data too, and `test/references.test.ts` enforces it: every link is HTTPS, every summary is longer than ten characters, every entry is marked verified, no URL is duplicated across groups, retailer links span Australian, New Zealand, German and UK shops, and every kit that is a real product has a `productUrl`.

## Before the shock: the pivots

`src/pivots.ts` copies the bearing sizes, Trek part numbers and bolt torques from the 2013 Fuel EX service manual PDF checked into `docs/`, and encodes a four-step health check (remove the shock, swing the rear triangle by hand, push the wheel sideways, bounce on the pedals), each with a sign that it failed. The threshold depends on whether the bike is an ebike:

```ts
export const shouldRebuildPivots = (failedSteps: number, ebike: boolean): boolean => {
  if (ebike) return failedSteps >= 1;
  return failedSteps >= 2;
};
```

On a thirteen-year-old frame about to carry a mid-drive, one failed step is enough.

## From one shock to 28 checkers

Commit `329b17e` renamed the project and added fork, motor and battery fitment in the same change. Since then: bottom bracket and chainline, cassette, chain, chainring, derailleurs, shifter, brake rotor (including the trap that SRAM rotors come in 200 and 220 mm while Shimano's come in 203 and 223 mm), brake pads, brake hose, wheel, tyre, tubeless setup, spoke length, dropper post, headset, handlebar and stem, saddle, pedals, mixed wheel sizes ("mullet" geometry), ebike legality by region, and a rating of how suitable a frame is for conversion. Each is `src/<part>.ts` exporting `check<Part>Fit(frame, part): Fitment` with a test beside it, which is the documented contract for contributing a new one. A refactor into `src/standards.ts` came after the copies in each module drifted: the 92 mm press-fit bottom bracket shell was `"bb92"` in one file and `"pf92"` in another. `src/measure.ts` lists what to measure and how; its `feeds` field, which says which checkers a measurement feeds, became an exact-match list after a substring match let "chain" feed "chainring".

```
 Test Files  35 passed (35)
      Tests  252 passed (252)
   Duration  1.21s
```

One honest gap: `src/fork.test.ts` was added alongside a fix in the wrong directory, and `vitest.config.ts` only includes `test/**`, so its assertions never run. The `test/fork.test.ts` that does run has eight.

## Why the data is code

Because the moment the compatibility data is TypeScript, "no shock reservoir hits the frame on any bike in the catalog", "every coil has a rate range" and "this kit does not exist" become assertions a contributor can submit a pull request against, and the two corrections I made to my own facts on day one are in the history rather than silently overwritten. The original recipe, `recipes/fuel-ex-5-2013-ebike/recipe.ts`, is one bike, one rider and a set of candidate parts; fork it for your frame. Source on [GitHub](https://github.com/isaacrowntree/bike-part-planner), MIT.
