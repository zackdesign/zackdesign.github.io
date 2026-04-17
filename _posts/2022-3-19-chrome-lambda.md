---
layout: post
title: "Chrome on Lambda — headful browser in a container image"
description: "A reference build for running headful Chrome with extensions inside an AWS Lambda container image, using Xvfb to give Chrome the display it insists on."
excerpt: "Running headful Chrome — with extensions — inside an AWS Lambda container image, using Xvfb to supply the virtual display Chrome insists on."
image: /images/blog/chrome-lambda.jpg
image_alt: Server racks glowing in a modern data centre corridor
date: 2022-03-19
last_modified_at: 2022-03-19
categories: [engineering]
tags: [aws, lambda, chrome, docker, serverless, puppeteer]
---

Running Chrome on AWS Lambda is easy. Running *headful* Chrome on AWS Lambda — with real extensions loaded, a real DOM rendered, and a real compositor drawing pixels — is not. Zack Design published [chrome-lambda](https://github.com/isaacrowntree/chrome-lambda) as a reference container image for exactly that scenario.

<!-- more -->

## Why headful at all

99% of "Chrome on Lambda" needs are served by `chromium --headless` or the newer `--headless=new`. The remaining 1% is the awkward middle ground:

- Browser extensions that refuse to load in headless mode (ad-blockers, paywall bypassers, enterprise auth extensions, site-specific MV3 extensions that gate on `chrome.tabs` events).
- Scraping targets that fingerprint the browser and silently serve stripped-down HTML to headless clients.
- Workflows that require rendering real pixels — screenshots of a rendered DOM, PDF output with webfonts correctly laid out, or visual-regression diffs.

For those, you need a real Chrome — which means a real X display — inside Lambda's 10 GB container sandbox.

## The recipe

The image is a thin wrapper around three familiar pieces:

1. **Lambda base container image** for the runtime boilerplate.
2. **[Xvfb](https://www.x.org/releases/X11R7.6/doc/man/man1/Xvfb.1.xhtml)** — an X virtual framebuffer that gives Chrome the `:99` display it expects, without needing a real GPU.
3. **Chromium + Puppeteer** driving the browser over the DevTools protocol, with the extension layout unpacked into the container filesystem so it is ready on every cold start.

The shell entrypoint starts Xvfb, sets `DISPLAY=:99`, then hands off to the Lambda runtime bootstrap.

## Reading material

This image stands on the shoulders of several earlier writeups. The README links to all three — they are excellent:

- [Running headful Chrome with extensions in a Lambda container image](https://techandstuff.medium.com/running-headful-chrome-with-extensions-in-a-lambda-container-image-22ba1c566feb)
- [Running Chrome in a Docker container](https://medium.com/dot-debug/running-chrome-in-a-docker-container-a55e7f4da4a8)
- [Run Xvfb on AWS Lambda container](https://incolumitas.com/2021/01/23/run-xvfb-on-aws-lambda-container/)

## When to reach for it

If you are stuck fighting a site that serves different markup to headless clients, or you need to ship with a privacy or auth extension preloaded, [the repo](https://github.com/isaacrowntree/chrome-lambda) is a decent place to start. For everything else, `--headless=new` is lighter and cheaper.
