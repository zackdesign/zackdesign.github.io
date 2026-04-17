---
layout: post
title: "Clean Backdrop — free, GPU-accelerated studio backdrop cleanup"
description: "An open-source alternative to Retouch4me Clean Backdrop — shadow lift plus frequency separation on a BiRefNet-Portrait mask, run on CUDA. No AI inpainting artifacts."
excerpt: "An open-source alternative to Retouch4me Clean Backdrop — shadow lift plus frequency separation on a BiRefNet-Portrait mask, run on CUDA. Clean math, no AI inpainting artifacts."
image: /images/blog/clean-backdrop.jpg
image_alt: Black and white photography studio with lighting gear and seamless backdrop
date: 2026-03-25
last_modified_at: 2026-03-25
categories: [open-source]
tags: [python, photography, cuda, birefnet, image-processing, open-source]
---

Zack Design has published [`clean-backdrop`](https://github.com/isaacrowntree/clean-backdrop) — a free, open-source tool for cleaning up studio portrait backdrops. Shadow lift plus frequency separation on a high-quality portrait segmentation mask, running on a CUDA GPU, no AI inpainting artifacts anywhere. It is a clean-math alternative to paid tools like Retouch4me Clean Backdrop.

<!-- more -->

## The problem

Studio paper backdrops are never as clean as they look before the shoot. A six-hour session leaves scuff marks, footprints, seam shadows where the paper meets the floor, uneven lighting where the key light rolled off, and the occasional crease from the roll dispenser. Fixing those by hand in Photoshop — with the healing brush, dodge/burn layers, and a feathered mask around the subject — is a real job. For a shoot with two hundred keepers, it is unreasonable.

The commercial tools that automate this are excellent and expensive. `clean-backdrop` is the free alternative.

## How it works

Two complementary techniques, run on GPU:

1. **Shadow Lift.** Samples a patch of clean wall, then blends cast shadows toward that reference. Preserves the natural wall gradient (studios are not lit perfectly flat and should not be rendered that way). Adjustable 0–100%.
2. **Texture Smoothing (Frequency Separation).** Splits the image into a low-frequency lighting gradient and a high-frequency detail layer. Smooths the detail layer — where marks, scuffs, and paper texture live — while leaving the gradient untouched. No smudging, no false positives on the subject's hair.

Both passes run on a **[BiRefNet-Portrait](https://github.com/ZhengPeng7/BiRefNet)** subject segmentation mask with distance-based feathering, so the boundary between subject and cleaned background has no visible "bar" artifact at any crop size.

## Smart edge handling

- **Smooth subject masking.** Feathering scales with image size, so a 24 MP portrait has the same clean transition as a 45 MP headshot.
- **Automatic floor detection.** Real floors (wood, tile, concrete) are distinguished from wall shadow/vignetting by a colour-analysis heuristic. Real floors stay; darkening on walls gets cleaned.
- **Vertical floor transition.** The wall-to-floor boundary uses a row-based ramp so the floor texture and contact shadows around the subject's feet are never disturbed.

## Running it

There are two ways to use it:

```bash
# Web UI — drag-and-drop with live sliders
pip install -r requirements.txt
python app.py
# open http://localhost:5000
```

```bash
# Batch — directory in, directory out
python batch.py "D:\Photos\Export\My Shoot" --lift 70 --texture 50
```

The web UI shows four tabs — Original, Shadows, Texture, Preview — so you can dial shadow lift and texture smoothing independently and watch the separation happen. Outputs are saved next to the original with a `_clean` suffix, ICC colour profiles and EXIF metadata preserved.

## Why open-source

Because the underlying math is not exotic — shadow lift and frequency separation have been in the photo-retouching toolkit for twenty years — and because a high-quality portrait segmentation model exists under a permissive licence. The commercial offerings are polished, but the core workflow does not need to be proprietary. If you shoot regularly against studio paper, [clone the repo](https://github.com/isaacrowntree/clean-backdrop) and stop paying a per-seat fee for a batch operation.
