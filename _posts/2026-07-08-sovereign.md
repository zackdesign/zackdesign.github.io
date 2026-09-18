---
layout: post
title: "Sovereign — an autonomous IBKR fund that trades through bezant, with guardrails because it's real money"
description: "One holding had grown to 41.6% of my Interactive Brokers account. Sovereign is the open-source portfolio manager I built to fix that on rules instead of instinct: nine single-purpose TypeScript agents on top of bezant, an executor that proves one fill before it sends a batch, hard caps in dollars, and the currency bug the risk register caught before the first live order. Apache/MIT."
excerpt: "One holding had run to 41.6% of my Interactive Brokers account. Sovereign is what I built to trim it on rules: nine single-purpose TypeScript agents on top of bezant, an executor that proves one fill before it sends a batch, hard caps in dollars, and a risk register that found the account's value was being read in the wrong currency. Apache/MIT, self-host it against your own bezant."
image: /images/blog/sovereign.jpg
image_alt: A compass resting on a map — steering a portfolio by a set heading rather than by hand
date: 2026-07-08
last_modified_at: 2026-07-08
categories: [open-source]
tags: [ibkr, trading, typescript, portfolio, quant, risk, backtesting, interactive-brokers, open-source, claude-code, bezant]
---

Zack Design has published [**Sovereign**](https://github.com/isaacrowntree/sovereign-ibkr-fund), an open-source portfolio manager for Interactive Brokers (IBKR), built on [bezant](https://github.com/isaacrowntree/bezant). The reason it exists is one number: a single holding had grown to **41.6% of my whole account**, and trimming it by hand meant placing real orders late at night, in US dollars, on a cash account (one that cannot borrow) whose base currency is Australian dollars. Sovereign is nine TypeScript programs, each with one job, that hold a target mix of holdings, notice when the real mix has drifted from it, work out the smallest trades that bring it back, and place them through bezant. The same inputs always produce the same trades, and 509 test cases across 40 files pin down the ways that can go wrong.

<!-- more -->

**Source:** [github.com/isaacrowntree/sovereign-ibkr-fund](https://github.com/isaacrowntree/sovereign-ibkr-fund) (Apache-2.0 OR MIT) · Built on **[bezant](https://github.com/isaacrowntree/bezant)**

This post covers the executor's rule that one small probe order must fill before it trusts the connection with a batch, and why that probe is removed from the queue by object reference rather than by position; the three caps in absolute dollars that sit outside the order-sizing maths; and the three bugs found by the pre-launch risk register, a written review of every way the executor could lose money: net asset value (the account's total worth, "NAV" from here on) read in the wrong currency and counted twice, a confirmation timeout that could place the same trade twice, and a tax-lot matcher that paired sales with purchases by record and ignored how many shares each held. All three are fixed in v0.1.0; the register that found them ships in `docs/execution-risk-register.md`.

## Nine agents and not one language-model call

Every agent is a plain process: `node dist/agents/<name>.js --once`. There are no calls to a large language model anywhere in the loop. A trade decision is a function of its inputs (positions, prices, the target portfolio, the risk state) and has to be reproducible from the state file, so it cannot come from a model that gives a different answer each time it is asked.

| Agent | Job | Default cadence |
|---|---|---|
| **Managing Partner** | Orchestrates the fund, records NAV and positions | every 4 hours |
| **Portfolio Strategist** | Chooses target weights (Hierarchical Risk Parity or Black-Litterman), detects drift, sizes the rebalancing orders | every 4 hours |
| **Quant Analyst** | Detects the market regime, runs factor regressions | every 4 hours |
| **Risk Manager** | Value at risk and conditional value at risk, drawdown control, volatility targeting | every 4 hours |
| **Execution Bot** | Places queued orders through bezant, only inside the trading window and under the caps | every 4 hours |
| **Tax Optimizer** | Tracks purchase lots first-in-first-out, harvests tax losses, tracks wash sales | daily |
| **Hedger** | Options overlay (covered calls, protective puts) | daily |
| **Research Scout** | Price monitoring, alerts | daily |
| **Observer** | Listens to bezant's live stream of fills and order events | continuous |

Underneath is a set of ways to turn price history into target weights: Hierarchical Risk Parity, Black-Litterman, risk parity, and Ledoit-Wolf shrinkage for estimating the covariance matrix, plus a market-regime overlay and volatility targeting, each with its own test file under `src/portfolio/`, `src/quant/` and `src/risk/`.

## Prove one fill before trusting the connection

The executor never sends a batch of orders on a session until one live order has been confirmed as filled. `planExecution` in `src/execution/staging.ts` puts it in `validate` mode: one order, the smallest-value sell (or the smallest order at all if there are no sells), and nothing else until IBKR's execution records confirm the fill.

```ts
if (!validated && pending.length > 0) {
  const pool = sells.length > 0 ? sells : buys;
  const probe = [...pool].sort((a, b) => a.estimatedValue - b.estimatedValue)[0];
  return {
    mode: 'validate',
    orders: [probe],
    // Exclude the probe by identity, NOT by position: the smallest-value
    // probe is frequently not queue index 0 (the strategist emits sells
    // loss-first, not cheapest-first), so `slice(1)` would drop the real
    // index-0 order AND re-queue the probe that just executed — a
    // duplicate order on a live account.
    deferred: pending.filter(o => o !== probe),
  };
}
```

That comment is there because the first version used `slice(1)`, which drops whatever is first in the queue. The figure shows why that is the wrong thing to drop.

![Two panels showing a queue of three sell orders where the cheapest, chosen as the probe, sits at position 2 not position 0: dropping the first element by position throws away the real first order and re-queues the probe for a second execution, while filtering the probe out by object identity leaves exactly the two other orders deferred.](/images/blog/sovereign-probe-by-identity.svg)

A duplicate order on a live account is the whole class of failure this mode exists to prevent.

## Caps that do not trust the maths

Order sizes are worked out as a percentage of NAV. If the NAV is garbage, the percentage is garbage, so there is a second gate in absolute dollars that does not know about the sizing at all. `orderCapViolation` in `src/risk/data-sanity.ts` checks every order against three caps set by environment variables, and the executor halts the run if any is breached:

| Cap | What it limits | Default |
|---|---|---|
| `MAX_ORDER_NOTIONAL_USD` | the value of any one order | 15,000 US dollars |
| `MAX_ORDER_PCT_NAV` | any one order as a share of NAV | 50% |
| `MAX_RUN_NOTIONAL_USD` | the total value of all orders in one run | 60,000 US dollars |

In front of that, `navSanityViolation` and `priceSanityViolations` refuse to size anything when the numbers look impossible: a NAV of zero or less, a NAV below a floor, a NAV that has moved more than a configured percentage since the last cycle, or a price that has jumped more than a configured percentage. The strategist logs, alerts and gives up rather than generating orders against a NAV that reads zero or a price that reads a hundred times too low. On top of that, loss thresholds first reduce exposure and then stop trading altogether, and everything stateful lives in `STATE_DIR`, outside the checkout, so a deploy cannot overwrite the ledger.

## The NAV was in the wrong currency

The risk register is a review of the executor against the live account before unpausing it, and its first finding was a units error. The account is held with Interactive Brokers Australia, with Australian dollars as its base currency. The API's `/summary` endpoint reports `totalcashvalue` and `netliquidation` in the base currency, so the cash check was comparing US-dollar purchase costs against Australian-dollar cash, and the strategist was sizing US shares as a fraction of a NAV stated in Australian dollars.

I expected `/summary` to be the account's cash. What the live `/ledger` endpoint showed was a separate balance for each currency, which IBKR does not convert: a US-dollar cash balance of $0, US-dollar settled cash of $0, and most of the NAV held in US stock. A cash account cannot borrow US dollars, so US-dollar purchases have to be funded by the proceeds of the US-dollar sales that run first, which the sells-before-buys ordering already guarantees. The fix is `gateway.getUsdBalances()`, which reads `/ledger` and returns US-dollar cash and US-dollar NAV, skipping the `BASE` row (IBKR's total in the base currency rather than a real currency). That last clause matters: with `BASE` included, the NAV came out roughly doubled.

