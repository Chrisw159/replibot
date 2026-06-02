---
name: Data-collection mode
description: How dataCollectionMode makes the bot observe-and-record races without betting, and the runner-snapshot rule it depends on.
---

# Data-collection mode

`bot_config.dataCollectionMode` (boolean) switches the bot to pure observation: it places NO bets
(paper or real) but records every observed GB/IE race to the permanent `race_dataset` table with
rich runner metadata + decision-time liquidity, then settles winner/BSP/going later.

## Rule: snapshot ALL active runners, not just priced ones
**Rule:** In data-collection mode the runner snapshot must include every `ACTIVE` runner, even those
with no current back offer (`bestBackPrice == null`).

**Why:** Betfair can list an active runner with no back price available at a given poll. The normal
betting path intentionally filters those out (`status === "ACTIVE" && bestBackPrice != null`), but for
research we want the complete field — dropping unpriced runners undercounts the race and corrupts the
dataset.

**How to apply:** `buildSnapshot` takes an `includeUnpriced` flag; the data-collection branch calls it
with `true`. `ScheduleRunner.price` (and the frontend interface) is `number | null`; null sorts last
and renders as "—". Betting paths still call `buildSnapshot` on already-filtered `eligible` runners, so
their prices are always non-null.

## Settlement
`runScheduleSettlement` selects by time + null winner/going, NOT by status, so `OBSERVED` rows are
settled normally and mirrored to `race_dataset` (metadata preserved via `...r` spread).

## Limitation
Betfair only exposes WINNER/LOSER + BSP — finishing positions beyond the winner (2nd/3rd) are NOT
available, so "full result" stops at the winner.

## Deploy safety
Adding the `dataCollectionMode` column is safe on the droplet: docker-compose `db-migrate`
(`drizzle-kit push`) runs and must succeed before the `api` service starts.
