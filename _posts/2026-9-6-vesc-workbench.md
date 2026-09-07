---
layout: post
title: "vesc-workbench — scripting a sealed motor controller, and the dashboard that came out of it"
description: "An open-source workbench for tuning VESC motor controllers over your phone's Bluetooth bridge with no USB — and, once the discontinued DAVEGA X display turned out to be a scriptable ESP32, ten replacement dashboards for it, tested without hardware."
excerpt: "Tuning a VESC means clicking through tabs in a GUI, hoping you wrote the number you think you wrote, with no record of what changed. It doesn't have to. The whole configuration API is scriptable over your phone's Bluetooth bridge — VESC Tool just doesn't tell you how. That was the plan. The display bolted to the deck turned out to be the more interesting problem."
image: /images/blog/vesc-workbench.jpg
image_alt: A LaCroix electric skateboard shot head-on against black — Hypertrucks splayed wide on pneumatic tyres, a blue anodised hanger, twin LED pods and a carbon deck.
date: 2026-09-06
last_modified_at: 2026-09-07
categories: [open-source]
tags: [lispbm, lisp, python, micropython, qml, makefile, vesc, embedded, firmware, reverse-engineering, ui-design, electric-skateboard]
---

Zack Design has published **[vesc-workbench](https://github.com/isaacrowntree/vesc-workbench)** — a scripted workbench for tuning **VESC** motor controllers. Read, write and verify configuration, develop LispBM, and diagnose the remote and the motors, all from a Makefile over your phone's Bluetooth bridge. No USB cable, no opening the enclosure.

It also contains ten dashboards for a display its manufacturer stopped supporting, which is not what I set out to build.

**MIT licensed.**

<!-- more -->

**Source → [github.com/isaacrowntree/vesc-workbench](https://github.com/isaacrowntree/vesc-workbench)** (MIT)

## If you tune a VESC, this is for you

Everyone who runs a VESC ends up in the same loop. Change a current limit. Ride. Change it back. Change the throttle curve. Ride. Was that better, or was it a headwind? What did you actually have it set to three weeks ago, before the thing you're now trying to undo?

The tooling does not help you here. VESC Tool is a good GUI, but it is a GUI: you click through tabs, you hope you typed the number into the field you meant, and when you are done there is no record of what changed. Exporting an XML backup is a manual step you take *instead of* riding, so nobody does it every time — and a backup you only take before something scary isn't a history. And on a lot of builds — a sealed skate enclosure, a scooter deck, an ebike downtube — the USB port is behind screws, so you are doing all of this on a phone, standing in a driveway.

This repo is that loop, scripted:

```sh
make pull      # read both motor sides' configs to XML
make apply     # write them back, then verify by reading them again
```

Your settings are now text files. You can `git diff` a tuning session, review it before it goes near the motors, and revert it in one command. `apply` reads back after writing, so a setting that didn't take is something you find out about at the bench rather than at speed — which matters, because `setMcconf(false)` accepts a write and silently discards it.

And it runs over Bluetooth, from your laptop, with the board sitting where it is.

## The connection trick, because nobody documents it

This is the part worth the post on its own, so [it has its own page](https://github.com/isaacrowntree/vesc-workbench/blob/master/docs/connecting.md) in the repo.

VESC Tool ships a CLI. It looks like it should solve everything, and then it doesn't: `--vescPort` calls `connectSerial()` and takes a serial device, full stop. Hand it an IP and it refuses. Bridge the TCP socket to a `socat` PTY and it opens the port and then never completes the handshake. If your controller isn't reachable over USB, the documented CLI is a dead end.

I wrote that down as impossible. It isn't.

VESC Tool also accepts `--loadQml`, and QML loaded that way runs *inside the application*, with the `VescIf` singleton in scope. `VescIf` is the whole connection and configuration API — and `VescIf.connectTcp()` is invokable from it. The phone app has a **Wireless Bridge to Computer (TCP)** mode sitting right there on its Start page.

So the path is:

```
your laptop  --TCP-->  phone (VESC Tool app)  --BLE-->  ESC
```

The entire minimum viable version:

```qml
import QtQuick 2.7

Item {
    id: root
    property int ticks: 0

    Component.onCompleted: VescIf.connectTcp("192.168.1.100", 65102)

    Timer {
        interval: 500; running: true; repeat: true
        onTriggered: {
            root.ticks++
            if (root.ticks > 60) { console.log("timeout"); Qt.quit() }
            if (!VescIf.isPortConnected()) return

            // Firmware params arrive AFTER the socket connects. Until they do,
            // getFirmwareNow() returns "x.x" and every config read is garbage.
            var fw = VescIf.getFirmwareNow()
            if (fw.indexOf("x.x") >= 0) return

            console.log("connected, fw " + fw)
            VescIf.disconnectPort()
            Qt.quit()
        }
    }
}
```

```sh
"/Applications/VESC Tool.app/Contents/MacOS/VESC Tool" --offscreen --loadQml connect.qml
```

That's it. `--offscreen` keeps the GUI away, `console.log` goes to stdout, and from there `VescIf.mcConfig()`, `VescIf.appConfig()` and `VescIf.commands()` are all yours. You do not need the rest of my repo to use this — take the file.

That comment about `"x.x"` is not decoration: the socket connects several seconds before the firmware parameters arrive, and a config read in that window returns defaults that look exactly like a controller which has wiped itself.

## Diagnostics that answer the actual question

Half of tuning is not tuning, it's working out what is wrong. A GUI shows you a number; it rarely tells you *why the number is that*.

```sh
make ppm-watch    # live remote readout — prints only on change
make ppm-cal      # guided calibration: neutral, full throttle, full brake
make probe        # connect, report firmware and LispBM state
make check        # is the bridge up? is desktop VESC Tool holding it?
```

`ppm-watch` distinguishes **the remote is not transmitting** from **the decoder is not running**. In VESC Tool those look identical — a still bar — and they have completely different fixes. `make check` does the same thing for the connection: it tells you which failure you have in a second, instead of leaving you to interpret a two-minute timeout.

And when you're working on a board that is powered up:

```sh
make motors-off   # kill motor output, no config write, display stays live
make motors-on
```

`app-disable-output` rather than a configuration change, so nothing needs undoing afterwards and nothing gets left in a weird state if you walk away.

## The findings are the other half of the repo

`docs/findings.md` is the document I wanted to find and could not. The pattern in all of them is the same: the ESC does something reasonable, reports it accurately, and the accurate report points at the wrong thing.

| What you see | What is actually happening |
|---|---|
| Throttle dead after a LispBM script ran, and a reboot doesn't fix it | `uart-start` permanently flashes `app_to_use = APP_NONE` |
| PPM values go in and come back wrong, so you suspect the remote | The sub-config silently refuses writes while `ctrl_type` is 0 |
| "did you forget to upload the code" — which reads like your mistake | `lispWriteCode()` doesn't land code; `CodeLoader.lispUploadFromPath` does |
| A config that looks corrupted | A read taken before the ESC finished booting |

There's a correction in there too. The esk8 forums will tell you VESC's built-in traction control interferes with braking and is dangerous. I enabled it, then read `app_ppm.c` to understand the failure mode: it lives entirely in the non-brake branch, braking never reaches the traction-control code, and it self-disengages on any fault. The warning is real for some other control paths; for PPM on current firmware it's repeated folklore. Documented with the file and the branch, so you can check my reasoning rather than trusting either of us.

## Where it came from: a display that refused to grow up

All of this exists because of a much smaller problem.

I have a LaCroix Nazaré — an electric skateboard with a FOCBOX Unity sealed in the enclosure, which I ride on grass at a golf course, a surface demanding enough that the tuning genuinely matters. I wanted it on firmware 7 for the FOC improvements and LispBM. The DAVEGA X display bolted to the deck refused to run on it:

> Unsupported VESC FW: 7.01
>
> Supported VESC FW versions: 3.48 - 6.x

DAVEGA is discontinued. Everyone downgrades.

I checked whether that was really true rather than assuming it. The vendor's update index still lists a **v5.07rc3, dated 2025-03-11** — newer than the v5.06 the public changelog stops at, released after the shop closed and never announced. It carries the same constant as every version before it. No firmware DAVEGA ever shipped accepts VESC 7.

But **the telemetry protocol did not change**. `COMM_GET_VALUES` returns the same twenty-five fields, same order, same scaling, in 6.00 and in 7.x. The display isn't failing to parse anything — it reads two version bytes, sees a 7, and declines to have the conversation.

VESC firmware 6 embeds **LispBM**, and from 6.06 it exposes the firmware's own command decoder to it as `cmds-proc`. So a script on the ESC can take the display's UART line, hand every packet to the real handler, and rewrite the reply on the way out:

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

Twenty-seven lines for the rewrite, 178 for the whole shim once you count the UART reader and its debug counters. Everything else passes through untouched. The display sees a 6.00 controller; it's talking to a 7.00 controller; both are telling the truth about the only thing that matters.

You shouldn't take my word for the payload being unchanged, so `tests/protocol-diff.sh` checks out both firmware versions from upstream and diffs the serialisation on every CI run. If Vedder ever changes the layout, the test goes red and the shim is wrong in a way you find out about immediately rather than at 40 km/h.

If you have a DAVEGA and want to keep its own firmware, that shim is the whole answer and you can stop reading here.

## Writing LispBM without bricking your throttle

If you're doing anything custom on a VESC, LispBM is where it happens, and the repo treats it as a real development environment:

```sh
make upload-lisp LISP=path/to/script.lisp   # upload and run
make lisp-stats                             # heap, CPU, globals
make lisp-stop / lisp-erase                 # stop, or back to stock
make test-lisp                              # run it in the real interpreter
```

That last one matters more than it sounds. Scripts are tested by running them in the **upstream LispBM REPL** in Docker with stubs for the VESC extensions — not by transcribing them into Python and testing the transcription. LispBM symbols are case-insensitive, `t` is a special symbol that never resolves from the environment (so `(var t ...)` silently kills the context that uses it), and `uart-read`'s timeout argument is in seconds and isn't the argument you'd guess. Running the actual interpreter catches all three. A reimplementation catches none of them.

And `make lisp-erase` is always one command from stock behaviour, which is the thing that makes experimenting on a board you ride tolerable.

## Then the display stopped being a black box

The shim treats the DAVEGA as something to lie to. That stopped being true once I went looking properly.

Its firmware is not open source and the shop closed in 2024, but the vendor's own installer still names its endpoints, and they still resolve. More usefully: the X is an **ESP32 running MicroPython**, and it will give you a REPL. Hold up and down while it boots and it raises its own access point.

From there its filesystem is right in front of you. Settings are a plain `/data/config.json` — which is how I found the display had been configured for 175 mm wheels on 72/16 gearing when the board runs 200 mm on 84/20. It had been under-reading my speed by 18%, silently, for as long as I had owned it. One command fixed it.

It also means the screen is programmable. The firmware runs a user `start.py` *before* the stock app starts, so a replacement dashboard is not a firmware build — it is one file you can delete. Hold UP at boot and it steps aside.

At which point the shim stops being necessary at all. A dashboard I wrote has no version gate to fail, so it reads firmware 7 directly, and the LispBM context on the ESC is free for something better than lying about a version byte — it runs a flight recorder now.

## So the display got ten dashboards

![Ten dashboards for the DAVEGA X, each a different layout, rendered at true 240x320 device size](/images/blog/davega-themes.png)

Ten themes, each with **its own layout** rather than its own colours: a full analogue tachometer, hexagonal shards on a diagonal split, three hairline arcs, one enormous thin numeral, concentric rings with a single red hand, a shift-light rail you read peripherally, a power-flow meter that treats current as more important than speed. The default takes the best idea from each and throws the rest away.

Those are not mockups. Every picture in this post is the real screen code run through a host-side stand-in for the panel, rendering the pixels it actually produced.

The interesting part is not the pictures. It is that **the panel cannot draw a curve.**

The display driver offers `fill_rectangle`, `pixel` and `writeblock`. There is no line, no circle, no polygon. And measured on the device, the costs are not what you would guess:

| | measured |
|---|---|
| `fill_rectangle` | **2.9 ms** — independent of size |
| `pixel` | **2.29 ms** |
| `writeblock`, 240×40 | **12 ms** for 9,600 pixels |
| free heap | **98 kB** — a 200×100 RGB565 buffer fails to allocate |

A draw call costs the same whether it covers nine pixels or nine thousand. So the obvious way to draw an arc — one thin rectangle per column, the way you would rasterise it — costs **481 ms for a 96 px radius**. That is four times the budget for an entire frame, to draw one gauge.

The way through is the third primitive. Compose the curve into a memory buffer and push it in a single transfer: 12 ms a band, and the maths in between is free because it never touches the bus. There isn't enough RAM to hold the whole picture, so it goes in horizontal strips with one buffer reused down the screen, and the drawing code works in absolute screen coordinates while each strip quietly discards what falls outside it.

That is the entire trick, and it is what makes a tachometer possible on a panel with no line primitive. The dial face, its bezel and its twenty-one tick marks are composed once as furniture; the sweep is composed the same way into a band that covers only the dial.

I did try the cleverer version first — repaint only the wedge between the old angle and the new. It is cheaper, and it is wrong: an arc drawn in three pieces lands on different pixels from the same arc drawn in one, because each piece quantises its own start angle. A partial renderer that disagrees with a full repaint is worse than one that costs a few more milliseconds, so the arcs repaint whole. Everything that is a straight line still repaints only its tip.

Steady-state cost across all ten: **23 to 88 ms a frame**, against 5 Hz telemetry.

## The harness is the reason any of it works

A 2.8″ screen bolted to a deck is a terrible place to iterate a design. So before the first dashboard there was a host-side stand-in for the ILI9341 that records every draw call, rasterises to PNG, and models the panel's cost. Screens are pure functions of a telemetry frame, so the same code runs on the device and in CI, and **390 checks** run with no hardware attached.

Four things it catches that looking at the screen cannot:

- **Anything that leaves the 240×320 frame** fails the build, rather than being clipped where you might not notice.
- **Golden images** for every frame in the envelope — standstill, full throttle, hard regen, thermal derate, battery empty, battery full, a fault at speed. Those frames are *generated from the board's verified configuration*, so the extremes a real ride rarely produces are covered on purpose.
- **Partial redraw against a full repaint**, across all **810** transitions between envelope frames and themes. Partial redraw's failure mode is stale pixels — a value that got shorter, a gauge that receded — and the two paths must agree exactly, pixel for pixel.
- **Chrome labels against live regions.** A label is drawn once; a region repaints whenever its value changes; the panel's font is opaque. So a label sitting inside a region's box is erased the first time that value moves and never comes back. It looks right at a standstill and wrong thirty seconds into a ride.

That last one is the test I'm most pleased with, because the harness was flattering the design until I fixed it. It drew glyphs without their backgrounds, while the real font fills the whole character cell — so labels that punched holes through their own gauges looked perfect in every render. Modelling the panel honestly made four themes fail immediately.

Every theme goes through all of it, and a parity test asserts each of the 64 declared colours actually appears in the rendered output, so a palette nobody has looked at cannot ship.

## Where it's at

Telemetry is live: a DAVEGA X running a dashboard I wrote, reading a FOCBOX Unity on firmware 7.00 directly, no version spoofing in the path. A Unity is two controllers in one case, and the standard reply only carries whichever one answered — its own temperature, its own tachometer — so the local ESC is asked over the wire and the second is asked through it over CAN, and the two are combined the way DAVEGA's own Unity code does it: pack current and energy summed, per-motor figures averaged, distance counted once. Temperature is the one place I diverge and take the hotter of the two, because an average hides the controller that is about to derate behind the one that is fine.

The board is tuned for grass, 80 A a side, and traction control is on and confirmed after a hard run round a golf course. Themes and the dashboard both install over WiFi in one command, as precompiled bytecode — MicroPython compiles a `.py` every time it imports it, and on this ESP32 that compile was most of the wait between switching the board on and seeing a number.

Hardware coverage is honest — FOCBOX Unity, one board, one display — but the connection layer and the config workflow aren't Unity-specific at all. `profiles/` holds one file per known-good setup, and deliberately holds *connection details only*: not current limits, not gearing. Copying a stranger's motor tuning is how packs and motors get damaged. Run the detection wizard, then use this to keep track of what you changed.

If you have a VESC and a scripting habit, start with [docs/connecting.md](https://github.com/isaacrowntree/vesc-workbench/blob/master/docs/connecting.md). Even if you use nothing else, having your board's configuration in git is worth the twenty minutes.