Re-running the strategist on the corrected numbers, verified against the live account (US-dollar cash $0.00, US-dollar NAV $29,155.64), showed the old quantities were oversized by the exchange rate:

| Order | Sized on the mixed-currency NAV | Sized on the US-dollar NAV |
|---|---|---|
| AVGO | 9 shares | 6 shares |
| TLT | 39 shares | 27 shares |

The weights now sum to about 100%, and the concentrated holding's true weight was 41.6%, not the 29% the mixed-currency maths had reported.

## A timeout is not a cancel

Second finding. When the wait for a fill confirmation timed out, the executor dropped the order rather than requeue it, on the stated assumption that the strategist would rebuild the queue from live positions. The strategist reads positions only; it knows nothing about orders still open at the broker. If the timed-out order was still working at IBKR, the drift persisted, the strategist's next run generated the same order again, and the executor submitted it a second time.

The fix was already one route away: bezant exposes `DELETE /accounts/{id}/orders/{orderId}`, and it just was not wired up. `gateway.cancelOrder()` now runs, on a best-effort basis, after a confirmation timeout, an error on the confirmation stream, or a partial fill that timed out, before the run halts. A failed cancel leaves the risk that was already there; it never throws.

## Matching sales by record is not matching them by share

Third finding. The original tax-lot matcher paired each sale with exactly one earliest unmatched purchase record and ignored quantities. A sale that spanned two purchase lots priced the whole quantity off one lot, which could flip the sign of the realised profit or loss. That matters because only a sale at a loss opens a wash-sale window (the rule that disallows a tax loss if the same stock is bought back within a set number of days), so a loss that was wrongly reported as a gain let the strategist buy the stock back inside 31 days. And a sale smaller than its lot marked the whole lot consumed, so the next sale of the same symbol found no cost basis at all.

