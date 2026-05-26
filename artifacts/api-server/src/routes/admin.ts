import { Router, type IRouter } from "express";
import { sql, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { betsTable, dutchScheduleTable, botLogsTable, raceDatasetTable } from "@workspace/db";

/**
 * ============================================================================
 *  PERMANENT DATA — NEVER WIPE
 * ============================================================================
 *  The `race_dataset` table is the long-term research corpus (every race we
 *  have ever observed, with winners + going). It must NEVER be referenced by
 *  any reset/delete endpoint in this file. If you add a new wipe endpoint,
 *  audit it to confirm raceDatasetTable is not touched.
 * ============================================================================
 */

const router: IRouter = Router();

const ADMIN_TOKEN = "k7Qm9pR2vT5wXz8aB3cD6fH1jL4nP7sU";

router.post("/admin/:token/reset-dutch", async (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const betsDel = await db
    .delete(betsTable)
    .where(sql`${betsTable.strategyName} = 'Dutch Bot'`)
    .returning({ id: betsTable.id });
  const schedDel = await db.delete(dutchScheduleTable).returning({ id: dutchScheduleTable.id });
  res.json({
    ok: true,
    betsDeleted: betsDel.length,
    scheduleDeleted: schedDel.length,
  });
});

router.post("/admin/:token/reset-strategy", async (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const name = String(req.query.name ?? "");
  if (!name) {
    res.status(400).json({ error: "missing ?name=" });
    return;
  }
  const betsDel = await db
    .delete(betsTable)
    .where(sql`${betsTable.strategyName} = ${name}`)
    .returning({ id: betsTable.id });
  res.json({ ok: true, strategy: name, betsDeleted: betsDel.length });
});

router.post("/admin/:token/clear-logs", async (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const del = await db.delete(botLogsTable).returning({ id: botLogsTable.id });
  res.json({ ok: true, logsDeleted: del.length });
});

// Read-only dataset access (no token required — research data, no secrets).
router.get("/dataset/races", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 1000);
  const date  = req.query.date ? String(req.query.date) : null;
  const rows = date
    ? await db.select().from(raceDatasetTable)
        .where(sql`${raceDatasetTable.scheduledDate} = ${date}`)
        .orderBy(desc(raceDatasetTable.marketStartTime))
        .limit(limit)
    : await db.select().from(raceDatasetTable)
        .orderBy(desc(raceDatasetTable.marketStartTime))
        .limit(limit);
  res.json({ count: rows.length, races: rows });
});

router.get("/dataset/races/count", async (_req, res) => {
  const [r] = await db
    .select({
      total:        sql<number>`count(*)::int`,
      withWinner:   sql<number>`count(${raceDatasetTable.winnerSelectionId})::int`,
      withGoing:    sql<number>`count(${raceDatasetTable.going})::int`,
    })
    .from(raceDatasetTable);
  res.json(r ?? { total: 0, withWinner: 0, withGoing: 0 });
});

// ============================================================================
//  BACKFILL — replay bot decisions against today's settled races
// ============================================================================
//  Replays Dutch / Dutch V2 Premium / Dutch V2 Conservative deterministically
//  against the runner snapshots stored in `dutch_schedule` for today. For each
//  race where the bot would have placed a bet, inserts a settled bet row with
//  the correct WON/LOST status and actualProfit based on the recorded winner.
//
//  Idempotent: skips any (marketId, strategyName) pair that already has a row
//  in `bets`, so live bets are never duplicated.
// ============================================================================

const NON_WIN_PATTERN = /each.?way|forecast|\(f\/c\)|\bFC\b|\bRFC\b|reverse\s|straight\s+f|combination\s+f|to be placed|\bTBP\b|match bet|daily win dist|without\s+\w|to win by|trained\s+winner|named\s+fav|jockey.*champion|specials|scorecast|wincast/i;
const HURDLE_PATTERN = /\bhrd\b|hurdle/i;
const NHF_PATTERN    = /\bnhf\b|bumper/i;
const LAY_FAV_RACE_BLOCKLIST = /\b(Grp|Group|Listed)\b/i;
const MIN_LIQUIDITY = 3000;
const MIN_RUNNERS   = 5;
const MAX_RUNNERS   = 15;
const MIN_BET_SIZE  = 2.0;

