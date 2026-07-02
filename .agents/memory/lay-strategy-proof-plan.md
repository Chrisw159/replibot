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

# FOM portfolio — second frozen candidate (frozen 2 Jul 2026)

User wanted higher returns than LT2's ~£4/wk. Systematic scan (~40 rank×fav-band cells) over
550 fully-priced races found a coherent "front-of-market" back portfolio:

> fav < 2.0 → BACK the 2nd favourite; fav 2.0-3.0 → BACK the 2nd favourite;
> fav 3.0-4.0 → BACK the favourite; fav >= 4.0 → no back bet (LT2 territory).
> Flat 1% of bank per bet, 5% commission.

Backtest (26 May-1 Jul, 407 bets, 10.7/day): +26.7% ROI, t=2.58, both halves positive
(+33%/+20%), survives settling at BSP (all 3 legs higher at BSP), 5/6 weeks positive,
maxDD 18% of bank at 1% stakes.

**Why cautious:** discovered in-sample by scanning many cells — expect regression toward
~10% ROI. Each leg alone is only ~1.8σ. Proof gate: 300 forward bets (~4 weeks at 10.7/day),
require ROI > +5% to go live. Same freeze discipline: do NOT re-tune bands on old data.

**Crash test (Monte Carlo under efficient-market null, 3,000 sims, 2 Jul 2026):**
- Fixed rule pre-specified: p=0.0003 (real, IF the rule had been chosen in advance).
- Dredge-corrected (replicating the 20-cell scan+selection procedure on random data):
  p=0.18 — the scan procedure alone manufactures a median +17% ROI "portfolio" from noise.
- Rank calibration on real winners: rank1 36.0% actual vs 35.2% implied, rank2 21.4% vs
  20.6% — front-of-market bias direction is REAL but small (~+0.8pp ≈ +2-4% ROI, not +26%).
- Verdict: NOT PROVEN; realistic forward expectation is single-digit ROI (~£10-30/wk on £500
  at 1-2% stakes). Only the 300-bet forward test counts as evidence.

**Confirmed losers (in AND out of sample — do not resurrect):** Martingale staking (-14.9%),
BACK fav 2.0-2.5 (-11.6% OOS), LAY 3.0-4.0 band (-16.9%), blanket LAY 4.2-10 without the
fav>=5 condition (-12.4% OOS). Paper P&L on the droplet deducts NO commission — always
adjust before quoting results.
