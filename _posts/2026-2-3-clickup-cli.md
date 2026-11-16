---
layout: post
title: "clickup-cli — ClickUp from the terminal, wired into git and GitHub"
description: "A Go CLI for ClickUp that reads the task ID off your git branch, links PRs, and keeps a local index because ClickUp's search parameter is silently ignored — warm search takes 0.49 s across 4,086 tasks, where paging the API takes 9 s and reaches only 1,000 of them."
excerpt: "A Go CLI for ClickUp that reads the task ID off your git branch, links PRs, and keeps a local index because ClickUp's search parameter is silently ignored — warm search takes 0.49 s across 4,086 tasks, where paging the API takes 9 s and reaches only 1,000 of them."
image: /images/blog/clickup-cli.jpg
image_alt: The ClickUp mark beside a terminal window running clickup task view, clickup link pr, and clickup status set "review"
date: 2026-02-03
last_modified_at: 2026-11-16
categories: [open-source]
tags: [go, cli, clickup, github, ai-agents, cobra, open-source]
---

Triptech Travel's **[`clickup-cli`](https://github.com/triptechtravel/clickup-cli)** is a command-line tool, written in Go, for ClickUp, the project-management web app Triptech tracks its work in. It reads the **ClickUp task ID from the name of your git branch**, so `clickup task view`, `clickup status set "review"` and `clickup link pr` need no arguments. It keeps a **local search index** that answers in half a second across 4,086 tasks, because ClickUp's own search parameter is silently ignored. Every list and view command emits JSON, so AI coding agents can drive ClickUp without a browser. Isaac Rowntree wrote and released it as part of his engineering work at [Triptech Travel](https://github.com/triptechtravel); it is cross-posted here on the Zack Design blog. **MIT licensed.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/triptechtravel/clickup-cli" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
  <a href="https://triptechtravel.github.io/clickup-cli" target="_blank" rel="noopener" class="btn btn-outline-primary btn-lg">Documentation</a>
</div>

This post covers:

- the pattern that pulls a task ID out of a branch name, and the list of words it must ignore;
- the three-stage matcher that turns "review" into the right status name;
- ClickUp's `search=` parameter, which is accepted and ignored, and the local index, built in 38 seconds, that searches instead of paging through the API;
- three reasonable rules that together empty the index, and the guards against them;
- the `clickup api` passthrough to any endpoint, and why unknown commands must fail loudly;
- a retry policy that refuses to repeat a request that creates things, and a JSON field that is a number until someone logs time and then becomes a string;
- trying it, why Go, and testing against the live API.

<!-- more -->

## Why it exists

The ClickUp web app doesn't know which git branch you're on. So you retype the same task ID hundreds of times a week: to read the task, move its status, and link the pull request. Read the task ID from the branch name, and those commands need no arguments. With forty stars in November 2026, it is the most-starred thing released under the Triptech org.

## Reading the task ID from the branch name

The CLI reads the branch from `git rev-parse --abbrev-ref HEAD`. It matches it with two regular expressions in `internal/git/taskid.go`:

```go
// CU-{alphanumeric} pattern for default ClickUp task IDs
cuIDPattern = regexp.MustCompile(`(?i)CU-([0-9a-z]+)`)

// PREFIX-{number} pattern for custom task IDs (e.g., PROJ-42, ENG-1234)
customIDPattern = regexp.MustCompile(`([A-Z][A-Z0-9]+-\d+)`)
```

Branch prefixes (`feature/`, `fix/`, `hotfix/`, `release/`, `chore/` and so on) are stripped first. Some uppercase branch names look like a custom task ID: `FIX-12`, `RELEASE-3`. An `excludedPrefixes` map rejects those rather than sending them to the API. If both forms are present, the `CU-` form wins. The API receives the bare ID with the prefix removed, because that's what the endpoints expect.

`clickup link pr` then reads the GitHub remote. Two more patterns in `internal/git/context.go` handle the SSH and HTTPS forms of the URL. It then asks `gh`, GitHub's own command-line tool, for the open pull request on the branch.

## Matching a status name from a partial one

ClickUp status names are too long to type. `MatchStatus` in `pkg/cmdutil/status.go` tries three stages in turn:

1. an exact match, ignoring case;
2. a match where the typed text is contained in the status name;
3. a fuzzy match, using `fuzzy.RankMatchNormalizedFold` from the `lithammer/fuzzysearch` library.

The only non-obvious rule is in the middle stage:

```go
if len(containsMatches) > 1 {
    // If multiple contains matches, pick the shortest (most specific).
```

So `"review"` matches `"code review"` rather than `"ready for code review"` when a workspace has both. A miss prints the available statuses rather than guessing.

## ClickUp's search parameter does nothing

The documentation for `GET team/{id}/task` lists a `search=` parameter, so `clickup task search "5.6.1"` looks like one API call. It returns one card where there are four.

The parameter is accepted and ignored. The same date-ordered page comes back whatever you pass. So "server-side search" through it is really the first page of the workspace, filtered locally. Two more traps sit on top of that:

- Drilling down through tiers (current sprint first, then wider) and stopping at the first tier that finds anything is wrong. A weak match in the current sprint hides an exact match two pages further on.
- Asking ClickUp for tasks ordered by last update with `reverse=true` gives you the *oldest* first, not the newest. A sweep built on it reads the oldest thousand tasks in the workspace.

![Two bars of 4,086 tasks from oldest to newest: a ten-page sweep with reverse=true, meant to read the newest 990, reads the oldest 990, leaving 3,096 tasks, including every recent one, unread.](/images/blog/clickup-search-window.svg)

Tests against the live API pin two things mocked tests can't catch. ClickUp returns 99 rows for a nominal 100-row page. So a short page doesn't mean you've reached the end; only an empty page does. And the ten-page cap is real, and it bites on this workspace. The CLI prints a "Not shown:" line, so an absence of rows doesn't read as an absence of tasks.

## A local index instead

Paging through ten pages on every search is slow, and it still misses the eleventh. So search uses a local index in `internal/taskindex/`. The whole workspace is fetched once. After that, the CLI asks only for tasks updated since the last sync, using ClickUp's `date_updated_gt` filter, one of the few it honours. A week of changes is a single page. The index lives at `~/.cache/clickup/index-<workspace>.json`; `CLICKUP_CACHE_DIR` moves it.

| | Paging the API | With the index |
|---|---|---|
| First build | not applicable | 38 s for 4,086 tasks (2.8 MB on disk) |
| A search once the index is warm | 9 s, and only 1,000 tasks searched | 0.49 s across all 4,086 |

The index stores subtasks with their parent, so one cache serves both `--include-subtasks` and plain searches. `--no-cache`, `--comments` and `--assignee` bypass it. Comment bodies aren't indexed, and assignee is one of the few filters ClickUp really applies. A missing or corrupt cache falls back to a fresh sync, never an error.

## Three reasonable rules that empty the index

Three rules, each correct on its own, delete the index together. With all three, a `--refresh` of a healthy 4,089-entry index leaves 7 entries, reports itself complete, and answers "No tasks found":

1. The insert-or-update step skips any entry equal to what is stored. That avoids rewriting a multi-megabyte file when nothing changed.
2. A completed rebuild drops any entry not stamped with the time of that rebuild. That's how deleted tasks are removed.
3. The equality check ignores the timestamp, which is correct on its own.

So every task that simply hasn't changed is never re-stamped, looks unseen, and is dropped. The more stable the workspace, the more it deletes. The guard is twofold. The update step advances the timestamp on an unchanged entry without forcing a write. And a rebuild that would keep less than a tenth of a populated index is refused and reported. Repeated `--refresh` holds steady at 4,090 entries.

## Any endpoint, and commands that fail loudly

**`clickup api`** is a generic passthrough to any endpoint, including ones without a dedicated command: `clickup api -X PUT task/abc123 -f archived=true`. `-f` turns `true`, `false`, `null` and numbers into JSON types, because ClickUp silently ignores the string `"true"`.

**`task archive` and `task unarchive`** handle what ClickUp doesn't: it doesn't archive subtasks with their parent, which can leave `to do` subtasks alive under an archived task. Archiving names every subtask it leaves behind, and `--cascade` includes them.

A command that doesn't exist must fail loudly. Cobra, the Go library the CLI is built on, prints help and exits 0 for an unknown subcommand under a group. So a mistyped or missing command looks like it worked. `clickup task bogus` exits non-zero and names the commands that exist.

## Retrying failed requests, except the ones that create things

Requests time out waiting for response headers often enough to matter, even in a routine `task edit` or `comment add`. Retrying only on HTTP 429, the "too many requests" status, isn't enough. `internal/api/retry.go` makes up to three attempts, waiting 250 ms and then 1 s. It retries on dropped connections and on the 502, 503 and 504 gateway errors.

That applies to GET, HEAD, PUT and DELETE. A PUT applied twice is the same edit. POST is excluded on purpose, because it's the verb that creates a comment, a task or a time entry. A timeout waiting for headers doesn't mean the server did nothing, and repeating it automatically produces duplicates. Instead the user gets:

```
POST request failed without a response (…); it may already have been applied — check before retrying
```

## A field that is a number until time is logged against it

ClickUp reports `time_spent` as the number `0` while nothing is tracked. Once something is, it's the string `"2040000"`, in the same response. Go types that expect one or the other fail outright. `clickup task view <parent>` then shows no name, no status, no siblings, just a `json.Unmarshal` error, as soon as one subtask has time logged against it (issue #27).

`clickup.Millis` accepts either form and writes back as a number. So `--json` output, and any `jq` filters over it, are unchanged. The Go types are generated from ClickUp's OpenAPI spec, the machine-readable description of the API. We keep a patch over that spec, and an `x-go-type` annotation in it wires `Millis` into every millisecond field.

The same defect sits one field over. A time entry's `start`, `end` and `at` swing between string and number exactly as `duration` does. The spec's own stop-timer example shows a string `start` beside a numeric `end`. Stopping a timer is the worst place to break. The timer is already stopped on the server by the time a CLI that can't read the response fails, so a retry finds no timer running. Request bodies deliberately keep plain integers, because the CLI is the side sending them.

## Trying it

Install it with the script, Homebrew or Go:

```sh
curl -fsSL https://raw.githubusercontent.com/triptechtravel/clickup-cli/main/scripts/install.sh | sh
brew install triptechtravel/tap/clickup
go install github.com/triptechtravel/clickup-cli/cmd/clickup@latest
```

Then `clickup auth login` with your API token, and `clickup space select` to choose a default space. A typical day:

```sh
# On branch feature/CU-abc123-refactor-auth
clickup task view                 # shows CU-abc123 details
clickup status set "in progress"
# ...write code, open PR...
clickup link pr                   # links the PR to the task automatically
clickup status set "review"
clickup sprint current            # what else is in this sprint?
```

Beyond tasks, it covers ClickUp Docs and their pages, time tracking, comments with @mentions, your inbox, chat and attachments. Every list and view command takes three output flags:

- `--json`;
- `--jq`, for a `jq` expression (the standard command-line JSON filter);
- `--template`, for a Go template.

That's what lets [Claude Code](https://claude.com/claude-code), Copilot and Cursor read and update ClickUp without driving a browser. `--with-token` covers continuous-integration jobs, and `examples/` holds six GitHub Actions workflows.

## Why Go

Go gives a single static binary per platform, with no runtime to install. Shell completion is identical across bash, zsh, fish and PowerShell.

## Testing against the live API

Mocked tests pass while the live API disagrees: about search, and about fields that change type. So `scripts/smoke.sh` runs two round trips against a real workspace:

- create a task, search for it, and check it's found;
- log time on a subtask, then read the parent and check it still decodes.

The ClickUp v2 spec is pinned in the repo and patched, because upstream changes it without notice and the documented types aren't the types the API sends. Triptech uses it for all of its engineering work. If you're on ClickUp and spend any real fraction of your day in a terminal, [install it](https://github.com/triptechtravel/clickup-cli) and tell the team what's missing.
