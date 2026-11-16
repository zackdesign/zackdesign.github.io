---
layout: post
title: "Four Australian client sites, rebuilt for 2026 — and shipped behind a preview on their own live domains"
description: "Mower Corner, AC Service & Parts, Breeder's Choice and Superior Shavings on hand-written CSS and Jekyll 4.4, with no CSS framework: 947 stockists rendered as indexable HTML from a CSV the owner edits in Dropbox, a two-pass state matcher that finds 74 rows a strict regex drops, and a redesign staged on the client's live domain before sign-off."
excerpt: "A strict regex for Australian states silently drops 74 of 407 stockists; a two-pass matcher finds them. Four client sites on hand-written CSS with no framework, a stockist finder that reads the owner's Dropbox CSV at page load, and a way to stage a redesign on a client's live domain weeks before they approve it."
image: /images/blog/client-sites-rebuilt.jpg
image_alt: The four rebuilt homepages side by side — Mower Corner's cast-iron and safety-orange shopfront, Breeder's Choice in daylight green, Superior Shavings in industrial iron and red, and AC Service & Parts in bone and forest
date: 2026-08-21
last_modified_at: 2026-11-16
categories: [engineering]
tags: [jekyll, design-systems, css, seo, accessibility, github-pages, client-work, australia]
redirect_from:
  - /breeders-choice/
  - /mower-corner/
  - /recent-website-updates/
---

