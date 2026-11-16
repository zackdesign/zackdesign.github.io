---
layout: post
title: "Clean Backdrop — free, GPU-accelerated studio backdrop cleanup"
description: "Studio backdrop cleanup with two Gaussian blurs and a distance map on a BiRefNet-Portrait subject mask. Why the LaMa inpainting model smudges backdrops, the floor detector and its threshold, and the soft-edged masks."
excerpt: "Healing a studio backdrop with the LaMa inpainting model smudges it. clean-backdrop uses no inpainting: a shadow lift plus a mask-weighted blur on a BiRefNet-Portrait subject mask, running on the GPU. Here is why the simpler approaches fail."
image: /images/blog/clean-backdrop.jpg
image_alt: Black and white photography studio with lighting gear and seamless backdrop
date: 2026-03-25
last_modified_at: 2026-11-16
categories: [open-source]
tags: [python, photography, cuda, birefnet, image-processing, open-source]
---

Zack Design's **[`clean-backdrop`](https://github.com/isaacrowntree/clean-backdrop)** is a free tool for photographers that removes cast shadows, scuffs and paper texture from studio portrait backdrops **without touching the subject**. It finds the subject with [BiRefNet-Portrait](https://github.com/ZhengPeng7/BiRefNet), a neural network that separates a person from the background, then cleans the backdrop with **two Gaussian blurs and a distance map**, running on the GPU. There's no inpainting AI in it, because inpainting smudges a backdrop. It is a free alternative to Retouch4me Clean Backdrop. **MIT licensed.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/isaacrowntree/clean-backdrop" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
  <a href="https://isaacrowntree.github.io/clean-backdrop/" target="_blank" rel="noopener" class="btn btn-outline-primary btn-lg">Documentation</a>
</div>

This post covers:

