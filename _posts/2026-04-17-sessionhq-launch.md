---
layout: post
title: Introducing SessionHQ — Our Flagship SaaS Product
description: Zack Design's flagship SaaS product — a modern, multi-tenant class check-in platform for dance studios, gyms, and martial arts schools, launching with founding partner Havana on the Hastings in Port Macquarie.
keywords: SessionHQ, SaaS product launch, class check-in software, dance studio software, gym management, Next.js, Cloudflare Workers, Supabase, Square payments, multi-tenant SaaS, Havana on the Hastings, Port Macquarie
og_image: /images/sessionhq-icon.png
date: 2026-04-17
---

# Introducing SessionHQ

After months of design, engineering, and iteration with real studio operators, Zack Design is proud to launch **[SessionHQ](https://sessionhq.org)** — the modern check-in platform for class-based studios. It is the most ambitious product we have ever shipped, and it now runs nightly check-ins at our founding partner [Havana on the Hastings](https://www.havanahastingsdance.com.au/) in Port Macquarie.

<!-- more -->

## What SessionHQ does

SessionHQ replaces the spreadsheets, paper sign-in sheets, and duct-taped Mindbody workarounds that most small studios tolerate because the alternatives are too expensive, too clunky, or too generic. We built it by sitting at the front desk on a Tuesday night and asking, *"what actually needs to happen here?"*

The answer, it turns out, is:

- **Members walk in and check in fast.** PIN pad, NFC wristband tap, or QR scan from their phone. No app install required. No "where's my card."
- **Passes just work.** Class packs, casual rates, unlimited passes. Credits deduct automatically on check-in. Cards-on-file auto-renew the moment a pack runs out.
- **Payments happen where the student is.** Square integration handles card payments inline. PCI-compliant. No raw card numbers ever touch our servers.
- **Admins see the truth.** Tonight's attendance, revenue, unpaid check-ins, LTV, retention cohorts — all updating in real time.

No per-member fees. No transaction surcharges on top of Square. One flat monthly subscription.

## The technology behind it

SessionHQ is a serious piece of software infrastructure. A quick tour of the stack:

- **Next.js 16 & React 19** on the frontend, with Tailwind 4 and a custom 19-primitive design system (not shadcn — we wanted the ownership).
- **Cloudflare Workers** via OpenNext for the runtime. Global edge deployment, sub-100ms cold starts, one Worker cron handling pass-lifecycle, database backup, prune, and retention sweeps.
- **Supabase** for auth, Postgres, realtime, and row-level security. Every tenant-owned table enforces `auth_tenant_id()` at the database layer — a studio *cannot* see another studio's data, period.
- **Square** for payments, with Supabase Vault for token storage and PCI-safe tokenisation.
- **Resend** for lifecycle email, **Sentry** for observability, **R2** for storage, **Playwright** and **Vitest** for 800+ tests across unit, integration, and E2E.

Multi-tenancy, GDPR-readiness (consent capture, data export, right-to-erasure, full audit trail), idempotency, rate limiting, feature flags — all in from day one, not bolted on later.

## Why we built it

We have spent 20+ years building software for other people. SessionHQ is different: **it is our product.** We own the roadmap, the pricing, the customer relationship. We decide which features matter. We eat the bug reports.

It is also a proof point. We believe small businesses deserve software that is as thoughtfully engineered as anything the enterprise market gets — without the enterprise price tag, the 12-month implementation, or the 400-page MSA. SessionHQ is our demonstration that a small, focused team can ship serious SaaS.

## Founding partner: Havana on the Hastings

SessionHQ did not launch in a vacuum. It launched with a customer.

[Havana on the Hastings](https://www.havanahastingsdance.com.au/) is Port Macquarie's Latin dance community — Cuban salsa, bachata, urban kiz, and rueda (the dance that brought founders Mike and Kellie together). They run on passes, practicas, and real connection, with the warmth of a studio where "everyone starts somewhere" is not just a slogan but a weekly reality.

They were already operating on the pass system that SessionHQ is built around. Partnering with them meant we did not have to guess what studio operators needed — we had one telling us, in real time, what worked and what did not. Every feature in SessionHQ has been stress-tested at their front desk on a Tuesday night.

If you are in Port Macquarie and want to dance, [drop in](https://www.havanahastingsdance.com.au/classes). Absolute beginners are welcome every week.

## What's next

SessionHQ is onboarding new studios now. If you run a dance studio, gym, yoga or pilates studio, martial arts school, or climbing gym — or if you know someone who does — we would love to talk.

- **Visit** [sessionhq.org](https://sessionhq.org) to see the product.
- **Request access** on the site, or **book a 15-minute demo** via `info@sessionhq.org`.
- **Founding-studio pricing is locked in** for the studios who sign on before general availability.

This is the start of something we are going to spend years building on. Thanks for being here for the beginning.
