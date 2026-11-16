---
layout: post
title: "bike-part-planner — test-driven MTB part fitment modelling"
description: "A zero-dependency TypeScript engine that answers 'will this part fit my bike?' with a list of reasons instead of a yes or no. It started as one rear-shock question on a 2013 Trek Fuel EX 5, whose honest answer turned out to be 'nobody has done this', and grew to 27 fitment checkers and a spring-rate model that explains why the textbook formula overshoots."
excerpt: "The question was 'can I fit a coil shock to a 2013 Trek Fuel EX 5 ebike conversion?'. The answer the model produces is that a 184 mm by 50 mm imperial pin-mount shock is not a size any brand still makes, zero completed coil builds are documented on the frame, and the one buildable option is made to order. Modelling that in code, with tests, is why the project exists."
image: /images/blog/bike-part-planner.jpg
image_alt: Mountain biker riding a trail through a lush green forest
date: 2026-04-12
last_modified_at: 2026-11-16
categories: [open-source]
tags: [typescript, bikes, mtb, suspension, testing, open-source]
redirect_from:
  - /bike-shock-planner/
---

Zack Design's **[bike-part-planner](https://github.com/isaacrowntree/bike-part-planner)** is a **test-driven** engine for the question every mountain biker searches before spending money: will this part actually fit my bike? Every compatibility fact is code rather than a chart, and the answer is a **list of reasons** rather than a yes or no. The framework has 27 `check*` functions and **no runtime dependencies**. **MIT licensed.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/isaacrowntree/bike-part-planner" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
</div>

This post covers:

- the fit checker that returns eleven separate mismatch reasons rather than a yes or no;
- the conversion kit modelled as a function that rewrites a shock's mounting hardware;
- why the spring-rate calculator carries a term for how much of the rider's weight sits on the rear wheel, and the assumption that 45% of an ebike's added mass rides there;
- why the frame does not want a coil, and the two tests that pin what forum research found;
- the pivots, how one shock question grew into 27 checkers, how to run it, and why the data is code.

<!-- more -->

## Why it exists

It began as one question: "can I fit a coil shock to a 2013 Trek Fuel EX 5 that I've converted to an ebike with a Bafang BBS02 motor?" Hence the original `bike-shock-planner` name. The model's answer was not one I wanted.

- The frame takes a shock 184 mm long with 50 mm of stroke, in the older imperial pin-mount fitting. No mainstream brand still makes that size.
- Exactly one new coil shock exists in it: the Push ElevenSix, built to order.
- There are zero documented coil builds online on the 2013 to 2016 frame with Trek's DRCV Full Floater suspension.

The rear-shock core was written in one day, 12 April 2026. That day included two corrections to its own facts.

## Verdicts, not yes or no

Every existing shock compatibility chart is a PDF, and a PDF can't be run against a test suite. `checkShockFit` in `src/shock.ts` takes a frame's shock mount and a candidate shock. It returns every dimensional mismatch separately:

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

`fits` allows those tolerances. `dropIn` is stricter: it demands exact equality on all six mounting dimensions.

The stroke tolerance was 0.5 mm on the first commit. It widened to plus or minus 1 mm the same afternoon, when I re-measured the stock shock's stroke from the label on its body as 50.8 mm. The stock shock itself was corrected from a Monarch RL to a Monarch RT3 in the fifth commit. Both fixes are in the log, because the data is code and the code is versioned. A chart would just have been wrong.

Every module added since uses a simpler shared shape from `src/fit.ts`. Each `Reason` has a severity of `"block"`, `"warn"` or `"ok"`, and `resolve()` sets `fits` to true when no block remains. The README example says `"pass"`, because the helper is named `pass`, but it emits `"ok"`. The code is right; the README is not.

## A conversion kit is a function

Trek sells no coil conversion for this frame. The realistic path is a 184 mm by 50 mm imperial shock plus replacement upper reducers. Reducers are the bushings that adapt the shock's eyelet to the frame; these need a 10 mm bolt hole and a width of 39.89 mm.

So a kit in `src/conversion.ts` is data describing the hardware it supplies. Applying it is a pure transform of the candidate shock:

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

