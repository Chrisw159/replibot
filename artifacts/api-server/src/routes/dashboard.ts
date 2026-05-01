import { Router, type IRouter } from "express";
import { desc, eq, gte, and, sql } from "drizzle-orm";
import { db, betsTable, strategiesTable } from "@workspace/db";
import {
  GetPnlChartQueryParams,
  GetDashboardSummaryResponse,
  GetPnlChartResponse,
  GetRecentBetsResponse,
  GetStrategyPerformanceResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [overall, today, strategies] = await Promise.all([
    db
      .select({
        totalBets: sql<number>`count(*)`,
        winningBets: sql<number>`count(*) filter (where status = 'WON')`,
        losingBets: sql<number>`count(*) filter (where status = 'LOST')`,
        pendingBets: sql<number>`count(*) filter (where status in ('PLACED', 'MATCHED'))`,
        totalStaked: sql<number>`coalesce(sum(stake_amount), 0)`,
        totalProfit: sql<number>`coalesce(sum(actual_profit), 0)`,
      })
      .from(betsTable),
    db
      .select({
        betsToday: sql<number>`count(*)`,
        profitToday: sql<number>`coalesce(sum(actual_profit), 0)`,
      })
      .from(betsTable)
      .where(gte(betsTable.placedAt, todayStart)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(strategiesTable)
      .where(eq(strategiesTable.isActive, true)),
  ]);

  const o = overall[0];
  const t = today[0];

  const totalBets = Number(o?.totalBets ?? 0);
  const winningBets = Number(o?.winningBets ?? 0);
  const totalStaked = Number(o?.totalStaked ?? 0);
  const totalProfit = Number(o?.totalProfit ?? 0);

  const winRate = totalBets > 0 ? (winningBets / totalBets) * 100 : 0;
  const roi = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;

  res.json(
    GetDashboardSummaryResponse.parse({
      totalBets,
      winningBets,
      losingBets: Number(o?.losingBets ?? 0),
      pendingBets: Number(o?.pendingBets ?? 0),
      totalStaked: Math.round(totalStaked * 100) / 100,
      totalProfit: Math.round(totalProfit * 100) / 100,
      winRate: Math.round(winRate * 10) / 10,
      roi: Math.round(roi * 10) / 10,
      profitToday: Math.round(Number(t?.profitToday ?? 0) * 100) / 100,
      betsToday: Number(t?.betsToday ?? 0),
      activeStrategies: Number(strategies[0]?.count ?? 0),
    })
  );
});

router.get("/dashboard/pnl-chart", async (req, res): Promise<void> => {
  const parsed = GetPnlChartQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const days = parsed.data.days ?? 30;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const data = await db
    .select({
      date: sql<string>`date(placed_at)::text`,
      dailyProfit: sql<number>`coalesce(sum(actual_profit), 0)`,
      bets: sql<number>`count(*)`,
    })
    .from(betsTable)
    .where(gte(betsTable.placedAt, since))
    .groupBy(sql`date(placed_at)`)
    .orderBy(sql`date(placed_at)`);

  let cumulative = 0;
  const result = data.map((row) => {
    cumulative += Number(row.dailyProfit);
    return {
      date: row.date,
      profit: Math.round(Number(row.dailyProfit) * 100) / 100,
      cumulativeProfit: Math.round(cumulative * 100) / 100,
      bets: Number(row.bets),
    };
  });

  res.json(GetPnlChartResponse.parse(result));
});

router.get("/dashboard/recent-bets", async (_req, res): Promise<void> => {
  // Return race-level summaries instead of individual bets
  const races = await db
    .select({
      marketId: betsTable.marketId,
      marketName: betsTable.marketName,
      eventName: betsTable.eventName,
      strategyName: betsTable.strategyName,
      placedAt: sql<string>`min(${betsTable.placedAt})`.as("placed_at"),
      runnersBackedCount: sql<number>`count(*)::int`.as("runners_backed"),
      totalStaked: sql<number>`sum(${betsTable.stakeAmount})::float`.as("total_staked"),
      netProfit: sql<number>`sum(${betsTable.actualProfit})::float`.as("net_profit"),
      settled: sql<boolean>`bool_and(${betsTable.status} in ('WON','LOST','SETTLED'))`.as("settled"),
      hasWinner: sql<boolean>`bool_or(${betsTable.status} = 'WON')`.as("has_winner"),
      winnerName: sql<string>`max(case when ${betsTable.status} = 'WON' then ${betsTable.selectionName} end)`.as("winner_name"),
    })
    .from(betsTable)
    .groupBy(betsTable.marketId, betsTable.marketName, betsTable.eventName, betsTable.strategyName)
    .orderBy(desc(sql`min(${betsTable.placedAt})`))
    .limit(10);

  res.json(races.map(r => ({
    marketId: r.marketId,
    marketName: r.marketName,
    eventName: r.eventName,
    strategyName: r.strategyName ?? null,
    placedAt: r.placedAt,
    runnersBackedCount: r.runnersBackedCount,
    totalStaked: Math.round(Number(r.totalStaked) * 100) / 100,
    netProfit: r.netProfit != null ? Math.round(Number(r.netProfit) * 100) / 100 : null,
    settled: r.settled,
    hasWinner: r.hasWinner,
    winnerName: r.winnerName ?? null,
  })));
});

router.get("/dashboard/strategy-performance", async (_req, res): Promise<void> => {
  const data = await db
    .select({
      strategyId: betsTable.strategyId,
      strategyName: betsTable.strategyName,
      totalBets: sql<number>`count(*)`,
      winningBets: sql<number>`count(*) filter (where status = 'WON')`,
      totalStaked: sql<number>`coalesce(sum(stake_amount), 0)`,
      totalProfit: sql<number>`coalesce(sum(actual_profit), 0)`,
    })
    .from(betsTable)
    .groupBy(betsTable.strategyId, betsTable.strategyName);

  const result = data.map((row) => {
    const totalBets = Number(row.totalBets);
    const winningBets = Number(row.winningBets);
    const totalStaked = Number(row.totalStaked);
    const totalProfit = Number(row.totalProfit);
    const winRate = totalBets > 0 ? (winningBets / totalBets) * 100 : 0;
    const roi = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;

    return {
      strategyId: row.strategyId ?? 0,
      strategyName: row.strategyName ?? "Unknown",
      totalBets,
      winningBets,
      winRate: Math.round(winRate * 10) / 10,
      totalStaked: Math.round(totalStaked * 100) / 100,
      totalProfit: Math.round(totalProfit * 100) / 100,
      roi: Math.round(roi * 10) / 10,
    };
  });

  res.json(GetStrategyPerformanceResponse.parse(result));
});

export default router;