- why it exists;
- the shadow-lift formula, and the mask-weighted blur that keeps the subject from bleeding into the background;
- the floor detector, and why its threshold is 100 rather than 60;
- the two soft-edged masks that prevent "bar" artefacts;
- why an inpainting model is the wrong tool;
- the cuDNN detail (NVIDIA's neural-network library) that decides whether segmentation runs on the GPU at all, and how to run it, including as a Claude Code command.

<!-- more -->

## Why it exists

Studio portraits are shot against a backdrop: a painted wall or a roll of seamless paper. The subject casts shadows on it, the paper picks up scuffs and footprints, and its grain shows. Cleaning that by hand is slow, and Retouch4me Clean Backdrop, the tool built for the job, is paid. This one is free and never touches the subject; the before and after in the repo are from a dance photoshoot.

## What a backdrop actually is

A lit studio wall is a smooth, slowly changing gradient plus fine, fast-changing noise. The gradient is the lighting, and it is wanted. The noise is scuffs, creases, paper grain and footprints, and it is not. Cast shadows are a third thing: a wide, soft darkening of the gradient. Two operations cover all of it, and neither needs a model.

**Shadow lift** (`shadow_lift` in `app.py`) takes the clean wall colour to be the median of the brightest 20% of background pixels. It then measures how far each pixel sits below that brightness:

```python
darkness = clean_brightness - gray
max_depth = clean_brightness * 0.5
shadow_amount = np.clip(darkness / max(max_depth, 1), 0, 1) * strength
```

`shadow_amount` is blurred over a window 6% of the image's short edge wide (at least 51 pixels). It then becomes a per-pixel weight for blending toward `clean_wall`. Because it is a blend toward one colour, not a flat fill, the wall keeps its gradient. A pixel that was only slightly dark moves only slightly.

**Texture smoothing** (`freq_separation`, because it separates fine detail from the smooth base) is one heavy Gaussian blur and a blend from the original toward the blurred copy. The blur's sigma is a fortieth of the short edge, and never less than 10 pixels.

The detail that matters is the weighting. A plain blur near the subject averages skin and hair into the wall. So the image is multiplied by the background mask before blurring, then divided by the blurred mask:

```python
weighted = img_f * wm[:, :, np.newaxis]
low_freq = cv2.GaussianBlur(weighted, (ksize, ksize), sigma)
low_weight = cv2.GaussianBlur(wm, (ksize, ksize), sigma)
low_weight = np.maximum(low_weight, 1e-6)
low_freq = low_freq / low_weight[:, :, np.newaxis]
```

That is a normalised convolution: only background pixels contribute to the estimate of the background's smooth base. The division needs the mask broadcast across the colour channels (`[:, :, np.newaxis]`): dividing a three-channel array by a two-channel one is an error NumPy reports only at runtime.

## Telling a floor from a darkening wall

Studios aren't all seamless paper. Some have a wood or tile floor that meets the wall, and smoothing a floor deletes texture that is supposed to be there.

`detect_floor` compares the background's median colour in two bands: the wall, a quarter to half way down, and the bottom 15% of the frame. If they differ enough, it scans the bottom half row by row for the steepest darkening and calls that row the floor line.

![Two portrait frames showing the floor detector's two sample bands, the wall between a quarter and half way down and the bottom 15 percent: on a headshot against a wall that merely darkens toward the floor the colour difference is 30 to 80 and no floor is declared; on a real floor the difference is 100 or more and the steepest darkening row in the bottom half becomes the floor line.](/images/blog/clean-backdrop-floor-detector.svg)

The difference is the straight-line distance between the two RGB colours. A threshold of 60 looks reasonable and is wrong. On a headshot against a plain wall that falls off toward the floor, the bottom of the wall is routinely 60 units darker than the middle. The detector declares a floor, leaves it out of the cleanup, and leaves a black bar under the subject. So the threshold is 100, with the reasoning inline:

```python
# Gradient darkening on the same wall is typically 30-80, real floor change is 100+
if diff < 100:
    return floor_mask, floor_start
```

`batch.py` has `--no-floor` for the cases where the heuristic is still wrong. Those 30 to 80 and 100+ figures are from the images I had, not a survey.

## Two masks, both with soft edges

Without inpainting, the artefact to watch for is a hard edge wherever a mask stops. There are two masks.

**The subject boundary** is a distance map: each pixel holds its distance from the subject's edge. A hard on-or-off mask softened with a three-pixel blur still shows a line. With the distance map, the cleanup ramps up from nothing to full strength over a band 2% of the short edge wide (at least 15 pixels), instead of switching on:

```python
dist = cv2.distanceTransform(1 - subj, cv2.DIST_L2, 5)
feather_px = max(int(min(h, w) * 0.02), 15)
return np.clip(dist / feather_px, 0, 1).astype(np.float32)
```

**The floor boundary** is a ramp over 5% of the image height (at least 30 pixels) at the top of the floor mask. A hard cut at one row leaves a seam where cleaned wall meets uncleaned floor. Both passes multiply their working mask by one minus the floor mask instead of zeroing it. Floor texture and the contact shadow under the subject's feet sit below the ramp and are left alone.

## Why not inpainting

The obvious recipe heals blemishes with an inpainting model, a neural network that fills in masked-out regions of a photo. The repo keeps that pipeline as `clean_backdrop.py`. It separates the subject from the background with `rembg`. It builds a mask of blemishes from a stack of heuristics: fine detail above a threshold, pixels darker than their wide surroundings, detected edges, vertical seams, and dark bars where the wall meets the floor. It grows the mask outward a little, and hands it to LaMa:

```python
lama_model = torch.jit.load(model_path, map_location=device)
lama_result = inpaint_lama(current, lama_mask, lama_model, device)
```

It has a `--sd` flag that also runs Stable Diffusion inpainting to remove rigging and light stands, with a colour correction afterwards because Stable Diffusion shifts the colours. A safety cap tightens every threshold when the combined mask covers more than 45% of the frame. That tells you how often it does.

The results look healed and feel wrong. Inpainting invents plausible pixels. On a backdrop the plausible pixels are a smear of the neighbours, and a smear next to untouched paper reads as smudging. Limiting LaMa to small isolated areas (under 5% of the frame) and adding sliders to tune the detection helps less than moving the sliders suggests.

So `app.py`, the tool itself, uses no inpainting. It is two Gaussian blurs and a distance map on a mask of the subject. The mask comes from BiRefNet-Portrait, run on the GPU through ONNX Runtime.

## GPU, but only if the cuDNN library can be found

`rembg` runs BiRefNet-Portrait through ONNX Runtime. With `onnxruntime-gpu` installed it uses the CUDA execution provider. That needs the `libcudnn.so.9` library on `LD_LIBRARY_PATH`, the list of directories the system searches for shared libraries.

If the library is missing, you get a `libcudnn.so.9: cannot open shared object file` error and segmentation falls back to the CPU. The run still completes, only slower, which is why the failure is easy to read past. The README documents the `find /usr -name "libcudnn.so.9"` and `LD_LIBRARY_PATH` steps. The model itself is about 928 MB and downloads on first run. I didn't measure CPU against GPU time per image; `batch.py` prints a per-image average at the end of each run if you want yours.

## Running it

You need Python 3.10 or later and, for speed, an NVIDIA GPU with cuDNN 9.

```bash
git clone https://github.com/isaacrowntree/clean-backdrop.git
cd clean-backdrop
pip install -r requirements.txt
pip install onnxruntime-gpu  # for GPU segmentation
python app.py
# Open http://localhost:5000
```

The web interface has two sliders (shadow lift 70% and texture 50% by default), an "Exclude floor" checkbox, and four tabs: Original, Shadows, Texture and Preview. The Shadows tab paints every pixel the lift changed orange, and the Texture tab paints what the smoothing removed blue, so you can see where each pass acted.

Preview processes the full image and shrinks the result to 1200 pixels on the long edge for display. Save writes the full-resolution result next to the original with a `_clean` suffix. It copies the colour profile and camera metadata across, because `cv2.imwrite` strips the profile and the result shifts colour in every viewer.

```bash
python batch.py "D:\Photos\Export\My Shoot" --lift 70 --texture 50
python batch.py /path/to/folder --no-floor
```

`batch.py` cleans every JPEG in a folder (`--ext` for others) into a `cleaned/` subfolder (`--output` to change it). It accepts Windows paths and rewrites `D:\...` to `/mnt/d/...`, because the tool runs under WSL against photos on the Windows side.

The repo also ships a Claude Code command, `/clean`, for a single image. Give it a Windows or WSL path and it runs the same two passes at the default strengths. It saves to `cleaned/` beside the original at JPEG quality 98, keeps the profile and metadata, and shows you the result.

## What I would tell someone starting this

The inpainting model isn't a bad model; it solves the wrong problem. A backdrop doesn't need pixels invented. It needs its fine detail toned down and its shadows blended toward a colour already in the frame. Stated that way, the tool is `cv2.GaussianBlur`, `cv2.distanceTransform` and a median.

The two traps in what's left, an array-shape mismatch and a floor threshold tuned on the wrong photos, are both cheaper to find than one smudged headshot is to explain. Source, before and after images and the docs site are in the [repo](https://github.com/isaacrowntree/clean-backdrop), MIT licensed.
