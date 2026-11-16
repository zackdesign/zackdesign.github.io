---
layout: post
title: "claude-social-skills — one CLI for ten platforms, built from their live API specs, checked against their live servers"
description: "One Bun command, `social`, covering X, Bluesky, Mastodon, Reddit, Facebook, Instagram, Threads, YouTube, eBay and email. Four platforms are generated from their published API description and pinned so a changed API fails the build; every platform is reachable end to end through one generic call; the skill docs are generated from the binary. Running it against the real servers shows where the docs are wrong: five retired eBay calls, a 402 from X, a Graph API two versions on, and eight email flags that no longer exist."
excerpt: "Hand-written API wrappers agree with their own documentation and drift from the platforms. `social` is one command generated from what the platforms publish and checked against what they actually serve, which differs in seven places."
image: /images/blog/claude-social-skills.jpg
image_alt: Smartphone screen displaying a folder of social media apps
date: 2026-02-15
last_modified_at: 2026-11-16
categories: [open-source, ai]
tags: [claude-code, plugins, social-media, email, ebay, bun, typescript, openapi, open-source]
---

Zack Design's **[`claude-social-skills`](https://github.com/isaacrowntree/claude-social-skills)** is one command, `social`, that talks to X, Bluesky, Mastodon, Reddit, Facebook, Instagram, Threads, YouTube, eBay and your mail, with **one Claude Code skill per platform**. It runs directly on [Bun](https://bun.sh) with no build step. Where a platform publishes a machine-readable description of its API, the tool is **generated from it and pinned**, so the day the API changes is the day the build fails. **MIT licensed.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/isaacrowntree/claude-social-skills" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
</div>

This post covers:

- why hand-written wrappers drift from the platforms;
- the shape: one command, one HTTP layer, and one generic call that reaches every platform;
- generating four of the platforms from what they publish;
- what the live servers say, from five retired eBay calls to eight mail-client flags that no longer exist, and what was not verified;
- setup, and what I would tell someone starting this.

<!-- more -->

## Why hand-written wrappers drift

A script written against a platform's docs works the day it is written. Within months eBay retires the category endpoints it calls, Facebook's Graph API moves two versions on, and the mail client drops eight of the flags its skill documents. Nothing reports any of it. So `social` is generated from what each platform publishes where it can be, and pointed at the real servers instead of the docs where it can't.

## One command, one HTTP layer, one escape hatch

The shape is borrowed from two earlier tools, [clickup-cli](/clickup-cli/) and [slackbuzz-cli](/slackbuzz-cli/), which both pull the vendor's live API specification and put a thin command on top. Here it is three layers.

A single HTTP core that every platform goes through: retries on 502, 503 and 504 for requests that are safe to repeat, one wait on a 429 for as long as the server asks up to ninety seconds, a typed error that carries the status and the response body, and a `--dry-run` flag that prints the request and sends nothing. No platform module calls `fetch` itself.

A short platform contract: a name, where its spec came from, which credentials it needs and how to get them, a function that returns an authenticated client, and a function that registers a handful of curated commands. That is all a platform is. eBay's module is the largest, because it has three authentication paths.

And a generic call for everything else:

```bash
social api mastodon api/v1/trends/tags
social api x users/by/username/bsky -q user.fields=public_metrics --jq .data
social api ebay sell/inventory/v1/offer --input offer.json
social api youtube channels -q part=snippet -q mine=true
```

`social api <platform> <path>` applies that platform's auth and takes typed body fields, a JSON file or stdin, query parameters, extra headers, a method override and a jq filter. It exists so that the curated commands can stay few. There is no flag per API field anywhere in the tool; if you need one, the passthrough is the answer, and the skill file says so.

## Generated from what the platform publishes

Four of the ten publish something a machine can read. X has an official OpenAPI 3 document with 159 paths. Bluesky renders its 165 lexicon files as an OpenAPI document too, 152 paths. Mastodon has a community-maintained OpenAPI 3.1 spec tracking version 4.7 with 174 paths. YouTube has Google's Discovery document. `bun run gen` fetches each one, generates TypeScript types, and checks the document against a pinned hash. In CI that check runs on every push, so an upstream change is a red build with the new hash in the log, not a silent drift.

Hashing the raw bytes is not enough to pin. X serves its OAuth scope lists in a different order on every request, and Google stamps the Discovery document with an etag, so two fetches ten seconds apart never match. So the pin is over a canonical form: parsed JSON with keys sorted, arrays of strings sorted as sets, and the etag removed. Two fetches then agree, and a real change still does not.

The other six have no fetchable spec. Meta's Graph API has none. Reddit has HTML docs. eBay publishes OpenAPI contracts but its developer site answers every non-browser request with a 403, so they would have to be vendored by hand. For these the wrapper cites the documentation page for each call in a comment next to the call, which is the weakest form of the guarantee but still a link someone can click when a call stops working.

The skill files Claude reads are generated from the tool. `bun run gen-skills` walks the command registry of each platform and writes its `SKILL.md`: every command, every flag, the credentials, the spec source, the passthrough examples. A verify mode fails CI if a checked-in skill differs from what the binary would produce. The documentation cannot describe a flag that does not exist, because it is not written by a person.

## What the live servers say

