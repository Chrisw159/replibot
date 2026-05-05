import { Router, type IRouter } from "express";
import { sql, desc } from "drizzle-orm";
import { db, betsTable, botConfigTable, botLogsTable } from "@workspace/db";
import {
  startBookieBot,
  stopBookieBot,
  isBookieBotRunning,
  getBookieStartedAt,
  getBookieConfig,
  setBookieConfig,
} from "../lib/bookieEngine";

const router: IRouter = Router();

async function getBookieStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [today] = await db
    .select({
      racesToday: sql<number>`count(distinct ${betsTable.marketId})::int`,
      betsToday: sql<number>`count(*)::int`,
      profitToday: sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
    })
    .from(betsTable)
    .where(
      sql`${betsTable.strategyName} = 'Bookie Bot'
          AND ${betsTable.placedAt} >= ${todayStart}`,
    );

  const [allTime] = await db
    .select({
      totalRaces: sql<number>`count(distinct ${betsTable.marketId})::int`,
      totalNetProfit: sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
    })
    .from(betsTable)
    .where(sql`${betsTable.strategyName} = 'Bookie Bot'`);

  return {
    racesToday: today?.racesToday ?? 0,
    betsToday: today?.betsToday ?? 0,
    profitToday: Math.round((today?.profitToday ?? 0) * 100) / 100,
    totalRaces: allTime?.totalRaces ?? 0,
    totalNetProfit: Math.round((allTime?.totalNetProfit ?? 0) * 100) / 100,
  };
}

router.get("/bookie/status", async (_req, res): Promise<void> => {
  const [config] = await db.select().from(botConfigTable).limit(1);
  const stats = await getBookieStats();
  res.json({
    isRunning: isBookieBotRunning(),
    startedAt: getBookieStartedAt()?.toISOString() ?? null,
    paperTradingMode: config?.paperTradingMode ?? true,
    bookieConfig: getBookieConfig(),
    ...stats,
  });
});

router.post("/bookie/start", async (_req, res): Promise<void> => {
  await startBookieBot();
  const [config] = await db.select().from(botConfigTable).limit(1);
  const stats = await getBookieStats();
  res.json({
    isRunning: true,
    startedAt: getBookieStartedAt()?.toISOString() ?? null,
    paperTradingMode: config?.paperTradingMode ?? true,
    bookieConfig: getBookieConfig(),
    ...stats,
  });
});

router.post("/bookie/stop", async (_req, res): Promise<void> => {
  await stopBookieBot();
  const stats = await getBookieStats();
  res.json({
    isRunning: false,
    startedAt: null,
    bookieConfig: getBookieConfig(),
    ...stats,
  });
});

router.patch("/bookie/config", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;

  const maxRaceNetLoss =
    typeof body.maxRaceNetLoss === "number" ? body.maxRaceNetLoss : undefined;
  const maxRunnerLiability =
    typeof body.maxRunnerLiability === "number" ? body.maxRunnerLiability : undefined;
  const minLiquidity =
    typeof body.minLiquidity === "number" ? body.minLiquidity : undefined;
  const countryCodes = Array.isArray(body.countryCodes)
    ? (body.countryCodes as string[]).map(c => String(c).trim().toUpperCase()).filter(Boolean)
    : undefined;

  if (maxRaceNetLoss !== undefined && (maxRaceNetLoss <= 0 || maxRaceNetLoss > 1000)) {
    res.status(400).json({ error: "maxRaceNetLoss must be between 1 and 1000" });
    return;
  }
  if (maxRunnerLiability !== undefined && (maxRunnerLiability <= 0 || maxRunnerLiability > 5000)) {
    res.status(400).json({ error: "maxRunnerLiability must be between 1 and 5000" });
    return;
  }
  if (minLiquidity !== undefined && (minLiquidity < 0 || minLiquidity > 500000)) {
    res.status(400).json({ error: "minLiquidity must be between 0 and 500000" });
    return;
  }
  if (countryCodes !== undefined && countryCodes.length === 0) {
    res.status(400).json({ error: "At least one country code is required" });
    return;
  }

  setBookieConfig({ maxRaceNetLoss, maxRunnerLiability, minLiquidity, countryCodes });
  res.json({ bookieConfig: getBookieConfig() });
});

router.get("/bookie/logs", async (req, res): Promise<void> => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
  res.setHeader("Cache-Control", "no-store");
  const logs = await db
    .select()
    .from(botLogsTable)
    .where(sql`${botLogsTable.message} LIKE '[BOOKIE]%'`)
    .orderBy(desc(botLogsTable.createdAt))
    .limit(limit);
  res.json(
    logs.map(l => ({
      id: l.id,
      level: l.level,
      message: l.message.replace(/^\[BOOKIE\] /, ""),
      metadata: l.metadata ?? null,
      createdAt: l.createdAt.toISOString(),
    }))
  );
});

router.get("/bookie/races", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      marketId: betsTable.marketId,
      marketName: betsTable.marketName,
      eventName: betsTable.eventName,
      placedAt: sql<string>`min(${betsTable.placedAt})`,
      betCount: sql<number>`count(*)::int`,
      totalStaked: sql<number>`sum(${betsTable.stakeAmount})::float`,
      totalCollected: sql<number>`coalesce(sum(case when ${betsTable.status} = 'WON' then ${betsTable.stakeAmount} else 0 end), 0)::float`,
      totalPaidOut: sql<number>`coalesce(sum(case when ${betsTable.status} = 'LOST' then abs(${betsTable.actualProfit}) else 0 end), 0)::float`,
      netProfit: sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
      settled: sql<boolean>`bool_and(${betsTable.status} in ('WON','LOST','VOID'))`,
    })
    .from(betsTable)
    .where(sql`${betsTable.strategyName} = 'Bookie Bot'`)
    .groupBy(betsTable.marketId, betsTable.marketName, betsTable.eventName)
    .orderBy(desc(sql`min(${betsTable.placedAt})`))
    .limit(50);

  res.json(rows);
});

router.get("/bookie/race/:marketId", async (req, res): Promise<void> => {
  const { marketId } = req.params;
  const bets = await db
    .select()
    .from(betsTable)
    .where(
      sql`${betsTable.marketId} = ${marketId}
          AND ${betsTable.strategyName} = 'Bookie Bot'`,
    )
    .orderBy(desc(betsTable.stakeAmount));

  res.json(
    bets.map(b => ({
      id: b.id,
      selectionName: b.selectionName,
      betType: b.betType,
      requestedOdds: Number(b.requestedOdds),
      stakeAmount: Number(b.stakeAmount),
      liability: Math.round(Number(b.stakeAmount) * (Number(b.requestedOdds) - 1) * 100) / 100,
      actualProfit: b.actualProfit !== null ? Number(b.actualProfit) : null,
      status: b.status,
      aiReasoning: b.aiReasoning,
      placedAt: b.placedAt.toISOString(),
    })),
  );
});

export default router;
