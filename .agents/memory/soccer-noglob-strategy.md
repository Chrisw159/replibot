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
- The full-match strategy uses a fixed £50 paper back after minute 80, then immediately rests one equal-stake lay at the valid exchange price that locks at least £20 net if the Under wins and £0 if it loses. Do not reintroduce dynamic staking or comparison strategies.
- Paper resting lays need a dedicated fast monitor independent of the slower entry scan. **Why:** a 20-second check missed a brief lay-price crossing before a goal and falsely booked a £50 loss while the real resting lay had matched.
- Each Betfair event may be entered only once. A settled win or loss must block every later scan from re-entering that fixture, including after a bot restart.
- **Why:** allowing re-entry after losses created repeated £50 positions on the same late-game market.
- Each bot remains single-strategy with no comparison totals, but the dashboard now has separate full-match and first-half bot views with independent controls and P&L.
- First-half bot rule (confirmed 23 Aug 2026): paper-only, enter from 35' while the first-half market is live when the score gap is ≥2; back only the tight first-half Under (current total + 0.5) and rest the same-stake lay for a 40% target.
- **Why:** the tight line makes the next first-half goal lose the Under so a fully matched same-stake lay produces the requested £0 result; no further goal produces the target return.
- First-half and full-match running state, configuration, trade monitoring, settlement, and reporting must remain isolated.
- The full-match resting lay is placed once and left unchanged. It must never be chased, replaced, traded out, or supplemented with an alternate fill.
- **Why:** the operator wants the simplest manual pattern: if the lay fills first it locks the intended outcomes; if a goal arrives first, accept the remaining exposure and normal settlement.
- **How to apply:** monitor only evidence that the original target order filled, including genuine partial fills. Never execute another full-match lay. Keep the first-half fallback unchanged.
