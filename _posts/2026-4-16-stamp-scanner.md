---
layout: post
title: "Stamp Scanner — iPhone + Mac + SAM 3 for cataloguing stamp collections"
description: "A two-device pipeline for philately: the iPhone is a macro scanner gated on frame sharpness, the Mac runs SAM 3 on Metal to cut every stamp off a page, perceptual-hash dedup, and a local Qwen3-VL for identification. SAM 2.1 took 59–69 s per page and found two stamps; SAM 3 takes 3–29 s and finds all of them."
excerpt: "The first pipeline ran SAM 2.1 and took 69 seconds to find two stamps on a page. The one that shipped runs SAM 3 with a text prompt, finds 27 in 18 seconds, deduplicates with a 64-bit pHash at Hamming distance 6, and writes straight into a SQLite file the Mac app watches. The VLM orientation pass was the dead end."
image: /images/blog/stamp-scanner.jpg
image_alt: Close-up of a vintage postage stamp collection through a magnifying glass
date: 2026-04-16
last_modified_at: 2026-11-16
categories: [open-source, ai]
tags: [swift, python, ios, mac, sam, vlm, philately, local-ai, open-source]
---

Zack Design's **[stamp-scanner](https://github.com/isaacrowntree/stamp-scanner)** is a two-device workflow for cataloguing stamp collections. The iPhone is a close-up scanner that fires only when the frame is **still and sharp**. The Mac uses **SAM 3**, Meta's Segment Anything Model, to cut every stamp off a page. It removes duplicates, straightens and white-balances each crop, and hands identification to a **local vision-language model**. Everything lands in **one SQLite file** that the Mac app watches, and no image leaves the Mac. **MIT licensed.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/isaacrowntree/stamp-scanner" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
</div>

This post covers:

- why it uses two devices, and why everything stays local;
- how the iPhone, the Mac and the Python workers connect;
- the sharpness gate on the phone: a threshold of 350 on an edge-detail score, not an accelerometer;
- the SAM 3 text prompt, and the mask filters that make it usable;
- duplicate detection that keeps the better copy rather than the first one, and white balance that samples the stamp's own border;
- one SQLite file with two writers;
- what the vision model is and is not good for: the Ollama settings that return nothing, and the orientation model abandoned in favour of two buttons;
- the Colnect catalogue lookup, and a local image search added since;
- how to run it, and the tests.

<!-- more -->

## Why it exists

A stamp collection is hundreds of small rectangles on album pages, and typing each one into a spreadsheet doesn't scale. Stamp-scanner photographs whole pages, cuts out every stamp, and fills in what it can.

Each device does the half it is good at. The iPhone's close-up camera is fast and sharp on stamp-sized subjects: the average crop in my library is 377 by 509 pixels. The Mac has the GPU SAM 3 wants, the memory the vision model wants, and the screen. It stays local because a collection is personal. The only outbound calls are catalogue lookups.

## How the pieces connect

The phone photographs a page and uploads it over the local network to a small server inside the Mac app. That server drops the file in a folder. A Python worker watches the folder, cuts out the stamps and writes them to the database. The Mac app shows the database, and starts the identification worker when you ask.

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

SAM 3 here is the 3.45 GB `facebook/sam3` checkpoint, running on Metal, Apple's GPU framework. Duplicates are caught with a **perceptual hash**, a short fingerprint of what an image looks like. Identification uses **Qwen3-VL**, a vision-language model that answers questions about an image, served locally by Ollama.

The night before the first commit, the pipeline used SAM 2.1-base. It took 59 to 69 seconds per page and found two stamps. After the switch to SAM 3, the worker log shows 27 stamps saved from one page in 18.3 seconds.

## The phone decides when to shoot

The old design had the phone wait for the accelerometer to settle. It doesn't any more: there is no motion-sensor code in the app. Instead, `MotionGate.swift` watches the preview frames using Core Image, Apple's image-processing framework. Each frame goes through three checks:

- **Is it moving?** The frame is shrunk to 192 pixels wide and compared with the previous one. An average pixel difference above 3% counts as movement.
- **Is it sharp?** A 512-pixel square from the centre goes through a 3-by-3 Laplacian edge filter. The variance of that filter's output is the sharpness score.
- **Is it a real scene?** Average brightness must sit between 15% and 90%. A phone lying face-down is near-black with little edge detail, and a loose floor would let it fire.

The picture must be still for 180 milliseconds, then two frames in a row must score above 350. After it fires, the gate ignores the page until the picture changes by more than 10%.

![A timeline of preview frames: red while the picture is moving; then still for 180 milliseconds; then two consecutive frames sharper than 350, at which point the shutter fires; then latched and ignoring the page until the picture changes by more than 10 percent, when it re-arms.](/images/blog/stamp-scanner-shutter-gate.svg)

