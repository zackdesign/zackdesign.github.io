---
layout: post
title: "Sovereign — an autonomous IBKR fund that trades through bezant, with guardrails because it's real money"
description: "An open-source, multi-agent portfolio fund for Interactive Brokers, built on top of bezant. Deterministic TypeScript agents handle allocation, risk, tax, and execution — with validation-first trading, hard caps, and data-sanity gates. Runs standalone or under any scheduler. Dual-licensed Apache/MIT."
excerpt: "bezant gave us typed access to Interactive Brokers. Sovereign is the thing that actually runs a fund on top of it: nine deterministic agents for allocation, risk, tax, and execution — with the kind of guardrails you want when a bug moves real money. Apache/MIT, self-host it against your own bezant."
image: /images/blog/sovereign.jpg
image_alt: A compass resting on a map — steering a portfolio by a set heading rather than by hand
date: 2026-07-08
last_modified_at: 2026-07-08
categories: [open-source]
tags: [ibkr, trading, typescript, portfolio, quant, risk, backtesting, interactive-brokers, open-source, claude-code, bezant]
---

Zack Design has published [**Sovereign**](https://github.com/isaacrowntree/sovereign-ibkr-fund) — an open-source, multi-agent portfolio fund for Interactive Brokers. It's the companion to [bezant](https://github.com/isaacrowntree/bezant): bezant mints the access, Sovereign spends it. Nine deterministic TypeScript agents hold a model portfolio, detect drift, size trades with real risk controls, and execute through bezant — standalone, or under whatever scheduler you already run.

<!-- more -->

**Source → [github.com/isaacrowntree/sovereign-ibkr-fund](https://github.com/isaacrowntree/sovereign-ibkr-fund)** (Apache-2.0 OR MIT) · Built on **[bezant](https://github.com/isaacrowntree/bezant)**

## Why it exists

I had a portfolio problem that a lot of people quietly have: one winner had run so hard it became **40%+ of the book**. Great on the way up, a single point of failure on the way down. Fixing that by hand — trimming the concentration, funding a diversified target, doing it without fat-fingering a real order — is exactly the kind of repetitive, high-stakes, easy-to-get-wrong work you should not be doing manually at 11pm.

So the fund isn't a get-rich bot. It's a **discipline engine**: hold a target allocation, notice when reality drifts from it, and make the smallest correct trades to close the gap — with enough guardrails that a bad market-data tick or a logic bug can't do real damage.

bezant already gave every language typed access to IBKR's Client Portal API. Sovereign is what happens when you build an actual fund on that foundation and take the "it's real money" part seriously.

## Nine agents, no LLM calls

The agents are plain TypeScript `--once` processes — **deterministic, no model calls in the loop.** That's deliberate: I want a trade decision to be a pure function of the inputs, reproducible and auditable, not a sample from a distribution.

| Agent | Job |
|---|---|
| **Managing Partner** | Orchestrates the fund, snapshots NAV and positions |
| **Portfolio Strategist** | HRP / Black-Litterman weights, drift detection, sizes rebalance orders |
| **Quant Analyst** | Regime detection, factor regression |
| **Risk Manager** | VaR / CVaR, drawdown control, volatility targeting |
| **Execution Bot** | Places orders through bezant — window-gated, capped, reconciled |
| **Tax Optimizer** | FIFO lots, tax-loss harvesting, wash-sale tracking |
| **Hedger** | Options overlay (covered calls, protective puts) |
| **Research Scout** | Price monitoring and alerts |
| **Observer** | Ingests the WebSocket fill/event stream |

Under the hood there's a real quant toolbox: Hierarchical Risk Parity, Black-Litterman, risk-parity, Ledoit-Wolf shrinkage covariance, a regime overlay, and vol targeting — all backtestable.

## The guardrails are the point

Anyone can write a loop that places market orders. The interesting engineering is everything that stops it from doing something stupid with real money:

- **Validation-first execution.** Before it will batch a rebalance, the executor proves a live fill on the single smallest order and confirms it against IBKR's own execution records. No confirmed fill, no batch.
- **Executions are authoritative.** Fills are reconciled against IBKR's execution log, and the trade ledger is **idempotent** — the same fill can never be recorded twice, even if a confirmation arrives by two paths.
- **Hard caps.** Absolute backstops on per-order notional, per-order % of NAV, and per-run notional — independent of the sizing math. A garbled input can't size a monster order.
- **Data-sanity gates.** If NAV or a price tick looks impossible (zeroed, or a 100× move with no cash flow), the strategist refuses to generate orders that cycle rather than trade against garbage.
- **Drawdown control.** De-risk and hard-stop thresholds that pull exposure down when the book is bleeding.
- **State lives outside the checkout.** Positions and ledger sit in `STATE_DIR`, never entangled with the code — so a deploy can never clobber your holdings.

Most of these exist because the honest way to build this is to assume your own code will misbehave and make sure the blast radius is bounded when it does.

## Standalone, or under whatever you run

Every agent is just `node dist/agents/<name>.js --once`. That one contract means Sovereign doesn't care how it's scheduled:

- **Built-in scheduler** — `npm start` runs the whole fund on a cadence, zero dependencies.
- **cron / systemd** — point timers at the `--once` scripts; examples in `deploy/`.
- **Any orchestrator** — set `ENABLE_SCHEDULER=false` and let your platform drive the same scripts.

The core never imports the scheduler, so it genuinely runs both ways.

## Your book stays yours

The public repo ships a **generic sample portfolio** (a diversified ETF template) and runs against **paper** out of the box. Your real allocation goes in a gitignored `src/portfolios/local.ts` that takes precedence automatically and never leaves your machine. Everything else — caps, thresholds, cadences, optimizer choice — is environment-driven. Nothing about *your* positions lives in the source.

## Backtesting

There's a full backtest engine (HRP, risk-parity, Black-Litterman, regime overlay, vol targeting). The historical dataset is gitignored — you generate it yourself from Yahoo Finance with `npm run fetch-data`, and the backtest suites skip cleanly until it exists, so a fresh clone is green on the first `npm test`.

## Status and licensing

- **v0.1** — runs end-to-end against IBKR paper accounts; the API and agent set will evolve.
- **Dual-licensed Apache-2.0 OR MIT.**
- **Requires a running [bezant](https://github.com/isaacrowntree/bezant) gateway** — that's how it talks to IBKR.
- **Not affiliated with Interactive Brokers.** This is not financial advice. It places real trades — **start on paper**, and understand every guardrail before you flip `TRADING_MODE=live`.

If bezant was about making IBKR *programmable*, Sovereign is about making a portfolio *governable* — trading on rules you can read, with brakes you can trust. If you're running money through IBKR and you'd rather it followed a written policy than your 11pm instincts, clone it and point it at your own bezant. Contributions welcome — especially on the optimizers and the risk engine.
