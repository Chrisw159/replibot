---
name: Soccer "no more goals" in-play bot
description: Frozen rules + design decisions for the soccer in-play under-goals paper bot
---

Frozen strategy (agreed 17 Aug 2026, paper mode only until proven):
- 85'+ in-play, goal gap ≥ 2 → back Under (total+0.5); prefer buffer line Under (total+2.5) if it trades in the 1.25–1.50 band. Stake £50, trade out at +15% NET of 5% commission, breakeven-out after a goal, else settle at FT. Max 3 concurrent, £100 daily stop, £5k min liquidity.

Key design decisions (engine: api-server soccerEngine):
- Betfair betting API has NO scoreline/clock. Score is inferred from the CORRECT_SCORE market (favourite priced ≤1.15 = current score); ambiguous scores (e.g. "Any Other Home Win") are skipped, never guessed. Minute estimated from marketStartTime + 15 min half-time.
- **Why:** the API alternative (Stream API score feed) needs infra the project doesn't have; the CS inference is honest — it refuses to trade when unsure.
- Paper exits must be executable: equal-profit lay stake = S·B/O and the quoted lay depth must cover it, else skip the tick. **Why:** review found the naive version credited fictitious green-outs on thin books.
- Daily stop is recomputed AFTER settlements within a cycle and attributed by closedAt (not placedAt), else losses settled today from yesterday's entries escape the stop.
- Goal-after-entry detection: re-read CS market and compare total vs entryTotalGoals; price-spike (≥1.4× entry) only as fallback when score unreadable.
