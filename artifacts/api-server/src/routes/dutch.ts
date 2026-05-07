import { Router, type IRouter } from "express";
import { sql, desc } from "drizzle-orm";
import { db, betsTable, botConfigTable, botLogsTable } from "@workspace/db";
import {
  startDutchBot,
  stopDutchBot,
  isDutchBotRunning,
  getDutchStartedAt,
  getDutchConfig,
  setDutchConfig,
  saveDutchConfigToDb,
} from "../lib/dutchEngine";
import { getMarketSettlement } from "../lib/betfair";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const DUTCH_FILTER = sql`${betsTable.strategyName} = 'Dutch Bot'`;

async function getDutchStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [today] = await db
    .select({
      racesToday:  sql<number>`count(distinct ${betsTable.marketId})::int`,
      betsToday:   sql<number>`count(*)::int`,
      profitToday: sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
    })
    .from(betsTable)
    .where(sql`${DUTCH_FILTER} AND ${betsTable.placedAt} >= ${todayStart}`);

  const [allTime] = await db
    .select({
      totalRaces:     sql<number>`count(distinct ${betsTable.marketId})::int`,
      totalNetProfit: sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
    })
    .from(betsTable)
    .where(DUTCH_FILTER);

  return {
    racesToday:     today?.racesToday     ?? 0,
    betsToday:      today?.betsToday      ?? 0,
    profitToday:    Math.round((today?.profitToday    ?? 0) * 100) / 100,
    totalRaces:     allTime?.totalRaces     ?? 0,
    totalNetProfit: Math.round((allTime?.totalNetProfit ?? 0) * 100) / 100,
  };
}

function statusPayload() {
  return {
    isRunning:   isDutchBotRunning(),
    startedAt:   getDutchStartedAt()?.toISOString() ?? null,
    dutchConfig: getDutchConfig(),
  };
}

router.get("/dutch/status", async (_req, res): Promise<void> => {
  const [config] = await db.select().from(botConfigTable).limit(1);
  const stats = await getDutchStats();
  res.json({ ...statusPayload(), paperTradingMode: config?.paperTradingMode ?? true, ...stats });
});

router.post("/dutch/start", async (_req, res): Promise<void> => {
  await startDutchBot();
  const [config] = await db.select().from(botConfigTable).limit(1);
  const stats = await getDutchStats();
  res.json({ ...statusPayload(), paperTradingMode: config?.paperTradingMode ?? true, ...stats });
});

router.post("/dutch/stop", async (_req, res): Promise<void> => {
  await stopDutchBot();
  const stats = await getDutchStats();
  res.json({ ...statusPayload(), ...stats });
});

router.patch("/dutch/config", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;

  const totalOutlay  = typeof body.totalOutlay  === "number" ? body.totalOutlay  : undefined;
  const topPct       = typeof body.topPct       === "number" ? body.topPct       : undefined;
  const minFavPrice  = typeof body.minFavPrice  === "number" ? body.minFavPrice  : undefined;
  const minLiquidity = typeof body.minLiquidity === "number" ? body.minLiquidity : undefined;
  const minRunners   = typeof body.minRunners   === "number" ? body.minRunners   : undefined;
  const countryCodes = Array.isArray(body.countryCodes)
    ? (body.countryCodes as string[]).map(c => String(c).trim().toUpperCase()).filter(Boolean)
    : undefined;

  if (totalOutlay  !== undefined && (totalOutlay  < 2   || totalOutlay  > 10000)) {
    res.status(400).json({ error: "totalOutlay must be between £2 and £10,000" }); return;
  }
  if (topPct !== undefined && (topPct <= 0 || topPct > 1)) {
    res.status(400).json({ error: "topPct must be between 0 and 1 (e.g. 0.4 for 40%)" }); return;
  }
  if (minFavPrice !== undefined && (minFavPrice < 1.01 || minFavPrice > 20)) {
    res.status(400).json({ error: "minFavPrice must be between 1.01 and 20" }); return;
  }
  if (minLiquidity !== undefined && (minLiquidity < 0 || minLiquidity > 1_000_000)) {
    res.status(400).json({ error: "minLiquidity must be between 0 and 1,000,000" }); return;
  }
  if (minRunners !== undefined && (minRunners < 2 || minRunners > 20)) {
    res.status(400).json({ error: "minRunners must be between 2 and 20" }); return;
  }
  if (countryCodes !== undefined && countryCodes.length === 0) {
    res.status(400).json({ error: "At least one country code is required" }); return;
  }

  const patch: Parameters<typeof setDutchConfig>[0] = {};
  if (totalOutlay  !== undefined) patch.totalOutlay  = totalOutlay;
  if (topPct       !== undefined) patch.topPct       = topPct;
  if (minFavPrice  !== undefined) patch.minFavPrice  = minFavPrice;
  if (minLiquidity !== undefined) patch.minLiquidity = minLiquidity;
  if (minRunners   !== undefined) patch.minRunners   = minRunners;
  if (countryCodes !== undefined) patch.countryCodes = countryCodes;
  setDutchConfig(patch);
  await saveDutchConfigToDb();
  res.json({ dutchConfig: getDutchConfig() });
});

