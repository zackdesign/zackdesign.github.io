---
layout: post
title: "react-native-nitro-unzip — a fast, Nitro-powered unzip module"
description: "A React Native ZIP library built on Nitro Modules — ~500 files/sec on iOS, ~474 on Android, AES-256 support, cancellation, and zero bridge serialisation."
excerpt: "A React Native ZIP library built on Nitro Modules — ~500 files/sec on iOS, ~474 on Android, AES-256 support, cancellation via JSI, and zero bridge serialisation."
image: /images/blog/react-native-nitro-unzip.jpg
image_alt: Android phone displaying app development tools on a desk
date: 2026-02-27
last_modified_at: 2026-02-27
categories: [open-source]
tags: [react-native, nitro, ios, android, typescript, performance, open-source]
---

Zack Design has published [`react-native-nitro-unzip`](https://github.com/isaacrowntree/react-native-nitro-unzip) — a high-performance ZIP module for React Native, built on [Nitro Modules](https://nitro.margelo.com/). It extracts and creates password-protected archives on iOS and Android faster than the existing community options, with real progress callbacks and cancellation delivered directly over JSI rather than the old bridge.

<!-- more -->

## Benchmarks, up front

On a 350 MB archive containing 10,000 files:

- **iOS:** ~500 files/sec
- **Android:** ~474 files/sec

Those numbers are measured with release builds, not debug — the bridge-free JSI path is a large part of why the difference shows up at all.

## Feature surface

- **Extraction** with per-file progress (bytes extracted, files remaining, percentage complete) delivered synchronously via JSI — no bridge serialisation, no frame drops.
- **Synchronous cancellation.** A cancel is honoured on the next file boundary, not at the next JS tick.
- **Password-protected archives.** AES-256 encryption supported on both platforms for extraction *and* creation.
- **Zip creation.** Compress a directory into an archive, optionally with a password.
- **Concurrent operations.** Multiple tasks run independently without locking each other.
- **Background execution on iOS** via proper `UIApplication` background task management, so a 500 MB archive can finish extracting even if the user backgrounds the app.

## Quick example

```typescript
import { getUnzip } from 'react-native-nitro-unzip';

const unzip = getUnzip();
const task = unzip.extract('/path/to/archive.zip', '/path/to/output');

task.onProgress((p) => {
  console.log(`${(p.progress * 100).toFixed(0)}% — ${p.extractedFiles}/${p.totalFiles} files`);
});

const result = await task.await();
console.log(`Extracted ${result.extractedFiles} files in ${result.duration}ms`);
```

Progress callbacks fire on every file, and because they ride JSI they never queue up behind the bridge.

## Why it exists

React Native has had ZIP libraries for years. Most of them predate Nitro and therefore predate modern JSI — which means every progress tick had to serialise across the bridge, every cancellation had to round-trip through an async message queue, and every archive operation paid the bridge tax proportional to the number of files. For the kind of app that extracts a single 2 MB archive at install time, none of that matters. For the kind of app that handles large user-uploaded archives, downloads payload bundles from a server, or packages up content for offline use, it matters a lot.

Internally the native side leans on battle-tested libraries — `SSZipArchive` on iOS, an optimised `ZipInputStream` path on Android — rather than reinventing the compression format. The contribution is the JSI layer, the cancellation machinery, and the progress plumbing that sits on top.

## Installation and docs

```bash
npm install react-native-nitro-unzip react-native-nitro-modules
cd ios && pod install
```

Requires React Native 0.75+, Nitro Modules 0.34+, iOS 15.5+, and Java 17 on Android. Full docs — including extraction, compression, password handling, cancellation semantics, and the API reference auto-generated from TypeScript — live at [isaacrowntree.github.io/react-native-nitro-unzip](https://isaacrowntree.github.io/react-native-nitro-unzip/).

Source on [GitHub](https://github.com/isaacrowntree/react-native-nitro-unzip).
