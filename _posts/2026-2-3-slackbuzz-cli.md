---
layout: post
title: "slackbuzz-cli — Slack from the terminal, without leaving flow"
description: "A Go CLI for Slack that brings activity inbox, threaded DMs, file uploads, reactions, status, and ClickUp/GitHub-aware message enrichment to a terminal."
excerpt: "A Go CLI for Slack that brings the activity inbox, threads, DMs, file uploads, reactions, and ClickUp/GitHub-aware message enrichment to a terminal."
image: /images/blog/slackbuzz-cli.jpg
image_alt: Monitor displaying bright programming code on a dark desk
date: 2026-02-03
last_modified_at: 2026-02-03
categories: [open-source]
tags: [go, cli, slack, developer-tools, ai-agents, open-source]
---

The companion piece to [clickup-cli](/clickup-cli/) — [`slackbuzz-cli`](https://github.com/triptechtravel/slackbuzz-cli) is a [Triptech Travel](https://github.com/triptechtravel) open-source project, authored and released by Isaac Rowntree in his Triptech engineering capacity and cross-posted here on the Zack Design blog. It is a Go-based command-line tool for Slack that lets you read mentions, reply to threads, upload files, manage your status, and search a workspace without ever opening a browser.

<!-- more -->

## Why yet another Slack client

Because the Slack desktop app is an electron-shaped context switch, and nothing kills a deep-focus coding session faster than "let me just check that thread…" and losing the next forty minutes. A terminal client flips the relationship: Slack comes to you when you choose to check it, in the same shell where you are already working, with output that pipes cleanly into `jq`, `grep`, and `fzf`.

## What it does

- **Activity inbox.** `slackbuzz activity` (alias `inbox`) — mentions, DMs, and threads needing your attention in one list.
- **Messages.** List, send, search, edit, and delete in any channel or DM. Threads are first-class.
- **Files.** Upload one or many files to channels or DMs, with thread targeting and shared-file search.
- **Reactions.** Add and remove emoji reactions; inline reaction counts everywhere they matter.
- **Saved items & bookmarks.** Save for later, list, manage.
- **Status.** Set, view, and clear your Slack status without opening the app.
- **DM browsing.** List and read direct-message conversations.
- **Emoji rendering.** 1,900+ shortcodes rendered as proper Unicode, plus custom workspace emoji.
- **@mention resolution.** `@isaac` in a message body auto-resolves to Slack's `<@U0123456>` format, with first-name shorthand for dotted or multi-word names.
- **Shell unescape.** Strips zsh history-expansion artifacts like `\!` before sending — no more "hello world\!" accidents.
- **ClickUp & GitHub enrichment.** Auto-detects `CU-` task IDs and GitHub PR/issue URLs in messages, with actionable hints inline.
- **AI-friendly.** Every list/view command supports `--json`, `--jq`, and `--template` — so Claude Code, Copilot, and Cursor can read your workspace directly.
- **Shell completions.** bash, zsh, fish, PowerShell.
- **Secure credentials.** Tokens stored in the macOS Keychain or the Linux Secret Service, with a plaintext fallback where those are unavailable.

## A typical morning

```sh
slackbuzz activity              # what happened while I was asleep
slackbuzz send '#general' "morning team"
slackbuzz status set "heads down — PR review at 2pm" --emoji ":brain:"
slackbuzz file upload diagram.png '#engineering' --thread T123ABC
```

## Why Go, again

Same reasons as `clickup-cli` — single static binary, zero runtime dependencies, identical shell completions on every platform, and a pleasant concurrency story for the websocket-heavy parts of Slack's API.

Install via Homebrew (`brew install triptechtravel/tap/slackbuzz`), `go install`, or grab a binary from [releases](https://github.com/triptechtravel/slackbuzz-cli/releases). Source lives on [GitHub](https://github.com/triptechtravel/slackbuzz-cli).