```swift
// iPhone preview frames are ~1920×1080 even though the shutter captures
// at 48MP. The Laplacian variance on preview frames maxes out around
// 400–600 with good lighting + macro. 350 gates out motion blur and
// focus-hunting while letting well-lit macro shots fire.
private let blurMin: Float = 350
```

Tapping the preview fires it by hand. The camera starts on the 0.5x ultra-wide lens, the close-up lens on an iPhone 15 Pro, with autofocus restricted to near subjects. Photos are saved as HEIC, Apple's compressed photo format.

Each file waits in an on-disk outbox and uploads to `POST /submit` with a pairing secret in the header. The phone finds the Mac through Bonjour, Apple's local-network discovery, as `_stampscanner._tcp`, and pairs once with a six-digit code. The Mac's `PhoneIngestServer` listens on port 47000. It writes each upload to a temporary file and then moves it into `.run/sam_inbox/`, so the worker never sees a half-written file.

## Cutting stamps out with a text prompt

`tools/sam_worker.py` is a background process. The Mac app starts it as `.venv/bin/python tools/sam_worker.py --daemon`. It claims each inbox file by renaming it, so two workers can't process the same one. It runs Ultralytics' `SAM3SemanticPredictor` on the Metal GPU with a text prompt describing what to find:

```python
DEFAULT_PROMPT = "perforated postage stamp"
DEFAULT_NEGATIVES = ["envelope", "printed text", "paper fragment"]
DEFAULT_CONF = 0.5
DEFAULT_IOU = 0.6
```

Only masks that match the positive prompt are kept. Raw SAM output on an album page still includes slivers and chunks of page. `filter_and_dedup` drops any mask that:

- is a thin sliver, with an aspect ratio under 0.30;
- fills less than 45% of its own bounding box;
- covers less than 0.3% or more than 95% of the frame.

It then resolves overlaps. A mask mostly inside a much larger one is dropped. Two masks overlapping by more than 55% are ranked by fill, shape and confidence, and the better one stays.

Each survivor is cut out with `cv2.minAreaRect`, the smallest rotated rectangle that encloses it. The rectangle is padded outward by 8% and warped square, which straightens the stamp. If the result is more than 5% wider than tall, it is turned to portrait.

The comparison with the previous night comes from the logs, not a benchmark:

| Model | Page | Time | Stamps found |
|---|---|---:|---:|
| SAM 2.1-base, automatic masks (15 April) | one page | 69.0 s | 2 |
| SAM 2.1-base, automatic masks (15 April) | another page | 59.5 s | 2 |
| SAM 3 with text prompt (16 April) | 21-stamp page | 26.3 s | 21 of 21 |
| SAM 3 with text prompt (16 April) | 27-stamp page | 18.3 s | 27 of 27 |
| SAM 3 with text prompt (16 April) | 15-stamp page | 11.3 s | 15 of 15 |
| SAM 3 with text prompt (16 April) | empty frame | 3.8 s | 0 |

The `.gitignore` still lists `sam2.1*.pt`.

## Duplicates: keep the better copy, not the first one

Pages get photographed twice, and neighbouring frames overlap. Each crop gets a 64-bit perceptual hash from `imagehash.phash`. It is stored as a signed 64-bit integer, because that is what SQLite can hold. The worker compares it with every hashed row. Two hashes that differ in six bits or fewer (a Hamming distance of at most 6) count as the same stamp:

```python
for row in rows:
    if hamming(phash, existing_hash) <= MAX_HAMMING:   # MAX_HAMMING = 6
        existing_quality = row[1] * row[2] * row[3]     # conf × cropW × cropH
        if quality > existing_quality:
            return "better", row
        return "worse", row
return "unique", None
```

A "better" match doesn't skip the new crop. It deletes the older row and its captures folder instead. Re-shooting a page from closer upgrades the library rather than being rejected. The log records each decision: `skip (dup of …, lower quality)` or `replacing … (higher quality)`.

The Mac app runs a second, separate check. Its `IssueDetector` compares Apple Vision image fingerprints across the whole library and tags three problems: `duplicate`, `obscured` (blurry, or shot through an album sleeve) and `partial` (a crop that is too narrow or too small). Each tag can be dismissed per stamp. The live library on my Mac holds 1,731 rows, and 242 of them are marked `duplicateOf` by this pass.

White balance is done per crop, using the crop's own border. The border strip is one fifteenth of the shorter side. The brightest 5% of its pixels are taken as the white reference. Each colour channel is then scaled to bring them toward 245 out of 255, with the scale limited to between 0.8 and 1.5. If the reference is darker than 100 in any channel, the crop is left alone: a black-bordered stamp should not be whitened. The docstring says the reference maps to 255; the code targets 245.

## One SQLite file, two writers

The library lives at `~/Library/Application Support/StampScanner/library.sqlite`. The worker inserts eleven columns into its `stamps` table. The database runs in write-ahead-log mode, so a reader and a writer don't block each other, with a 3-second wait when the file is busy.