Zack Design has rebuilt four Australian client sites for 2026: **[Mower Corner](https://mowercorner.com.au)**, **[AC Service & Parts](https://acparts.com.au)**, **[Breeder's Choice](https://breederschoice.com.au)** and **[Superior Shavings](https://superiorshavings.com.au)**. They run on **hand-written CSS**, on Jekyll 4.4.1 and GitHub Pages, and **none of the four loads a CSS framework**. The most useful findings are small. A strict regex for Australian states silently drops **74 of 407 stockists**. And a redesign can be staged on the client's **own live domain**, hidden from search, weeks before they approve it.

This post covers:

- the stockist finder that reads the owner's Dropbox CSV at page load, and the two-pass state matcher that finds 74 of 407 retailers a strict regex drops;
- the four things that make it safe to ship an unapproved redesign to `/preview/` on the client's live domain, and a Liquid filter chain that doubles a URL;
- what replaced Bootstrap and jQuery;
- four businesses, four registers: why four trades in two states, two of them sister brands, need four designs;
- the `<details>` menu, `Intl.DateTimeFormat` readout and reduced-motion reveal on Mower Corner.

<!-- more -->

This post replaces three older ones about the same clients, which described sites that no longer exist.

## The stockist finder belongs to the client

Breeder's Choice and Superior Shavings are sold through produce stores, saddleries and pet retailers: 407 and 540 of them, counted from the live CSVs today. The owner maintains both lists in his own Dropbox, and has for years.

The obvious engineering move is to pull the CSV at build time. It server-renders, it's fast, it's cacheable. I built it the other way on purpose, and the header of `stockists.js` says so:

```js
/* Stockist finder — fully dynamic by design.
   The CSV lives in the owner's Dropbox and is fetched in the browser at page
   load, so edits go live with NO site deploy. Do not move this to build time.
   No jQuery, no jquery-csv: ~40 lines of native fetch + parse. */
```

With a build-time fetch, his edits would not appear until something triggered a deploy. The moment his workflow depends on my CI, I have taken his list away from him. Instead, he edits a spreadsheet and the site updates. The URL reaches the script as {% raw %}`data-csv="{{ site.stockists_csv }}"`{% endraw %}. The parser handles quoted fields and embedded commas. If the fetch fails, the page says so and shows the phone number.

State matching is where rows go missing. One regex, `\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b`, against the address fields drops 74 of Breeder's Choice's 407 rows: Victoria shows 185 stockists instead of 258. The live CSVs mix `VIC`, `Vic` and `Victoria`, and a strict match silently loses the rows it doesn't recognise. So it is two passes:

```js
  function stateOf(s) {
    var hay = (s['Address 2'] || '') + ' ' + (s['Address 1'] || '');
    var m = hay.match(/\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/);
    if (m) return m[1];
    m = hay.match(/\b(new south wales|victoria|queensland|south australia|western australia|tasmania|northern territory|australian capital territory|nsw|vic|qld|sa|wa|tas|nt|act)\b/i);
    if (!m) return '';
    var t = m[1].toLowerCase();
    return STATE_NAMES[t] || t.toUpperCase();
  }
```

That is not defensive programming for its own sake. It is the difference between a stockist appearing and a stockist not existing.

The list renders as indexable HTML across nine pages per site: `stockists/index.md` plus `act`, `nsw`, `nt`, `qld`, `sa`, `tas`, `vic` and `wa`. The Google map is an enhancement on top. A finder that draws everything into a map and nothing else leaves several hundred Australian retail locations invisible to search.

## Shipping a redesign onto a live domain nobody has approved yet

This is the part I would reuse anywhere.

Both bedding sites belong to one owner. A redesign he has not seen cannot go live. But a preview he has to take my word for is not a preview either. Staging on a `.github.io` address means he reviews something that behaves differently from the real thing: different domain, different certificate, no CNAME, no analytics.

So the new design goes onto his own live domain at `/preview/`, and the old site keeps serving `/`, untouched. Here it ran that way for two weeks before sign-off.

![Left, before sign-off: the live domain keeps serving the old site at its root and its stockists pages, the new home page and nine new stockist pages live under /preview/, marked not indexed and left out of the sitemap, and a standalone 404 page links only to home and the phone number. Right, after sign-off: the preview pages move to the root in one commit per site, both gates are removed, the old layout and its config aliases deleted, and the 404 page is unchanged.](/images/blog/client-sites-preview-layout.svg)

Four things make that safe:

1. **Every preview page carries two release gates in its front matter**: `noindex: true` and `sitemap: false`, on the home page and all nine stockist pages. Google never sees a half-approved site, or a duplicate of the live one. The default share image (`og:image`) is scoped to `path: "preview"` for the same reason: the old pages at `/` have to stay byte-identical.
2. **The old layout stays the default by doing nothing.** There is no default layout in `_config.yml`. The root `index.md` keeps `layout: default`. Every new page under `preview/` opts into `layout: home` or `layout: stockists` explicitly.
3. **Config keys are deliberately duplicated.** The old layout reads `stockistscsv` and `phone_international`, and jekyll-seo-tag appends `site.tagline` to the live homepage `<title>`. So the new templates read `stockists_csv`, `phone_intl` and `brand_tagline`. Both sets live in `_config.yml`, each commented with the layout that owns it. The comment on the alias reads "the OLD layout still serving at / reads this key. Remove when the preview is promoted." Rename a key without its alias and the live stockists page quietly loses its CSV.
4. **The 404 page is standalone**, with `layout: null`, its own markup and inline CSS, linking only home and the phone number. The CSS comment says why: "this page serves on the LIVE domain today, so it carries no nav into the unreleased design and no links that 404." A 404 that inherits the redesign's header leaks the unreleased site on any bad URL.

One Liquid trap is worth recording, because it looks correct. Say the header builds the stockists link as:

{% raw %}
```liquid
{%- assign stk = page.stockists_index | default: home | append: 'stockists/' -%}
```
{% endraw %}

Filters are a left-to-right pipeline, not a conditional. `default:` only substitutes when the left side is empty, but `append:` runs regardless. On a preview page where `page.stockists_index` is already `/preview/stockists/`, the link becomes `/preview/stockists/stockists/`. An explicit `unless` avoids it.

After sign-off, the flip is mechanical. `git mv preview/stockists/* stockists/`, repoint `home_url` and `stockists_index`, drop the two gates, and delete `_layouts/default.html` and the aliases only it reads. One commit per site. The design has already been running on the real domain, so there is nothing to discover at go-live.

GitHub Pages has two traps. First, it caches assets for four hours, which leaves browsers running stale JS after a deploy. So every asset URL on the bedding sites carries {% raw %}`?v={{ site.time | date: '%s' }}`{% endraw %}. Second, the Pages action injects a `base_path` that silently breaks every asset URL if the custom-domain setting is ever dropped. So the workflow pins `jekyll build --baseurl ""`. Google Analytics is emitted only when `jekyll.environment == "production"`, which the workflow sets. A dev build has zero gtag loads; production has exactly one.

## What replaced Bootstrap and jQuery

Breeder's Choice's old `_layouts/default.html` pulled, in order:

- a Font Awesome kit from `kit.fontawesome.com`;
- Bootstrap 5.3.3 CSS from jsDelivr;
- AOS 2.3.1, a scroll-animation library, from unpkg;
- and, near the bottom of the file: jQuery 3.7.1 from `code.jquery.com`, Bootstrap's bundle from jsDelivr again, jQuery CSV 1.0.40 from cdnjs, and AOS's script from unpkg.

Superior Shavings had the same Font Awesome kit, the same Bootstrap and jQuery, jQuery CSV from jsDelivr, and Montserrat from Google Fonts. It had no AOS. Five CDN hosts each, a different five. Mower Corner's externals were in `_includes/styles.html` and `_includes/scripts.html`: Bootstrap 5.3.2, Font Awesome 6.4.2 from cdnjs, AOS from unpkg, Oswald and Open Sans from Google Fonts, and every photo from Cloudinary.

None of that was unreasonable in 2015. But the whole budget of every page went to generic scaffolding. What came out looked like every other Bootstrap site, because it was one.

What replaced it is one hand-written stylesheet and a little plain JavaScript per site. Mower Corner has `main.css` and `site.js` across five source pages. Breeder's Choice and Superior Shavings each have ten pages plus a 404, and share the same two scripts: `stockists.js` is byte-identical between them, and `site.js` differs only in its header comment.

AC Service & Parts is a one-page site. Its CSS is inline in `_layouts/home.html`.

Google Fonts and Analytics still load on all four. Mower Corner still serves its images through Cloudinary. The 2017 shop photography is flat and underexposed, and `e_improve:outdoor` plus `e_auto_color` on the actual pixels beats any CSS filter. I am not going to claim a purity I did not ship.

## Four businesses, four registers

The temptation with four clients at once is one design system in four colourways. But these are four trades in two states. Two are sister brands owned by the same person, which makes *telling them apart* the actual design problem.

**Mower Corner: "spec plate."** Their mark is a condensed wordmark standing in a strip of grass, unchanged since the 90s. It is genuine equity in Colac. The grass is kept, redrawn as a silhouette; the sky gradient and clip-art operators are gone. The structural device is the riveted spec plate off the side of every machine in the shop, carrying the shop's own data. `main.css` declares:

- `--ink: #14181a`, cast iron;
- `--orange: #f2600c`, safety orange, the equity colour;
- `--grass: #2b7134`, traced from the wordmark's grass strip;
- `--radius: 2px; /* pressed metal, not soft plastic */`.

**Breeder's Choice: "the bale and the spec."** A family business that has done one thing since 1994. A 14 kg bale with a moisture spec is a real product, so the product leads. The site uses their own pallet photography, and a kraft bale-label tag carrying the spec the way the printed wrap does. The colours are `--forest: #0B4423` and `--green: #0F6B36` from the logo, on cream and kraft, with `--radius: 6px; /* softer than the industrial sibling */`. The stylesheet header calls it "the daylight sibling of Superior Shavings' iron-dark industrial register."

**Superior Shavings: "mill-side."** The sister plant is in NSW softwood country, and the pitch is proximity: from the saw into the bale with minimal handling. So it gets the opposite register. `--iron: #1F2224`, the logo's `--red: #BF2025`, a numbered mill line, and the spec set as a monospaced bale ticket. Same structure as Breeder's Choice, same ethos, different plant. Each site links the other in three places: the story section ("In NSW? Meet Superior Shavings"), the footer, and a `Brand` node in the JSON-LD.

**AC Service & Parts: refine, not replace.** The paddock palette and harvest photography work. So the budget goes to what a review found:

- **Contrast.** Terracotta text on bone measures 3.1:1. A darker `--terracotta-dark` at `#A8562F` gives 4.7:1 on bone, but fails on `--paper` and `--bone-dim`. At `#9A4E2A` it gives 4.5:1 on every background.
- **Structured data.** Typing each catalogue `<li>` as a schema.org `Product` with only a name and image draws Search Console's "Either offers, review, or aggregateRating should be specified" error, 30 times over. The Contentful model has no price or SKU, so those can never validate. So the catalogue is an `OfferCatalog` on the `LocalBusiness` node.
- **Smaller fixes.** The two Unsplash heroes are self-hosted. The desktop nav carries no `aria-hidden="true"` to hide it from screen readers. The copy doesn't say "No middlemen", because SpareX is a distributor. And there is one gated gtag block, not a second, ungated one at the end of `<body>` that would double-count.

## Mower Corner, specifically

Mower Corner went live on 6 August. It has the most functional work, because a shop has state that a bedding manufacturer does not.

The header carries a live readout: "Open now · until 5pm", or "Closed · opens tomorrow 9am". It is computed in the shop's timezone, not the visitor's, so someone checking from interstate sees whether Colac is open right now. The hours live once, in `_config.yml`. They drive the schema.org `openingHoursSpecification`, the printed plate and the readout. The layout hands them to the script as `window.MC_HOURS`, via `jsonify`.

The script uses `Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', … }).formatToParts()`. It has three guards:

- it normalises the hour with `% 24`, because en-AU can render midnight as 24;
- it cuts the weekday to three letters, because the locale data varies between browsers;
- it wraps the whole thing in `try`, because `formatToParts` with an explicit `timeZone` can throw on old engines, and a status readout is never worth a blank page.

It refreshes every 60 s.

Four service pages are written against local search demand: `chainsaw-service-sharpening`, `mower-servicing-repairs`, `spare-parts` and `pickup-and-delivery`. They say only what is sourced; an invented pickup process, however plausible, is a promise the shop never made. The range includes STIHL's iMOW robotic mowers. Click & Collect is branded STIHL-only throughout, because the online-order pipeline is STIHL's. Implying you could get a Victa through it would generate exactly the wrong phone calls. `site.webmanifest` uses `display: browser`, not `standalone`, because a brochure site for a local shop has no business prompting Chrome to install itself.

Two implementation notes I would defend anywhere:

- **The mobile menu is a `<details>` disclosure.** It opens and closes with no JavaScript. `mobileMenu()` only adds four things: Escape (returning focus to the `<summary>`), closing on an outside click, closing on same-page anchors, and closing when the `(min-width: 62rem)` query flips to desktop. If the script fails, you still get a working menu, not a hamburger that does nothing.
- **Reveal-on-scroll uses an `IntersectionObserver` instead of AOS**, at `threshold: 0.1`, staggered by `Math.min(i % 4, 3) * 70` ms. It checks `prefers-reduced-motion` first. If the visitor has asked for less motion, or the browser lacks the API, it marks everything visible. The hiding styles are switched on by `document.documentElement.classList.add('js')` in the script itself, not the document head. If the file never loads, nothing is ever hidden.

Two multi-agent review rounds over the code confirmed 43 findings, all fixed. They run from ink-on-orange `::selection` at 5.4:1 to a duplicate canonical.

What holds across all four: put the client's data where the client already edits it, count what a regex drops before trusting it, and stage on the real domain behind `noindex` rather than on a lookalike. No Lighthouse numbers were recorded, so I am not quoting any.
