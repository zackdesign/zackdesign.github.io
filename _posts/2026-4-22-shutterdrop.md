---
layout: post
title: "Shutterdrop — wireless tethered phone camera for your Mac"
description: "An iOS + Android + Python receiver that turns your phone into a tap-and-drop wireless tether for your Mac. LAN + Bonjour, no cable, no cloud."
excerpt: "Tap your phone, the photo lands in a folder on your Mac a moment later. iOS + Android + Python receiver — LAN + Bonjour, no cable, no cloud, no account."
image: /images/blog/shutterdrop.jpg
image_alt: A silver iPhone resting on a silver MacBook, hinting at the wireless tether between phone and laptop
date: 2026-04-22
last_modified_at: 2026-04-22
categories: [open-source]
tags: [swift, kotlin, python, ios, android, mac, photography, bonjour, open-source]
---

Zack Design has published [`shutterdrop`](https://github.com/isaacrowntree/shutterdrop) — a wireless tethered camera that turns the phone in your pocket into a wifi shutter for your Mac. Tap the screen on your phone, the photo lands in a watched folder on your Mac a moment later. Like Capture One tether, but over wifi from your iPhone or Android instead of a USB DSLR. No cable, no cloud, no account.

<!-- more -->

## Why this exists

I take a lot of product photos for eBay listings — bike parts, electronics, miscellaneous resale. The iPhone in my pocket has a vastly better camera than my MacBook's built-in webcam, but the friction of "shoot on phone → AirDrop → import to listing tool" was killing the throughput. Existing wireless tether tools either want a subscription, push photos through someone else's cloud, or are tied to a specific desktop app I don't use.

Shutterdrop is the smallest possible thing that solves the problem: tap shutter, file shows up. That's it. The receiver writes straight to a watched folder, so whatever workflow you already have (Finder smart folder, Hazel rule, Lightroom auto-import, eBay listing CLI) just sees new files appear.

## What it's like to use

1. Start the receiver on your Mac. It prints a 6-digit pairing code in the terminal.
2. Open the Shutterdrop app on your phone. It finds your Mac on the wifi automatically and asks for the code.
3. Type the code once. You're paired forever — your phone remembers your Mac.
4. Frame the shot, tap anywhere on the camera preview, and a moment later the photo appears in `~/Pictures/Shutterdrop/` on your Mac. Drag it straight into your eBay listing, your Lightroom catalogue, or wherever you already work.

If you walk out of wifi range mid-shoot, captures queue up on the phone and flush as soon as you're back online. Nothing gets lost.

## What's in it

- **iPhone app** for iOS 17+, with a manual lens picker on Pro phones (0.5× / 1× / 3×) and a built-in torch toggle. Photos are HEIC at full quality.
- **Android app** for Android 8 and up. JPEG capture, edge-to-edge layout, accessible to TalkBack screen readers.
- **A small Mac receiver** written in Python. It runs in the background, advertises itself on the local network, and drops every incoming photo into a folder of your choice. Linux works too.
- **Pairing is private.** A one-time 6-digit code shown on your Mac, with rate limits and a 5-minute window so nobody on the same wifi can guess their way in. The shared key lives in your phone's secure storage (iOS Keychain or Android EncryptedSharedPreferences).

## Status

Working end-to-end on both iPhone and Android, with an automated test suite for the Mac receiver that runs on every push. The wire protocol between phone and Mac is small enough that you could write your own receiver — drop incoming photos into S3, pipe them through `pngcrush`, auto-import to Lightroom, whatever you want. MIT-licensed, source on [GitHub](https://github.com/isaacrowntree/shutterdrop).

## Under the hood (for the curious)

```
Phone (iOS or Android)              Mac (or Linux)
┌───────────────────────┐           ┌────────────────────────┐
│ Camera preview        │  HTTP     │ receiver.py            │   drop
│ Tap-to-capture (HEIC  ├──over────▶│ (Python stdlib +       ├──────▶  ~/Pictures/Shutterdrop/
│  on iOS / JPEG on     │  LAN +    │  zeroconf)             │
│  Android)             │  Bonjour  │ advertises             │
│ Offline outbox        │           │ _shutterdrop._tcp      │
│ Bonjour discovery     │           └────────────────────────┘
└───────────────────────┘
```

Three endpoints, that's the whole protocol:

```
GET  /health  → {"ok":true}                          unauthenticated
POST /pair    → {"code":"123456","peerName":"…"}     returns {"secret","peer"}
POST /submit  → multipart/form-data, "photo" part, Bearer auth required
```

Build details and architecture notes are in the [README](https://github.com/isaacrowntree/shutterdrop).
