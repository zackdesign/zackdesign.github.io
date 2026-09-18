---
layout: post
title: "clickup-cli — ClickUp from the terminal, wired into git and GitHub"
description: "A Go CLI for ClickUp that reads the task ID off your git branch, links PRs, and keeps a local index because ClickUp's search parameter is silently ignored — warm search 0.49 s against 4,086 tasks, down from 9 s against a 1,000-task prefix."
excerpt: "A Go CLI for ClickUp that reads the task ID off your git branch, links PRs, and keeps a local index because ClickUp's search parameter is silently ignored — warm search 0.49 s against 4,086 tasks, down from 9 s against a 1,000-task prefix."
image: /images/blog/clickup-cli.jpg
image_alt: The ClickUp mark beside a terminal window running clickup task view, clickup link pr, and clickup status set "review"
date: 2026-02-03
last_modified_at: 2026-09-18
categories: [open-source]
tags: [go, cli, clickup, github, ai-agents, cobra, open-source]
---

[`clickup-cli`](https://github.com/triptechtravel/clickup-cli) is a [Triptech Travel](https://github.com/triptechtravel) open-source project — authored and released by Isaac Rowntree in his Triptech engineering capacity, cross-posted here on the Zack Design blog. It is a command-line tool, written in Go, for ClickUp, the project-management web app Triptech tracks its work in. It shipped on 3 February 2026 as 69 Go files and 6,663 lines whose whole job was to read a ClickUp task ID out of the name of the current git branch, so that `clickup task view`, `clickup status set "review"` and `clickup link pr` need no arguments. It is the most-starred thing released under the Triptech org to date — sixteen stars when this was written, and thirty-six by August 2026, which for a workflow tool nobody marketed is a quietly pleasing result.

This post walks through the parts that took real work: the pattern that pulls a task ID out of a branch name and the list of words it must ignore, the three-stage matcher that turns "review" into the right status name, the discovery that ClickUp's `search=` parameter is accepted and ignored (and the local index, built in 38 seconds, that replaced paging through the API), a JSON field that is a number until someone logs time and then becomes a string, and a retry policy that refuses to repeat a request that creates things.

<!-- more -->

## Reading the task ID from the branch name

The web app does not know what branch you are on, so you retype the same task ID hundreds of times a week. The CLI reads it from `git rev-parse --abbrev-ref HEAD` and matches it with two regular expressions in `internal/git/taskid.go`:

```go
// CU-{alphanumeric} pattern for default ClickUp task IDs
cuIDPattern = regexp.MustCompile(`(?i)CU-([0-9a-z]+)`)

// PREFIX-{number} pattern for custom task IDs (e.g., PROJ-42, ENG-1234)
customIDPattern = regexp.MustCompile(`([A-Z][A-Z0-9]+-\d+)`)
```

Branch prefixes (`feature/`, `fix/`, `hotfix/`, `release/`, `chore/` and so on) are stripped first. An uppercase branch prefix that happens to look like a custom task ID — `FIX-12`, `RELEASE-3` — is rejected by an `excludedPrefixes` map rather than sent to the API. If both forms are present, the `CU-` form wins. The API receives the bare ID with the prefix removed, because that is what the endpoints expect. `clickup link pr` then reads the GitHub remote with two more patterns (one for the SSH form of the URL, one for HTTPS, in `internal/git/context.go`) and asks `gh`, GitHub's own command-line tool, for the open pull request on the branch.

## Matching a status name from a partial one

ClickUp status names are too long to type. `MatchStatus` in `pkg/cmdutil/status.go` tries three stages in turn: an exact match ignoring case, then a match where the typed text is contained in the status name, then a fuzzy match using `fuzzy.RankMatchNormalizedFold` from the `lithammer/fuzzysearch` library. The only non-obvious rule is in the middle stage:

```go
if len(containsMatches) > 1 {
    // If multiple contains matches, pick the shortest (most specific).
```

So `"review"` matches `"code review"` rather than `"ready for code review"` when a workspace has both. A miss prints the available statuses rather than guessing.

## ClickUp's search parameter does nothing

I expected `clickup task search "5.6.1"` to be one API call, because the documentation for `GET team/{id}/task` lists a `search=` parameter. It returned one card. There were four.

The parameter is accepted and ignored: the same date-ordered page comes back whatever you pass. So what the code called "server-side search (fastest — single API call)" was really the first page of the workspace, filtered locally. Two more defects were stacked on top. The search drilled down through tiers (current sprint first, then wider) and returned at the first tier that found anything, so a weak match in the current sprint hid an exact match two pages further on. And asking ClickUp for tasks ordered by last update with `reverse=true` gives you the *oldest* first, not the newest, so the sweep was pointed at the oldest thousand tasks in the workspace.

![Two bars of 4,086 tasks from oldest to newest: the ten-page sweep was meant to read the newest 990 but actually read the oldest 990, leaving 3,096 tasks, including every recent one, unread.](/images/blog/clickup-search-window.svg)

Two things the mocked tests could never have caught are now pinned by tests against the live API. ClickUp returns 99 rows for a nominal 100-row page, so a short page does not mean you have reached the end; only an empty page does. And the ten-page cap is real and bites on this workspace, so the CLI now prints a "Not shown:" line rather than letting an absence of rows read as an absence of tasks.

Paging through ten pages on every search is slow and still misses the eleventh. The fix is a local index in `internal/taskindex/`: the whole workspace is fetched once, then kept current by asking only for tasks updated since the last sync (ClickUp's `date_updated_gt` filter, one of the few it honours), so a week of changes is a single page. It lives at `~/.cache/clickup/index-<workspace>.json` (override the directory with `CLICKUP_CACHE_DIR`).

| | Before the index | With the index |
|---|---|---|
| First build | not applicable | 38 s for 4,086 tasks (2.8 MB on disk) |
| A search once the index is warm | 9 s, and only the oldest 1,000 tasks were searched | 0.49 s across all 4,086 |

The index stores subtasks with their parent, so one cache serves both `--include-subtasks` and plain searches. `--no-cache`, `--comments` and `--assignee` bypass it (comment bodies are not indexed; assignee is one of the few filters ClickUp really applies). A missing or corrupt cache degrades to a fresh sync, never an error.

Then my own fixes deleted it. A `--refresh` of a healthy 4,089-entry index left 7 entries, reported itself complete, and answered "No tasks found". The cause was three reasonable rules interacting. The insert-or-update step skipped any entry that compared equal to what was stored, to avoid rewriting a multi-megabyte file when nothing had changed. A completed rebuild dropped any entry not stamped with the time of that rebuild, which is how deleted tasks are reconciled. And the equality check ignored the timestamp — correct on its own — so every task that had simply not changed was never re-stamped, looked unseen, and was dropped. The more stable the workspace, the more it deleted. The update step now advances the timestamp on an otherwise-identical entry without marking the index as needing a write, and a rebuild that would keep less than a tenth of a populated index is refused and reported rather than acted on. Repeated `--refresh` now holds steady at 4,090 entries.

## A field that is a number until time is logged against it

`clickup task view <parent>` failed outright — no name, no status, no siblings, just a `json.Unmarshal` error — as soon as one subtask had time logged against it (issue #27). ClickUp reports `time_spent` as the number `0` while nothing is tracked and as the string `"2040000"` once something is, in the same response. The generated Go types expected one or the other.

`clickup.Millis` accepts either form and writes back as a number, so `--json` output and any `jq` filters over it are unchanged. It is wired into every millisecond field in the generated response types through an `x-go-type` annotation in the patch we keep over ClickUp's OpenAPI spec (the machine-readable description of the API that the Go types are generated from). Review of that commit found the same defect one field over: a time entry's `start`, `end` and `at` swing between string and number exactly as `duration` does — the spec's own stop-timer example shows a string `start` beside a numeric `end`. Stopping a timer is the worst place to break, because the timer is already stopped on the server by the time the CLI fails to read the response, so a retry finds no timer running. Request bodies deliberately keep plain integers: the CLI is the side sending them.

## Retrying failed requests, except the ones that create things

Two calls timed out waiting for response headers during a routine `task edit` and `comment add`. The transport retried only on HTTP 429, the "too many requests" status. `internal/api/retry.go` now retries reads and repeatable writes up to three times, waiting 250 ms and then 1 s, on dropped connections and on the 502, 503 and 504 gateway errors. A PUT applied twice is the same edit. A POST — the verb that creates a comment, a task or a time entry — is excluded on purpose: a timeout waiting for headers does not mean the server did nothing, and repeating it automatically produces duplicates. Instead the user gets:

```
POST request failed without a response (…); it may already have been applied — check before retrying
```

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

Every list and view command takes `--json`, `--jq` for a `jq` expression (the standard command-line JSON filter), and `--template` for a Go template, which is what lets [Claude Code](https://claude.com/claude-code), Copilot and Cursor read and update ClickUp without driving a browser. `clickup api` is the escape hatch for any endpoint without a dedicated command. `--with-token` covers continuous-integration jobs, and `examples/` holds six GitHub Actions workflows.

## Why Go

A single static binary per platform with no runtime to install, and shell completion that is identical across bash, zsh, fish and PowerShell. Homebrew publishes `triptechtravel/tap/clickup`; `go install github.com/triptechtravel/clickup-cli/cmd/clickup@latest` and a `curl | sh` installer also work.

## What was learned

Mocked tests passed while the live API disagreed, twice, so `scripts/smoke.sh` now runs two round trips against a real workspace: create a task, search for it, and check it is found; and log time on a subtask, then read the parent and check it still decodes. The ClickUp v2 spec is pinned in the repo and patched, because upstream changed it under us and because the documented types are not the types the API sends. The repo is at 162 commits and 78 test files; Triptech uses it for all of its engineering work. If you are on ClickUp and spend any real fraction of your day in a terminal, [install it](https://github.com/triptechtravel/clickup-cli) and tell the team what is missing.