type SnapshotRunner = { selectionId: number; name: string; price: number };
type PlanBet = {
  selectionId: number;
  runnerName: string;
  backPrice: number;
  side: "BACK" | "LAY";
  stake: number;
  liability: number;
};
type Plan = { mode: "BACK_FAV" | "LAY_FAV" | "LAY_TOP2" | "SKIP"; bets: PlanBet[]; reason: string };

function planDutch(eligible: SnapshotRunner[], outlay: number, marketName: string): Plan {
  if (eligible.length === 0) return { mode: "SKIP", bets: [], reason: "No eligible runners" };
  const sorted = [...eligible].sort((a, b) => a.price - b.price);
  const fav = sorted[0];
  const p = fav.price;
  if (p < 2.5) {
    if (p < 1.5)              return { mode: "SKIP", bets: [], reason: `Phase 1: BACK_FAV skipped — fav ${p.toFixed(2)} < 1.5` };
    if (p >= 1.8 && p < 2.0)  return { mode: "SKIP", bets: [], reason: `Phase 1: BACK_FAV skipped — fav ${p.toFixed(2)} in dead zone 1.8-2.0` };
    const stake = Math.round(outlay * 100) / 100;
    return { mode: "BACK_FAV", bets: [{ selectionId: fav.selectionId, runnerName: fav.name, backPrice: p, side: "BACK", stake, liability: stake }], reason: `BACK heavy favourite at ${p}` };
  }
  if (p >= 3.0 && p < 3.6) {
    if (LAY_FAV_RACE_BLOCKLIST.test(marketName)) return { mode: "SKIP", bets: [], reason: `Phase 1: LAY_FAV skipped — Group/Listed race` };
    const liability = Math.round(outlay * 100) / 100;
    const stake = Math.round((liability / (p - 1)) * 100) / 100;
    return { mode: "LAY_FAV", bets: [{ selectionId: fav.selectionId, runnerName: fav.name, backPrice: p, side: "LAY", stake, liability }], reason: `LAY favourite — sweet-spot 3.0-3.6` };
  }
  if (p >= 5.0) {
    const top2 = sorted.slice(0, 2).filter(r => r.price <= 8.0);
    if (top2.length < 2) return { mode: "SKIP", bets: [], reason: `Top-2 lay aborted — second above 8.0` };
    const liabPer = Math.round((outlay / 2) * 100) / 100;
    return { mode: "LAY_TOP2", bets: top2.map(r => ({ selectionId: r.selectionId, runnerName: r.name, backPrice: r.price, side: "LAY" as const, stake: Math.round((liabPer / (r.price - 1)) * 100) / 100, liability: liabPer })), reason: `LAY top 2 — open race, fav ${p}` };
  }
  return { mode: "SKIP", bets: [], reason: `Favourite at ${p.toFixed(2)} — neutral zone` };
}

