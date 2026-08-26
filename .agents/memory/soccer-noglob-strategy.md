---
name: Soccer "no more goals" in-play bot
description: Frozen rules + design decisions for the soccer in-play under-goals paper bot
---

Frozen entry rules (paper mode only until proven):
- Enter late in-play only with a goal gap ≥ 2. Prefer the one-goal-insured Under line when eligible; otherwise use the tight Under line only when eligible.
- There is no daily stop-loss. Do not add or re-enable one.

Key design decisions:
- Live score comes from ESPN when available, with Correct Score market inference as fallback. If the two sources disagree at entry, stand aside for that cycle.
- **Why:** disagreement often means a goal is in flight and one source is delayed; refusing that cycle avoids entering from stale score data.
- Goal-after-entry detection: re-read CS market and compare total vs entryTotalGoals; price-spike (≥1.4× entry) only as fallback when score unreadable.
- The only active strategy mirrors the operator's manual method: rest a same-stake lay immediately to lock a £20 return (40% of £50) if the Under wins and break even if it loses. Do not reintroduce comparison strategies.
- Paper resting lays need a dedicated fast monitor independent of the slower entry scan. **Why:** a 20-second check missed a brief lay-price crossing before a goal and falsely booked a £50 loss while the real resting lay had matched.
- Each Betfair event may be entered only once. A settled win or loss must block every later scan from re-entering that fixture, including after a bot restart.
- **Why:** allowing re-entry after losses created repeated £50 positions on the same late-game market.
- Each bot remains single-strategy with no comparison totals, but the dashboard now has separate full-match and first-half bot views with independent controls and P&L.
- First-half bot rule (confirmed 23 Aug 2026): paper-only, enter from 35' while the first-half market is live when the score gap is ≥2; back only the tight first-half Under (current total + 0.5) and rest the same-stake lay for a 40% target.
- **Why:** the tight line makes the next first-half goal lose the Under so a fully matched same-stake lay produces the requested £0 result; no further goal produces the target return.
- First-half and full-match running state, configuration, trade monitoring, settlement, and reporting must remain isolated.
- Full-match fallback hedging must remain tightly bounded by a small flat-currency loss, not a percentage of stake, and must stop after a short retry window rather than chase worsening prices.
- **Why:** the successful hedge upside is only a partial win (roughly 40%), so paying a large insurance premium to avoid an already near-full-stake loss has poor value; leave the residual back position unhedged instead of locking a large guaranteed loss.
- **How to apply:** future fallback or near-close logic must never bypass the small-loss cap. Preserve accepted partial fills, stop chasing after the bounded retry window, and settle the remaining exposure normally.
