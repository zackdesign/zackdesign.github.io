---
layout: post
title: "deflicker-runner — killing LED PWM flicker in 4K video, in 400MB of RAM"
description: "A streaming temporal-median deflicker pipeline for 4K footage shot under LED lights — full-length video, tiny memory budget, multiple correction modes."
excerpt: "A streaming temporal-median deflicker pipeline for 4K footage shot under LED lights — full-length video, ~400MB RAM, and a handful of specialised modes for spot flicker and rolling-shutter artifacts."
image: /images/blog/deflicker-runner.jpg
image_alt: Close-up of an optical camera lens reflecting light
date: 2026-02-08
last_modified_at: 2026-02-08
categories: [open-source]
tags: [video, ffmpeg, python, deflicker, rolling-shutter, led-flicker, open-source]
---

Zack Design has published [`deflicker-runner`](https://github.com/isaacrowntree/deflicker-runner) — a Python pipeline for removing the subtle but maddening LED flicker that rolling-shutter cameras capture when shooting under overhead LED panels. It runs on arbitrarily long 4K footage in about 400 MB of RAM, which is the interesting part.

<!-- more -->

## The problem

LED panels do not emit light continuously. They pulse at 100 Hz (50 Hz mains, rectified to both halves). A rolling-shutter sensor at 59.94 fps captures a slightly different slice of that pulse train per frame — and the beat frequency between the two lands right around 20 Hz. The result is a ~2% whole-frame brightness oscillation, which is small enough to miss on set and loud enough to ruin the footage in post.

Two flavours show up in real shoots:

- **Whole-frame pulsing** on the broad surfaces that reflect the overhead LEDs — walls, ceilings, dark backgrounds.
- **Spot flicker** on small sources: filament bulbs, fairy lights, practicals that are themselves PWM-driven.

## The pipeline

`deflicker-runner` ships a handful of modes, each suited to a different failure:

| Approach | Best for | How it works |
|----------|----------|-------------|
| `temporal-median` | Whole-frame LED flicker | Per-pixel temporal median at 540p, upscaled back to 4K. Eliminates the 3-frame cycle entirely. |
| `spot-replace` | Small filament bulbs | Full-resolution detection of bright flickering spots, then per-box temporal median replacement. |
| `running-mean` | General purpose | Per-row running temporal mean baseline. Good balance of speed and quality. |
| `pixel-smooth` | Motion-preserving | Per-pixel BCC-style weighted average that respects motion. |
| `fft-notch` | Precise frequency removal | FFT notch at the exact LED beat frequency (~19.88 Hz). Subtle ~2% correction. |
| `physical-model` | Physics-based | Fits the LED waveform and rolling-shutter timing model. Most theoretically correct. |
| `global-row` | Global brightness variation | Two-stage: global normalisation plus per-row residual. |

For most footage, `auto` picks the right mode for you. `temporal-median` is the default recommendation.

## The memory trick

A 4K frame is 8 MB raw. Naively running temporal median on a full-length clip means holding hundreds of frames in RAM at once. The runner sidesteps that by:

1. Downscaling to 540p before the median stage (4× fewer pixels in each dimension, 16× less memory).
2. Running median over a small rolling window — 5 to 11 frames depending on mode.
3. Upscaling the *correction delta* (not the frame itself) back to 4K and applying it to the original-resolution pixel stream.

The result is a deflicker pass that runs happily on a laptop, not a workstation, and handles a full talk recording without ever buffering the whole thing into RAM.

## Why ship it

LED flicker is one of those problems that is unsolvable in a single `ffmpeg` filter — none of the stock filters know about the beat frequency, and none of them can route different correction strategies at different scales. A small, focused Python tool makes the tradeoffs explicit and gives a colourist or editor an honest knob to turn. Source on [GitHub](https://github.com/isaacrowntree/deflicker-runner).
