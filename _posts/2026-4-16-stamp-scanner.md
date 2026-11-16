---
layout: post
title: "Stamp Scanner — iPhone + Mac + SAM 3 for cataloguing stamp collections"
description: "Photograph a stamp album page with an iPhone and a Mac cuts out every stamp with SAM 3, removes duplicates, identifies each with a local Qwen3-VL and matches it to a Stanley Gibbons number. No image leaves the Mac. SAM 3 finds every stamp on a page in 3–29 s; SAM 2.1 takes about a minute and finds two."
excerpt: "Photograph an album page and the Mac cuts out every stamp (27 of 27 in 18 seconds with SAM 3, where SAM 2.1 finds two in about a minute), keeps the better of any duplicate, identifies each with a local vision model and matches it to a Stanley Gibbons number. Asking the model which way up a stamp is turns out to be the dead end."
image: /images/blog/stamp-scanner.jpg
image_alt: Close-up of a vintage postage stamp collection through a magnifying glass
date: 2026-04-16
last_modified_at: 2026-11-16
categories: [open-source, ai]
tags: [swift, python, ios, mac, sam, vlm, philately, local-ai, open-source]
---

Zack Design's **[stamp-scanner](https://github.com/isaacrowntree/stamp-scanner)** is a two-device workflow for cataloguing stamp collections. The iPhone is a close-up scanner that fires only when the frame is **still and sharp**. The Mac uses **SAM 3**, Meta's Segment Anything Model, to cut every stamp off a page. It removes duplicates, straightens and white-balances each crop, has a **local vision-language model** identify it, and **matches it to its Stanley Gibbons catalogue number**. Everything lands in **one SQLite file** that the Mac app watches, and no image leaves the Mac. **MIT licensed.**

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
- what the vision model is and is not good for: the Ollama settings that return nothing, and why orientation is two buttons rather than a model;
- matching stamps to Stanley Gibbons catalogue numbers;
- how to run it, and the tests.

<!-- more -->

## Why it exists

A stamp collection is hundreds of small rectangles on album pages, and typing each one into a spreadsheet doesn't scale. Stamp-scanner photographs whole pages, cuts out every stamp, and fills in what it can. It stays local because a collection is personal; the only outbound calls are catalogue lookups.

Each device does the half it is good at. The iPhone's close-up camera is fast and sharp on stamp-sized subjects: the average crop in my library is 377 by 509 pixels. The Mac has the GPU SAM 3 wants, the memory the vision model wants, and the screen.

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
                                     └────────────────────┘                    │ writes
                                                │ spawns                       │
                                                ▼                              │
                                     ┌────────────────────┐                    │
                                     │ orientation_worker │───── Ollama ───────┘
                                     │   (Qwen3-VL)       │
                                     └────────────────────┘
```

SAM 3 here is the 3.45 GB `facebook/sam3` checkpoint, running on Metal, Apple's GPU framework. Duplicates are caught with a **perceptual hash**, a short fingerprint of what an image looks like. Identification uses **Qwen3-VL**, a vision-language model that answers questions about an image, served locally by Ollama.

SAM 2.1 isn't enough for this. With automatic masks, SAM 2.1-base takes 59 to 69 seconds per page and finds two stamps. SAM 3 with a text prompt saves 27 stamps from one page in 18.3 seconds.

## The phone decides when to shoot

Waiting for the accelerometer to settle is the obvious trigger, but stillness of the phone is not what matters; the picture is. There is no motion-sensor code in the app. `MotionGate.swift` watches the preview frames using Core Image, Apple's image-processing framework. Each frame goes through three checks:

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

The comparison comes from the worker logs, not a benchmark:

| Model | Page | Time | Stamps found |
|---|---|---:|---:|
| SAM 2.1-base, automatic masks | one page | 69.0 s | 2 |
| SAM 2.1-base, automatic masks | another page | 59.5 s | 2 |
| SAM 3 with text prompt | 21-stamp page | 26.3 s | 21 of 21 |
| SAM 3 with text prompt | 27-stamp page | 18.3 s | 27 of 27 |
| SAM 3 with text prompt | 15-stamp page | 11.3 s | 15 of 15 |
| SAM 3 with text prompt | empty frame | 3.8 s | 0 |

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

GRDB's `@Query` doesn't notice writes from another process, so on its own the grid wouldn't update as stamps stream in. `DatabaseWatcher.swift` puts a file-system watcher on `library.sqlite-wal` to catch them. The Swift side has no ingest logic at all.

## What the vision model is and is not good for

`orientation_worker.py` sends crops to Ollama at `http://localhost:11434/api/generate`. Each crop is shrunk to 384 pixels on the long side and sent as a base64 JPEG. `keep_alive: "30m"` keeps the model loaded between stamps. Afterwards the worker unloads it explicitly, so SAM can have the GPU memory back.

