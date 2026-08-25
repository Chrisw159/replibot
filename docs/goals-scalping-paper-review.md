# Goals scalping paper review checklist

Before considering any separate live-mode work, review a meaningful sample of both full-match and first-half paper trades:

- Confirm every entry occurred inside that bot's configured time window with a lead of at least two goals.
- Confirm the selected Under line and displayed entry odds match the recorded market snapshot.
- Confirm stakes are £50 at entry odds up to and including 2.0, and £100 above 2.0.
- Confirm the original target lay equals the matched back odds minus the configured offset, rounded down to a valid Betfair tick.
- For partial target fills, confirm matched stake and weighted price-stake increase only once as traded volume clears the recorded queue.
- Confirm fallback attempts occur no earlier than the configured interval (default and minimum five minutes) and show elapsed time, available price, projected P&L, and decision.
- Confirm a deferred fallback exceeds the configured loss cap and remains scheduled for another check.
- Confirm an accepted fallback is at breakeven/profit or within the configured loss cap, fills only the remaining stake, and prevents the old target from competing.
- At settlement, recompute both possible combined back/lay outcomes from the recorded aggregate matched stake and weighted average lay odds.
- Investigate any missing evidence, duplicate fill, early fallback, cap breach, or mismatch between projected and realized paper P&L before discussing live operation.