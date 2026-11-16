---
layout: post
title: "Sovereign — an autonomous IBKR fund that trades through bezant, with guardrails because it's real money"
description: "One holding had grown to 41.6% of my Interactive Brokers account. Sovereign is the open-source portfolio manager I built to fix that on rules instead of instinct: nine single-purpose TypeScript agents on top of bezant, an executor that proves one fill before it sends a batch, hard caps in dollars, and the currency bug the risk register caught before the first live order. Apache/MIT."
excerpt: "One holding had run to 41.6% of my Interactive Brokers account. Sovereign is what I built to trim it on rules: nine single-purpose TypeScript agents on top of bezant, an executor that proves one fill before it sends a batch, hard caps in dollars, and a risk register that found the account's value was being read in the wrong currency. Apache/MIT, self-host it against your own bezant."
image: /images/blog/sovereign.jpg
image_alt: A compass resting on a map — steering a portfolio by a set heading rather than by hand
date: 2026-07-08
last_modified_at: 2026-11-16
categories: [open-source]
tags: [ibkr, trading, typescript, portfolio, quant, risk, backtesting, interactive-brokers, open-source, claude-code, bezant]
---

Zack Design's **[Sovereign](https://github.com/isaacrowntree/sovereign-ibkr-fund)** is an open-source portfolio manager for Interactive Brokers (IBKR) accounts, built on [bezant](https://github.com/isaacrowntree/bezant). It exists because one holding had grown to **41.6% of my whole account**. Sovereign is nine TypeScript programs, each with one job. Together they hold a target mix of holdings, notice when the real mix has drifted, work out the smallest trades that bring it back, and place them through bezant. **The same inputs always produce the same trades**, and tests pin down the ways that can go wrong. **Dual-licensed Apache-2.0 or MIT.**

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/isaacrowntree/sovereign-ibkr-fund" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
  <a href="https://github.com/isaacrowntree/bezant" target="_blank" rel="noopener" class="btn btn-outline-primary btn-lg">bezant on GitHub</a>
</div>

This post covers:

- why it exists, and the nine agents, none of which calls a language model;
- the executor's rule that one small probe order must fill before it trusts the connection with a batch, and why that probe is removed from the queue by object reference rather than by position;
- the three caps in absolute dollars that sit outside the order-sizing maths;
- the three bugs found by the pre-launch **risk register**, a written review of every way the executor could lose money: the account's value read in the wrong currency, a timeout that could place the same trade twice, and a tax-lot matcher that ignored share counts;
- reconciling fills against IBKR's records, the features I tested and switched off, keeping your real portfolio out of git, and how to run it.

<!-- more -->

