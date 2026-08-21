---
layout: post
title: "Four Australian client sites, rebuilt for 2026 — and shipped behind a preview on their own live domains"
description: "Mower Corner, AC Service & Parts, Breeder's Choice and Superior Shavings rebuilt from Bootstrap-and-jQuery to hand-written CSS on Jekyll — four distinct identities, 947 stockists rendered as indexable HTML, and a preview-on-the-live-domain pattern that let the clients sign off before anything changed."
excerpt: "Four established Australian businesses, rebuilt from Bootstrap-and-jQuery to hand-written CSS. Four deliberately different identities, a stockist finder the owner still edits from Dropbox, and a way to ship a redesign onto a client's live domain months before they approve it."
image: /images/blog/client-sites-rebuilt.jpg
image_alt: The four rebuilt homepages side by side — Mower Corner's cast-iron and safety-orange shopfront, Breeder's Choice in daylight green, Superior Shavings in industrial iron and red, and AC Service & Parts in bone and forest
date: 2026-08-21
last_modified_at: 2026-08-21
categories: [engineering]
tags: [jekyll, design-systems, css, seo, accessibility, github-pages, client-work, australia]
redirect_from:
  - /breeders-choice/
  - /mower-corner/
  - /recent-website-updates/
---

Zack Design has rebuilt four Australian client sites for 2026 — **[Mower Corner](https://mowercorner.com.au)**, **[AC Service & Parts](https://acparts.com.au)**, **[Breeder's Choice](https://breederschoice.com.au)** and **[Superior Shavings](https://superiorshavings.com.au)** — and the last two went live this week. All four run on Jekyll and GitHub Pages, and none of them loads a CSS framework any more.

<!-- more -->

This post replaces three older ones about the same clients. Those described sites that no longer exist, and they described them in the language of a brochure. This is what actually got built.

## What was there before

The two sister bedding sites each carried a single monolithic Jekyll layout — 1,843 lines on Breeder's Choice, 1,380 on Superior Shavings — pulling Bootstrap 5.3.3, jQuery 3.7.1, jQuery CSV, AOS 2.3.1 and a Font Awesome kit from **five different CDN hosts** before either rendered a word. Mower Corner was one page — one `index.md` — reaching for jsDelivr, cdnjs, unpkg, Google Fonts and Cloudinary.

None of that was unreasonable in 2015. It's just that the entire budget of every page went to downloading generic scaffolding, and what came back out the other side looked like every other Bootstrap site, because it was one.

What replaced it, per site:

| | CSS | JS | Pages |
|---|---|---|---|
| Mower Corner | 1,132 lines | 210 lines | 5 |
| Breeder's Choice | 443 lines | 228 lines | 10 |
| Superior Shavings | 443 lines | 228 lines | 10 |

Hand-written, no framework, no jQuery, no AOS, no icon kit. Google Fonts and Analytics still load, and Mower Corner still serves its imagery through Cloudinary — I'm not going to claim a purity I didn't ship.

## Four businesses, four registers

The temptation with four clients at once is one design system in four colourways. These are four different trades in two states, and two of them are sister brands owned by the same person — which makes *differentiating* them the actual design problem, not a nice-to-have.

**Mower Corner — "spec plate."** Their mark is a condensed wordmark standing in a strip of grass, unchanged since the 90s, and it's genuine equity in Colac. So the grass stayed and got redrawn as a crisp silhouette; the sky gradient and the clip-art operator silhouettes that dated it did not. The structural device is the riveted spec plate off the side of every machine in the shop, carrying the shop's own data — phone, hours, address. Cast iron `#14181A`, safety orange `#F2600C`, the traced grass green `#2B7134`.

**Breeder's Choice — "the bale and the spec."** A family business that has done one thing since 1994. A 14 kg bale with a moisture spec is a real product, so the product leads: real photography of their own pallets, and a kraft bale-label tag carrying the spec the way the printed wrap does. Logo greens `#0B4423` / `#0F6B36` on cream and kraft.

**Superior Shavings — "mill-side."** The sister plant, in NSW softwood country, where the pitch is proximity — from the saw into the bale with minimal handling. So it got a deliberately opposite register: iron greys and the logo's red `#BF2025`, a numbered mill line, and the product spec set as a mono bale ticket. Same structure as Breeder's Choice, same ethos, different plant. The two sites cross-link rather than compete.

**AC Service & Parts — refine, not replace.** The paddock palette and harvest photography were already working. Rebuilding would have been the expensive way to end up somewhere similar, so the budget went where it counted: contrast fixed to AA on every ground, marketing claims softened to what's verifiable, structured data repaired, heroes self-hosted, and the logo's teal finally let out of quarantine.

## The stockist finder belongs to the client

Breeder's Choice and Superior Shavings are sold through produce stores, saddleries and pet retailers — **407 and 540 of them** respectively. The owner maintains both lists as CSVs in his own Dropbox, and has for years.

The obvious engineering move is to pull that CSV at build time: it server-renders, it's fast, it's cacheable. I built it the other way on purpose. The CSV is still fetched **in the browser at page load**, because a build-time fetch means his edits don't appear until something triggers a deploy — and the moment his workflow depends on my CI, I've taken his list away from him. He edits a spreadsheet; the site updates. That's the whole contract.

What did change is what it costs. jQuery plus jQuery CSV became about forty lines of native `fetch` and a CSV parser that handles quoted fields properly. The state matching runs two passes — strict uppercase abbreviation first, then a case-insensitive recovery pass — because the live CSVs mix `VIC`, `Vic` and `Victoria`, and a strict parse silently drops those rows. That's not defensive programming for its own sake; it's the difference between a stockist appearing and a stockist not existing.

The list itself renders as **indexable HTML** across nine pages per site — an index plus eight states — with the Google map as an enhancement on top. The previous implementation drew everything into a map and nothing else, which meant several hundred Australian retail locations were invisible to search.

## Shipping a redesign onto a live domain nobody has approved yet

This is the part I'd reuse anywhere.

Both bedding sites belong to one owner, and a redesign he hasn't seen can't go live — but a preview he has to take my word for isn't a preview either. Staging on a `.github.io` URL means he's reviewing something that behaves subtly differently from the real thing: different domain, different SSL, no CNAME, no analytics.

So the new design shipped **to his own live domain**, at `/preview/`, months before he approved it — while the 2013 site kept serving `/` untouched. Four things made that safe:

1. **Every preview page carried `noindex: true` and `sitemap: false`** in front matter, so Google never saw a half-approved site or a duplicate of the live one.
2. **The old layout stayed the default.** The new pages opted into new layouts by path; `/` kept rendering the old one until the day of the flip.
3. **Config keys were deliberately duplicated.** The old layout read `stockistscsv` and `phone_international`; the new templates read `stockists_csv` and `phone_intl`. Both sets lived in `_config.yml`, each commented with which layout owned it, so cleaning up the new names could never quietly break the page that was actually serving customers.
4. **The 404 page was rebuilt standalone** — its own markup, its own inline CSS, linking only home and the phone number. An earlier version inherited the redesign's header, which meant any bad URL on the live domain leaked the unreleased site and offered navigation to routes that didn't exist yet.

The flip itself, once he signed off, was mechanical: move `preview/*` to the root, repoint the URL front matter, drop the two release gates, delete the old layout and the legacy aliases it alone read. One commit per site. The design had already been running on the real domain for weeks, so there was nothing to discover at go-live.

## Mower Corner, specifically

Mower Corner went live back in early August and got the most functional work, because a shop has state a bedding manufacturer doesn't.

The header carries a **live open/closed readout** — "Open now · until 5pm", or "Closed · opens tomorrow 8:30am" — computed client-side against the shop's real trading hours in Melbourne time, with today's row marked in the hours plate. It's the single most-asked question about a physical shop and it was previously answered by a static table you had to cross-reference against your own watch.

Four **service pages** were written against real local search demand rather than invented: chainsaw service and sharpening, mower servicing and repairs, spare parts, and pickup and delivery. The range picked up STIHL's iMOW robotic mowers, and Click & Collect is branded STIHL-only throughout — they're a STIHL dealer, and the online-order pipeline is STIHL's, so implying you could get a Victa through it would have generated exactly the wrong phone calls.

Two implementation notes I'd defend anywhere:

- The **mobile menu is a `<details>` disclosure**. It opens and closes with no JavaScript at all. The 28 lines of JS behind it only add the niceties — Escape to close, outside-click, closing on same-page anchors — so a script failure degrades to a working menu rather than a hamburger that does nothing.
- **Reveal-on-scroll replaced AOS** with an `IntersectionObserver`, and it checks `prefers-reduced-motion` first. If the visitor has asked for less motion, or the browser lacks the API, everything is simply visible.

## What I'm not claiming

The posts this one replaces asserted "a measurable increase in conversion rates" without a number. I don't have before-and-after analytics I trust across a redesign, a domain move and a seasonal cycle, so I'm not going to imply I do. What's verifiable: four sites that load without a framework, several hundred retail locations that are now indexable, contrast that passes AA, structured data that validates, and every marketing claim on the bedding sites checked against a source before it shipped.

Still open, honestly: Google Business listings need updating on the bedding brands, one domain transfer needs registrant paperwork, and the animal photography on both sister sites is currently stills cut from the client's own video — interim, until his photographer delivers.
