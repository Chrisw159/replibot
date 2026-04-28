import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, betsTable } from "@workspace/db";
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
