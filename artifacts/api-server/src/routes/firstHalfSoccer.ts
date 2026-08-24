import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { firstHalfSoccerConfigTable, soccerTradesTable } from "@workspace/db/schema";
import {
  getFirstHalfSoccerConfig,
  getFirstHalfCandidatesSnapshot,
  getFirstHalfLastCycleAt,
  getFirstHalfSoccerBotStartedAt,
  getFirstHalfWatchedGameCount,
  isFirstHalfSoccerBotRunning,
  startFirstHalfSoccerBot,
  stopFirstHalfSoccerBot,
} from "../lib/firstHalfSoccerEngine";
import { getSession } from "../lib/betfair";

const router: IRouter = Router();
const STRATEGY = "FIRST_HALF_LAY_LOCK";
const num = (value: string | number | null | undefined) => Number(value ?? 0);

function serializeConfig(config: Awaited<ReturnType<typeof getFirstHalfSoccerConfig>>) {
  return {
    id: config.id,
    isRunning: isFirstHalfSoccerBotRunning(),
    stake: num(config.stake),
    minOdds: num(config.minOdds),
    entryMinute: config.entryMinute,
    minGoalGap: config.minGoalGap,
    maxConcurrent: config.maxConcurrent,
    minLiquidity: num(config.minLiquidity),
    checkIntervalSeconds: config.checkIntervalSeconds,
    paperMode: true,
    layTargetPct: num(config.layTargetPct),
    updatedAt: config.updatedAt?.toISOString() ?? null,
  };
}

function serializeTrade(trade: typeof soccerTradesTable.$inferSelect) {
  return {
    id: trade.id, eventId: trade.eventId, eventName: trade.eventName, competition: trade.competition,
    marketId: trade.marketId, marketName: trade.marketName, selectionId: trade.selectionId,
    selectionName: trade.selectionName, line: num(trade.line), bufferLine: false,
    entryScore: trade.entryScore, entryTotalGoals: trade.entryTotalGoals, entryMinute: trade.entryMinute,
    entryOdds: num(trade.entryOdds), stake: num(trade.stake), layPrice: trade.layPrice === null ? null : num(trade.layPrice),
    layMatchedAt: trade.layMatchedAt?.toISOString() ?? null, status: trade.status,
    exitOdds: trade.exitOdds === null ? null : num(trade.exitOdds), exitReason: trade.exitReason,
    profit: trade.profit === null ? null : num(trade.profit), goalAfterEntry: trade.goalAfterEntry,
    paper: true, placedAt: trade.placedAt.toISOString(), closedAt: trade.closedAt?.toISOString() ?? null,
  };
}

async function statusPayload() {
  const [open] = await db.select({ count: sql<number>`count(*)` }).from(soccerTradesTable)
    .where(and(eq(soccerTradesTable.strategy, STRATEGY), inArray(soccerTradesTable.status, ["OPEN", "HEDGED"])));
  const [today] = await db.select({
    pnl: sql<string>`coalesce(sum(${soccerTradesTable.profit}), 0)`,
    trades: sql<number>`count(*)`,
  }).from(soccerTradesTable).where(and(
    eq(soccerTradesTable.strategy, STRATEGY),
    sql`${soccerTradesTable.placedAt} >= date_trunc('day', now())`,
  ));
  return {
    isRunning: isFirstHalfSoccerBotRunning(),
    startedAt: getFirstHalfSoccerBotStartedAt()?.toISOString() ?? null,
    openTrades: Number(open?.count ?? 0),
    watchedGames: getFirstHalfWatchedGameCount(),
    todayPnl: num(today?.pnl),
    todayTrades: Number(today?.trades ?? 0),
    paperMode: true,
    lastCycleAt: getFirstHalfLastCycleAt()?.toISOString() ?? null,
    betfairConnected: !!getSession(),
  };
}

router.get("/first-half-soccer/config", async (_req, res) => res.json(serializeConfig(await getFirstHalfSoccerConfig())));

