---
layout: post
title: "cloudflare-worker-rollbar — a Rollbar client built for Workers"
description: "A zero-dependency Rollbar client for Cloudflare Workers: 451 lines, fetch only, a handler wrapper that reports in the background after the response has gone, and the circular-reference bug that took the first production release down."
excerpt: "A zero-dependency Rollbar client for Cloudflare Workers — fetch only, a handler wrapper that reports after the response has gone, and the circular-reference stack overflow that shipped in 2.0.0."
image: /images/blog/cloudflare-worker-rollbar.jpg
image_alt: Black screen filled with JavaScript code illuminated in cool light
date: 2024-01-11
last_modified_at: 2024-01-11
categories: [open-source]
tags: [cloudflare-workers, rollbar, typescript, observability, edge, open-source]
---

Triptech's production APIs run on Cloudflare Workers, small JavaScript programs that run in Cloudflare's data centres, and for a while the errors they threw went nowhere. Rollbar is the error-tracking service we report to, and its official JavaScript library comes in a Node.js build and a browser build; a Worker is neither. The Worker runtime is a sandboxed JavaScript engine with `fetch` for making HTTP requests and not much else. [`@triptech/cloudflare-worker-rollbar`](https://github.com/triptechtravel/cloudflare-worker-rollbar) is a [Triptech Travel](https://github.com/triptechtravel) open-source project — authored and released by Isaac Rowntree in his Triptech engineering capacity, and cross-posted here on the Zack Design blog. The whole client is 451 lines in `src/client.ts`, has zero runtime dependencies, and builds to an 11 kB `dist/index.js`.

This post covers the 100-line first version and the gist it started from, what the 2.0 rewrite added (a wrapper for the request handler, a hand-written stack-trace parser, and redaction of secrets), how the wrapper sends its report after the response has already gone back so the report never slows a request, and the `RangeError: Maximum call stack size exceeded` that 2.0.0 shipped with.

<!-- more -->

## From a gist to a package

The first commit, on 11 January 2024, was a single `src/index.ts` of about a hundred lines, adapted from [a gist by dukejones](https://gist.github.com/dukejones/d160a1b2051ff7c1a485bdcf966f1bcc). A `Rollbar` class took a token and an environment name as its two constructor arguments, exposed `error(error, description)` and `message(message, attributes)`, and did one thing well: build the JSON body that Rollbar's "item" endpoint expects and send it with `fetch` to `https://api.rollbar.com/api/1/item/`.

```typescript
const stack = ErrorStackParser.parse(error);
const rollbarBody = {
  access_token: this.token,
  data: {
    environment: this.environment,
    body: {
      trace: {
        frames: stack.map((stackFrame) => Frame(stackFrame)),
        exception: { class: error.name, message: error.message },
      },
    },
  },
};
```

It had one dependency, `error-stack-parser`, and one quirk: if the token was missing, the constructor returned early and every method silently did nothing. That was deliberate for local development and a trap in production.

The 2.0.0 rewrite (January 2026) replaced it with four files (`client.ts`, `stack-parser.ts`, `types.ts`, `index.ts`), a configuration object instead of positional arguments, six log levels, and a test suite that runs in 310 ms:

| | First version | 2.0 |
|---|---|---|
| Source | one file, about 100 lines | four files, 451 lines in `client.ts` |
| Runtime dependencies | one (`error-stack-parser`) | none |
| Constructor | token and environment as positional arguments | one configuration object |
| Missing token | silently does nothing | throws |
| Tests | none | 43, in 310 ms |

```
 ✓ tests/stack-parser.test.ts (11 tests) 5ms
 ✓ tests/client.test.ts (24 tests) 11ms
 ✓ tests/wrapper.test.ts (8 tests) 12ms

 Test Files  3 passed (3)
      Tests  43 passed (43)
```

The constructor now throws on a missing `accessToken`. Silent no-ops are gone.

## One wrapper around the request handler

The integration most Workers want is one line: hand the function that handles requests to `rollbar.wrap()` and stop writing try/catch.

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

Inside `wrap()` the mechanism is short. The handler runs inside a try block. Anything thrown that is not an `Error` object is turned into one (`new Error(String(err))`), so a bare `throw 'nope'` still reports with `class: 'Error'`. `buildRequestContext(request)` copies the URL, method, headers, query parameters and the caller's IP address (the `cf-connecting-ip` header) into the report. Then:

```typescript
const reportPromise = this.error(error, reportContext)
if (ctx?.waitUntil) {
  ctx.waitUntil(reportPromise)
} else {
  await reportPromise
}
```

Workers give each request an execution context with a `waitUntil` method: hand it a promise, and the runtime keeps the Worker alive until that promise settles, even after the response has been sent. If the Worker passed its context in, the report is handed to `waitUntil` and the HTTP 500 error response goes back to the caller immediately, with the report to Rollbar finishing in the background. Without a context (in tests, or when a caller forgot to pass it) the report is awaited before the response goes back, because the alternative is losing the report. The figure shows the two orderings.

![Two timelines. With the Worker's execution context, the 500 response goes back to the caller immediately and the report to Rollbar continues in the background while the runtime keeps the Worker alive. Without a context, the report is sent and waited for first, and the 500 goes back only after Rollbar has answered.](/images/blog/rollbar-waituntil-timing.svg)

The default response is a JSON `{ error: 'Internal Server Error' }` with status 500; the `errorResponse` option replaces it, and `rethrow: true` throws the error again after reporting it. `tests/wrapper.test.ts` checks the background path directly:

```typescript
const wrapped = rollbar.wrap(handler)
await wrapped(request, {}, { waitUntil })
expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise))
```

## Reading a stack trace without a library

Dropping `error-stack-parser` meant writing the parser. `src/stack-parser.ts` is 177 lines and three regular expressions, one for each shape a stack-trace line can take: a V8 (Chrome and Workers) line with a function name (`at fn (file:10:15)`), a V8 line with no function name (`at file:10:15`), and Firefox's `fn@file:10:15`. Two details matter more than the regular expressions. Rollbar wants the frames oldest first, which is the reverse of the order `error.stack` prints them in, so the parsed list is reversed before it is sent. And a line that matches none of the three patterns is not dropped; it becomes a frame with `filename: '(unparsed)'` and the raw line as its `method`, because a stack trace with a hole in it is worse than one with an odd-looking frame.

## Redacting secrets, and the bug it hid

Every report passes through `scrubObject()` before `send()`, which replaces the values of secret-looking fields. Eight field names are redacted by default (`password`, `secret`, `token`, `accessToken`, `access_token`, `apiKey`, `api_key`, `credential`), matched on the exact key ignoring case, and five headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`) are matched on any part of the name, so `x-auth-token-v2` is redacted too. The `scrubFields` option extends the list. The request body is never included unless `includeRequestBody: true` is set.

2.0.0 went to production with a `scrubObject` that walked into nested objects recursively and had no memory of where it had been. Reporting an error whose `custom` context contained an object that referred back to itself (the fix commit names DOM elements, React state, Google Maps objects and InstantSearch state as the usual sources) threw `RangeError: Maximum call stack size exceeded` from inside the error reporter. That was the whole bug: the scrubber followed the loop until the JavaScript engine ran out of stack, and the original error never reached Rollbar. `logMessage()` had a second copy of the problem, spreading unredacted `custom` data straight into the report.

2.0.1 fixed both. `scrubObject` now carries a `WeakSet` of objects it has already visited and substitutes the string `'[Circular Reference]'` the second time it meets one:

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

It is a `WeakSet` rather than a `Set` because a `WeakSet` does not stop the garbage collector reclaiming the caller's objects once the call is over. The fix added tests for self-referencing `custom` data and for the message path. The 2.0.0 changelog lists 41 tests; the suite is now 43.

## What the report says about itself

`buildPayload()` stamps every report with `platform: 'cloudflare-workers'`, `language: 'javascript'`, a Unix timestamp in seconds, and a `notifier` block naming the package and its version, so Rollbar's dashboard can tell these reports apart from the Node.js library's. `code_version` is set when the configuration has one, which is the deploy's git commit hash if you follow the example in `example/index.ts`: `codeVersion: env.GIT_SHA`. `send()` posts the JSON, reads Rollbar's `{ err, result }` response, logs `result.message` when `err` is not zero, and returns `null` instead of throwing if the network call fails. An error reporter that throws is not an improvement.

## What it is and is not

The package is 907 lines of TypeScript across the four files (451, 177, 232 and 47), ships both module formats (ESM and CommonJS) built with `tsup`, and needs nothing at runtime beyond `fetch`. It does not batch, retry or queue reports; it makes one `fetch` per report, which is the right trade for a Worker where `waitUntil` already means the call costs the caller nothing. Install it [from npm](https://www.npmjs.com/package/@triptech/cloudflare-worker-rollbar) or read the [source on GitHub](https://github.com/triptechtravel/cloudflare-worker-rollbar). If you are on 1.x, the constructor and `message()` changed; the README has the two-line migration.