Two Ollama behaviours cost time and are noted in the code. Qwen3-VL returns nothing when the output limit, `num_predict`, is small. It also returns nothing at `temperature=0`, the setting that should make it deterministic, across several models. So the worker uses the default temperature and caps output at 2,048 tokens. The Ollama log puts the loaded 4-bit model at 10.9 GiB on an M3 Pro, with all 37 layers on the GPU.

**Identification works.** One prompt asks for JSON only. It returns country, year, denomination, colour, subject, series, whether it was used, cancel type, printing and overprint. It takes about a minute per stamp, and each result is written back with its own `UPDATE`. Qwen3-VL is used rather than Gemma for "smaller, faster, more reliable output", in the words of the commit that chose it.

**Orientation doesn't work.** The prompt asks which rotation makes the stamp upright: 0, 90, 180 or 270. The function's own docstring calls it "too slow/unreliable on local hardware", and marks it DEPRECATED. Only 3 of the 1,731 rows in the live library have `oriented=1`. Orientation is two rotate buttons on each grid cell instead. A rotation sends a notification for just that record, so it doesn't re-fetch the whole grid.

## Matching against the Stanley Gibbons catalogue

An identified stamp still needs a catalogue number. Stanley Gibbons (SG) numbers are the standard reference for British Commonwealth stamps, and SG's 1840–1970 Commonwealth volume is on the Internet Archive as OCR text. `tools/sg_fetch.py 1840-1970` downloads it to `~/.stamp-scanner/sg/`, outside the repo. Later volumes are borrow-only there, so stamps issued after 1970 come back as "no match", with the reason logged.

`sg_catalogue.py` turns the OCR into one record per stamp: SG number, year, denomination and colour. Scanned catalogue text is messy, so the parser expects type numbers missing from continuation lines, commas in place of full stops, "½" written as a glyph or as "1/2", and garbled page headers. It finds each country's section by its headings. Ten countries are set up, including Australia, New Zealand, Canada and the United Kingdom.

`sg_lookup.py` walks the library and scores every candidate:

- **0.7** when year and denomination both match, rising to 1.0 when colour and subject match too;
- **0.3** when only the year matches, rising to 0.6 the same way.

The best match goes into `catalogueRef` if it scores at least 0.7. `--min-score` changes that bar, and `--dry-run` reports without writing.

Two checks run before matching, because the vision model makes predictable mistakes:

- `vlm_correct.py` spots a denomination that couldn't exist in that year, such as cents on an Australian stamp before decimal currency in 1966, and adds the era-correct alternatives to try. It never overwrites what the model said.
- `sanity.py` flags implausible identifications for review. It only rejects impossible ones, such as a year before the country issued stamps.

## Trying it

You need macOS 14 or later, Xcode 15, Python 3.12, Ollama, and around 25 GB of free disk. SAM 3 is gated on Hugging Face: request access to `facebook/sam3` (it's free), then put your token in `.env.local`.

```bash
git clone https://github.com/isaacrowntree/stamp-scanner && cd stamp-scanner
python3 -m venv .venv
.venv/bin/pip install ultralytics pillow numpy torch scipy opencv-python \
                     huggingface_hub pillow-heif imagehash requests
cp .env.example .env.local      # add your HF_TOKEN
ollama pull qwen3-vl
./run.sh download               # fetches sam3.pt (3.4 GB)
./run.sh                        # launches the Mac app; the SAM worker starts with it

.venv/bin/python tools/sg_fetch.py 1840-1970   # optional: the SG catalogue text
.venv/bin/python tools/sg_lookup.py --dry-run  # match identified stamps to SG numbers
```

For the iPhone app, run `xcodegen` in `ios-app/` and open the generated project. `./run.sh stop` kills leftover workers.

## Tests and status

```bash
cd mac-app && swift test                    # Mac app unit tests
python -m unittest discover tools/tests     # SG parser, matcher and checks
./tools/run_fixture_pipeline.sh             # SAM on the bundled fixtures
./tools/run_fixture_pipeline.sh --identify  # plus Qwen3-VL identification (slow)
```

The Swift tests cover the pairing code, the issue detector and the schema round-trip. The Python tests run the SG parser against short catalogue excerpts, and cover the matcher, the denomination corrections, the sanity checks and the database migration. The fixture script runs the bundled JPEG and PNG images through the real worker against a scratch database, including a selfie as a negative control.

The worker writes a heartbeat between files, so the launcher doesn't mistake a long run of back-to-back jobs for a hang. `run.sh` kills stale workers on start, so a survivor from an earlier session can't race the new worker for the inbox.

Full architecture and build notes are in the [README](https://github.com/isaacrowntree/stamp-scanner). If you have a collection that deserves better than a spreadsheet, this is a working start.
