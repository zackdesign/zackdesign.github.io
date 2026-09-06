---
layout: post
title: "vesc-workbench — my electric skateboard's display refused firmware 7, so I taught the board to lie about its version"
description: "An open-source workbench for VESC motor controllers: config read/write/verify, LispBM development and diagnostics over a phone's Bluetooth bridge, with no USB. Includes a shim that keeps a discontinued DAVEGA X display alive on VESC firmware 7."
excerpt: "A DAVEGA X on VESC firmware 7 boots, checks two bytes, and gives up. The telemetry protocol did not change at all. So the fix is sixty lines of Lisp running on the motor controller itself."
image: /images/blog/vesc-workbench.jpg
image_alt: An all-terrain electric longboard photographed from directly above, lying on grass — griptape deck, pneumatic tyres and blue motor hubs.
date: 2026-09-06
last_modified_at: 2026-09-06
categories: [open-source]
tags: [lispbm, lisp, python, qml, makefile, vesc, embedded, firmware, reverse-engineering, electric-skateboard]
---

Zack Design has published **[vesc-workbench](https://github.com/isaacrowntree/vesc-workbench)** — a scripted workbench for VESC motor controllers. Read, write and verify configuration, develop LispBM, and diagnose problems, all over a phone's Bluetooth bridge with no USB cable and without opening the enclosure. It ships with a shim that keeps a discontinued DAVEGA X display working on VESC firmware 7.

**MIT licensed.**

<!-- more -->

**Source → [github.com/isaacrowntree/vesc-workbench](https://github.com/isaacrowntree/vesc-workbench)** (MIT)

## Why this exists

I have a LaCroix Nazaré. It is an electric skateboard with a FOCBOX Unity motor controller sealed inside the enclosure, and I ride it on grass at a golf course, which is a demanding enough surface that the settings actually matter.

Two things were true at once. The controller wanted to be on firmware 7 — better FOC, LispBM scripting, several years of fixes. And the DAVEGA X display bolted to the deck refused to run on it:

> supported vesc firmware versions 5.x to 6.x - press any button to restart

DAVEGA is discontinued. There is no display-side update coming. The obvious move is to downgrade the controller and forget about it, which is what most people do.

The less obvious observation is that **the telemetry protocol did not change**. `COMM_GET_VALUES` returns the same twenty-five fields in the same order with the same scaling in 6.00 and in 7.x. The display is not failing to parse anything. It reads the two version bytes in `COMM_FW_VERSION`, sees a 7, and declines to have the conversation.

So the fix is not a port. The fix is to change two bytes in one packet.

## Sixty lines of Lisp, running on the motor controller

VESC firmware 6.06 and later embed **LispBM**, a small Lisp interpreter, and expose the firmware's own command decoder to it as `cmds-proc`. That is the whole trick. A script on the ESC can take the UART line the display talks to, hand every packet to the firmware's real handler, and rewrite the reply on the way back out:

```lisp
(defun fixfw (d) {
    (var n (bufget-u8 d 1))
    (if (and (= (bufget-u8 d 0) 2) (= (bufget-u8 d 2) 0)) {
        (bufset-u8 d 3 6)                    ; FW_VERSION_MAJOR -> 6
        (bufset-u8 d 4 0)                    ; FW_VERSION_MINOR -> 0
        (bufcpy p 0 d 2 n)                   ; crc16 always starts at index 0
        (var c (crc16 p n))
        (bufset-u8 d (+ 2 n) (shr c 8))
        (bufset-u8 d (+ 3 n) (bitwise-and c 255))})})
```

Everything else passes through untouched, including the CRC-16 framing, which has to be recomputed for the one packet we edit. The display sees a 6.00 controller. It is talking to a 7.00 controller. Both are telling the truth about the only thing that matters, which is the telemetry.

The claim that the payload is unchanged is not something you should take my word for. `tests/protocol-diff.sh` checks out both firmware versions from upstream and diffs the serialisation, on every CI run. If Vedder ever does change the layout, the test goes red and the shim is wrong in a way you find out about immediately.

The Lisp itself is tested by running it in the **upstream LispBM REPL** in Docker, with stubs for the VESC extensions — not by transcribing it into Python and testing the transcription. This matters more than it sounds. LispBM symbols are case-insensitive, `t` is a special symbol that never resolves from the environment, and `uart-read`'s timeout argument is in seconds and is not where you would guess. A test that runs the actual interpreter catches all three. A reimplementation catches none of them.

## The part that turned out to be more useful than the shim

To develop any of this I needed to script the controller from my laptop. The board's USB port is inside a sealed enclosure. The phone talks to it over Bluetooth.

VESC Tool has a CLI, and the CLI is serial-only — `--vescPort` goes straight to `connectSerial()`, and it rejects a TCP address and rejects a `socat` PTY too. I wrote that down as a dead end. It was not one.

VESC Tool also takes `--loadQml`, and QML loaded that way runs with `VescIf` in scope, and `VescIf.connectTcp()` is invokable. The phone app has a "Wireless Bridge to Computer (TCP)" mode. Put those together and the entire configuration API — every motor parameter, both sides of a dual controller, LispBM upload, live telemetry — is reachable from a Makefile, over Bluetooth, with the board sitting on the bench and nothing plugged into it.

```sh
make pull      # read both motor sides' configs to XML
make apply     # write them back, then verify by reading them again
```

That is settings under version control, diffable, reviewable, and reversible. Which is a different relationship with a motor controller than clicking through tabs in a GUI and hoping.

## What else is in it

The rest of the repo is the affordances that fell out of doing this for a week:

- `make ppm-watch` — live remote readout that prints only on change, and distinguishes *the remote is not transmitting* from *the decoder is not running*. In a GUI those look identical.
- `make ppm-cal` — guided throttle calibration: neutral, full throttle, full brake, written back and verified.
- `make motors-off` / `motors-on` — cut motor output via `app-disable-output` with no configuration write, so you can work on a live board with the display running and the wheels inert.
- `make davega-debug` — sixty seconds of proxy counters with a verdict at the end, using LispBM globals as a telemetry channel because they come back in `lispGetStats` even when print output does not.
- `make lisp-erase` — back to stock behaviour, always one command away.

And `docs/known-issues.md`, which is the document I wanted to find and could not. `uart-start` permanently flashes `app_to_use = APP_NONE`, which kills your throttle in a way that survives a reboot and looks like a hardware fault. The PPM sub-config silently refuses writes while `ctrl_type` is 0. A read taken while the ESC is still booting returns values that look exactly like a corrupted config and are not.

## Did this already exist?

Pieces of it. There are forum threads with LispBM snippets, there is a well-documented protocol, and there are people who have clearly solved the DAVEGA problem privately. What I could not find was any of it as a repository you can clone, test and run.

The closest prior art is downgrading, which works and costs you the firmware.

## One correction worth publishing

The esk8 forums will tell you that VESC's built-in traction control interferes with braking and is dangerous. I enabled it, then went and read `app_ppm.c` to understand the failure mode.

It lives entirely in the non-brake branch. Braking never reaches the traction-control code, and the whole thing self-disengages on any fault. The warning is real for some other control paths; for PPM on current firmware it is repeated folklore. That is in the docs too, with the file and the branch, so the next person can check my reasoning rather than trusting either of us.

## Where it's at

Telemetry is live on my board right now: a DAVEGA X showing speed, current, voltage and distance from a controller running firmware 7.00 that it believes is running 6.00. The board is tuned for grass, 80 A a side, and it is punchy in exactly the way I wanted.

The hardware coverage is honest: FOCBOX Unity, one board, one display. `profiles/` holds one file per known-good setup, and it deliberately holds *connection details only* — not current limits, not gearing. Copying a stranger's motor tuning is how packs and motors get damaged. Run the detection wizard.

If you have a VESC, a sealed enclosure and a scripting habit, the workbench part is useful on its own.

---

*Header photo by [Khudadad Alam](https://unsplash.com/@khudadad) on [Unsplash](https://unsplash.com).*
