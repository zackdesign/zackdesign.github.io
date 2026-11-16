---
layout: post
title: "deflicker-runner — killing LED PWM flicker in 4K video, in 400MB of RAM"
description: "A streaming temporal-median deflicker for 4K footage shot under LED lights — five 540p frames in a deque instead of ~18 GB of decoded video, and a 96–211× upscale speedup that made the whole thing practical."
excerpt: "A streaming temporal-median deflicker for 4K footage shot under LED lights — five 540p frames in a deque instead of ~18 GB of decoded video, and a 96–211× upscale speedup that made the whole thing practical."
image: /images/blog/deflicker-runner.jpg
image_alt: Close-up of an optical camera lens reflecting light
date: 2026-02-08
last_modified_at: 2026-11-16
categories: [open-source]
tags: [video, ffmpeg, python, deflicker, rolling-shutter, led-flicker, open-source]
---

Zack Design's **[deflicker-runner](https://github.com/isaacrowntree/deflicker-runner)** is a Python pipeline that removes the flicker a camera records under overhead LED panels. A rolling-shutter camera, which reads its sensor one row at a time, catches the LEDs switching on and off as a pulse in brightness: only about 2%, but at about 20 beats per second, which the eye sees clearly. The naive fix needs the whole 4K clip decoded, about **18 GB** of memory. The streaming version keeps **five small greyscale frames** in a queue and runs on a full-length clip in **a few hundred megabytes**. **MIT licensed.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/isaacrowntree/deflicker-runner" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
</div>

This post covers:

- why it exists, and the arithmetic that turns a 100 Hz light into a 19.88 Hz flicker;
- the median-then-ratio loop at the centre of the tool;
- the two-decoder design that lets it stream, and the resize call that was the bottleneck until `scipy.ndimage.zoom` was swapped for `cv2.resize`;
- why filament bulbs need a separate full-resolution path;
- the measured reduction on two festival clips;
- the modes that did not earn their place, and how to run it yourself.

<!-- more -->

## Why it exists

The footage was from the Port Macquarie Latin Festival 2026: 4K at 59.94 frames per second, indoors, under overhead LED panels. The walls and ceiling pulsed, and filament bulbs at the top of the frame flickered on their own. The pulse is only about 2% of the frame's brightness, but at about 20 beats per second the eye sees it clearly.

The textbook fix is simple: for every pixel, take the median of its value over time. The catch is memory. Doing that over a whole 4K clip (3840 by 2160 pixels) means holding it all decoded, about 18 GB. This tool gets the same result while holding five small greyscale frames, about 2.6 MB of measurement data.

## Why a 100 Hz light shows up as a 20 Hz flicker on video

LED drivers switch the light on and off very fast. This is pulse-width modulation, or PWM. On 50 Hz mains the panels pulse 100 times a second, once for each half of the mains cycle.

A camera sampling 59.94 times a second can't follow that. What it records is the beat between the two rates. Twice the frame rate is 119.88, and the difference between that and 100 is 19.88 pulses per second. Every third frame lands on nearly the same point of the pulse, so the footage carries a three-frame cycle.

A rolling-shutter camera reads its sensor one row at a time, so the bottom rows are read later than the top rows. That adds a top-to-bottom gradient. The flicker shows up in two shapes:

- **Whole-frame pulsing** on the walls, ceilings and dark surfaces that reflect the panels. The panels themselves are saturated white and look fine.
- **Spot flicker** on filament bulbs, fairy lights and other point sources, which are 2 to 5 pixels wide at 4K.

`diagnose.py` tells you which shape you have before you spend GPU time. It checks for banding down the frame and for beating between the top and bottom of the frame over time, and dumps per-row brightness to `tmp/`.

## The median of five frames is the un-flickered picture

![Top: a row of video frames whose brightness repeats bright, medium, dark every three frames, with a five-frame window bracketed to show it always contains one full cycle, so the median is the steady brightness. Bottom: one decoder feeds small greyscale frames into a five-frame queue two frames ahead of the current frame, a second decoder reads the same frame at full resolution, the correction from the queue is multiplied into it and sent to the encoder, and the oldest small frame is dropped.](/images/blog/deflicker-streaming-window.svg)