Every platform is exercised against its real server with whatever credentials exist, read-only, and anything not exercised is said out loud. Two platforms have credentials on the build machine, eBay and mail. Here is what the servers say that the documentation doesn't.

**eBay has retired five Trading API calls.** `GetCategories`, `GetCategorySpecifics`, `GetSuggestedCategories`, `GetCategoryFeatures` and `GeteBayOfficialTime` all return HTTP 410, so category search, category suggestion and item-specifics commands built on the Trading docs are dead. Listing, revising, messages, offers and My eBay are all alive, and a listing verified with `VerifyAddFixedPriceItem` was accepted by eBay with only a payments-hold warning, without creating anything. Category lookups use the Commerce Taxonomy REST API, which needs only an app-level token: a client id and secret exchanged by the tool, no user sign-in, no callback server. That keeps the reason the Trading path exists at all.

![Three eBay credentials and what each reaches: an Auth'n'Auth token pasted once reaches the Trading API for listing, pictures, messages and offers; an OAuth 2 user token via a browser redirect reaches the Sell REST APIs; an app-only token with no sign-in reaches the Taxonomy API for categories, which replaced the Trading calls eBay retired.](/images/blog/claude-social-skills-ebay-auth.svg)

The two user auth paths both stay, on purpose. The Auth'n'Auth token is one string pasted from the portal that lasts about eighteen months and needs no server, and that is how a person lists things from a laptop. OAuth, with its self-signed certificate on `https://localhost:8888`, is there for the Sell REST APIs and nothing else. They sit behind one command surface: `social ebay selling` and `social ebay messages` use the first, `social api ebay sell/...` uses the second, and the error you get when a key is missing names the exact key and the page it comes from.

**X answers 402 when the credits run out.** Every request on this account returns `402 Payment Required, credits depleted`. The signing is right, or it would be a 401; the account has simply used up its paid API allowance. The tool uses the app-only bearer token for reads when the user keys are absent, and says which four keys posting needs.

**Meta is on Graph API v26.** Scripts written for v24 are two versions behind. The current changelog was read, the version is one constant per host, and the live server confirmed v26 answers and v99 does not. One more thing the docs describe generically and the server does precisely: an invalid token in the query string is a 400, the same token in an `Authorization` header is a 401. The tool sends the header, so that the token never appears in an error message's URL.

**Bluesky's expired token is a 400.** Not a 401, which is what a generic "refresh on unauthorised" handler listens for. It is `400 ExpiredToken`, so the client catches that body, resumes the session and retries once. And the error for a wrong password is `AuthenticationRequired`, which Bluesky's own OpenAPI document does not list for that endpoint.

**mastodon.social's public timeline needs a token.** The docs say authentication is optional for the public timeline. On mastodon.social it is a 422, "This method requires an authenticated user"; on fosstodon.org the same request is a 200. Instance operators can turn it off, and the biggest one has.

**Reddit requires approval now.** Since November 2025 any API access needs an explicit request through Reddit's support form. And from the build machine's IP, logged-out JSON is blocked by network security regardless of the User-Agent, so the one unauthenticated check can't be run from there. Both facts are in the tool's credential hint.

**The mail client has moved on.** A skill written for himalaya 1.2.0 doesn't work with the installed 2.1.0, which rejects eight of its flags: `--output json` became a global `--json`, `--folder` became `--mailbox`, `folder list` became `mailbox list`, the preview and header flags on `message read` are gone along with the whole `template` subcommand, and reading a message no longer marks it seen. The mail module is built only from what `himalaya --help` accepts, and was run against three real accounts: listing, searching, reading the newest message without changing its flags, and tracing its authentication headers to an SPF, DKIM and DMARC verdict and a three-hop delivery chain.

## What was not verified

Authenticated calls on Bluesky, Mastodon, Reddit, Facebook, Instagram, Threads and YouTube were not run against the real servers, because no credentials for them existed on the build machine. Each of those platforms was still exercised for real as far as the unauthenticated surface allows: the spec fetched, the public endpoints read, the auth flow driven up to the browser sign-in, and the token endpoint sent a bad code to confirm the shape of its refusal. Nothing that publishes, sends, moves or deletes was run anywhere. Every curated command on every platform is covered by a local fake that asserts the exact method, path, query, headers and body, and none of those tests touches the network. The README lists what was and was not exercised, because the difference matters and a green test suite does not show it.

## Setup

```bash
git clone https://github.com/isaacrowntree/claude-social-skills && cd claude-social-skills
./scripts/setup.sh      # bun install, `social` on PATH, fetch and pin the specs, link the skills
social auth status      # what each platform still needs
social doctor           # one cheap authenticated read per configured platform
```

Credentials come from the environment, from `~/.config/social/.env`, or from the OS keyring, in that order. Platforms with a browser flow use `social auth login <platform>`; the rest take a pasted value with `social auth set`. Or install it as a Claude Code plugin marketplace and let the skills do the talking.

## What I would tell someone starting this

- Generate from the spec where one exists, and pin it. The pin is the only thing that tells you the API moved.
- When there is no spec, run the tool against the real server and read what comes back. Five of the seven things above were found by a 410, a 402, a 422 or an exit code, not by reading.
- Say what you did not verify, in the README, next to what you did.
- One HTTP layer and one passthrough command keep every platform module small enough to read in a sitting, which is the only reason ten of them fit in one repo.
