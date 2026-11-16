---
layout: post
title: "cloudflare-worker-rollbar — a Rollbar client built for Workers"
description: "A zero-dependency Rollbar client for Cloudflare Workers: fetch only, a handler wrapper that reports in the background after the response has gone, and a redactor that survives circular references."
excerpt: "A zero-dependency Rollbar client for Cloudflare Workers — fetch only, a handler wrapper that reports after the response has gone, and a redactor that doesn't overflow the stack on circular data."
image: /images/blog/cloudflare-worker-rollbar.jpg
image_alt: Black screen filled with JavaScript code illuminated in cool light
date: 2024-01-11
last_modified_at: 2026-11-16
categories: [open-source]
tags: [cloudflare-workers, rollbar, typescript, observability, edge, open-source]
---

Triptech Travel's **[`@triptech/cloudflare-worker-rollbar`](https://github.com/triptechtravel/cloudflare-worker-rollbar)** is a client for Rollbar, the error-tracking service, built for Cloudflare Workers: small JavaScript programs that run in Cloudflare's data centres. It has **zero runtime dependencies** and needs only `fetch`. It builds to an 11 kB `dist/index.js`. A wrapper around the request handler sends each report **after the response has gone**, so reporting never slows a request. Isaac Rowntree wrote and released it as part of his engineering work at [Triptech Travel](https://github.com/triptechtravel); it is cross-posted here on the Zack Design blog. **MIT licensed.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/triptechtravel/cloudflare-worker-rollbar" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
  <a href="https://www.npmjs.com/package/@triptech/cloudflare-worker-rollbar" target="_blank" rel="noopener" class="btn btn-outline-primary btn-lg">Install from npm</a>
</div>

This post covers:

- why Rollbar's own library doesn't fit a Worker;
- the wrapper around the request handler, which reports after the response has gone back, and what the client sends;
- a hand-written stack-trace parser, in place of a library, and what each report says about itself;
- redacting secrets without a `RangeError: Maximum call stack size exceeded` on circular data;
- how to try it, and what the package doesn't do.

<!-- more -->

## Why it exists

Triptech's production APIs run on Cloudflare Workers, and their errors need to reach Rollbar. Rollbar's official JavaScript library comes in a Node.js build and a browser build. A Worker is neither. The Worker runtime is a sandboxed JavaScript engine with `fetch` for making HTTP requests and not much else.

## One wrapper around the request handler

The integration most Workers want is one line. Hand the function that handles requests to `rollbar.wrap()`, and stop writing try/catch.

```typescript
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    const rollbar = new Rollbar({
      accessToken: env.ROLLBAR_TOKEN,
      environment: 'production',
      codeVersion: 'abc123',
    })

    return rollbar.wrap(async (req, env, ctx) => {
      const data = await processRequest(req)
      return Response.json(data)
    })(request, env, ctx)
  },
}
```

Inside `wrap()` the mechanism is short. The handler runs inside a try block. Anything thrown that isn't an `Error` object is turned into one (`new Error(String(err))`). So a bare `throw 'nope'` still reports, with `class: 'Error'`. `buildRequestContext(request)` copies the URL, method, headers and query parameters into the report. It adds the caller's IP address from the `cf-connecting-ip` header. Then:

```typescript
const reportPromise = this.error(error, reportContext)
if (ctx?.waitUntil) {
  ctx.waitUntil(reportPromise)
} else {
  await reportPromise
}
```

Workers give each request an execution context with a `waitUntil` method. Hand it a promise, and the runtime keeps the Worker alive until that promise settles, even after the response has been sent. If the Worker passed its context in, the report goes to `waitUntil`. The HTTP 500 response goes back to the caller immediately, and the report to Rollbar finishes in the background. Without a context (in tests, or when a caller forgot to pass it) the report is awaited first. The alternative is losing the report. The figure shows the two orderings.

![Two timelines. With the Worker's execution context, the 500 response goes back to the caller immediately and the report to Rollbar continues in the background while the runtime keeps the Worker alive. Without a context, the report is sent and waited for first, and the 500 goes back only after Rollbar has answered.](/images/blog/rollbar-waituntil-timing.svg)

The default response is a JSON `{ error: 'Internal Server Error' }` with status 500. The `errorResponse` option replaces it, and `rethrow: true` throws the error again after reporting it. `tests/wrapper.test.ts` checks the background path directly:

```typescript
const wrapped = rollbar.wrap(handler)
await wrapped(request, {}, { waitUntil })
expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise))
```

To tie errors to a user, `rollbar.withPerson({ id, username, email })` returns a copy of the client that adds that person to every report.

## What the client sends

The client is adapted from [a gist by dukedorje](https://gist.github.com/dukedorje/d160a1b2051ff7c1a485bdcf966f1bcc). Its core job is to build the JSON body that Rollbar's "item" endpoint expects, and send it with `fetch` to `https://api.rollbar.com/api/1/item/`. For an error, `src/client.ts` does this:

```typescript
const frames = parseStackFrames(error)

const payload = this.buildPayload(level, context)
payload.data.body = {
  trace: {
    frames,
    exception: {
      class: error.name,
      message: error.message,
    },
  },
}
```

The source is four files: `client.ts`, `stack-parser.ts`, `types.ts` and `index.ts`. The constructor takes one configuration object. There are six logging methods (`debug`, `info`, `warning`, `log`, `error`, `critical`). Tests cover the stack parser, the client and the handler wrapper.

The constructor throws `Rollbar accessToken is required` on a missing token. A client that silently does nothing without a token is convenient in local development and a trap in production: errors vanish and nothing says why.

## Reading a stack trace without a library

Zero dependencies means no stack-parsing library such as `error-stack-parser`. `src/stack-parser.ts` uses three regular expressions, one for each shape a stack-trace line can take:

- a V8 (Chrome and Workers) line with a function name: `at fn (file:10:15)`;
- a V8 line with no function name: `at file:10:15`;
- Firefox's `fn@file:10:15`.

Two details matter more than the regular expressions. Rollbar wants the frames oldest first, which is the reverse of the order `error.stack` prints them in. So the parsed list is reversed before it is sent. And a line that matches none of the three patterns isn't dropped. It becomes a frame with `filename: '(unparsed)'` and the raw line as its `method`. A stack trace with a hole in it is worse than one with an odd-looking frame.

## What the report says about itself

`buildPayload()` stamps every report with a few fields:

- `platform: 'cloudflare-workers'` and `language: 'javascript'`;
- a Unix timestamp in seconds;
- a `notifier` block naming the package and its version, so Rollbar's dashboard can tell these reports apart from the Node.js library's.

`code_version` is set when the configuration has one. If you follow `example/index.ts`, that's the deploy's git commit hash: `codeVersion: env.GIT_SHA`. `send()` posts the JSON and reads Rollbar's `{ err, result }` response. It logs `result.message` when `err` isn't zero. If the network call fails, it returns `null` instead of throwing. An error reporter that throws is not an improvement.

## Redacting secrets without following loops

Secret-looking values are replaced with `[SCRUBBED]` before anything is sent. That covers the `custom` data you attach, the global `payload` and the request headers.

- **Eight field names** are redacted by default: `password`, `secret`, `token`, `accessToken`, `access_token`, `apiKey`, `api_key` and `credential`. They match the exact key, ignoring case.
- **Five headers** are always redacted: `authorization`, `cookie`, `set-cookie`, `x-api-key` and `x-auth-token`. These match any part of the name, so `x-auth-token-v2` is redacted too.

The `scrubFields` option extends the list. The request body is never included unless `includeRequestBody: true` is set.

A scrubber that walks into nested objects with no memory of where it has been fails on circular data. Some `custom` context contains an object that refers back to itself: DOM elements, React state, Google Maps objects and InstantSearch state are the usual sources. The scrubber follows the loop until the JavaScript engine runs out of stack, and throws `RangeError: Maximum call stack size exceeded` from inside the error reporter. The original error never reaches Rollbar.

So `scrubObject` carries a `WeakSet` of objects it has already visited. The second time it meets one, it substitutes the string `'[Circular Reference]'`:

```typescript
function scrubObject<T extends Record<string, unknown>>(
  obj: T,
  scrubFields: string[],
  visited: WeakSet<object> = new WeakSet()
): T {
  if (visited.has(obj)) {
    return '[Circular Reference]' as unknown as T
  }
  visited.add(obj)
  // ...
```

It is a `WeakSet` rather than a `Set` because a `WeakSet` doesn't stop the garbage collector reclaiming the caller's objects once the call is over. The message path needs the same care: `logMessage()` runs `custom` data through `scrubObject` rather than spreading it straight into the report. Tests cover self-referencing `custom` data and the message path.

## Trying it

Install it [from npm](https://www.npmjs.com/package/@triptech/cloudflare-worker-rollbar):

```bash
npm install @triptech/cloudflare-worker-rollbar
```

Then store your Rollbar server token (the `post_server_item` one) as a Worker secret, as `example/wrangler.toml` suggests:

```bash
npx wrangler secret put ROLLBAR_TOKEN
```

Import it with `import { Rollbar } from '@triptech/cloudflare-worker-rollbar'` and wrap your handler as above. Upgrading from 1.x: the constructor takes an object, and `log()` plus the level methods replace `message()`. The README has a side-by-side migration.

## What it does and doesn't do

The package ships both module formats (ESM and CommonJS), built with `tsup`, and needs nothing at runtime beyond `fetch`. It doesn't batch, retry or queue reports. It makes one `fetch` per report. That's the right trade for a Worker, where `waitUntil` already means the call costs the caller nothing. The [source is on GitHub](https://github.com/triptechtravel/cloudflare-worker-rollbar).
