---
layout: post
title: "color-grade-ai — AI-assisted .cube LUT generation"
description: "A Claude Code skill that measures a video frame and fits a .cube 3D LUT to correct it — including the four months its white-balance advice was backwards, and the eleven-defect evaluation set that now scores every change."
excerpt: "A Claude Code skill that measures a video frame and fits a .cube 3D LUT to correct it — including the four months its white-balance advice was backwards, and the eleven-defect evaluation set that now scores every change."
image: /images/blog/color-grade-ai.jpg
image_alt: Cinema camera with a large lens in a professional production setting
date: 2026-02-04
last_modified_at: 2026-11-16
categories: [open-source, ai]
tags: [video, color-grading, lut, davinci-resolve, premiere, claude-code, ai]
---

Zack Design's **[color-grade-ai](https://github.com/isaacrowntree/color-grade-ai)** is a Claude Code skill for colour-correcting video. It takes one video frame, measures what is wrong with its colour, and writes a correction as a **LUT** (a look-up table: a file that says, for every input colour, what output colour to show) in the `.cube` text format that DaVinci Resolve, Adobe Premiere Pro and `ffmpeg -vf lut3d` all load. The measuring uses **classical colour science and no machine learning**, and an **eleven-defect evaluation set** now scores every change. **MIT licensed.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/isaacrowntree/color-grade-ai" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
  <a href="https://isaacrowntree.github.io/color-grade-ai" target="_blank" rel="noopener" class="btn btn-outline-primary btn-lg">Documentation</a>
</div>

This post covers:

- why it exists, and what the analyser measures at each step of the correction chain;
- the four months its white-balance advice was backwards;
- why tone curves moved from HSL lightness to true luminance (14 of the 27 shipped LUTs changed, and saturated colours moved by up to 0.37 on a 0-to-1 scale);
- the solver that re-measures after each candidate correction, and the eleven-defect evaluation set that scores it (81% of each defect removed on average, 60% in the worst case);
- the two ways real footage broke it;
- the interactive preview, trying it yourself, and what was learned.

<!-- more -->

## Why it exists

It started with one job: dance and party footage where red stage lights made skin look sunburnt. The first release, on 4 February 2026, was six hand-tuned LUT presets and a Claude Code skill to pick between them. The same day, the skin preset had to be widened. Skin under red practical lights was far more saturated and darker than the preset's window allowed, so it ignored every skin pixel in the underexposed scenes it was built for.

Presets alone meant guessing which one to use, and how hard. The rest of this post replaces that guess with a measurement.

## What a frame is measured for

The pipeline is Python for measurement and Ruby for LUT generation. Ruby needs no gems, and Python needs only Pillow, NumPy and PyYAML. A grade is a chain of steps, which Resolve calls nodes. `auto_grade.py` reports one measurement per node, using classical colour science and no machine learning:

- **Exposure**: where the darkest, middle and brightest parts of the picture sit. The median should be near 45% of full brightness, and it reports how much of the frame sits above 92%, where highlights start to clip.
- **White balance**: the "Shades of Gray" estimate (Finlayson and Trezzi 2004). It averages pixels with an exponent of 6, which leans toward the brighter ones. It is cross-checked against a "White Patch" estimate from the brightest 1% of pixels, and reported as a gain per colour channel.
- **Skin**: a detector for skin-coloured pixels in the YCbCr colour space, shared with the solver. It measures the average hue of skin against the line, at roughly 20 degrees, along which real skin tones sit.
- **Saturation**: the Hasler–Süsstrunk colourfulness measure, reported only when it leaves a plausible band.
- **Black level**: the brightness of the darkest pixels. Blacks below 2% are solid and above 5% read as milky. It also measures shadow noise and checks the shadows are neutral rather than tinted.

```bash
python3 footage_type.py frame.png                 # log or display-referred?
python3 auto_grade.py frame_709.png --emit fix.cube
python3 match_grade.py reference.png shot.png --emit match.cube
python3 sample_clip.py clip.mov --emit fix.cube   # fit across a clip, not one frame
ruby generate_chain_lut.rb studio_balanced.cube \
  studio_punch@0.8 warm_shift@0.3 sat_boost@0.5 black_crush@0.15
```

The `@0.8` suffix is each node's strength. The chain is baked into one `.cube` that loads as a single LUT in any editor. `sample_clip.py` takes the median of 12 frames across a clip, and warns when the clip varies too much for one LUT.

## The white-balance advice was backwards

From the day `auto_grade.py` landed in April until August, the headline command told you to warm up a scene that was already too warm.

