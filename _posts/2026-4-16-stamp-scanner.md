---
layout: post
title: "Stamp Scanner — iPhone + Mac + SAM 3 for cataloguing stamp collections"
description: "A two-device workflow that turns an iPhone into a macro scanner and a Mac into a SAM-3 segmentation, deduplication, and VLM identification pipeline for philately."
excerpt: "A two-device workflow — iPhone as a macro scanner, Mac running SAM 3 segmentation, deduplication, and a local Qwen3-VL for identification — with Colnect lookup and a SwiftUI library UI."
image: /images/blog/stamp-scanner.jpg
image_alt: Close-up of a vintage postage stamp collection through a magnifying glass
date: 2026-04-16
last_modified_at: 2026-04-16
categories: [open-source, ai]
tags: [swift, python, ios, mac, sam, vlm, philately, local-ai, open-source]
---

Zack Design has published [`stamp-scanner`](https://github.com/isaacrowntree/stamp-scanner) — a two-device workflow for cataloguing stamp collections. The iPhone acts as a tethered macro scanner. The Mac runs SAM 3 segmentation, perceptual-hash deduplication, rotation correction, and a local Qwen3-VL for identification. Everything lives in a queryable SQLite library you can point external tools at.

<!-- more -->

## The architecture, in ASCII

```
iPhone (ios-app/)                    Mac (mac-app/)                 Python (tools/)
┌───────────────────┐   HTTP over    ┌───────────────────┐   file   ┌─────────────────┐
│ Capture (HEIC)    ├───LAN+Bonjour─▶│ PhoneIngestServer ├──drop───▶│ sam_worker.py   │
│ MotionGate        │                │ (accepts uploads) │          │ SAM 3 + dedup   │
│ Lens picker       │                └───────────────────┘          │ + white balance │
└───────────────────┘                         │                     └────────┬────────┘
                                              │                              │ writes
                                              ▼                              ▼
                                     ┌────────────────────┐         ┌─────────────────────┐
                                     │ SwiftUI library UI │◀──GRDB──│ library.sqlite      │
                                     │ grid · detail      │         │ (~/Library/App Sup) │
                                     │ rotate · identify  │         └──────────▲──────────┘
                                     │ colnect lookup     │                    │ writes
                                     └────────────────────┘                    │
                                                │ spawns                       │
                                                ▼                              │
                                     ┌────────────────────┐                    │
                                     │ orientation_worker │───── Ollama ───────┤
                                     │   (Qwen3-VL)       │                    │
                                     │ colnect_lookup.py  │───── HTTP ─────────┘
                                     └────────────────────┘
```

## The data flow

1. **iPhone captures HEIC.** `MotionGate` waits for the phone to be steady (accelerometer settled) before taking the shot, the lens picker selects the macro-capable camera, and the captured HEIC is uploaded over Bonjour/LAN to the paired Mac.
2. **Mac receives it.** `PhoneIngestServer` — a SwiftUI app wrapping a tiny HTTP listener — drops the file into `.run/sam_inbox/`.
3. **SAM 3 segments the stamp.** `sam_worker.py` runs the Segment Anything 3 model to cut the stamp out of the page, perceptual-hashes it to detect duplicates already in the library, warps it square, and white-balances against the untouched corners of the page.
4. **SQLite writes.** The segmented, deduplicated, white-balanced stamp lands in `library.sqlite` via a GRDB schema.
5. **SwiftUI UI renders.** The Mac app exposes a grid, a detail view, rotation tools, and "identify" / "Colnect lookup" buttons.
6. **Identification is VLM-driven.** Hitting "identify" spawns `orientation_worker` against a local Ollama-hosted Qwen3-VL instance. Hitting "Colnect lookup" queries the Colnect catalogue API for an official ID match.

## Why two devices

Because an iPhone's macro camera + image signal processor is genuinely excellent at stamp-sized subjects — better than a flatbed scanner at 1200 dpi for small dense subjects, and much faster. A Mac, meanwhile, is the right place for the heavy lifting: SAM 3 wants a GPU, the local VLM wants 20 GB of unified memory, and GRDB + SwiftUI want a real filesystem and a large screen. Splitting capture from processing plays to each device's strengths.

## Why local

A stamp collection is personal. You do not want to upload it to a third-party cataloguing service that might vanish in two years or quietly start charging a subscription. Local models, local SQLite, local UI. The only optional outbound call is the Colnect catalogue API, and that is a lookup against their public IDs — no collection data leaves your Mac.

## Status

Working end-to-end for single-subject captures, deduplication, rotation, and VLM-based identification. Full architecture and build instructions in the [README](https://github.com/isaacrowntree/stamp-scanner). If you have a collection that deserves better than a spreadsheet, this is a solid starting point.
