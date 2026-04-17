---
layout: post
title: "cloudflare-worker-rollbar — a Rollbar client built for Workers"
description: "A zero-dependency, TypeScript-first Rollbar client for Cloudflare Workers — built because Rollbar's official SDK does not fit the isolated V8 runtime."
excerpt: "A zero-dependency, TypeScript-first Rollbar client for Cloudflare Workers — waitUntil-friendly, request-handler wrappable, with sensitive-data scrubbing built in."
image: /images/blog/cloudflare-worker-rollbar.jpg
image_alt: Black screen filled with JavaScript code illuminated in cool light
date: 2024-01-11
last_modified_at: 2024-01-11
categories: [open-source]
tags: [cloudflare-workers, rollbar, typescript, observability, edge, open-source]
---

[`@triptech/cloudflare-worker-rollbar`](https://github.com/triptechtravel/cloudflare-worker-rollbar) is a [Triptech Travel](https://github.com/triptechtravel) open-source project — authored and released by Isaac Rowntree in his Triptech engineering capacity, and cross-posted here on the Zack Design blog. It is a lightweight, zero-dependency Rollbar client built specifically for the Cloudflare Workers runtime. It exists because Rollbar's official JavaScript SDK is built for Node and the browser, and neither of those assumptions survives contact with Workers' isolated V8 environment.

<!-- more -->

## Why a custom client

Rollbar's official SDK reaches for things that simply do not exist on Workers:

- A mutable global `process` object.
- Node streams and `Buffer` for payload serialisation.
- Long-lived background queues that drain on their own schedule.
- `XMLHttpRequest`-style timing assumptions from the browser build.

You can wedge the official package in with polyfills and `nodejs_compat`, but the result is a bigger bundle, slower cold starts, and an ongoing compatibility risk every time the SDK ships an update. Writing a tiny, fetch-only implementation is the cleaner path.

## What the package gives you

- **Zero dependencies.** Every HTTP call is a raw `fetch()` — nothing ships with the package except TypeScript types.
- **Full TypeScript.** Comprehensive types for every API, so `env.ROLLBAR_TOKEN` and the request payloads are all type-checked at build time.
- **`waitUntil()`-friendly.** Error reports fire on `ctx.waitUntil(...)` so they never block the response.
- **A handler wrapper.** `rollbar.wrap(handler)` catches everything the inner handler throws and reports it with request context already attached.
- **Sensitive-data scrubbing.** Passwords, tokens, and configurable header names are redacted before the payload leaves the Worker.

## Minimum setup

```typescript
import { Rollbar } from '@triptech/cloudflare-worker-rollbar'

export interface Env {
  ROLLBAR_TOKEN: string
}

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

That is the whole integration for an entire Worker — every throw inside the wrapped handler is reported with the request URL, method, headers, and a sanitised body.

## Why it matters

Cloudflare Workers run Triptech's production APIs at the edge — which means the observability story cannot rely on tools built for long-running Node processes. A small, carefully-scoped client avoids the temptation to "just polyfill it" and instead leans on the runtime primitives (`fetch`, `waitUntil`, `ExecutionContext`) that Cloudflare already gives you. Install it [from npm](https://www.npmjs.com/package/@triptech/cloudflare-worker-rollbar) or read the [source on GitHub](https://github.com/triptechtravel/cloudflare-worker-rollbar).
