---
layout: post
title: "Introducing Nexxara — event media management, reimagined"
description: "Nexxara is Zack Design's event media SaaS — dual-watermarked galleries, QR access, AI photo bracketing, and a real multi-tenant role model built on Next.js, Cloudflare, and Supabase."
excerpt: "Dual-watermarked galleries, QR access, AI photo bracketing, real multi-tenant roles — our event media SaaS, built on Next.js, Cloudflare, and Supabase."
image: /images/blog/nexxara-launch.jpg
image_alt: Concert crowd illuminated by stage lights, phones held high
date: 2025-11-15
last_modified_at: 2025-11-15
categories: [product]
tags: [nexxara, saas, nextjs, cloudflare, supabase, event-media, product-launch]
---

Zack Design is building a second flagship SaaS: **[Nexxara](https://nexxara.media)** — an event media management platform for production companies, event studios, and the photographers who shoot for them. It exists because every toolchain for sharing event photos today is either a consumer-grade nightmare (Dropbox links that expire, WeTransfer emails that vanish) or an enterprise DAM that costs more per month than a small studio earns per event.

<!-- more -->

## What Nexxara does

Production companies run events. Events have editions — the festival in November, the same festival in March. Each edition has photographers, videographers, maybe a drone operator, and dozens or thousands of attendees who want the photos afterwards. Nexxara is the platform that connects all of that:

- **Photographers upload** photos and videos directly from the field. Cloudflare R2 on the backend; presigned URLs mean large files never round-trip through the app server.
- **Event managers curate** — pick the keepers, drop the throwaways, organise into collections (personal or edition-wide), re-order with drag-and-drop, set watermark positions.
- **Attendees access** via a QR code or deeplink that opens the gallery on their phone. Social sign-in with Google or Facebook, or a magic-link email.
- **Everyone gets beautiful galleries.** Justified-row layouts (the Google Photos / Flickr style), video with watermark-aware HTML5 controls, a YouTube-style scrubber with keyframe previews, and a lightbox that actually works on iOS.

## The dual watermark system

This is the feature most of our early beta users care about.

Every photo is watermarked *twice*. The **edition watermark** — the festival logo, the sponsor mark, whatever the event operator decides — applies to every photo in that edition. The **personal watermark** is the photographer's own signature, scaled and positioned intelligently so the two marks don't fight. Both are applied on-the-fly by a Cloudflare Worker sitting in front of the R2 bucket, using the Image Resizing API for format-agnostic transforms. No watermarking pipeline at upload time. No re-exporting a thousand JPEGs when the sponsor logo changes.

## Real multi-tenant RBAC

Nexxara is a company-scoped product from day one:

- **Admin** — platform-level. That is us.
- **Event Manager** — owns an event or a set of editions. Invites photographers, approves uploads, curates galleries, sets pricing.
- **Media Team** — photographers, videographers, the drone operator. Upload, edit their own work, request access via QR/URL.
- **Basic User** — the attendee. Gets a gallery, can download, can share via deeplink.

Every query is scoped by the user's active company and role. Supabase row-level security enforces it at the database layer — not in middleware, not in the ORM, in the `auth_company_id()` function itself. A photographer from one studio physically cannot see another studio's raw uploads, period.

## The technology

- **[Next.js](https://nextjs.org/)** on the frontend, deployed via **[OpenNext](https://open-next.js.org/)** to **Cloudflare Workers** — global edge, sub-100ms cold starts, the same runtime as SessionHQ.
- **[Supabase](https://supabase.com/)** for Postgres, auth, and row-level security. OAuth with Google and Facebook, magic-link for everyone else.
- **[Cloudflare R2](https://www.cloudflare.com/developer-platform/products/r2/)** for media storage. No egress fees. A Worker on `files.nexxara.media` handles every transform, every watermark, every fit/crop/quality variant.
- **[Stripe](https://stripe.com/)** for subscriptions and per-edition billing.
- **Three Cloudflare Workers** sit alongside the main app:
  - **Image** — on-the-fly transform and watermark at the edge.
  - **Queue** — AI photo analysis. Bracketing (grouping the same shot taken as a burst), face detection, quality scoring, EXIF extraction.
  - **Progress Actor** — a Durable Object + WebSocket combo that broadcasts real-time upload, AI, and bracket progress to every admin tab currently watching. Built on `@cloudflare/actors`.
- **[`react-photo-album`](https://react-photo-album.com/)** for the justified-row gallery layout.
- **[`mp4box`](https://github.com/gpac/mp4box.js/)** for client-side video introspection before upload, so we can generate thumbnails without waiting for a server round-trip (with a Cloudflare Media Transformations fallback for large files).

## Why we are building it

Because event photography has a supply-side bottleneck nobody talks about: photographers hate the *after*. The shoot is the fun part. Sorting, watermarking, hosting, and chasing attendees to download their photos before the link expires — that is the job that kills margin on a $400 gig. Nexxara automates the boring 80%, and it lets the studio running the event present the whole thing with one consistent brand across every photographer's output.

It is also a proof point, same as SessionHQ. A small, focused team can ship serious multi-tenant SaaS on a small stack, without an enterprise DAM's price tag or implementation timeline.

## Beta

Nexxara is currently in closed beta with a handful of production companies and event photographers. If you run events, shoot events, or coordinate photographers across multiple editions, [request access](https://nexxara.media) on the site — we would genuinely love to hear what you need from it.
