# zackdesign.biz

Jekyll 4 site, built and deployed by `.github/workflows` on push to `master` (GitHub Pages via Actions, not the classic Pages builder: `jekyll_picture_tag` needs libvips). Build locally with `bundle exec jekyll build`. Sister site isaacrowntree.com lives at `~/src/isaacrowntree.github.io` and shares the palette, type and the same performance pitfalls; check it when fixing either.

## Blog post format

`_posts/2026-3-20-ledger.md` is the reference. Every post follows it:

1. **Front matter:** `title` ("Name: what it is" for projects), `description` (SEO), `excerpt` (card text, matches the opening), `image` + `image_alt`, `date`, `last_modified_at` (bump on any substantive edit), `categories`, `tags`.
2. **Opening paragraph** (~60–110 words). Project posts start "Zack Design's **[Name](url)** is …" in plain words, a few key phrases in bold, and end with the licence ("**MIT licensed.**"). Projects owned by Triptech say so; never claim them for Zack Design. Essays keep a narrative hook. Detail goes in the body, not the opening.
3. **Button row** straight after it (`<div class="hero-cta-row" …>` with `btn-primary` then `btn-outline-primary`): the most useful action first (the live product, else "Source on GitHub"), then docs or a demo. Only real URLs. Essays with nothing to link skip it.
4. **"This post covers:"** a short list of the sections, in order.
5. `<!-- more -->`, then `##` sections with plain headings. A "Why it exists" section and a "Trying it" section with commands suit project posts.

Style: plain, concrete, short sentences; Australian spelling; explain jargon the first time; no marketing words.

## Search

`search.json` is the index (built by Liquid), `js/search.js` the dialog in `_includes/navbar.html`. Posts are always indexed; pages opt in with `search: true` in front matter.

## Performance rules (slow devices)

- No `mix-blend-mode` on fixed, full-viewport layers (the grain overlay is plain alpha).
- `backdrop-filter` only on fixed chrome (navbar, sticky bars), never on cards or anything in normal flow.
- Parallax: `js/parallax.js` writes `--scroll-progress` onto the elements that read it, not the section (a custom property on a section restyles all its descendants every frame). Parallax is off on touch and low-end devices.
- No permanent `will-change` on lists of cards.