A five-frame window (`--radius=2`, two frames either side of the current one) always contains at least one full three-frame cycle. So the per-pixel median across the window is the un-flickered brightness, with nothing to tune. The correction is a ratio applied to the frame, not a replacement of it, so fine detail survives. From `apply_temporal_median_streaming` in `deflicker.py`:

```python
window = np.stack(list(meas_window)).astype(np.float32)
current = window[current_pos]
target = _fast_median(window, axis=0)

safe_current = np.maximum(current, 1.0)
corr = target / safe_current
# ... dark-floor ramp below brightness 25, where noise dominates
corr = gaussian_filter(corr, sigma=2.0)
corr = np.clip(corr, 0.80, 1.20)

corr_full = _upscale_correction(corr.astype(np.float32), h, w)
result = np.clip(frame.astype(np.float32) * corr_full[:, :, np.newaxis], 0, 255)
```

The correction is computed on a 540p (960 by 540 pixel) greyscale copy of the frame. It is smoothed and limited to plus or minus 20%, and only then enlarged to full size and multiplied into the full-resolution frame. In dark areas, where noise dominates, it fades out between brightness 45 and 25 and is off below that. `_fast_median` uses `np.partition`, which is about twice as fast as `np.median` for a window this small.

## Streaming: decode the file twice and keep five frames

The streaming path runs two ffmpeg decoders on the same file:

- one scaled down to 540p greyscale for measurement, decoded in software because the frames are tiny, which leaves the GPU decoder free;
- one at full resolution, decoded on the GPU with CUDA.

NVIDIA's hardware encoder, NVENC (`h264_nvenc`, `constqp`, `qp=10`, preset `p4`), writes the output. The measurement decoder runs two frames ahead of the full-resolution one.

For each frame, the small copy joins the queue. The full-resolution frame is read, corrected and written. Then the small frame that has fallen more than two frames behind is dropped. Nothing else is buffered; the bottom half of the figure above is the whole design. So the pipeline is a GPU decode and a GPU encode on either side of a CPU NumPy loop, and it needs an ffmpeg built with CUDA decoding and NVENC.

The other modes are not streamed. The per-row ones (`running-mean`, `fft-notch`, `bcc`, `physical-model`, `global-row`, `hybrid`) keep only one average per row per frame, which is cheap. `pixel-smooth` loads every frame as 8-bit greyscale, shrinking the measurement size below 540p if needed to stay under about 4 GB.

## The upscale was the bottleneck

The median over five frames runs at about 41 frames per second and was never the problem. Enlarging the 540p correction map to 4K every frame was. With `scipy.ndimage.zoom` it took 83 ms, or 12 frames per second, slower than every other stage.

| Method | Time per frame | Equivalent frames per second |
|---|---|---|
| `scipy.ndimage.zoom` (order=1) | 83 ms | 12 |
| `cv2.resize` (`INTER_LINEAR`) | 0.4 to 0.9 ms | 1,100 to 2,500 |

That is a 96 to 211 times speedup from one function call. The two outputs differ by at most 0.05 (0.007 on average), which is invisible under a correction that is itself only about 2%. OpenCV is optional, and the code falls back to SciPy without it. With it, the stages measure like this on 4K footage at 59.94 frames per second:

| Stage | Frames per second | What limits it |
|---|---|---|
| Reading the 540p measurement copy | about 200 | CUDA decode |
| Median over five frames | about 40 | the NumPy partition |
| Applying the correction to the full frame | about 20 | converting a 24 MB frame to floating point |
| NVENC encode | about 100 | the encoder |

## Filament bulbs vanish at low resolution, so they get their own path

A filament two pixels wide at 4K doesn't exist at 540p, so the whole-frame path can't see it. `spot-replace` works at full resolution instead, on the top third of the frame (up to 720 rows), where the ceiling lights are:

1. **Find the bulbs.** Pixels brighter than 150 whose brightness varies over time with a standard deviation above 40 are candidates. Eroding that mask leaves compact cores, and long thin shapes are thrown out. You can also name the spots yourself with `--spots=Y1,X1,Y2,X2`.
2. **Follow each bulb.** Its position is tracked frame by frame and smoothed, so a moving camera doesn't lose it.
3. **Correct it.** Each frame's brightness at the bulb is compared with the bulb's median over the clip. The difference is added back through a soft round patch (a Gaussian, 8 pixels wide by default), so the edge doesn't show.

