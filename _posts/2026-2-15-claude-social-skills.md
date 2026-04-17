---
layout: post
title: "claude-social-skills — Claude Code plugins for social, email, and eBay"
description: "A Claude Code plugin marketplace bundling social-post, ebay-listing, and himalaya-email — scripts + skills, no MCP servers required."
excerpt: "A Claude Code plugin marketplace bundling social-post, ebay-listing, and himalaya-email — just scripts + skills, no MCP servers, no daemons."
image: /images/blog/claude-social-skills.jpg
image_alt: Smartphone screen displaying a folder of social media apps
date: 2026-02-15
last_modified_at: 2026-02-15
categories: [open-source, ai]
tags: [claude-code, plugins, social-media, email, ebay, python, open-source]
---

Zack Design has published [`claude-social-skills`](https://github.com/isaacrowntree/claude-social-skills) — a Claude Code plugin marketplace bundling three genuinely useful capabilities into a single install. No MCP servers, no background daemons — just Python scripts plus `SKILL.md` files that teach Claude how to use them.

<!-- more -->

## What is in the marketplace

| Plugin | What it does |
|--------|-------------|
| **social-post** | Post to Twitter/X, Reddit, Facebook Pages, and Instagram Business/Creator accounts |
| **ebay-listing** | List items for sale on eBay — title, description, photos, pricing, shipping |
| **himalaya-email** | Read, send, and manage email using the excellent [Himalaya CLI](https://pimalaya.org/himalaya/) |

Each plugin is a self-contained directory with its own skill definition, scripts, and dependency list. Install only what you need.

## Install

Inside Claude Code:

```
/plugin marketplace add isaacrowntree/claude-social-skills
/plugin install social-post@social-skills
/plugin install ebay-listing@social-skills
/plugin install himalaya-email@social-skills
```

## social-post — one command, four platforms

`social-post` wraps four very different APIs behind a uniform skill surface. Credentials are exported as environment variables (Twitter API keys, Reddit client ID/secret, Facebook Page token, Instagram Business token), and the skill tells Claude which ones are required for which platform.

You can ask Claude things like:

> Post this to Reddit r/programming: "Check out this tool..."

> Share on Twitter and Reddit: "Big announcement..."

And it figures out the right endpoints, handles the rate limits, and reports back with the posted URLs. Under the hood, each platform is a ~100-line Python script, so nothing is magic — you can run `python3 scripts/tweet.py "Hello world"` directly if you want.

## ebay-listing — structured, not chatty

Listing on eBay through their API is finicky: item specifics, shipping policies, photos, tax categories, return policies, payment profiles. The skill defines a structured JSON shape for "a listing" and hands Claude enough context to map a rough human description ("I've got a 2022 Shimano derailleur, barely used, want $80") into a valid eBay payload.

## himalaya-email — email, but agent-shaped

Himalaya is a terminal-native email client that speaks IMAP, SMTP, Maildir, and Notmuch. Wrapping it in a skill means Claude can triage, summarise, reply, and draft email the same way a human would — without Yet Another OAuth dance or a bespoke Gmail integration that breaks on IMAP-only accounts.

## Why this shape

I experimented with full-blown MCP servers for these capabilities and ended up preferring the scripts-plus-skill approach: zero extra processes, zero ports to manage, and the underlying scripts stay runnable by a human on the CLI. Every credential is whatever the underlying service hands you — Twitter developer tokens, Reddit app credentials, Facebook Graph tokens, IMAP passwords in your keychain — stored however you already store them.

If you run Claude Code and you want to turn it into a genuinely useful operator for your daily online life, [install the marketplace](https://github.com/isaacrowntree/claude-social-skills) and pick the skills you actually use.
