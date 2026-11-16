---
layout: post
title: "Chrome on Lambda — headful browser in a container image"
description: "A reference build for running Chrome with a real screen inside an AWS Lambda container image: Xvfb supplies the virtual display Chrome refuses to start without."
excerpt: "Chrome with a real screen inside an AWS Lambda container image — Xvfb supplies the virtual display Chrome refuses to start without."
image: /images/blog/chrome-lambda.jpg
image_alt: Server racks glowing in a modern data centre corridor
date: 2022-03-19
last_modified_at: 2026-11-16
categories: [engineering]
tags: [aws, lambda, chrome, docker, serverless, chrome-launcher]
---

Running Chrome with no screen ("headless") on AWS Lambda, Amazon's service for running a function on demand with no server to manage, is a solved problem. Running Chrome with a screen ("headful"), with real pixels being drawn, is not. Chrome refuses to start without a display to draw on, and a Lambda function does not have one. **[chrome-lambda](https://github.com/isaacrowntree/chrome-lambda)** is a reference container image that gives it a fake one.

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/isaacrowntree/chrome-lambda" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
</div>

This post covers:

- when a browser with a screen is the only option;
- the pieces the image is built from, and the order in which the startup script creates the virtual display before Chrome starts;
- running it locally, and the earlier writeups it builds on;
- when to reach for it, and when plain headless Chrome is the better choice.

<!-- more -->

## When a browser without a screen is not enough

Most Chrome-on-Lambda jobs are served by `chrome --headless`. The cases that are not:

- Browser extensions that will not load in headless mode, such as ad-blockers and corporate sign-in extensions.
- Websites that detect a headless browser and quietly serve it a stripped-down page.
- Work that needs real pixels: screenshots of the page as actually rendered, PDFs with web fonts laid out correctly, and image comparisons that catch visual regressions.

Each of those needs a real Chrome, which means a real display, inside the 10 GB container image Lambda allows.

## The recipe

The repo is a fork of Guillaume Ruch's chrome-lambda. It adds the flags Chrome needs to start, puts the display on `:99` and points `HOME` at `/tmp`, the only writable folder on Lambda. The image is a handful of familiar pieces:

1. Ubuntu 20.04, plus AWS's Lambda runtime interface client, which lets any container image act as a Lambda function.
2. [Xvfb](https://www.x.org/releases/X11R7.6/doc/man/man1/Xvfb.1.xhtml), the "X virtual framebuffer": a display server that draws into memory instead of a monitor. It gives Chrome a display to open, numbered `:99`, with no graphics card behind it. A small window manager, Fluxbox, runs on top.
3. `google-chrome-stable` from Google's package repository, started by `chrome-launcher` and driven over Chrome's DevTools debugging protocol. It runs with `--no-sandbox`, `--disable-dev-shm-usage` and `--no-xshm`, the usual flags for Chrome in a locked-down container.

The script that runs when the container starts does three things in order. It sets the `DISPLAY` environment variable to `:99` and starts Xvfb there, waiting up to five seconds for it to answer. It starts Fluxbox the same way. Then it hands control to Lambda's runtime client, which calls the handler that launches Chrome. Chrome never learns the display is fake.

![Three steps in order when the container starts: Xvfb starts and owns a virtual display called :99 that draws into memory; the DISPLAY variable is set to :99 so anything launched afterwards draws there; then the Lambda runtime starts and the handler launches Chrome, which draws into Xvfb's memory without knowing there is no monitor.](/images/blog/chrome-lambda-startup.svg)

The sample handler only proves the browser works. It opens example.com and reads `chrome.runtime` from the page. An `extension.zip` sits in the repo for you to load.

## Running it locally

When the container is not running on Lambda, the startup script wraps the handler in AWS's runtime interface emulator, which listens on port 8080:

```sh
docker build -t chrome-lambda .
docker run -p 9000:8080 chrome-lambda
curl -XPOST "http://localhost:9000/2015-03-31/functions/function/invocations" -d '{}'
```

## Reading material

The image stands on three earlier writeups, all linked from the README:

- [Running headful Chrome with extensions in a Lambda container image](https://techandstuff.medium.com/running-headful-chrome-with-extensions-in-a-lambda-container-image-22ba1c566feb)
- [Running Chrome in a Docker container](https://medium.com/dot-debug/running-chrome-in-a-docker-container-a55e7f4da4a8)
- [Run Xvfb on AWS Lambda container](https://incolumitas.com/2021/01/23/run-xvfb-on-aws-lambda-container/)

## When to reach for it

If a site serves a different page to headless browsers, or you need a privacy or sign-in extension preloaded, [the repo](https://github.com/isaacrowntree/chrome-lambda) is a starting point. For everything else, headless Chrome is lighter and cheaper, and you should use it.