`matchSellFifo` in `src/tax/fifo.ts` now replays the history, reduces each purchase lot by the shares that earlier sales already consumed, and consumes the current sale oldest lot first, producing a weighted cost basis, a `longTermQty` (the shares held over a year, which qualify for the Australian capital-gains discount), and a `matchedLots[]` array on the trade record. Eight unit tests cover it, including the multi-lot sign flip.

## IBKR's execution records win

Fills reach the ledger by two paths: the executor records what the WebSocket stream confirmed, and `src/execution/reconcile.ts` backfills from IBKR's execution history. The reconciler records each execution id once however many times it sees it, with a fallback key for records written before execution ids were captured, so a fill that arrives by both paths is recorded once. If the stream said an order did not fill and IBKR's executions say it did, the executions win and the ledger is corrected with a logged `RECONCILED` line.

## Run it under any scheduler

`npm start` runs the built-in scheduler and a status server, with each agent on the cadence above (`SCHED_*_SEC` to tune). Set `ENABLE_SCHEDULER=false` and any scheduler (cron, systemd timers, something else) can drive the same `--once` scripts; `deploy/` has systemd unit and timer files. The core never imports the scheduler.

## Your real portfolio stays out of git

The public repo ships `src/portfolios/sample.ts`, a template of eight exchange-traded funds, and runs against a paper account out of the box:

| Fund | QQQ | XLI | XLV | XLF | VIG | VDC | TLT | GLD |
|---|---|---|---|---|---|---|---|---|
| Target weight | 20% | 10% | 10% | 10% | 15% | 10% | 15% | 10% |

Weights must sum to 100 and `validateTargets()` enforces it. A real allocation goes in `src/portfolios/local.ts`, which is gitignored and takes precedence automatically. Caps, thresholds, cadences and the choice of optimiser are all environment variables; nothing about a real position is in source.

The backtest engine runs on a Yahoo Finance daily price dataset that is also gitignored: `npm run fetch-data` writes it, and the backtest suites skip until it exists, so a fresh clone is green on the first `npm test`.

## Status and licensing

- **v0.1.0**: runs end-to-end against IBKR paper accounts; the set of agents will evolve.
- **Dual-licensed under Apache-2.0 or MIT.**
- **Requires a running [bezant](https://github.com/isaacrowntree/bezant) gateway**, on `http://localhost:8080` by default.
- **Not affiliated with Interactive Brokers.** This is not financial advice. It places real trades: **start on a paper account**, and read every guardrail before setting `TRADING_MODE=live`.

The lesson from the register is that the dangerous bugs were not in the optimiser. They were units, identity and ordering: Australian dollars where US dollars were assumed, a queue position where an object reference was needed, a record where a share count was needed. Each was caught by reading the live account's actual responses against what the code assumed, and each now has a test. If bezant made IBKR programmable, Sovereign is the part that makes a portfolio follow a written policy, with brakes that are independent of the policy. Contributions welcome, especially on the optimisers and the risk engine.
