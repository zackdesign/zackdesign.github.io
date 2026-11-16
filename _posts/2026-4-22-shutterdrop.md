---
layout: post
title: "Shutterdrop — wireless tethered phone camera for your Mac"
description: "Tap the phone, a HEIC lands in ~/Pictures/Shutterdrop on the Mac. The whole protocol is three HTTP endpoints, the receiver is one Python file with zeroconf as its only dependency, and the hard parts are pairing, multipart boundaries and writing the file atomically."
excerpt: "Tap your phone, the photo lands in a folder on your Mac. iOS + Android + a Python receiver over LAN + Bonjour, no cable, no cloud, no account. Three endpoints, a 6-digit pairing code with a lockout, a hand-rolled multipart parser that survives the boundary appearing inside a JPEG, and an atomic write so a folder watcher never sees half a photo."
image: /images/blog/shutterdrop.jpg
image_alt: A silver iPhone resting on a silver MacBook, hinting at the wireless tether between phone and laptop
date: 2026-04-22
last_modified_at: 2026-11-16
categories: [open-source]
tags: [swift, kotlin, python, ios, android, mac, photography, bonjour, open-source]
---

Zack Design's **[Shutterdrop](https://github.com/isaacrowntree/shutterdrop)** is a wireless tether that turns the phone in your pocket into a shutter for your Mac. Tap the camera preview on your iPhone or Android and the photo lands in `~/Pictures/Shutterdrop/`, as a HEIC (Apple's compressed photo format) from iOS or a JPEG from Android. It does what Capture One's tethered shooting does for a camera on a USB cable, but over wifi: **no cable, no cloud, no account**. The whole protocol is **three HTTP endpoints**; the receiver is one Python file whose only dependency outside the standard library is `zeroconf`, the library that announces it on the local network. **MIT licensed.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/isaacrowntree/shutterdrop" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
</div>

This post covers:

- the two phone apps, and the places where the Android app is honestly behind the iOS one;
- the three HTTP routes, how the receiver finds its own network address without sending a packet, and how a 6-digit pairing code survives a shared wifi network (5 attempts, a half-second delay per guess, a 5-minute window);
- why the parser for the upload body is hand-written, and splits on a line break followed by the boundary rather than on the boundary alone;
- why the file is opened with flags that refuse to overwrite or follow a symbolic link, and is renamed into place;
- test coverage, how the pieces connect, and how to try it.

<!-- more -->

## Why this exists

I take a lot of product photos for eBay listings, and "shoot on phone, AirDrop, import" is the slow step in every one. Existing wireless tether tools want a subscription, route photos through someone else's cloud, or are tied to a desktop app I don't use. Shutterdrop's receiver writes straight to a folder, so whatever already watches folders sees new files appear: a Finder smart folder, the Hazel automation app, Lightroom auto-import. I haven't measured the delay from tap to file, and nothing in the repo does.

## The two phone apps

The iOS app needs iOS 17 or later, and is written in SwiftUI. It looks for `_shutterdrop._tcp` with `NWBrowser`. It finds the Mac's address by opening a throwaway connection and reading where it connected. A hard 8-second timeout means an unreachable Bonjour entry can't hang the Pair button. An IPv6 address gets its interface suffix percent-encoded, as in `[fe80::1%25en0]`.

Capture asks for HEVC when the camera offers it, and JPEG otherwise, with quality ahead of speed. The lens picker sets the zoom on the triple-camera device to 1.0, 2.0 or 6.0, which are the 0.5x, 1x and 3x lenses. The torch switches on at full brightness.

Every capture is written first to an outbox folder in the app's cache. It's uploaded with `URLSession.upload(for:fromFile:)`, so the HEIC is never held in memory twice. The outbox flushes when `NWPathMonitor` says the network is back. After a failure it waits 2 seconds, so a Mac answering 401 isn't hammered by the network monitor and the pairing code at once.

