---
name: LT2 lay rule — pre-registered thresholds and proof plan
description: The only candidate edge found in REPLIBOT data, its frozen parameters, and the agreed proof process. Do not re-tune thresholds.
---

# LT2 candidate rule (frozen 2 Jul 2026)

After 6 weeks of paper data (1,817 bets, -£2,806 / -6.1% ROI overall), the ONLY rule that was
profitable in-sample AND weakly positive out-of-sample on the race_dataset corpus:

> Fav >= 5.0, field >= 8 runners, liquidity >= £3,000 → LAY top 2 in market at odds <= 8.0.
> Fixed liability 1% of bank per race. 5% commission. Settle at BSP.

**Why frozen:** out-of-sample support is only ~30 races (+21% ROI, <1σ above breakeven) and the
result flips negative at fav>=4.5 — a threshold cliff. Re-tuning parameters on the same data
would be data-dredging; the rule must be tested as-is on NEW races only.

**Proof gate (agreed with user):** ~300 qualifying races (~4-5 months at ~2/day) of forward
data before any real money. User chose: bankroll <£500, stay 100% paper until proven, 50%
drawdown tolerance, 5% commission account.

**How to apply:** validation runs FROM the dev side — pull race corpus via
`http://144.126.238.76/api/dataset/races?date=YYYY-MM-DD&limit=1000` (no auth), keep rows with
runnersJson + winnerSelectionId, simulate the frozen rule, append results. No droplet code
changes needed for the proving phase (deploy pipeline is still broken anyway).

**Confirmed losers (in AND out of sample — do not resurrect):** Martingale staking (-14.9%),
BACK fav 2.0-2.5 (-11.6% OOS), LAY 3.0-4.0 band (-16.9%), blanket LAY 4.2-10 without the
fav>=5 condition (-12.4% OOS). Paper P&L on the droplet deducts NO commission — always
adjust before quoting results.
