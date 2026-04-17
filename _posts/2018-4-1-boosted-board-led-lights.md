---
layout: post
title: "Boosted Board LED brake lights — Arduino, accelerometer, Cylon sweep"
description: "An Arduino Uno + 3-axis accelerometer + WS2812B LED strip project that turns a Boosted board into a rolling brake-and-indicator light rig."
excerpt: "An Arduino + accelerometer + WS2812B strip turning a Boosted board into a Cylon-style rolling light rig — with a brake light that actually reacts to deceleration."
image: /images/blog/boosted-board-led-lights.jpg
image_alt: Skater riding a longboard on an asphalt ramp in golden light
date: 2018-04-01
last_modified_at: 2018-04-01
categories: [engineering]
tags: [arduino, hardware, led, fastled, electric-skateboard, hobby-project]
---

Every engineer needs a ridiculous weekend project, and this one is mine: strapping an Arduino Uno, a 3-axis accelerometer, and a metre of addressable RGB LEDs to the underside of a [Boosted electric skateboard](https://en.wikipedia.org/wiki/Boosted_(company)) to make a rolling Cylon-style light strip — with a brake light that actually responds to deceleration. Source on [GitHub](https://github.com/isaacrowntree/boosted-board-led-lights).

<!-- more -->

## The idea

Electric skateboards are fast, quiet, and nearly invisible at dusk. A bright LED underglow solves the "can car drivers see me" problem; a reactive red brake light solves the harder one — *can the person behind me tell I'm slowing down?* The accelerometer reads longitudinal deceleration, and when it crosses a threshold the rear LEDs flash hard red. Under acceleration and steady cruise, a Cylon-style sweep runs down the full strip using the excellent [FastLED](https://fastled.io/) library.

## Parts list

- Arduino Uno
- ±3g 3-axis accelerometer
- 1 metre of 30 LED WS2812B digital RGB strip
- 1000 µF capacitor (across the 5V rail — the strip's inrush current will reboot an Arduino without it)
- 220 Ω resistor on the data line
- Cygnett 5000 mAh 5V 2.4A USB power bank

## What works and what doesn't

The Cylon sweep and underglow work beautifully. The brake detection works *in principle* — but the deceleration threshold is still fiddly. A hard push-off registers as "braking" if you are not careful with the sensitivity curve, and road-surface vibration adds enough noise that a simple threshold is not quite robust. Next iteration likely needs a low-pass filter or a short rolling average rather than a single-sample compare.

The other open items are the usual physical-computing headaches: shrinking the electronics enough to fit cleanly inside the deck's cable channel, weather-sealing everything so a puddle does not fry the microcontroller, and confirming the 2.4 A power bank can hold up when all 30 LEDs are white at full brightness (spec says yes, real life will tell).

## Why publish it

Because 90% of fun hardware projects never make it out of someone's garage. This one works well enough to ride around at night, it is wired correctly, and the FastLED patterns are reusable for anyone building a similar rig for a longboard, e-scooter, or bike. If you are poking at your own wearable-ish electronics build, [clone it](https://github.com/isaacrowntree/boosted-board-led-lights) and make it yours.