The Mac app opens the same file through GRDB, a Swift SQLite library. The Python side creates the table independently. So every one of the app's schema migrations checks `db.columns(in: "stamps")` before adding a column.

At first the grid didn't update as stamps streamed in, because GRDB's `@Query` doesn't notice writes from another process. `DatabaseWatcher.swift` fixed it with a file-system watcher on `library.sqlite-wal`. The Swift side has no ingest logic at all.

## What the vision model is and is not good for

`orientation_worker.py` sends crops to Ollama at `http://localhost:11434/api/generate`. Each crop is shrunk to 384 pixels on the long side and sent as a base64 JPEG. `keep_alive: "30m"` keeps the model loaded between stamps. Afterwards the worker unloads it explicitly, so SAM can have the GPU memory back.

Two Ollama behaviours cost time and are noted in the code. Qwen3-VL returns nothing when the output limit, `num_predict`, is small. It also returns nothing at `temperature=0`, the setting that should make it deterministic, across several models. So the worker uses the default temperature and caps output at 2,048 tokens. The Ollama log puts the loaded 4-bit model at 10.9 GiB on an M3 Pro, with all 37 layers on the GPU.

**Identification works.** One prompt asks for JSON only. It returns country, year, denomination, colour, subject, series, whether it was used, cancel type, printing and overprint. It takes about a minute per stamp, and each result is written back with its own `UPDATE`. The earlier model was Gemma. The commit that switched it says Qwen3-VL was "smaller, faster, more reliable output". A stale comment in `sam_worker.py` still mentions Gemma 4.

**Orientation didn't work.** The prompt asked which rotation makes the stamp upright: 0, 90, 180 or 270. The function's own docstring calls it "too slow/unreliable on local hardware", and marks it DEPRECATED. Only 3 of the 1,731 rows in the live library have `oriented=1`. Orientation is now two rotate buttons on each grid cell. A rotation sends a notification for just that record, so it doesn't re-fetch the whole grid.

## Matching against the Colnect catalogue

Colnect is an online stamp catalogue. `colnect_lookup.py` searches it for any identified stamp that has no catalogue reference yet, and writes `Colnect <id>` into `catalogueRef`. It makes no more than one request per second.

Its first version was wrong. The rewrite followed the official API spec. Requests are signed with HMAC-SHA256 over the path and timestamp, joined by the literal characters `>|<`, and the signature was checked against the spec's worked example. The spec also requires a User-Agent longer than 15 characters, so it sends one.

Three days after this post, two tools landed that match stamps by picture instead of by description:

- `colnect_mirror.py` downloads catalogue data and thumbnails for one country (`--country Australia`) or all of them (`--all`). It keeps them in `~/.stamp-scanner/colnect/`, outside the repo, because Colnect's terms forbid redistributing its content.
- `colnect_embed.py` turns each thumbnail into a CLIP embedding, a list of numbers that places similar-looking images close together. `--query <crop.png>` then finds the nearest catalogue stamps to a scanned crop.

The commit puts Australia, about 20,000 stamps, at roughly 30 minutes of setup, then under 10 ms per lookup. For now these run from the command line; the Mac app doesn't call them yet.

## Trying it

You need macOS 14 or later, Xcode 15, Python 3.12, Ollama, and around 25 GB of free disk. SAM 3 is gated on Hugging Face: request access to `facebook/sam3` (it's free), then put your token in `.env.local`.

```bash
git clone https://github.com/isaacrowntree/stamp-scanner && cd stamp-scanner
python3 -m venv .venv
.venv/bin/pip install ultralytics pillow numpy torch scipy opencv-python \
                     huggingface_hub pillow-heif imagehash requests
cp .env.example .env.local      # add HF_TOKEN, and COLNECT_API_KEY if you have one
ollama pull qwen3-vl
./run.sh download               # fetches sam3.pt (3.4 GB)
./run.sh                        # launches the Mac app; the SAM worker starts with it
```

For the iPhone app, run `xcodegen` in `ios-app/` and open the generated project. `./run.sh stop` kills leftover workers.

## Tests and status

```bash
cd mac-app && swift test                    # 12 XCTest cases
./tools/run_fixture_pipeline.sh             # SAM on the bundled fixtures
./tools/run_fixture_pipeline.sh --identify  # plus Qwen3-VL identification (slow)
```

The XCTest cases cover the pairing code, the issue detector and the schema round-trip. The fixture script runs the 12 bundled JPEG and PNG images through the real worker against a scratch database, including a selfie as a negative control.

Two launcher fixes came from real failures. The worker writes a heartbeat between files, because the launcher used to kill it during back-to-back jobs. And `run.sh` kills stale workers on start, because a survivor from an earlier session runs old code and races the new worker for the inbox.

Full architecture and build notes are in the [README](https://github.com/isaacrowntree/stamp-scanner). If you have a collection that deserves better than a spreadsheet, this is a working start.