**Source:** [github.com/isaacrowntree/sovereign-ibkr-fund](https://github.com/isaacrowntree/sovereign-ibkr-fund) (Apache-2.0 OR MIT) · Built on **[bezant](https://github.com/isaacrowntree/bezant)**

## Why it exists

A single holding had grown to **41.6% of my whole account**. Trimming it by hand meant placing real orders late at night, in US dollars. The account is a cash account (one that cannot borrow) whose base currency is Australian dollars. Sovereign does that trimming on written rules instead.

## Nine agents and not one language-model call

Every agent is a plain process: `node dist/agents/<name>.js --once`. There are no calls to a large language model anywhere in the loop. A trade decision is a function of its inputs: positions, prices, the target portfolio and the risk state. It has to be reproducible from the stored state, so it cannot come from a model that gives a different answer each time.

| Agent | Job | Default cadence |
|---|---|---|
| **Managing Partner** | Orchestrates the fund, records the account's value and positions | every 4 hours |
| **Portfolio Strategist** | Chooses target weights (Hierarchical Risk Parity or Black-Litterman), detects drift, sizes the rebalancing orders | every 4 hours |
| **Quant Analyst** | Detects the market regime, runs factor regressions | every 4 hours |
| **Risk Manager** | Value at risk and conditional value at risk, drawdown control, volatility targeting | every 4 hours |
| **Execution Bot** | Places queued orders through bezant, only inside the trading window and under the caps | every 4 hours |
| **Tax Optimizer** | Tracks purchase lots first-in-first-out, prunes the wash-sale list | daily |
| **Research Scout** | Price monitoring, alerts | daily |
| **Observer** | Reads the fills and order events bezant captured from IBKR's live stream | every 5 minutes |
| **Daily Summary** | A digest after the US close: value, fills, drift, movers | daily |

Underneath are several ways to turn price history into target weights. There is Hierarchical Risk Parity, Black-Litterman, risk parity, and Ledoit-Wolf shrinkage for estimating the covariance matrix, plus volatility targeting. Each has its own test file under `src/portfolio/`, `src/quant/` and `src/risk/`.

## Prove one fill before trusting the connection

The executor never sends a batch of orders on a session until one live order has been confirmed as filled. `planExecution` in `src/execution/staging.ts` puts it in `validate` mode. That means one order, the smallest-value sell (or the smallest order at all if there are no sells), and nothing else until IBKR's execution records confirm the fill.

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

Order sizes are worked out as a percentage of the account's net asset value, its total worth ("NAV" from here on). If the NAV is garbage, the percentage is garbage. So there is a second gate in absolute dollars that knows nothing about the sizing. `orderCapViolation` in `src/risk/data-sanity.ts` checks every order against three caps set by environment variables, and the executor halts the run if any is breached:

| Cap | What it limits | Default |
|---|---|---|
| `MAX_ORDER_NOTIONAL_USD` | the value of any one order | 15,000 US dollars |
| `MAX_ORDER_PCT_NAV` | any one order as a share of NAV | 50% |
| `MAX_RUN_NOTIONAL_USD` | the total value of all orders in one run | 60,000 US dollars |

In front of that, `navSanityViolation` and `priceSanityViolations` refuse to size anything when the numbers look impossible. That covers a NAV of zero or less, a NAV below a floor, a NAV that has moved more than a set percentage since the last cycle, and a price that has jumped too far. The strategist logs, alerts and gives up rather than size orders against a NAV of zero or a price a hundred times too low.

Loss thresholds first reduce exposure and then stop trading altogether. `EXECUTION_ENABLED` is a kill switch, checked before every order. And all state lives in a SQLite file under `STATE_DIR`, outside the checkout, so a deploy cannot overwrite the ledger.

## The NAV was in the wrong currency

The pre-launch risk register found three bugs, described in this and the next two sections. All three were fixed in v0.1.0, and the register ships in `docs/execution-risk-register.md`. It is a review of the executor against the live account, done before unpausing it.

Its first finding was a units error. The account is with Interactive Brokers Australia, in Australian dollars. The API's `/summary` endpoint reports `totalcashvalue` and `netliquidation` in that base currency. So the cash check compared US-dollar purchase costs with Australian-dollar cash. And the strategist sized US shares as a fraction of a NAV stated in Australian dollars.

I expected `/summary` to be the account's cash. The live `/ledger` endpoint showed a separate balance for each currency, which IBKR does not convert. US-dollar cash was $0, US-dollar settled cash was $0, and most of the NAV was in US stock. A cash account cannot borrow US dollars, so US purchases have to be funded by the US sales that run first. The sells-before-buys ordering already guarantees that.

The fix is `gateway.getUsdBalances()`. It reads `/ledger` and returns US-dollar cash and US-dollar NAV, skipping the `BASE` row (IBKR's total in the base currency, not a real currency). That last part matters: with `BASE` included, the NAV came out roughly doubled.

I re-ran the strategist on the corrected numbers, checked against the live account (US-dollar cash $0.00, US-dollar NAV $29,155.64). The old quantities were oversized by the exchange rate:

| Order | Sized on the mixed-currency NAV | Sized on the US-dollar NAV |
|---|---|---|
| AVGO | 9 shares | 6 shares |
| TLT | 39 shares | 27 shares |

The weights now sum to about 100%. The concentrated holding's true weight was 41.6%, not the 29% the mixed-currency maths had reported.

## A timeout is not a cancel

Second finding. When the wait for a fill confirmation timed out, the executor dropped the order rather than requeue it. The stated assumption was that the strategist would rebuild the queue from live positions. But the strategist reads positions only; it knows nothing about orders still open at the broker. If the order was still working at IBKR, the drift persisted, the strategist generated the same order again, and the executor submitted it a second time.

The fix was one route away. bezant exposes `DELETE /accounts/{id}/orders/{orderId}`, and it just was not wired up. `gateway.cancelOrder()` now runs after a confirmation timeout, a stream error or a timed-out partial fill, before the run halts.

A review in September went further, because a cancel is only a request. Every cancel is now written to state and checked against the live orders at the start of the next run. Every placement also carries its own order reference. If IBKR never answers a placement, the executor looks the order up by that reference instead of guessing, and never places it again.

## Matching sales by record is not matching them by share

Third finding. The original tax-lot matcher paired each sale with one purchase record and ignored quantities. A sale that spanned two purchase lots priced the whole quantity off one lot. That could flip the sign of the realised profit or loss.

The sign matters because only a sale at a loss opens a wash-sale window: a rule that disallows a tax loss if the same stock is bought back within a set number of days. A loss wrongly reported as a gain let the strategist buy the stock back inside 31 days. And a sale smaller than its lot marked the whole lot used, so the next sale of that stock found no cost basis at all.

`matchSellFifo` in `src/tax/fifo.ts` now replays the history and consumes the sale oldest lot first. It returns a weighted cost basis and a `longTermQty`: the shares held over a year, which qualify for the Australian capital-gains discount. Each trade record gets a `matchedLots[]` array. Since September it is a thin view over one lot engine (`src/tax/lots.ts`), the same one that builds the Australian tax report in Australian dollars. Unit tests cover it, including the multi-lot sign flip.

## IBKR's execution records win

Fills reach the ledger by two paths. The executor records what the stream confirmed, and `src/execution/reconcile.ts` backfills from IBKR's execution history. The reconciler records each execution id once, however many times it sees it, so a fill that arrives by both paths is recorded once. If the stream said an order did not fill and IBKR's executions say it did, the executions win. The ledger is corrected with a logged `RECONCILED` line.

## Tested, then switched off

Some features did not survive their own tests.

- **The regime overlay is retired.** It cut exposure when the market looked like a bear. A fair test needs bear markets the account's history does not contain, and every sell it triggers is a short-term taxable sale. It stays off (`ENABLE_REGIME=false`), and the Hedger agent that relied on it was retired with it.
- **Tolerance bands lost.** Bands rebalance each holding when it leaves its own range, instead of on one drift threshold. I wrote the decision rule down and committed it before computing any result. From January 2022 to September 2026, after tax, bands returned 190.3% against 202.6% for the existing gate, with more than three times the trades. They stay off (`DRIFT_GATE=legacy`). The study is in `docs/backtesting.md`.
- **Tax-loss harvesting is off.** It is US logic, and even when on it only reports candidates. The US-style 31-day re-buy block stays on as the cautious default.

## Your real portfolio stays out of git

The public repo ships `src/portfolios/sample.ts`, a template of eight exchange-traded funds, and runs against a paper account out of the box:

| Fund | QQQ | XLI | XLV | XLF | VIG | VDC | TLT | GLD |
|---|---|---|---|---|---|---|---|---|
| Target weight | 20% | 10% | 10% | 10% | 15% | 10% | 15% | 10% |

Weights must sum to 100 and `validateTargets()` enforces it. A real allocation goes in `src/portfolios/local.ts`, which is gitignored and takes precedence automatically. Caps, thresholds, cadences and the choice of optimiser are all environment variables. Nothing about a real position is in source.

## Running it

You need Node 22.13 or later (state uses its built-in SQLite), pnpm, and a running [bezant](https://github.com/isaacrowntree/bezant) on `http://localhost:8080`:

```sh
git clone https://github.com/isaacrowntree/sovereign-ibkr-fund.git
cd sovereign-ibkr-fund
pnpm install
cp .env.example .env        # point BEZANT_URL at your bezant; TRADING_MODE=paper
pnpm run build
pnpm start                  # status server + built-in scheduler, sample portfolio
```

`pnpm start` runs each agent on the cadence above (`SCHED_*_SEC` to tune). Set `ENABLE_SCHEDULER=false` and any scheduler, such as cron or systemd timers, can drive the same `--once` scripts. `deploy/` has systemd unit and timer files. The core never imports the scheduler.

The backtest engine runs on a Yahoo Finance daily price dataset that is also gitignored. `pnpm run fetch-data` writes it. The backtest suites skip until it exists, so a fresh clone passes on the first `pnpm test`.

## Status and licensing

- **v0.1.0**: runs end-to-end against IBKR paper accounts; the set of agents will evolve.
- **Dual-licensed under Apache-2.0 or MIT.**
- **Requires a running [bezant](https://github.com/isaacrowntree/bezant) gateway**, on `http://localhost:8080` by default.
- **Not affiliated with Interactive Brokers.** This is not financial advice. It places real trades: **start on a paper account**, and read every guardrail before setting `TRADING_MODE=live`.

The lesson from the register is that the dangerous bugs were not in the optimiser. They were units, identity and ordering. Australian dollars where US dollars were assumed, a queue position where an object reference was needed, a record where a share count was needed. Each was caught by reading the live account's actual responses against what the code assumed, and each now has a test.

If bezant made IBKR programmable, Sovereign is the part that makes a portfolio follow a written policy, with brakes that are independent of the policy. Contributions welcome, especially on the optimisers and the risk engine.
