import { Router, type IRouter } from "express";
import { sql, desc } from "drizzle-orm";
import { db, betsTable, botLogsTable } from "@workspace/db";

const router: IRouter = Router();

const DUTCH_FILTER = sql`${betsTable.aiReasoning} LIKE '[DUTCH]%'`;

async function getDutchStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [today] = await db
    .select({
      racesToday: sql<number>`count(distinct ${betsTable.marketId})::int`,
      betsToday: sql<number>`count(*)::int`,
      profitToday: sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
    })
    .from(betsTable)
    .where(sql`${DUTCH_FILTER} AND ${betsTable.placedAt} >= ${todayStart}`);

  const [allTime] = await db
    .select({
      totalRaces: sql<number>`count(distinct ${betsTable.marketId})::int`,
      totalNetProfit: sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
    })
    .from(betsTable)
    .where(DUTCH_FILTER);

  return {
    racesToday: today?.racesToday ?? 0,
    betsToday: today?.betsToday ?? 0,
    profitToday: Math.round((today?.profitToday ?? 0) * 100) / 100,
    totalRaces: allTime?.totalRaces ?? 0,
    totalNetProfit: Math.round((allTime?.totalNetProfit ?? 0) * 100) / 100,
  };
}

router.get("/dutch/status", async (_req, res): Promise<void> => {
  const stats = await getDutchStats();
  res.json(stats);
});

router.get("/dutch/races", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      marketId: betsTable.marketId,
      marketName: betsTable.marketName,
      eventName: betsTable.eventName,
      strategyName: betsTable.strategyName,
      placedAt: sql<string>`min(${betsTable.placedAt})`,
      betCount: sql<number>`count(*)::int`,
      totalStaked: sql<number>`sum(${betsTable.stakeAmount})::float`,
      netProfit: sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
      settled: sql<boolean>`bool_and(${betsTable.status} in ('WON','LOST','VOID'))`,
      winnerName: sql<string>`max(case when ${betsTable.status} = 'WON' then ${betsTable.selectionName} end)`,
    })
    .from(betsTable)
    .where(DUTCH_FILTER)
    .groupBy(betsTable.marketId, betsTable.marketName, betsTable.eventName, betsTable.strategyName)
    .orderBy(desc(sql`min(${betsTable.placedAt})`))
    .limit(50);

  res.json(
    rows.map(r => ({
      marketId: r.marketId,
      marketName: r.marketName,
      eventName: r.eventName,
      strategyName: r.strategyName ?? null,
      placedAt: r.placedAt,
      betCount: r.betCount,
      totalStaked: Math.round(Number(r.totalStaked) * 100) / 100,
      netProfit: Math.round(Number(r.netProfit) * 100) / 100,
      settled: r.settled,
      winnerName: r.winnerName ?? null,
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

  res.json(
    bets.map(b => ({
      id: b.id,
      selectionName: b.selectionName,
      requestedOdds: Number(b.requestedOdds),
      stakeAmount: Number(b.stakeAmount),
      potentialProfit: b.potentialProfit !== null ? Number(b.potentialProfit) : null,
      actualProfit: b.actualProfit !== null ? Number(b.actualProfit) : null,
      status: b.status,
      aiReasoning: b.aiReasoning,
      placedAt: b.placedAt.toISOString(),
    })),
  );
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
      id: l.id,
      level: l.level,
      message: l.message.replace(/^\[DUTCH\]\s*/, ""),
      metadata: l.metadata ?? null,
      createdAt: l.createdAt.toISOString(),
    })),
  );
});

export default router;