The analyser reports a gain per colour channel: green's average divided by that channel's average. A gain below 1 means the channel is already too strong. The code read it the other way round. A synthetic warm cast measured a red gain of 0.800 and a blue gain of 1.391, and was told to apply `warm_shift`. The green-cast check had the same flaw: it fired on a magenta cast.

![Left: the red, green and blue gains measured on a warm frame, red at 0.800 below the 1.0 line and blue at 1.391 above it. Right: a gain below one means the channel is already too strong, so the correct advice is to cool the shot; the code advised warming it.](/images/blog/color-grade-gain-direction.svg)

Nobody noticed for a simple reason. The summary loop crashed with a `KeyError` on any frame that had a cast, but only after printing the report. Only a perfectly neutral frame ran to the end.

## Tone curves were applied in the wrong colour space

Version 1 applied every tone curve to HSL lightness (the average of a pixel's brightest and darkest channel) on gamma-encoded Rec.709, the standard encoding of HD video. That is wrong twice.

First, HSL lightness is not how bright a colour looks. A fully saturated red has a lightness of 0.5 but a Rec.709 luminance of 0.21. So a saturated colour and a grey that look equally bright were adjusted by different amounts, and colours drifted relative to greys. Second, rewriting the lightness and converting back through `hsl_to_rgb` doesn't preserve hue or saturation. Meanwhile `auto_grade.py` measured true Rec.709 luminance, so the analyser and the generator disagreed about what "luminance" meant.

Version 2, in `generate_lut.rb`, works in linear light:

1. Undo the display encoding with the BT.1886 curve (a pure power of 2.4, not the sRGB curve).
2. Apply the tone curve to Rec.709 luminance.
3. Scale red, green and blue by the same ratio, which keeps hue and saturation unchanged by construction.

Where brightening pushes a colour out of range, it is desaturated rather than clipped per channel, which would skew the hue.

Greys come out bit-identical to version 1. Saturated colours move by up to 0.37 at the most saturated grid points. 14 of the 27 shipped LUTs changed; the 13 that only adjust hue or saturation did not. `--legacy` reproduces version 1 exactly.

`test_luts.rb` checksums every generated LUT against `reference_checksums.yml`, a 4 KB file of SHA-256 hashes rather than 25 MB of reference LUTs. Any change to the maths fails until you regenerate on purpose.

## Fitting the correction by re-measuring

Strengths used to be guessed with constants like `deviation * 10` and `abs(gamma - 1) * 5`, with no feedback. `solve_grade.py` applies a candidate correction, measures the frame again, and keeps the value that leaves the least error.

The preset library turned out to be too gentle to choose from. `cool_shift` moves a channel by 4% at full strength, and no combination of presets neutralises a 22% tungsten cast. The first solver picked presets, ran out of strength at 1.0, and still failed. Now white balance, exposure and black level are fitted directly from the measurement and baked into a LUT by `bake_lut.rb`. Skin stays on the tuned `red_skin_fix` preset, because it corrects a shape, not a magnitude.

`eval_scenes.py` applies known defects to a synthetic scene. `test_eval.py` asserts how much of each defect the grade removes:

| Case | Defect applied |
|---|---|
| `warm_tungsten` | channel gains (1.22, 1.0, 0.78) |
| `cool_daylight` | channel gains (0.80, 1.0, 1.20) |
| `green_led` | channel gains (0.93, 1.12, 0.94) |
| `magenta_stage` | channel gains (1.14, 0.88, 1.10) |
| `underexposed` / `overexposed` | gamma 1.55 / gamma 0.62 with highlight gain 1.08 |
| `milky_blacks` | black lift 0.16 |
| `warm_and_dark`, `cool_and_milky` | combinations of the above |
| `washed_out` / `oversaturated` | saturation 0.32 / 1.95 |

The rules:

- every case must improve;
- at least 40% of each defect must be removed;
- the warm, cool and green casts must cut white-balance error below 60% of the original.

On average 81% of a defect is removed, and the worst case is 60%.

Building the set exposed that the "pristine" scene didn't measure as correct; some defective versions scored better. It was rebuilt to sit exactly on the targets. Another surprise: the solver's stage-by-stage search is greedy, and on two of the first nine cases it finished behind the plain, un-searched fit. It now computes both and returns whichever measures better.

Saturation is deliberately not fitted toward a number. A grey warehouse is legitimately drab, and a fruit market legitimately vivid. The evaluation scene measures 63.8 against the analyser's old target of 45, so the old advice on that correct scene was `sat_reduce`. The metric now stays silent anywhere inside a band of 25 to 95, and the report and the solver read the same constant.

## Real footage broke it twice

Every synthetic case is display-referred Rec.709: the pixel values are already the ones a screen should show. Log footage is different. It is a camera's flat, low-contrast encoding that keeps more dynamic range for grading later.

**Log footage was graded as if it were broken.** The analyser read the lifted blacks and flat contrast as defects, and fitted a plausible-looking wrong grade without complaint. `footage_type.py` now measures which encoding it is looking at and states it on every run. There are three outcomes, not two:

- **display**: everything runs;
- **log**: exposure and black level are held back;
- **ambiguous**: a heavily flattened, lifted, desaturated display grade can't be told from log by shape alone, so tone fitting is held back and it asks you. `--transfer` overrides.

The one signal that tells them apart is where the median sits within the frame's range. Rescaling a display image leaves it at 0.446; a log curve moves it. Of two real frames, one cleared that bar and the other, at 0.494, is reported as ambiguous. White balance and skin still run on log, because a cast is a cast whatever the curve.

**Sparse skin dominated the score.** On one real frame, 1,763 skin pixels drove 58% of the total error. That is 0.021% of the image, and the solver ignores skin below 1% of the frame. The optimiser was being graded on a term it wasn't allowed to touch. That is why it removed only 23% of the defect on real footage, against 79% on synthetic scenes. The reporting and fitting thresholds are now one constant, and the skin term is weighted by how confident the detector is.

Skin detection itself was rewritten. The old rule was a box of hue, saturation and value ranges (hue 0 to 50, saturation 0.10 to 0.70, value 0.20 to 0.90). It also selected wood, khaki and amber lamps. The new YCbCr region is generous toward flushed and sunburnt skin, which is what `red_skin_fix` corrects, and tight toward wood. `test_eval.py` asserts it rejects wood and terracotta and accepts the full range of skin tones. Leaving skin and saturated props out of the white-balance estimate dropped the pristine scene's white-balance error from 0.10 to 0.0003.

## Interactive preview

`preview.html` and `pipeline.mjs` are a JavaScript port of the Ruby LUT engine. Drag in a frame, load a conversion LUT, dial six nodes, and export the chain you're looking at.

The preview used to blend a full-strength LUT's output with the original image. The command line scales the preset's parameters instead. Greys agreed, so nobody noticed, but for `studio_punch` at 50% the two differed by up to a quarter of the range on saturated colours. The preview now generates LUTs live at the exact strength you set.

`node --test test_pipeline.mjs` checks the port against Ruby run live, not against committed files. The committed LUTs only pin ten strengths, while the slider offers 101. The test sweeps every preset at every slider value, in both colour models, and they agree to 1e-12.

## Trying it

You need Ruby 2.7 or later to generate LUTs, and Python 3 with Pillow, NumPy and PyYAML to analyse frames. ffmpeg extracts frames and samples clips.

```bash
git clone https://github.com/isaacrowntree/color-grade-ai.git
cd color-grade-ai
pip3 install Pillow numpy PyYAML

ffmpeg -i your_video.mov -ss 00:00:30 -frames:v 1 frame.png
python3 auto_grade.py frame.png --emit fix.cube
ruby generate_lut.rb red_skin_fix skin_fix.cube

python3 -m http.server 8080      # preview at http://localhost:8080/preview.html
```

To use it as a Claude Code skill, clone it to `~/.claude/skills/color-grade` (or `.claude/skills/color-grade` in a project). It also ships a plugin manifest in `.claude-plugin/plugin.json`. Then ask Claude to grade a frame or fix red skin.

The docs site is generated from `SKILL.md` by `generate_docs.rb`, and `test_luts.rb` now fails CI if the published page drifts from it, which it had.

If you only want the LUTs, you need none of this: `correction_luts/` holds all 27, regenerated from `manifest.yml` and checked for drift in CI.

## What was learned

Two entry points were broken for months and no test noticed. One was the inverted white-balance branch. The other was `analyze_frame.rb`, which mixed a Python script's error output into its normal output. When Pillow deprecated a function, the warning landed on top of the JSON and every run crashed.

Testing its replacement found one more: hue averaged as a plain number puts the average of 359 and 1 degrees at 180, the opposite colour. Reds straddle that point, and reds are most of what this tool looks at.

The Ruby, Python and Node test suites and a closed-loop evaluation set now run on every push, because "the grader got better" needed to be a number. Source on [GitHub](https://github.com/isaacrowntree/color-grade-ai), full docs at [isaacrowntree.github.io/color-grade-ai](https://isaacrowntree.github.io/color-grade-ai).
