---
layout: post
title: "Introducing SessionHQ — our flagship SaaS"
description: "SessionHQ, our multi-tenant check-in platform for dance studios, gyms and martial arts schools, is live at founding partner Havana on the Hastings: 283 commits, 888 unit tests, the studio's identity carried inside the sign-in token, and the browser bugs we hit on a kiosk tablet."
excerpt: "Our multi-tenant check-in platform is live at Havana on the Hastings — 283 commits, 888 unit tests, the studio's identity enforced from the sign-in token, and the Android and Workers bugs that shaped it."
image: /images/blog/sessionhq-launch.jpg
image_alt: Studio operator checking members in with the SessionHQ platform
date: 2026-04-17
last_modified_at: 2026-04-17
categories: [product]
tags: [sessionhq, saas, nextjs, supabase, cloudflare, square, product-launch]
---

Nine weeks and 283 commits after the first scaffold on 12 February, **[SessionHQ](https://sessionhq.org)** is running the front desk at [Havana on the Hastings](https://www.havanahastingsdance.com.au/) in Port Macquarie: a member walks in, types a PIN, taps a wristband on the tablet or scans a QR code with their phone, one class is deducted from their pass, and the admin's live feed updates. It is Zack Design's own product, built for many studios on one database from the first migration, and at launch it carries 888 unit tests and 107 browser tests (written with Playwright, which drives a real browser) across 22 spec files.

This post covers how the studio's identity is carried inside each user's sign-in token so that Postgres enforces the separation between studios without trusting application code, the nightly job that renews passes and charges cards on file, how tap-to-check-in and card payments work from a plain web page, and four bugs that only showed up on a real tablet at a real front desk: Android Chrome refusing to read Supabase timestamps, a sign-in cookie Android could not read, a Square library returning numbers JSON cannot encode, and a Workers promise that was cancelled before it ran.

<!-- more -->

## What SessionHQ does

Small studios run on spreadsheets, paper sign-in sheets and a payments app that does not know what a class pack is. SessionHQ replaces that with three surfaces from one codebase: a kiosk (`/station/[eventId]`) for the tablet at the door, a member web app that installs to the phone's home screen (`/member`) for balances and history, and an admin (`/admin/checkins`, `/admin/members`, `/admin/catalog`, `/admin/reports`) for the people running the night.

- **Check in fast.** PIN entry, a wristband tap on the tablet, or a QR scan that opens `/checkin/[eventId]` on the member's own phone. No app install.
- **Passes just work.** Class packs, casual rates and unlimited passes; `apply_pass_to_checkin` deducts one class at check-in time, and the nightly `pass-renewals` job charges the saved card when a pack runs out.
- **Payments where the student is.** Square's Web Payments SDK turns the card details into a one-time token inside the browser; our API only ever sees that token (`source_id`) or a stored card reference (`square_card_id`), never the card number.
- **Admins see the truth.** Tonight's attendance, revenue, unpaid check-ins and pass status reports.

## Each studio's identity travels inside the sign-in token

Every table a studio owns has row-level security enabled, which means Postgres itself decides which rows each query may see. Every one of those policies calls the same two functions from `supabase/migrations/20260101000000_initial_schema.sql`:

```sql
create or replace function auth_tenant_id() returns uuid as $$
  select (auth.jwt()->'app_metadata'->>'tenant_id')::uuid;
$$ language sql stable security definer;

create or replace function auth_tenant_role() returns text as $$
  select auth.jwt()->'app_metadata'->>'role';
$$ language sql stable security definer;
```

They read the signed sign-in token (a JWT) that arrives with every query. The studio id in that token is written by `custom_access_token_hook`, a Postgres function that Supabase Auth calls while creating the token. It looks the user up in `tenant_users` (staff, admins, owners) and then in `members`, and copies `tenant_id` and `role` into the token's `app_metadata` section, which the user cannot edit. Permission to run the hook is granted to `supabase_auth_admin` and revoked from `authenticated`, `anon` and `public`, so nothing a client can call touches it. A studio cannot query another studio's rows because the database never sees a studio id that did not come from the token. The service-role key bypasses row-level security; the API uses it only after its own check that the caller belongs to the studio.

![Three panels. At sign-in, Supabase Auth mints the user's token and calls a database function while doing so. That function looks the user up in the staff table and then the members table, and copies the studio's id and the user's role into the token. On every later query, the row-level security policy reads the studio id straight out of the token, so only that studio's rows come back.](/images/blog/sessionhq-tenant-token.svg)

## One nightly job does the money work

The app deploys to Cloudflare Workers through OpenNext (the adapter that runs Next.js on Workers), with `custom-worker.ts` wrapping the generated handler so the same Worker also owns a `scheduled()` entry point. A single scheduled trigger at 03:00 UTC (`0 3 * * *`) runs the whole nightly pipeline. Three jobs run one after another, because each reads the state the previous one wrote: pass lifecycle, then pass renewals, then lifecycle emails. Four more run alongside them at the same time: database backup, backup pruning, the retention sweep and email retry.

![One trigger at 03:00 UTC starts two groups of jobs. The top row runs in strict order: pass lifecycle, then pass renewals which charge saved cards, then lifecycle emails. The bottom row of four jobs, database backup, prune backups, retention sweep and email retry, runs at the same time and independently.](/images/blog/sessionhq-nightly-pipeline.svg)

Backups go to R2 (Cloudflare's file storage) and are pruned to 30 daily copies plus 12 monthly. The retention sweep calls `sweep_inactive_members`, which anonymises members with no check-ins in three years.

Each job runs inside `runJob()`, which logs a one-line result and reports any failure to Sentry, the error-tracking service, tagged with `cron_job`. At launch that reporter was a hand-written POST to Sentry's old `/api/{id}/store/` endpoint. It was later found to send a placeholder stack frame (`filename: "cron"`) instead of the real stack trace, so a failure in the nightly money pipeline could not be traced to a line of code; it has since been replaced with `withSentry` from `@sentry/cloudflare`, wrapping only the `scheduled` entry point, because `@sentry/nextjs` already handles the request path.

## Tap-to-check-in and card payments from a web page

The kiosk is a web page, so reading a wristband uses Web NFC, the browser API for near-field communication tags. `src/lib/nfc.ts` is 39 lines: check that `"NDEFReader" in window`, call `ndef.scan({ signal })`, and hand the `serialNumber` from the `reading` event to the check-in flow. The tag's serial number is all the check-in flow matches on; nothing is ever written to the tag. Where `NDEFReader` does not exist, the reader is never started and PIN entry is the path.

Square's per-studio access tokens are stored in Supabase Vault, the encrypted secrets store, by `store_square_tokens()`. The first version inserted straight into the `vault.secrets` table; the correct call is `vault.create_secret()`, and because Vault has no update function, rotating a token is a delete followed by a create.

## Four bugs from the front desk

| What the user saw | What was actually happening | What fixed it |
|---|---|---|
| The check-in feed showed "NaN" for every member's age on the tablet, and correct ages on every laptop (13 February). | Supabase returns timestamps like `2026-02-13 05:52:06.136236+00`: a space instead of a `T`, six decimal places, and a short `+00` zone. Android Chrome's `Date` parser rejected the zone and then the six decimals. `postgres-date` was tried and broke the browser bundle because it is CommonJS-only. | `src/lib/time.ts` parses the string with one regular expression, trims the fraction to three digits, and builds the instant with `Date.UTC()`. `src/lib/time.test.ts` covers each variant. |
| Signing in from the emailed link failed with `missing_code`. | The callback route expected a `code` parameter (the PKCE flow); the browser client was on the default implicit flow and put the tokens in the URL fragment instead. On Android, a second problem: the sign-in cookie was unreadable after a reload. | One line in `src/lib/supabase-browser.ts`, `{ auth: { flowType: 'pkce' } }`, then `httpOnly: false` set explicitly on the cookie. |
| Saved cards were invisible on the profile page, and replacing a card failed after Square had already created the new one. | Square SDK v44 returns `expMonth` and `expYear` as `BigInt`, a number type `JSON.stringify` refuses to encode, so both the GET and the PUT handlers crashed while encoding a successful result. | The route converts those two fields to ordinary numbers before responding, and a regression test pins it. |
| A new member was created and the welcome email never arrived; `email_log` had zero rows (launch day). | On Workers, a promise nobody waits for is cancelled the moment the response is sent. The call to Resend (the email service) and its log writes were started and left, so they never completed. | Every such send goes through a `queueEmail()` helper that wraps it in `ctx.waitUntil()`, which keeps the Worker alive until the promise settles. |

The last one is the same primitive the Rollbar client on this blog leans on, and it is easy to forget from inside a Next.js route.

## What else is in from day one

- **Rate limits** on the write endpoints, counted in memory per Worker instance:

  | Endpoint | Per IP address | Per user |
  |---|---|---|
  | `POST /api/checkins` | 120 per minute | 30 per minute |
  | `POST /api/payments/create` | 20 per minute | 10 per minute |

- **Idempotency.** A request that carries an `Idempotency-Key` header is remembered for 24 hours in `idempotency_keys`, keyed by the header, the studio and the endpoint, so a retried request cannot charge or check in twice.
- **GDPR.** Consent timestamps on `members`, `POST /api/admin/members/[id]/anonymize` behind a typed confirmation, `GET /api/admin/members/[id]/export`, and an audit trail on check-ins, passes, payments and member updates.
- **Personal data scrubbing** in Sentry's `beforeSend` hook: medical notes, PINs and payment tokens never leave the Worker.
- **A design system of 21 base components** in `src/components/ui/`, on Tailwind 4 with Next.js 16 and React 19. Not shadcn; we wanted to own it.
- **48 migrations**, applied in filename order, as the only schema definition.

## Why we built it

We have spent more than 20 years building software for other people. SessionHQ is ours: the roadmap, the pricing, the customer relationship, and the bug reports. It is also a proof point that a small team can ship software that serves many studios from one system with real isolation, real payments and real tests, without an enterprise price tag.

## Founding partner: Havana on the Hastings

SessionHQ launched with a customer. [Havana on the Hastings](https://www.havanahastingsdance.com.au/) is Port Macquarie's Latin dance community: Cuban salsa, bachata, urban kiz and rueda, the dance that brought founders Mike and Kellie together. They were already running on the pass model SessionHQ is built around, so every feature above was tested at their front desk on a class night, by the people who would use it, before it shipped. The founding-partner agreement is signed and sits in the repo.

If you are in Port Macquarie and want to dance, [drop in](https://www.havanahastingsdance.com.au/classes). Absolute beginners are welcome every week.

## What's next

SessionHQ is onboarding new studios now. If you run a dance studio, gym, yoga or pilates studio, martial arts school, or climbing gym — or if you know someone who does — we would love to talk.

- **Visit** [sessionhq.org](https://sessionhq.org) to see the product.
- **Request access** on the site, or **book a 15-minute demo** via `info@sessionhq.org`.

This is the start of something we are going to spend years building on. Thanks for being here for the beginning.