`recommendCoilConversion` fit-checks each catalog shock as it comes. If it fails, it tries each kit in turn until one makes it fit. Four kits are modelled:

- **Offset Bushings** and **Shockcraft's "Deaktiv"**: real products with part numbers. Both are advertised for air shocks, and neither is documented for coil.
- **Huber Bushings**: a custom-machined path.
- **A `SPECULATIVE` kit** whose description begins "NOT A PUBLISHED PRODUCT".

That last one has `publishedSku: false` and `documentedForCoil: false`. Both flags produce warnings in the recommendation rather than being hidden. The catalog can reason about a path that doesn't exist yet without pretending it does.

## The spring rate the quick calculators get wrong

A coil spring's rate is the force it takes to compress it by one inch, in pounds per inch. `src/springRate.ts` computes both the textbook rate and a practical one:

```ts
const quickLbIn = (riderLb * leverage) / (strokeIn * sag);
const practicalLbIn = (riderLb * rearShare * leverage) / (strokeIn * sag);
```

The difference is `rearShare`, which defaults to 0.58. The comment on that field is the finding. The share of the rider's weight on the rear wheel "is the factor most quick calculators omit, and it is the reason the textbook formula overshoots real-world spring choices by ~40%".

That 40% is asserted in a comment, not pinned by a test. What is pinned is the result. `test/ebike.test.ts` asserts that the practical rate for my 96 kg build lands between 580 and 680 pounds per inch. `snapToAvailableSpring` then rounds to the 25-pound-per-inch steps springs are actually sold in.

On an ebike, the added mass doesn't sit where the rider sits. So one rear-share multiplier on the total weight is wrong. `src/rider.ts` computes the rear-wheel load directly:

```ts
const RIDER_REAR_SHARE = 0.58;
const EBIKE_REAR_SHARE = 0.45;
const HIGH_TORQUE_BUMP_KG = 3;
const HIGH_TORQUE_THRESHOLD_NM = 100;
```

A motor at the bottom bracket (the crank axle) puts about half its weight on the rear wheel. A battery on the down tube puts about 35% there. So the ebike's added mass is counted at 45%.

A motor rated at 100 newton-metres or more adds 3 kg on top. That accounts for the torque spikes a mid-drive puts through the rear suspension on climbs. The Bafang BBS02 in the recipe is 4.1 kg of motor, 4.8 kg of battery, 0.6 kg of wiring and fittings, and 120 newton-metres.

## The frame does not want a coil

`FUEL_EX_5_2013` in `src/bike.ts` carries `progression: 1.13`. That means the suspension gets only 13% firmer as it moves through its travel. Trek tuned the Full Floater linkage around a DRCV air shock. A coil spring is linear, and on a linkage this flat it bottoms out harshly. Any bike with a progression below 1.2 gets a note recommending a progressive spring.

Then the spring catalog has its own trap, verified live in April 2026. The Cane Creek VALT Progressive is made in 45, 55 and 65 mm strokes, not 50. The figure shows what that means for a shock with 50 mm of stroke.

![Two panels of a shock with 50 millimetres of stroke drawn as a bar between two retainers: a 45 millimetre spring fits with 5 millimetres to spare at full extension, where the shock carries no load; a 55 millimetre spring is longer than the space between the retainers and would overrun them.](/images/blog/bike-part-planner-spring-stroke.svg)

The model records the 45 mm VALT as `fits50mmShock: true` and the 55 mm Sprindex as `false`. So the recommendation can't suggest a spring that binds.

## What the forum research found, as tests

`test/forum-reality.test.ts` exists because the answer was uncomfortable, and I wanted it to stay written down. Nobody has documented a completed coil conversion on this generation of the frame. `documentedCoilBuildsOnFrame: 0` on the bike record triggers a warning on every candidate:

> EXPERIMENTAL: zero completed coil builds are documented on the 2013-2016 Fuel EX DRCV Full Floater frame. Every 'Fuel EX coil' build online is either pre-2010 (standard 12.7mm bushings) or Gen 5 2020+ (metric trunnion) — NOT this frame. You would be the first publicly-documented builder.

