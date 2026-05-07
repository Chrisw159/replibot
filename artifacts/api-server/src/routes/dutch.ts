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
      winnerName:  sql<string>`max(case when ${betsTable.status} = 'WON' then ${betsTable.selectionName} end)`,
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

  // Extract full field snapshot stored in aiReasoning of any bet (||FIELD:[...])
  type FieldRunner = { selectionId: number; name: string; odds: number | null };
  let fullField: FieldRunner[] | null = null;
  for (const b of bets) {
    const raw = b.aiReasoning ?? "";
    const idx = raw.indexOf("||FIELD:");
    if (idx !== -1) {
      try { fullField = JSON.parse(raw.slice(idx + 8)) as FieldRunner[]; } catch { /* ignore */ }
      if (fullField) break;
    }
  }

  res.json({
    fullField,
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