The Android app needs Android 8 or later, and uses Compose and CameraX 1.4.1. It captures with `CAPTURE_MODE_MAXIMIZE_QUALITY`. It finds the Mac with `NsdManager`, using `registerServiceInfoCallback` on Android 14 and later and the older resolver below it. The whole-screen tap target is exposed to the TalkBack screen reader as a button.

It's behind iOS in four ways worth saying plainly:

- no lens picker;
- no torch;
- no network-change trigger or back-off on the outbox (it flushes on pairing and on each new capture);
- the upload reads the whole file into memory with `file.readBytes()`, where iOS streams it from disk.

## The whole protocol is three HTTP routes

```
GET  /health  → {"ok":true}                          unauthenticated
POST /pair    → {"code":"123456","peerName":"…"}     returns {"secret","peer"}
POST /submit  → multipart/form-data, "photo" part, Bearer auth required
```

That's the entire `do_GET` and `do_POST` in `mac-receiver/receiver.py`. The server is Python's `ThreadingHTTPServer`, speaking HTTP/1.0 on purpose. That means one request per connection, no keep-alive and no chunked encoding. So a request must declare its length up front:

- a `/submit` without a `Content-Length` header gets a 411 ("length required");
- a body over 100 MB gets a 413 before a byte of it is read;
- an unauthorised `/submit` has its body read and thrown away before the 401 reply, so the phone sees the 401 instead of a dropped connection.

`/health` returns only `{"ok": true}` until the caller proves it's paired. Only then are the peer name and pairing state added, so an unpaired device on the wifi learns nothing from it.

The receiver announces itself on the local network as `_shutterdrop._tcp.local.`, on port 47010 by default. It uses Bonjour, Apple's service-discovery protocol, through `zeroconf`, IPv4 only. To work out which of its own addresses to announce, it opens a UDP socket toward `8.8.8.8:80` and asks the operating system which local address it chose. That never sends a packet. The docstring notes that a VPN that takes over the default route can make it pick the wrong interface, hence the `--bind` flag.

The Bonjour name is cut to 63 bytes, the limit for a name. It's then decoded again, ignoring errors, so a multi-byte character split at the cut doesn't produce an invalid name.

## Pairing on a shared network

The long-term secret is 32 random bytes from `secrets.token_bytes`, base64-encoded. It's written to `~/.config/shutterdrop/secret` with flags that create the file only if it doesn't already exist. Owner-only permissions are set at creation, not by a `chmod` afterwards, which closes the gap in which another local user could read it. The pairing code is separate from it:

```python
def open(self) -> str:
    """Open a fresh window and return the new 6-digit code."""
    with self._lock:
        self._code = f"{secrets.randbelow(1_000_000):06d}"
        self._opened_at = time.monotonic()
        self._attempts = 0
        self._locked_until = 0.0
        return self._code
```

A million possible codes is nothing against a script on the same wifi. So the protection is in `try_match`:

- the comparison takes the same time whether or not it matches (`secrets.compare_digest`);
- the code is used up on the first match, so a leaked code can't be replayed;
- every wrong guess counts, and after `PAIRING_MAX_ATTEMPTS = 5` the window locks;
- each `/pair` request sleeps half a second before answering, which a person typing never notices and a guessing loop can't afford.

The window itself closes after `PAIRING_WINDOW_SECONDS = 5 * 60` without activity. One honest detail: the lockout is also 5 minutes, so it can never outlive the window it protects. In practice a lockout burns the rest of the current window, and you reopen it with `./run.sh --pair`.

The `/submit` check compares the length of the `Authorization` header first. Then it compares the whole `Bearer …` string against the expected value in constant time. On the phone, the secret lives in the iOS Keychain (readable after the first unlock), or in Android's `EncryptedSharedPreferences` with an AES-256 master key held in the hardware Keystore.

## The multipart parser is hand-rolled for one reason

An HTTP file upload is packaged as `multipart/form-data`: the parts are separated by a boundary string the sender chooses. The obvious way to split the body is on `--boundary`. But a JPEG is arbitrary bytes, and the boundary string can turn up inside it. When it does, the naive split cuts the photo short. RFC 2046 defines the delimiter as a line break followed by `--boundary`, so the parser normalises line endings and splits on that.