The model surfaces a pragmatic path instead, from the air-shock catalog. The Fox Float CTD DRCV and RockShox Monarch RT3 come in 184 mm long with 44 mm of stroke. They were fitted as standard to thousands of 2010 to 2014 Fuel EX and Remedy bikes, so they are cheap and everywhere.

A shorter stroke is mechanically safe; the frame just loses travel, and 130 mm becomes about 113 mm. So it sits behind an explicit `allowShorterStroke` opt-in, and the fit result states the reduction.

The research library in `src/references.ts` is data too, and `test/references.test.ts` enforces it:

- every link is HTTPS and marked verified, and every summary is longer than ten characters;
- no URL is duplicated across groups;
- retailer links include Australian, New Zealand, German and UK shops;
- every kit that is a real product has a `productUrl`.

## Before the shock: the pivots

`src/pivots.ts` holds the bearing sizes, Trek part numbers and bolt torques from the 2013 Fuel EX service manual, a PDF checked into `docs/`. It also encodes a four-step health check, each step with a sign that it failed:

1. Remove the shock.
2. Swing the rear triangle by hand.
3. Push the wheel sideways.
4. Bounce on the pedals.

The threshold depends on whether the bike is an ebike:

```ts
export const shouldRebuildPivots = (failedSteps: number, ebike: boolean): boolean => {
  if (ebike) return failedSteps >= 1;
  return failedSteps >= 2;
};
```

On a thirteen-year-old frame about to carry a mid-drive, one failed step is enough.

## From one shock to 27 checkers

Commit `329b17e` renamed the project and added fork, motor and battery fitment in the same change. Since then it has gained checks for:

- **Drivetrain:** bottom bracket and chainline, cassette, chain, chainring, rear and front derailleurs, shifter.
- **Brakes:** rotor, pads, hose. The rotor check knows that SRAM rotors come in 200 and 220 mm while Shimano's come in 203 and 223 mm.
- **Wheels:** wheel, tyre, tubeless setup, and mixed wheel sizes ("mullet" geometry).
- **Contact points:** dropper post, headset, handlebar and stem, saddle, pedals.
- **Ebike:** mid-drive and hub motors, batteries with a range estimate, legality by region, and how suitable a frame is for conversion.

There is also a spoke-length calculator, which computes a length rather than a verdict. Each checker is `src/<part>.ts` exporting `check<Part>Fit(frame, part): Fitment`, with a test beside it. That is the documented contract for contributing a new one.

Two refactors came from real bugs. The copies of each standard drifted between modules: the 92 mm press-fit bottom bracket shell was `"bb92"` in one file and `"pf92"` in another. Now they live once, in `src/standards.ts`. And `src/measure.ts` lists what to measure on your frame and how. Its `feeds` field says which checkers a measurement feeds. It became an exact-match list after a substring match let "chain" feed "chainring".

`test/accuracy-audit.test.ts` came later too. It pins the real-world standards and the exact points where a result flips from pass to warn to block, so an edit can't quietly move a threshold.

One honest gap: `src/fork.test.ts` was added alongside a fix, in the wrong directory. `vitest.config.ts` only includes `test/**`, so its assertions never run; only `test/fork.test.ts` does.

## Trying it

The project now uses Bun as its package manager. Node still runs vitest, `tsc` and `tsx`.

```bash
git clone https://github.com/isaacrowntree/bike-part-planner && cd bike-part-planner
bun install
bun run test              # the full suite; the test names read as a spec
bun run typecheck
bunx tsx src/cli.ts       # the coil-conversion report for my 96 kg ebike build
bunx tsx src/cli.ts 80 0.3   # the same report for an 80 kg rider at 30% sag
```

## Why the data is code

Once the compatibility data is TypeScript, claims become assertions. "No shock reservoir hits the frame on any bike in the catalog", "every coil has a rate range" and "this kit doesn't exist" are tests a contributor can send a pull request against. The two corrections I made to my own facts on day one are in the history, not silently overwritten.

The original recipe, `recipes/fuel-ex-5-2013-ebike/recipe.ts`, is one bike, one rider and a set of candidate parts. Fork it for your frame. Source on [GitHub](https://github.com/isaacrowntree/bike-part-planner), MIT.
