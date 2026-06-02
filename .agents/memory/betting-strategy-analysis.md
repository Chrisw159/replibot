---
name: Betting strategy analysis & backtesting
description: How to honestly backtest REPLIBOT racing strategies and what the data says about edge
---

# Betfair racing strategy — durable findings

## The efficiency baseline (the bar any strategy must clear)
- Flat-staking a back on the market favourite is ~breakeven on the exchange: measured ROI ≈ -0.2% over 164 bets ("Paper Back Fav"). That residual is commission + spread. **Any active strategy that does worse than ~-0.2% ROI is SUBTRACTING edge, not adding it.** All Dutch/V2/Martingale variants did -14% to -20% ROI — they actively destroy the breakeven baseline via poor selection, oversized stakes (£50-75 vs £10), and Martingale ruin.
- **Why:** racing exchange markets are close to efficient. Treat any claimed large edge with deep suspicion.

## Backtesting rule: NEVER select or price on BSP (look-ahead bias)
- The `dutch_schedule.runnersJson` rows carry per-runner `price` (decision-time last-traded ~8min pre-off), `bsp` (settlement), and `finalStatus` (WINNER/LOSER/REMOVED). ~320 races had full decision-time price coverage.
- A backtest MUST select the favourite and set entry price from **decision-time `price`**, using `bsp`/`finalStatus` only for the outcome. Selecting "the runner that turned out to be BSP favourite" inflates ROI massively because favourite rank flips between decision time and off, especially in open races.
- **How to apply:** sort runners by `price` (not `bsp`); enter at `price` minus 1-2 ticks slippage; apply 5% commission; validate with walk-forward (train first 60%, blind-test last 40%, no retuning).

## The one candidate edge that survived honest testing
- "Open-Race Favourite Value": BACK the market favourite (by decision-time price) when that price is **3.0-5.0**, fields of **5+ runners**, GB/IE WIN. ~+22% ROI, held in walk-forward (+23% train / +20% blind test) and under 2-tick slippage (+19.8%).
- **Hard cap at 5.0** — favourites at 5.0+ are catastrophic (-68% ROI). Mechanism: favourite-longshot bias (in wide-open races money over-spreads to longshots, leaving the fav underbet).
- **Caveat:** z≈1.66, CI ±36% — plausible not proven. Needs more data; deploy paper-only with conservative flat stakes + kill-switch. Do NOT scale stakes on it yet.
