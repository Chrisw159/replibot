import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import { db, betsTable, raceRunnersTable } from "@workspace/db";
import {
  ListBetsQueryParams,
  GetBetParams,
  ListBetsResponse,
  GetBetResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function mapBet(b: typeof betsTable.$inferSelect) {
  return {
    id: b.id,
    betId: b.betId ?? null,
    strategyId: b.strategyId ?? null,
    strategyName: b.strategyName ?? null,
    marketId: b.marketId,
    marketName: b.marketName,
    eventName: b.eventName,
    selectionId: b.selectionId,
    selectionName: b.selectionName,
    betType: b.betType,
    requestedOdds: Number(b.requestedOdds),
    matchedOdds: b.matchedOdds !== null ? Number(b.matchedOdds) : null,
    stakeAmount: Number(b.stakeAmount),
    potentialProfit: Number(b.potentialProfit),
    actualProfit: b.actualProfit !== null ? Number(b.actualProfit) : null,
    status: b.status,
    aiReasoning: b.aiReasoning ?? null,
    placedAt: b.placedAt.toISOString(),
    settledAt: b.settledAt ? b.settledAt.toISOString() : null,
  };
}

router.get("/bets", async (req, res): Promise<void> => {
  const parsed = ListBetsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let query = db.select().from(betsTable).$dynamic();

  if (parsed.data.status) {
    query = query.where(eq(betsTable.status, parsed.data.status));
  }

  if (parsed.data.strategyId) {
    query = query.where(eq(betsTable.strategyId, Number(parsed.data.strategyId)));
  }

  const bets = await query.orderBy(desc(betsTable.placedAt)).limit(parsed.data.limit ?? 50);
  res.json(ListBetsResponse.parse(bets.map(mapBet)));
});

router.get("/bets/races", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      marketId: betsTable.marketId,
      marketName: betsTable.marketName,
      eventName: betsTable.eventName,
      placedAt: sql<string>`min(${betsTable.placedAt})`.as("placed_at"),
      betCount: sql<number>`count(*)::int`.as("bet_count"),
      totalStaked: sql<number>`sum(${betsTable.stakeAmount})::float`.as("total_staked"),
      totalProfit: sql<number>`sum(${betsTable.actualProfit})::float`.as("total_profit"),
      settled: sql<boolean>`bool_and(${betsTable.status} in ('WON','LOST','SETTLED'))`.as("settled"),
    })
    .from(betsTable)
    .groupBy(betsTable.marketId, betsTable.marketName, betsTable.eventName)
    .orderBy(desc(sql`min(${betsTable.placedAt})`))
    .limit(100);

  res.json(rows);
});

router.get("/bets/race/:marketId", async (req, res): Promise<void> => {
  const { marketId } = req.params;
  const bets = await db
    .select()
    .from(betsTable)
    .where(eq(betsTable.marketId, marketId))
    .orderBy(desc(betsTable.placedAt));

  res.json(bets.map(mapBet));
});

router.get("/bets/race/:marketId/runners", async (req, res): Promise<void> => {
  const { marketId } = req.params;
  const runners = await db
    .select()
    .from(raceRunnersTable)
    .where(eq(raceRunnersTable.marketId, marketId))
    .orderBy(raceRunnersTable.bestBackPrice);

  res.json(runners.map(r => ({
    id: r.id,
    selectionId: r.selectionId,
    runnerName: r.runnerName,
    bestBackPrice: r.bestBackPrice != null ? Number(r.bestBackPrice) : null,
    status: r.status,
    included: r.included,
    excludeReason: r.excludeReason,
    recordedAt: r.recordedAt.toISOString(),
  })));
});

router.get("/bets/:id", async (req, res): Promise<void> => {
  const params = GetBetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [bet] = await db
    .select()
    .from(betsTable)
    .where(eq(betsTable.id, params.data.id));

  if (!bet) {
    res.status(404).json({ error: "Bet not found" });
    return;
  }

  res.json(GetBetResponse.parse(mapBet(bet)));
});

export default router;