![Two views of the same upload body as a strip of bytes, with the boundary string occurring by chance inside the photo. Splitting on the bare boundary string cuts the photo in half at the accidental match; splitting on a line break followed by the boundary cuts only at the real delimiter and keeps the whole photo.](/images/blog/shutterdrop-multipart-boundary.svg)

```python
body = _normalise_eol(body)
delim = b"\r\n--" + boundary.encode("ascii")
# The first boundary won't be preceded by CRLF — it can sit at the
# very start of the body. Inject a leading CRLF to make splitting
# uniform.
chunks = (b"\r\n" + body).split(delim)
```

`test_boundary_substring_inside_payload` and `test_lf_only_line_endings` in `tests/test_receiver.py` pin both halves of that.

The filename the phone sends is never used. The extension comes from the first bytes of the file:

| First bytes | Saved as |
|---|---|
| `FF D8` | `.jpg` |
| `ftyp` then `heic`, `heix` or `mif1`, at offset 4 | `.heic` |
| `\x89PNG` | `.png` |
| anything else | `.jpg` |

## Writing the file so a half-upload never looks like a photo

```python
tmp_path = staging / f"{job_id}.{ext}.tmp"
final_path = staging / f"{job_id}.{ext}"
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
fd = os.open(str(tmp_path), flags, 0o600)
os.write(fd, data); os.fsync(fd); os.close(fd)
os.replace(tmp_path, final_path)
```

The `job_id` is the time in milliseconds plus four random hex characters, so files sort in the order they were taken. The write goes to a `.tmp` file, is flushed to disk, and is then renamed into place. A folder watcher never sees a partial JPEG.

`O_EXCL` refuses to overwrite an existing file. `O_NOFOLLOW` refuses to follow a symbolic link someone left in the staging folder, which stops a local user redirecting the write somewhere else on disk.

## Status

Both apps work end to end against the receiver. The receiver's tests cover the multipart parser, the pairing window (lockout, use-once, expiry, and a test with competing threads), the Bonjour name trimming and the extension sniffer.

They run in GitHub Actions on Python 3.10 to 3.13, on every push that touches `mac-receiver/`. The protocol is small enough that writing your own receiver is an afternoon: one that drops into S3, say, or pipes through `pngcrush`.

## Trying it

```
Phone (iOS or Android)              Mac (or Linux)
┌───────────────────────┐           ┌────────────────────────┐
│ Camera preview        │  HTTP     │ receiver.py            │   drop
│ Tap-to-capture (HEIC  ├──over────▶│ (Python stdlib +       ├──────▶  ~/Pictures/Shutterdrop/
│  on iOS / JPEG on     │  LAN +    │  zeroconf)             │
│  Android)             │  Bonjour  │ advertises             │
│ Offline outbox        │           │ _shutterdrop._tcp      │
│ Bonjour discovery     │           └────────────────────────┘
└───────────────────────┘
```

The receiver needs Python 3.10 or later and working mDNS, so macOS, Linux, or WSL with mDNS forwarding:

```bash
git clone https://github.com/isaacrowntree/shutterdrop && cd shutterdrop/mac-receiver
./run.sh                                   # bootstraps a venv, starts server
./run.sh --staging ~/Desktop/inventory     # custom staging folder
./run.sh --port 47099                      # custom port
./run.sh --pair                            # re-open pairing for a new phone
./run.sh --reset-secret                    # rotate secret + open pairing
```

On first launch it prints a 6-digit code. Open the app, tap your Mac in the list, and type the code.

The apps are built from source. The iOS app needs Xcode 15 and [xcodegen](https://github.com/yonaskolb/XcodeGen); set your own team under Signing & Capabilities, and a free Apple ID works for personal use. The Android app needs the Android SDK:

```bash
# from the repo root
brew install xcodegen
(cd ios-app && xcodegen && open ShutterdropIOS.xcodeproj)
(cd android-app && ./gradlew installDebug)   # onto a connected phone
```

More build details and notes are in the [README](https://github.com/isaacrowntree/shutterdrop).
