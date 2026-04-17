---
layout: post
title: "color-grade-ai — AI-assisted .cube LUT generation"
description: "A Claude Code skill that analyses a video frame, identifies colour problems, and generates a targeted .cube 3D LUT for DaVinci Resolve and Adobe Premiere Pro."
excerpt: "A Claude Code skill that analyses a video frame, identifies colour problems, and generates targeted .cube 3D LUTs for DaVinci Resolve and Premiere Pro."
image: /images/blog/color-grade-ai.jpg
image_alt: Cinema camera with a large lens in a professional production setting
date: 2026-02-04
last_modified_at: 2026-02-04
categories: [open-source, ai]
tags: [video, color-grading, lut, davinci-resolve, premiere, claude-code, ai]
---

Zack Design has published [`color-grade-ai`](https://github.com/isaacrowntree/color-grade-ai) — a small, practical Claude Code skill that takes a single video frame and generates a targeted `.cube` 3D LUT to fix the colour problems it sees. It works in DaVinci Resolve, Adobe Premiere Pro, and anywhere else `.cube` LUTs are honoured.

<!-- more -->

## The pitch, in one paragraph

Feed it a frame. It tells you what is wrong (too yellow, crushed blacks, over-saturated skin, weird magenta cast in the highlights) and generates a `.cube` LUT that corrects it. Drop the LUT onto a node in Resolve, a Lumetri Look slot in Premiere, or an `ffmpeg -vf lut3d` pass — and the fix is applied.

## How it works

Under the hood, `color-grade-ai` is a pair of small Ruby + Python scripts with a LUT-chain engine sitting between them:

```bash
# Auto-analyse a frame and get per-node recommendations
python3 auto_grade.py frame_709.png

# Generate a single correction LUT from a named preset
ruby generate_lut.rb red_skin_fix skin_fix.cube

# Bake a creative chain into one LUT
ruby generate_chain_lut.rb studio_balanced.cube \
  studio_punch@0.8 warm_shift@0.3 sat_boost@0.5 black_crush@0.15
```

The `@0.8` syntax is how each node in the chain carries its own intensity, so you can dial in a look without editing the underlying preset. When a chain is baked into a single `.cube`, it loads as one LUT in any editor — no node-tree rebuilding required.

## Interactive preview

Because nobody wants to bounce between an editor and a terminal, the repo ships a browser preview UI. Drag a frame in, load a conversion LUT, dial corrections across a six-node chain, and see the result live. It is a ~150 line HTML page backed by a local Python `http.server` — no build step, no framework.

## As a Claude Code skill

`color-grade-ai` is structured as a [Claude Code](https://claude.com/claude-code) skill, which means once it is cloned into `~/.claude/skills/color-grade` (or the project-level equivalent), you can ask Claude things like *"grade this frame for a warm studio look, keep the skin neutral"* and it drives the same scripts with the right presets, chains, and intensities. The `SKILL.md` file documents every preset, every node in the chain, and every creative preset so the model has a structured API surface to reason about.

## Why it is useful

Most editors grade by feel — curves, wheels, a faint sense that "this is too yellow." That is a perfectly fine workflow for a hundred clips. It is *not* a fine workflow for a couple of hundred clips shot across multiple cameras under mixed light, where consistency matters more than feel. `color-grade-ai` exists for the batch case: give it the same analyser and the same LUT-chain, and every clip in a folder gets graded against the same reference.

Source on [GitHub](https://github.com/isaacrowntree/color-grade-ai), full docs at [isaacrowntree.github.io/color-grade-ai](https://isaacrowntree.github.io/color-grade-ai).