function planV2(eligible: SnapshotRunner[], outlay: number, marketName: string, raceDesc: string): Plan {
  if (HURDLE_PATTERN.test(raceDesc)) return { mode: "SKIP", bets: [], reason: "V2: Hurdle race" };
  if (NHF_PATTERN.test(raceDesc))    return { mode: "SKIP", bets: [], reason: "V2: NHF/Bumper race" };
  if (eligible.length === 0) return { mode: "SKIP", bets: [], reason: "No eligible runners" };
  const sorted = [...eligible].sort((a, b) => a.price - b.price);
  const fav = sorted[0];
  const p = fav.price;
  const rc = eligible.length;
  if (p >= 2.0 && p <= 2.5) {
    if (rc >= 8 && rc <= 9) return { mode: "SKIP", bets: [], reason: `V2: BACK_FAV skipped — ${rc} runners in 8-9 dead band` };
    const stake = Math.round(outlay * 100) / 100;
    return { mode: "BACK_FAV", bets: [{ selectionId: fav.selectionId, runnerName: fav.name, backPrice: p, side: "BACK", stake, liability: stake }], reason: `V2 BACK fav at ${p}` };
  }
  if (p >= 3.0 && p < 3.6) {
    if (LAY_FAV_RACE_BLOCKLIST.test(marketName)) return { mode: "SKIP", bets: [], reason: `V2: LAY_FAV skipped — Group/Listed` };
    if (rc < 8) return { mode: "SKIP", bets: [], reason: `V2: LAY_FAV skipped — ${rc} runners < 8` };
    const liability = Math.round(outlay * 100) / 100;
    const stake = Math.round((liability / (p - 1)) * 100) / 100;
    return { mode: "LAY_FAV", bets: [{ selectionId: fav.selectionId, runnerName: fav.name, backPrice: p, side: "LAY", stake, liability }], reason: `V2 LAY fav — band 3.0-3.6 (≥8 runners)` };
  }
  if (p >= 5.0) {
    const top2 = sorted.slice(0, 2).filter(r => r.price <= 8.0);
    if (top2.length < 2) return { mode: "SKIP", bets: [], reason: `V2: top-2 lay aborted — second above 8.0` };
    const liabPer = Math.round((outlay / 2) * 100) / 100;
    return { mode: "LAY_TOP2", bets: top2.map(r => ({ selectionId: r.selectionId, runnerName: r.name, backPrice: r.price, side: "LAY" as const, stake: Math.round((liabPer / (r.price - 1)) * 100) / 100, liability: liabPer })), reason: `V2 LAY top 2 — open race, fav ${p}` };
  }
  return { mode: "SKIP", bets: [], reason: `V2: fav ${p.toFixed(2)} outside all bands` };
}

interface BotConfig {
  strategyName: string;
  outlay: number;
  planner: (eligible: SnapshotRunner[], outlay: number, marketName: string, raceDesc: string) => Plan;
  betIdPrefix: string;
}

const BACKFILL_BOTS: BotConfig[] = [
  { strategyName: "Dutch Bot",              outlay: 50, planner: (e, o, m)    => planDutch(e, o, m),   betIdPrefix: "DUTCH-BACKFILL" },
  { strategyName: "Dutch V2 Premium",       outlay: 75, planner: (e, o, m, d) => planV2(e, o, m, d),   betIdPrefix: "DUTCH-V2-PREMIUM-BACKFILL" },
  { strategyName: "Dutch V2 Conservative",  outlay: 75, planner: (e, o, m, d) => planV2(e, o, m, d),   betIdPrefix: "DUTCH-V2-CONSERVATIVE-BACKFILL" },
];

