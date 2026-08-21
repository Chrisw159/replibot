---
name: Soccer "no more goals" in-play bot
description: Frozen rules + design decisions for the soccer in-play under-goals paper bot
---

Frozen entry rules (updated 21 Aug 2026, paper mode only until proven):
- 80'+ in-play, goal gap ≥ 2. First back the one-goal-insured Under (total+1.5) only above 1.60; otherwise back tight Under (total+0.5) only above 1.50. Otherwise do not enter. Stake £50, £5k min liquidity.
- There is no daily stop-loss. Do not add or re-enable one.

Key design decisions:
- Live score comes from ESPN when available, with Correct Score market inference as fallback. If the two sources disagree at entry, stand aside for that cycle.
- **Why:** disagreement often means a goal is in flight and one source is delayed; refusing that cycle avoids entering from stale score data.
- Goal-after-entry detection: re-read CS market and compare total vs entryTotalGoals; price-spike (≥1.4× entry) only as fallback when score unreadable.
- The only active strategy mirrors the operator's manual method: rest a same-stake lay immediately to lock a £20 return (40% of £50) if the Under wins and break even if it loses. Do not reintroduce comparison strategies.
- Paper resting lays need a dedicated fast monitor independent of the slower entry scan. **Why:** a 20-second check missed a brief lay-price crossing before a goal and falsely booked a £50 loss while the real resting lay had matched.
- Each Betfair event may be entered only once. A settled win or loss must block every later scan from re-entering that fixture, including after a bot restart.
- **Why:** allowing re-entry after losses created repeated £50 positions on the same late-game market.
- The operator dashboard is single-strategy. Do not add strategy tabs or combined/comparison totals.
- **Why:** the operator chose the manual same-stake lay lock as the sole production direction after the comparison logic caused confusion.
