---
layout: post
title: "slackbuzz-cli — Slack from the terminal, without leaving flow"
description: "A Go CLI for Slack generated from Slack's own OpenAPI spec — 174 typed methods, an app manifest derived from the calls the code makes, and the three-step upload that replaces Slack's removed files.upload."
excerpt: "A Go CLI for Slack generated from Slack's own OpenAPI spec — 174 typed methods, an app manifest derived from the calls the code makes, and the three-step upload that replaces Slack's removed files.upload."
image: /images/blog/slackbuzz-cli.jpg
image_alt: The Slack mark beside a terminal window running slackbuzz inbox, slackbuzz reply, and slackbuzz status
date: 2026-02-03
last_modified_at: 2026-11-16
categories: [open-source]
tags: [go, cli, slack, developer-tools, ai-agents, open-source]
---

**[slackbuzz-cli](https://github.com/isaacrowntree/slackbuzz-cli)** is a command-line Slack client, written in Go, and the companion piece to [clickup-cli](/clickup-cli/). It reads your mentions, replies to threads, uploads files, sets your status and searches the workspace **from a shell**, and every list and view command can print JSON, which is what makes it usable by AI coding agents such as Claude Code. Its Slack client is **generated from Slack's own published spec**. Isaac Rowntree wrote it during his engineering work at [Triptech Travel](https://github.com/triptechtravel), and it now lives on [his own GitHub](https://github.com/isaacrowntree), where he maintains it. **MIT licensed.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/isaacrowntree/slackbuzz-cli" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
  <a href="https://isaacrowntree.com/slackbuzz-cli/" target="_blank" rel="noopener" class="btn btn-outline-primary btn-lg">Documentation</a>
</div>

This post covers:

- how each command picks between the two kinds of Slack token, and why a direct message to yourself has to go out as the bot;
- generating the client from Slack's spec, and patching the two holes in it;
- an app permission list derived by reading the source code for `slackapi.<Method>()` calls, so the permissions can never drift from the code, and the scopes the spec puts on the wrong side;
- uploading files in three steps, since Slack has removed the one-call method;
- the outgoing-text clean-up, and why every command shares one function for it;
- setting it up, and what a typical morning with it looks like.

<!-- more -->

## Why it exists

The Slack desktop app takes over the whole screen and the whole of your attention. With slackbuzz, Slack comes to you when you choose to check it, in the shell you're already in. Its output pipes into `jq` (the standard JSON filter), `grep` and `fzf` (a fuzzy picker). Every list and view command takes `--json`, `--jq` and `--template`, which is what makes it usable by Claude Code, Copilot and Cursor.

## Two kinds of token, chosen per command

Slack gives an app two credentials, and they're allowed to do different things:

- a **bot token** (starting `xoxb-`) acts as the app. Reading channels, reactions and rich-format notifications go through it.
- a **user token** (starting `xoxp-`) acts as you. Search, direct messages, saved items, your status and posting as yourself need it.

Each command declares which it needs, with a `NeedsBotToken` or `NeedsUserToken` pre-run hook in `pkg/cmdutil/auth_check.go`. A missing token produces a targeted message rather than a raw Slack error string: "this command requires a user token (xoxp-). Run 'slackbuzz auth login --user-token' to add one". `--as-bot` on `message send`, `edit` and `delete` overrides the choice.

One case isn't obvious. A direct message to yourself, sent as yourself, produces no notification. That makes it useless as a reminder. So `pkg/cmd/message/send.go` works out who the target is before sending, and if it's you, sends as the bot:

```go
if api.LooksLikeUser(opts.channel) && !opts.asBot {
    if selfID, _, _ := auth.ResolveUserID(); selfID != "" {
        targetID := resolveTargetUserID(resolver, opts.channel)
        if targetID == selfID {
            if botClient, botErr := opts.factory.BotClient(); botErr == nil {
                client = botClient
```

That needs two more things. The bot needs the `im:write` permission, and the direct-message channel has to be opened through the bot client.

## Generating the client from Slack's spec, and patching the spec

The Slack client isn't a third-party library such as `slack-go`. It is generated from Slack's published OpenAPI spec, the machine-readable description of Slack's HTTP API. A wrapper lags behind the API it wraps: Slack has switched off the old `files.upload` method, and every request to it returns `method_deprecated`.

`make api/specs/slack_web.json` downloads `slack_web_openapi_v2.json` from Slack's `slack-api-specs` repository. `cmd/gen-api` walks it and writes `internal/slackapi/{types,operations,scopes}.gen.go`: 174 methods with typed parameters and responses. The Makefile's first job is to scrub an example `xoxb-` token that Slack's own spec embeds in the `oauth.v2.access` example. GitHub's secret scanner blocks the push, and it doesn't care that it's documentation.

The spec isn't complete, so `cmd/gen-api/patches.go` fills the gaps:

- The user object, `objs_user`, is defined with no type and no properties. A naive generator emits an untyped blob (`json.RawMessage`) for every user, and `users.list` returns nothing you can read a name out of. The patch builds a User type from the fields the commands actually read, and points `users.list` and `users.info` at it.
- A channel's `topic` and `purpose` are written out in place rather than referenced. They're rewritten to reference the sibling definition, so they come out as typed fields instead of `map[string]any`.

Slack's named errors become Go sentinel errors (`slackapi.ErrMissingScope`, `ErrChannelNotFound`, `ErrRatelimited`), matched with `errors.Is`. The same layer holds a trap. Treating every HTTP 401 (unauthorised) as "your login has expired" and throwing the body away hides the permission errors Slack also reports as 401.

## Permissions derived from the code's own calls

Slack apps fail late. A missing permission (Slack calls them scopes) shows up as an error at the moment a user runs the one command that needs it. `cmd/gen-manifest` removes the human from that loop:

1. It parses the Go source under `pkg/cmd/` and finds every `slackapi.<Method>(...)` call.
2. It looks up each method's required scopes in the spec.
3. It writes `pkg/cmd/app/manifest.go` as the union of them, plus a small baseline for name resolution and the login handshake.

The generated file lists the sixteen methods it covers, from `chat.delete` to `users.list`. CI runs `make verify-gen` and fails the pull request if anyone adds a call without regenerating. When a release does add scopes, `slackbuzz app update` pushes the manifest to Slack's `apps.manifest.update`.

The spec has one blind spot. It lists `search:read` without saying it's user-only, so a generator that trusts it puts the scope on the bot side too. Slack then rejects the whole manifest, "Illegal bot scopes found `search:read`", and `slackbuzz app create` fails. So the generator routes `search:read`, `stars:read` and `stars:write` to the user side only, with a test to keep them there.

## Uploading files in three steps

Slack has removed the one-call `files.upload`; it answers `method_deprecated`. Uploads use the three-step flow that replaces it, starting with `files.getUploadURLExternal`.

![Three panels in order: the command line asks Slack for an upload address and gets back a one-time URL and a file id; it sends the file bytes to that URL with no authentication header; then it tells Slack which channel and thread to share the finished file in.](/images/blog/slackbuzz-upload-three-steps.svg)

The public `slackapi.UploadFile` keeps a one-call signature, and the response is reshaped to match the one-call method's, so callers don't see the three steps. One Go function calling two Slack methods breaks the manifest generator's usual rule of one function per method. Its `handAugmented` map maps `UploadFile` to both endpoints, so both sets of scopes land in the manifest. Tests built on `httptest` cover the happy path, sharing to several channels, and errors from steps 1 and 3. It is also verified end to end against live Slack.

## Cleaning up text before it reaches Slack

Anything typed on a zsh command line arrives with the shell's own escaping in it: `hello world\!`. `internal/text/outgoing.go` strips that before Slack sees it. It protects a deliberately escaped backslash first:

```go
const placeholder = "\x00BACKSLASH\x00"
text = strings.ReplaceAll(text, `\\`, placeholder)
text = strings.ReplaceAll(text, `\!`, "!")
text = strings.ReplaceAll(text, `\?`, "?")
text = strings.ReplaceAll(text, `\n`, "\n")
text = strings.ReplaceAll(text, `\t`, "\t")
text = strings.ReplaceAll(text, placeholder, `\`)
```

The same pipeline does three more things:

- converts Markdown to Slack's own markup, called mrkdwn. A `- ` bullet becomes `•`, because Slack renders a leading hyphen literally.
- turns `@name` into Slack's `<@U0123456>` user reference, with first-name shorthand for dotted names.
- renders about 1,900 emoji shortcodes, plus the workspace's custom emoji.

Every command that sends text goes through one `text.NormalizeOutgoing`: `message send`, `message edit` and `notify --message`. A command that skips it is easy to miss. Edited text sent to `chat.update` untouched shows `**bold**` literally, and its mentions notify nobody. One shared function means the three commands can't drift apart.

## Turning partial names into channels and people

Channel and user names are resolved in `internal/api/fuzzy.go`, with the three stages borrowed from clickup-cli: an exact match, then a contains match (shortest wins if several), then a fuzzy match with `RankMatchNormalizedFold`. It reports which stage matched, so a fuzzy hit prints a confirmation and an exact one doesn't. `@michell` resolves to `@michelle`, `#stand` to `#stand-up`, and a miss prints "did you mean". `slackbuzz dm` with no arguments shows recently active direct messages. `message list` and `send` record their target in `~/.config/slack/recent.json` as the default for next time.

## Setting it up

Install via Homebrew or Go, or grab a binary from [releases](https://github.com/isaacrowntree/slackbuzz-cli/releases):

```sh
brew install isaacrowntree/tap/slackbuzz
go install github.com/isaacrowntree/slackbuzz-cli/cmd/slackbuzz@latest
```

Then create the Slack app with every scope it needs:

```sh
slackbuzz app create
```

On the main branch, not yet in a tagged release, that finishes with Slack's own OAuth install. You click **Allow** in the browser and both tokens are stored, with no copying from the OAuth & Permissions page. Slack only accepts HTTPS redirect addresses. So the redirect goes through a static relay page on the docs site, which hands the code back to a listener on `127.0.0.1`. `app create --web` works without an App Configuration Token, and `--clipboard` reads tokens without a terminal, for setup from an AI agent's shell. `slackbuzz auth login` still takes tokens you already have. `scripts/setup.sh` gets a teammate from nothing to authenticated, with the Claude Code skill installed, in one command.

A typical morning:

```sh
slackbuzz activity              # what happened while I was asleep
slackbuzz send '#general' "morning team"
slackbuzz status set "heads down — PR review at 2pm" :brain: --until 2h
slackbuzz file upload diagram.png '#engineering' --thread-ts 1706000000.000000
```

## Why generate from the spec

A dependency that wraps an API you don't control is a liability twice over. It hurts once when the API moves, and again when the wrapper doesn't. This project generates from the vendor's spec, patches the spec's gaps in one file, and derives permissions from the code's own calls. So the next `method_deprecated` is a one-afternoon fix with tests, not an archaeology project. Smoke tests against live Slack (`make smoke`) exist because a mocked suite can't tell you an endpoint is gone. Source lives on [GitHub](https://github.com/isaacrowntree/slackbuzz-cli).