router.post("/admin/:token/backfill-today", async (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) { res.status(404).json({ error: "not found" }); return; }
  const dryRun = req.query.dry === "1";

  const races = await db
    .select()
    .from(dutchScheduleTable)
    .where(sql`${dutchScheduleTable.marketStartTime}::date = CURRENT_DATE
               AND ${dutchScheduleTable.runnersJson} IS NOT NULL
               AND ${dutchScheduleTable.winnerSelectionId} IS NOT NULL`);

  const existing = await db
    .select({ marketId: betsTable.marketId, strategyName: betsTable.strategyName })
    .from(betsTable)
    .where(sql`${betsTable.placedAt}::date = CURRENT_DATE`);
  const existingPairs = new Set(existing.map(e => `${e.marketId}|${e.strategyName}`));

  const summary: Record<string, { betsInserted: number; racesBet: number; netProfit: number; skipped: Array<{race: string; reason: string}> }> = {};
  for (const bot of BACKFILL_BOTS) summary[bot.strategyName] = { betsInserted: 0, racesBet: 0, netProfit: 0, skipped: [] };

  for (const race of races) {
    type RawRunner = { selectionId: number; name: string; price?: number; lastPriceTraded?: number; bsp?: number; finalStatus?: string };
    const runners = (race.runnersJson as RawRunner[] | null) ?? [];
    // Decision-time price fallback chain: price (Dutch processed it live) →
    // lastPriceTraded → bsp (settlement-time, used when bot wasn't running and
    // we only have post-race data). BSP is a reasonable proxy for the price
    // the bot WOULD have seen ~2min before off in liquid UK/IE win markets.
    const priceOf = (r: RawRunner): number | null => {
      const valid = (x: unknown): x is number => typeof x === "number" && x >= 1.01;
      if (valid(r.price)) return r.price;
      if (valid(r.lastPriceTraded)) return r.lastPriceTraded;
      if (valid(r.bsp)) return r.bsp;
      return null;
    };
    const eligible: SnapshotRunner[] = runners
      .filter(r => r.finalStatus !== "REMOVED")
      .map(r => ({ selectionId: r.selectionId, name: r.name, price: priceOf(r) }))
      .filter((r): r is SnapshotRunner => r.price !== null);
    const winnerSel = race.winnerSelectionId!;
    const totalMatched = race.totalMatched ? Number(race.totalMatched) : 0;
    const raceDesc = `${race.eventName} ${race.marketName}`;
    const winnerName = runners.find(r => r.selectionId === winnerSel)?.name ?? null;

    // Universal filters (all bots share these)
    if (NON_WIN_PATTERN.test(race.marketName)) continue;
    if (totalMatched > 0 && totalMatched < MIN_LIQUIDITY) continue;
    if (eligible.length < MIN_RUNNERS) continue;
    if (eligible.length > MAX_RUNNERS) continue;

    for (const bot of BACKFILL_BOTS) {
      const key = `${race.marketId}|${bot.strategyName}`;
      if (existingPairs.has(key)) {
        summary[bot.strategyName].skipped.push({ race: race.eventName, reason: "already has bet (live or prior backfill)" });
        continue;
      }
      const plan = bot.planner(eligible, bot.outlay, race.marketName, raceDesc);
      if (plan.mode === "SKIP") continue;
      if (plan.bets.some(b => b.stake < MIN_BET_SIZE)) continue;

      const fullField = JSON.stringify(runners.map(r => ({ selectionId: r.selectionId, name: r.name, odds: priceOf(r) ?? 999 })).sort((a, b) => a.odds - b.odds));
      let raceNet = 0;
      const settledAt = race.marketStartTime;

      for (const b of plan.bets) {
        const selectionWon = b.selectionId === winnerSel;
        const isLay = b.side === "LAY";
        const actualProfit = isLay
          ? (selectionWon ? -(b.stake * (b.backPrice - 1)) : b.stake)
          : (selectionWon ? (b.stake * (b.backPrice - 1)) : -b.stake);
        const ourBetWon = isLay ? !selectionWon : selectionWon;
        raceNet += actualProfit;

        const reasoning = `[BACKFILL][${plan.mode}] ${b.side} £${b.stake.toFixed(2)} @ ${b.backPrice} · liab £${b.liability.toFixed(2)} · ${plan.reason}||FIELD:${fullField}${winnerName ? `||WINNER:${winnerName}` : ""}`;

        if (!dryRun) {
          await db.insert(betsTable).values({
            strategyId: null,
            strategyName: bot.strategyName,
            marketId: race.marketId,
            marketName: race.marketName,
            eventName: race.eventName,
            selectionId: b.selectionId,
            selectionName: b.runnerName,
            betType: b.side,
            requestedOdds: b.backPrice.toFixed(2),
            matchedOdds: b.backPrice.toFixed(2),
            stakeAmount: b.stake.toFixed(2),
            potentialProfit: (isLay ? b.stake : b.stake * (b.backPrice - 1)).toFixed(2),
            actualProfit: actualProfit.toFixed(2),
            status: ourBetWon ? "WON" : "LOST",
            aiReasoning: reasoning,
            betId: `${bot.betIdPrefix}-${race.marketId}-${b.selectionId}`,
            placedAt: race.marketStartTime,
            settledAt,
          });
        }
        summary[bot.strategyName].betsInserted += 1;
      }
      summary[bot.strategyName].racesBet += 1;
      summary[bot.strategyName].netProfit += raceNet;
    }
  }

  // Round netProfit
  for (const k of Object.keys(summary)) summary[k].netProfit = Math.round(summary[k].netProfit * 100) / 100;

  res.json({
    ok: true,
    dryRun,
    racesConsidered: races.length,
    summary,
  });
});

export default router;