The memory story is in the repo's performance notes. The first version stored a correction for the whole scanned area: 301 frames by 720 rows by 3,840 columns by 4 bytes is 3.2 GB, almost all zeros. Storing a box per bulb cut that to about 50 MB with identical output, a 64 times reduction. The tracked version stores even less, one number per bulb per frame. The full-resolution scan of the top rows is still held in memory for the whole range, so spot-replace is meant for a few seconds at a time with `--start` and `--duration`.

`auto` runs the spot detector on the first three seconds. It picks `spot-replace` if it finds a bulb, otherwise `temporal-median`.

## Measured

`test_deflicker.py generate` writes reference corrections from two festival clips. `verify` checks later runs against them to four decimal places.

Whole-frame flicker, clip C1608, `temporal-median --radius=2`:

| Region | Reduction in brightness spread | Reduction in brightness range | Three-frame oscillation removed |
|---|---|---|---|
| Ceiling | 57% | 58% | 85% |
| Wall | 66% | 58% | 76% |

Spot flicker, clip C1595, `spot-replace`: both filament bulbs, at 4K coordinates (24, 1406) and (8, 1760) in the top crop, were detected and corrected with the fixed thresholds.

## What did not earn its place

Every mode is defined in `presets.yml`, and command-line flags override its defaults. `all` runs every mode on the same clip and prints a comparison table.

- **`hybrid`** (a notch filter plus a running mean) can introduce artefacts and is marked not recommended.
- **`physical-model`** fits a formula for the light's brightness over time, `L(t) = 1 + A(|cos(2π·100t + φ)|^c − mean)`, against the rolling-shutter row timing, using the Nelder–Mead optimiser. It is the most theoretically correct mode. In practice it is fragile and needs good bright-row data to converge.
- **`fft-notch`** removes exactly the 19.88 Hz component and nothing else. Drift from camera movement is left alone, but it only ever removes the roughly 2%.
- **`running-mean`** over a 300-frame window is fast, and good enough when per-pixel precision isn't needed.
- **`pixel-smooth`** averages each pixel over 31 frames, weighted by how similar each frame is at that pixel, so motion and cuts survive. It is the slowest, because it needs every frame in memory.

## Trying it

You need Python 3.8 or later with NumPy and SciPy, OpenCV for the fast resize, and an ffmpeg and ffprobe built with CUDA decoding and the NVENC encoder. That means an NVIDIA GPU.

```bash
git clone https://github.com/isaacrowntree/deflicker-runner.git
cd deflicker-runner
pip install numpy scipy opencv-python

python3 diagnose.py input.MP4                                   # which kind of flicker?
python3 deflicker.py auto input.MP4 output.MP4                  # let it choose
python3 deflicker.py temporal-median input.MP4 output.MP4 --start=30 --duration=10
python3 deflicker.py spot-replace input.MP4 output.MP4 --start=128 --duration=5
python3 deflicker.py all input.MP4 compare/                     # every mode, side by side
```

Run `python3 deflicker.py` with no arguments for every option. A `SKILL.md` lets Claude Code run the sequence itself: diagnose the clip, pick an approach, process it, and verify the result.

## What was learned

The memory problem was never the median. It was holding decoded 4K in memory, and the answer was to decode twice at two resolutions and keep a window of five. The speed problem was one library call.

On the headline number: the streaming code's own docstring estimates about 200 MB, against about 18 GB for the batch version, and the repo description says about 400 MB. I haven't measured the peak on a full-length clip, so read the title's number as an order of magnitude.

Two ideas are sketched in `docs/performance.md` but not built. One is a GPU median using CuPy (NumPy's GPU counterpart), measured at 89 to 433 times faster but not needed at a radius of two. The other decodes, processes and encodes entirely on the GPU, which would remove two memory copies per frame. The repo also carries `motion_blur_flow.py`, a side experiment that uses the same temporal median to leave motion trails on in-focus moving subjects. Source on [GitHub](https://github.com/isaacrowntree/deflicker-runner).