router.get("/dutch/races", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      marketId:    betsTable.marketId,
      marketName:  betsTable.marketName,
      eventName:   betsTable.eventName,
      placedAt:    sql<string>`min(${betsTable.placedAt})`,
      betCount:    sql<number>`count(*)::int`,
      totalStaked: sql<number>`sum(${betsTable.stakeAmount}::float)`,
      netProfit:   sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
      settled:     sql<boolean>`bool_and(${betsTable.status} in ('WON','LOST','VOID'))`,
      winnerName:  sql<string>`coalesce(
        max(case when ${betsTable.status} = 'WON' then ${betsTable.selectionName} end),
        max(case when ${betsTable.aiReasoning} like '%||WINNER:%'
            then split_part(split_part(${betsTable.aiReasoning}, '||WINNER:', 2), '||', 1)
            end)
      )`,
    })
    .from(betsTable)
    .where(DUTCH_FILTER)
    .groupBy(betsTable.marketId, betsTable.marketName, betsTable.eventName)
    .orderBy(desc(sql`min(${betsTable.placedAt})`))
    .limit(50);

  res.json(
    rows.map(r => ({
      marketId:    r.marketId,
      marketName:  r.marketName,
      eventName:   r.eventName,
      placedAt:    r.placedAt,
      betCount:    r.betCount,
      totalStaked: Math.round(Number(r.totalStaked) * 100) / 100,
      netProfit:   Math.round(Number(r.netProfit)   * 100) / 100,
      settled:     r.settled,
      winnerName:  r.winnerName ?? null,
    })),
  );
});

router.get("/dutch/race/:marketId", async (req, res): Promise<void> => {
  const { marketId } = req.params;
  const bets = await db
    .select()
    .from(betsTable)
    .where(sql`${betsTable.marketId} = ${marketId} AND ${DUTCH_FILTER}`)
    .orderBy(desc(betsTable.stakeAmount));

  const totalStaked = bets.reduce((s, b) => s + Number(b.stakeAmount), 0);

  // Extract full field snapshot and actual winner from aiReasoning
  type FieldRunner = { selectionId: number; name: string; odds: number | null };
  let fullField: FieldRunner[] | null = null;
  let actualWinner: string | null = null;
  for (const b of bets) {
    const raw = b.aiReasoning ?? "";
    if (!fullField) {
      const fi = raw.indexOf("||FIELD:");
      if (fi !== -1) {
        try { fullField = JSON.parse(raw.slice(fi + 8).split("||")[0]) as FieldRunner[]; } catch { /* ignore */ }
      }
    }
    if (!actualWinner) {
      const wi = raw.indexOf("||WINNER:");
      if (wi !== -1) actualWinner = raw.slice(wi + 9).split("||")[0].trim() || null;
    }
    if (fullField && actualWinner) break;
  }

  // Live Betfair fallback: if race is settled but we have no winner stored, ask Betfair now
  // and backfill the DB so subsequent loads are instant
  const isSettled = bets.some(b => ["WON", "LOST", "VOID"].includes(b.status));
  if (!actualWinner && isSettled) {
    try {
      const settlement = await getMarketSettlement(marketId);
      if (settlement?.settled && settlement.winnerSelectionId != null) {
        const winId = settlement.winnerSelectionId;
        // Resolve name from fullField first, then from our own bets
        actualWinner =
          fullField?.find(r => r.selectionId === winId)?.name ??
          bets.find(b => b.selectionId === winId)?.selectionName ??
          null;
        // Backfill ||WINNER: tag into every bet for this market so we don't need Betfair again
        if (actualWinner) {
          const tag = `||WINNER:${actualWinner}`;
          for (const bet of bets) {
            const base = (bet.aiReasoning ?? "").replace(/\|\|WINNER:[^|]*$/, "");
            await db.update(betsTable)
              .set({ aiReasoning: base + tag })
              .where(eq(betsTable.id, bet.id));
          }
        }
      }
    } catch { /* non-fatal — we'll try again next load */ }
  }

  res.json({
    fullField,
    actualWinner,
    bets: bets.map(b => {
      const odds  = Number(b.requestedOdds);
      const stake = Number(b.stakeAmount);
      const netIfWins = Math.round((stake * (odds - 1) - (totalStaked - stake)) * 100) / 100;
      return {
        id:            b.id,
        selectionId:   b.selectionId,
        selectionName: b.selectionName,
        backOdds:      odds,
        stakeAmount:   stake,
        netIfWins,
        potentialProfit: b.potentialProfit !== null ? Number(b.potentialProfit) : null,
        actualProfit:    b.actualProfit    !== null ? Number(b.actualProfit)    : null,
        status:          b.status,
        placedAt:        b.placedAt.toISOString(),
      };
    }),
  });
});

router.get("/dutch/logs", async (req, res): Promise<void> => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
  res.setHeader("Cache-Control", "no-store");
  const logs = await db
    .select()
    .from(botLogsTable)
    .where(sql`${botLogsTable.message} LIKE '[DUTCH]%'`)
    .orderBy(desc(botLogsTable.createdAt))
    .limit(limit);
  res.json(
    logs.map(l => ({
      id:        l.id,
      level:     l.level,
      message:   l.message.replace(/^\[DUTCH\]\s*/, ""),
      createdAt: l.createdAt.toISOString(),
    })),
  );
});

export default router;
