---
layout: post
title: "clickup-cli — ClickUp from the terminal, wired into git and GitHub"
description: "A Go CLI for ClickUp that auto-detects task IDs from git branches, links PRs, drives the sprint dashboard, and hands AI coding agents clean JSON output."
excerpt: "A Go CLI for ClickUp that auto-detects task IDs from git branches, links PRs, drives the sprint dashboard, and hands AI coding agents clean JSON — now with 16 stars."
image: /images/blog/clickup-cli.jpg
image_alt: Close-up of programming code on a dark terminal window
date: 2026-02-03
last_modified_at: 2026-02-03
categories: [open-source]
tags: [go, cli, clickup, github, ai-agents, cobra, open-source]
---

[`clickup-cli`](https://github.com/triptechtravel/clickup-cli) is a [Triptech Travel](https://github.com/triptechtravel) open-source project — authored and released by Isaac Rowntree in his Triptech engineering capacity, cross-posted here on the Zack Design blog. It is a fast, scriptable command-line tool for ClickUp written in Go and designed for developers who live in a terminal and a GitHub PR tab. It is the most-starred thing released under the Triptech org to date — sixteen stars at the time of writing, which for a brand-new workflow tool is a quietly pleasing result.

<!-- more -->

## The problem

ClickUp's web app is fine. But if you spend your day in `git`, in `gh pr create`, and in a code editor, opening a browser tab to move a ticket to "code review" and paste a PR link is a context-switch tax you pay hundreds of times a week. The web app also does not know what branch you are on, so you retype the same task ID constantly.

## What the CLI does

- **Task management.** View, create, edit, search, bulk-edit, and bulk-delete tasks. Custom fields, tags, points, time estimates — all first-class.
- **Git integration.** Auto-detects the task ID from your current branch name. `clickup task view` with no arguments just works. `clickup link pr` wires the open GitHub PR to the task. `clickup link branch` and `clickup link commit` cover the long tail.
- **Sprint dashboard.** `clickup sprint current` lists tasks grouped by status. `clickup task create --current` drops a new task into the live sprint without you having to remember its ID.
- **Fuzzy status matching.** `clickup status set "review"` matches `"code review"` — because status names in ClickUp are almost always too long to type.
- **Time tracking.** `clickup task time log`, per-task and workspace-wide timesheets, date-range queries.
- **Comments & inbox.** `@mentions` auto-resolved from partial names, inbox roll-up across the workspace.
- **Docs.** List, view, create, and edit ClickUp Docs and their pages via the v3 API.
- **AI-friendly output.** `--json` on every list/view command, recursive task views, `--jq` filtering, and `--template` for bespoke output — so [Claude Code](https://claude.com/claude-code), Copilot, and Cursor can read and update ClickUp directly without needing a browser automation layer.
- **CI/CD ready.** `--with-token` for non-interactive auth, real exit codes, and a GitHub Actions workflow you can drop in unchanged.

## Typical day

```sh
# On branch feature/CU-abc123-refactor-auth
clickup task view                 # shows CU-abc123 details
clickup status set "in progress"
# ...write code, open PR...
clickup link pr                   # links the PR to the task automatically
clickup status set "review"
clickup sprint current            # what else is in this sprint?
```

That is the whole workflow — no browser tab open, no task ID retyped.

## Why Go

Go gives us a single static binary per platform with zero runtime dependencies, fast start-up, and a shell-completion story that works identically across bash, zsh, fish, and PowerShell. Homebrew publishes the `triptechtravel/tap/clickup` formula; `go install` also works for anyone on a supported Go version.

## What's next

Triptech is already using `clickup-cli` internally for all of its engineering work, and the API surface is stable enough that it is being wired into more AI-agent workflows. If you are on ClickUp and spend any real fraction of your day in a terminal, [install it](https://github.com/triptechtravel/clickup-cli) and let the team know what is missing.
