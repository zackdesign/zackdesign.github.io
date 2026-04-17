---
layout: post
title: "audio-analysis-and-recut — reconstructing a live set from the studio master"
description: "A Python tool that cross-correlates a noisy live performance recording against the original studio track and rebuilds a high-fidelity recut following the live arrangement."
excerpt: "A Python tool that cross-correlates a noisy live performance recording against the original studio track and rebuilds a clean recut that follows the live arrangement."
image: /images/blog/audio-analysis-and-recut.jpg
image_alt: Close-up of a mixing console in a professional recording studio
date: 2026-03-13
last_modified_at: 2026-03-13
categories: [open-source]
tags: [audio, dsp, python, ffmpeg, cross-correlation, open-source]
---

Zack Design has published [`audio-analysis-and-recut`](https://github.com/isaacrowntree/audio-analysis-and-recut) — a small Python + FFmpeg pipeline that takes a noisy live performance recording, works out exactly which sections of the original studio track the band played, and generates a high-fidelity recut that follows the live arrangement.

<!-- more -->

## The problem

You have two audio files:

- **Original** — the studio recording. High fidelity, the version on Spotify, the one you actually want to listen to.
- **Performance** — a live recording of the same song. Great arrangement, maybe some improvisation, but also crowd noise, ambient PA colouration, and a phone mic's idea of bass response.

The live arrangement is *better* — it is the one the band actually performed — but the audio fidelity is *worse*. What you want is: the live arrangement, with studio fidelity. That is what this tool does.

## How it works

1. **Band-pass filter** to 200–4000 Hz on both tracks. Vocals live in that range, crowd noise and room rumble largely do not. This is what makes matching robust to a noisy live environment.
2. **Sliding-window cross-correlation** between chunks of the performance and the full studio track. Each chunk's best match pins down where in the original it came from.
3. **Segment detection** by grouping matches with consistent time offsets. A 30-second verse played live will produce 30 seconds of chunks that all agree on the same studio offset.
4. **FFmpeg concatenation** of the identified original segments, in the order the live performance used them, into a clean output file.

## Example output

For "Ya Te Olvide" by Los 4 ft Laritza Bacallao (4:40 studio original → 1:56 live performance):

```
SEGMENT MAP:
  1  0:00-0:19  |  Orig 0:12-0:30  |  18.5s  (intro/verse start)
  2  0:19-1:04  |  Orig 0:50-1:35  |  44.5s  (verse/chorus)
  3  1:04-1:36  |  Orig 2:44-3:15  |  31.5s  (montuno section)
  4  1:36-1:46  |  Orig 4:13-4:23  |   9.5s  (ending)
  5  1:46-1:48  |  Orig 4:33-4:35  |   2.0s  (final tag)

Skipped from original:
  0:00-0:12  (11.8s) - pre-intro
  0:30-0:50  (20.1s) - transition/repeat
  1:35-2:44  (69.1s) - repeated verse section
  3:15-4:13  (57.9s) - extended montuno/breakdown
  4:23-4:33  (10.3s) - outro padding
```

The segment map reads like a director's cut list: the band skipped the pre-intro, compressed the long breakdown, and landed on a different ending. Feeding that back into FFmpeg reconstructs the performance from clean studio audio.

## Why bother

Latin dance classes like [Havana on the Hastings](https://www.havanahastingsdance.com.au/) often rehearse to studio recordings but perform to the band's own arrangement — which means choreographies that work in rehearsal do not always align with the live record they are showcased against. A recut reconciles the two: same arrangement the dancers know, but clean enough to cue on.

## Usage

```bash
cp original_song.mp3 staging/original.mp3
cp performance_recording.mp3 staging/performance.mp3
python3 analyze.py
# Output: output/ya_te_olvide_recut.mp3
```

Dependencies are Python 3 with NumPy, plus a working FFmpeg on `$PATH`. Source on [GitHub](https://github.com/isaacrowntree/audio-analysis-and-recut).
