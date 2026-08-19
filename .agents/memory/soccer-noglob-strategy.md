---
name: Soccer "no more goals" in-play bot
description: Frozen rules + design decisions for the soccer in-play under-goals paper bot
---

Frozen entry rules (agreed 17 Aug 2026, paper mode only until proven):
- 85'+ in-play, goal gap ≥ 2 → back Under (total+0.5); prefer buffer line Under (total+2.5) if it trades in the 1.25–1.50 band. Stake £50, £5k min liquidity.
- There is no daily stop-loss. Do not add or re-enable one.

Key design decisions:
- Live score comes from ESPN when available, with Correct Score market inference as fallback. If the two sources disagree at entry, stand aside for that cycle.
- **Why:** disagreement often means a goal is in flight and one source is delayed; refusing that cycle avoids entering from stale score data.
- Paper exits must be executable: equal-profit lay stake = S·B/O and the quoted lay depth must cover it, else skip the tick. **Why:** review found the naive version credited fictitious green-outs on thin books.
- Goal-after-entry detection: re-read CS market and compare total vs entryTotalGoals; price-spike (≥1.4× entry) only as fallback when score unreadable.
- Strategy 1 trades out at its target. Strategy 2 rests a same-stake lay intended to lock the configured return if the Under wins and return the stake if it loses.
- Each Betfair event may be entered only once. A settled win or loss must block every later scan from re-entering that fixture, including after a bot restart.
- **Why:** allowing re-entry after losses created repeated £50 positions on the same late-game market.
- The two strategies must remain completely separate in the operator dashboard: separate tabs, P&L, trade history, open bets, daily chart, and watchlist context. Never show combined strategy totals as the main view.
- **Why:** combined views made it impossible for the operator to understand what each strategy actually did.