router.patch("/first-half-soccer/config", async (req, res) => {
  const body = req.body ?? {};
  const patch: Record<string, unknown> = { paperMode: true };
  const numeric = (value: unknown) => Number(value).toFixed(2);
  if (body.stake !== undefined) patch.stake = numeric(body.stake);
  if (body.minOdds !== undefined) patch.minOdds = numeric(body.minOdds);
  if (body.entryMinute !== undefined) patch.entryMinute = Math.max(35, Math.min(45, Math.trunc(Number(body.entryMinute))));
  if (body.minGoalGap !== undefined) patch.minGoalGap = Math.max(2, Math.trunc(Number(body.minGoalGap)));
  if (body.maxConcurrent !== undefined) patch.maxConcurrent = Math.max(1, Math.min(40, Math.trunc(Number(body.maxConcurrent))));
  if (body.minLiquidity !== undefined) patch.minLiquidity = numeric(body.minLiquidity);
  if (body.checkIntervalSeconds !== undefined) patch.checkIntervalSeconds = Math.max(5, Math.trunc(Number(body.checkIntervalSeconds)));
  if (body.layTargetPct !== undefined) {
    const target = Number(body.layTargetPct);
    if (Number.isFinite(target) && target >= 0) patch.layTargetPct = target.toFixed(2);
  }
  const config = await getFirstHalfSoccerConfig();
  await db.update(firstHalfSoccerConfigTable).set(patch).where(eq(firstHalfSoccerConfigTable.id, config.id));
  res.json(serializeConfig(await getFirstHalfSoccerConfig()));
});

router.post("/first-half-soccer/start", async (_req, res) => {
  try {
    await startFirstHalfSoccerBot();
    res.json(await statusPayload());
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to start first-half bot" });
  }
});
router.post("/first-half-soccer/stop", async (_req, res) => {
  await stopFirstHalfSoccerBot();
  res.json(await statusPayload());
});
router.get("/first-half-soccer/status", async (_req, res) => res.json(await statusPayload()));
router.get("/first-half-soccer/candidates", (_req, res) => res.json(getFirstHalfCandidatesSnapshot()));

router.get("/first-half-soccer/trades", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const conditions = [eq(soccerTradesTable.strategy, STRATEGY)];
  if (status) conditions.push(eq(soccerTradesTable.status, status));
  const rows = await db.select().from(soccerTradesTable).where(and(...conditions))
    .orderBy(desc(soccerTradesTable.placedAt)).limit(limit);
  res.json(rows.map(serializeTrade));
});

router.get("/first-half-soccer/summary", async (_req, res) => {
  const rows = await db.select().from(soccerTradesTable).where(eq(soccerTradesTable.strategy, STRATEGY));
  const closed = rows.filter((trade) => !["OPEN", "HEDGED"].includes(trade.status));
  const settled = closed.filter((trade) => trade.status.startsWith("SETTLED_"));
  const count = (status: string) => rows.filter((trade) => trade.status === status).length;
  const totalPnl = closed.reduce((total, trade) => total + num(trade.profit), 0);
  const totalStaked = closed.reduce((total, trade) => total + num(trade.stake), 0);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayClosed = closed.filter((trade) => trade.closedAt && trade.closedAt >= todayStart);
  const byDay = new Map<string, { pnl: number; trades: number }>();
  for (const trade of closed) {
    const date = (trade.closedAt ?? trade.placedAt).toISOString().slice(0, 10);
    const current = byDay.get(date) ?? { pnl: 0, trades: 0 };
    current.pnl += num(trade.profit); current.trades += 1; byDay.set(date, current);
  }
  const profitCents = (trade: typeof rows[number]) => Math.round(num(trade.profit) * 100);
  const winners = settled.filter((trade) => profitCents(trade) > 0).length;
  const breakEvens = settled.filter((trade) => profitCents(trade) === 0).length;
  const losers = settled.filter((trade) => profitCents(trade) < 0).length;
  const settledCount = settled.length;
  res.json({
    totalTrades: rows.length, openTrades: count("OPEN") + count("HEDGED"),
    settledWon: winners, settledBreakEven: breakEvens, settledLost: losers,
    totalPnl: Math.round(totalPnl * 100) / 100, totalStaked: Math.round(totalStaked * 100) / 100,
    roiPct: totalStaked ? Math.round(totalPnl / totalStaked * 10000) / 100 : 0,
    todayPnl: Math.round(todayClosed.reduce((total, trade) => total + num(trade.profit), 0) * 100) / 100,
    todayTrades: todayClosed.length,
    avgEntryOdds: rows.length ? Math.round(rows.reduce((total, trade) => total + num(trade.entryOdds), 0) / rows.length * 100) / 100 : 0,
    winRatePct: settledCount ? Math.round(winners / settledCount * 10000) / 100 : 0,
    breakEvenRatePct: settledCount ? Math.round(breakEvens / settledCount * 10000) / 100 : 0,
    lossRatePct: settledCount ? Math.round(losers / settledCount * 10000) / 100 : 0,
    dailyPnl: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, pnl: Math.round(value.pnl * 100) / 100, trades: value.trades })),
  });
});

export default router;