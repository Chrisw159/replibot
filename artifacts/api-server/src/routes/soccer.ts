import { Router, type IRouter } from "express";
import { desc, eq, like, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { soccerConfigTable, soccerTradesTable, botLogsTable } from "@workspace/db/schema";
import {
  getSoccerConfig,
  startSoccerBot,
  stopSoccerBot,
  isSoccerBotRunning,
  getSoccerBotStartedAt,
  getSoccerLastCycleAt,
  getSoccerCandidatesSnapshot,
  getWatchedGameCount,
} from "../lib/soccerEngine";
import { getSession } from "../lib/betfair";

const router: IRouter = Router();
const num = (v: string | number | null | undefined) => Number(v ?? 0);

function serializeConfig(c: Awaited<ReturnType<typeof getSoccerConfig>>) {
  return {
    id: c.id,
    isRunning: isSoccerBotRunning(),
    stake: num(c.stake),
    minOdds: num(c.minOdds),
    maxOdds: num(c.maxOdds),
    entryMinute: c.entryMinute,
    minGoalGap: c.minGoalGap,
    maxConcurrent: c.maxConcurrent,
    minLiquidity: num(c.minLiquidity),
    checkIntervalSeconds: c.checkIntervalSeconds,
    paperMode: c.paperMode,
    blockReEntryAfterProfit: c.blockReEntryAfterProfit,
    layTargetPct: num(c.layTargetPct),
    updatedAt: c.updatedAt?.toISOString() ?? null,
  };
}

function serializeTrade(t: typeof soccerTradesTable.$inferSelect) {
  return {
    id: t.id,
    eventId: t.eventId,
    eventName: t.eventName,
    competition: t.competition,
    marketId: t.marketId,
    marketName: t.marketName,
    selectionId: t.selectionId,
    selectionName: t.selectionName,
    line: num(t.line),
    bufferLine: t.bufferLine,
    entryScore: t.entryScore,
    entryTotalGoals: t.entryTotalGoals,
    entryMinute: t.entryMinute,
    entryOdds: num(t.entryOdds),
    stake: num(t.stake),
    layPrice: t.layPrice === null ? null : num(t.layPrice),
    layMatchedAt: t.layMatchedAt?.toISOString() ?? null,
    status: t.status,
    exitOdds: t.exitOdds === null ? null : num(t.exitOdds),
    exitReason: t.exitReason,
    profit: t.profit === null ? null : num(t.profit),
    goalAfterEntry: t.goalAfterEntry,
    paper: t.paper,
    placedAt: t.placedAt.toISOString(),
    closedAt: t.closedAt?.toISOString() ?? null,
  };
}

async function statusPayload() {
  const open = await db
    .select({ n: sql<number>`count(*)` })
    .from(soccerTradesTable)
    .where(sql`${soccerTradesTable.status} IN ('OPEN', 'HEDGED')`);
  const today = await db
    .select({
      pnl: sql<string>`coalesce(sum(${soccerTradesTable.profit}), 0)`,
      trades: sql<number>`count(*)`,
    })
    .from(soccerTradesTable)
    .where(sql`${soccerTradesTable.placedAt} >= date_trunc('day', now())`);
  const config = await getSoccerConfig();
  return {
    isRunning: isSoccerBotRunning(),
    startedAt: getSoccerBotStartedAt()?.toISOString() ?? null,
    openTrades: Number(open[0]?.n ?? 0),
    watchedGames: getWatchedGameCount(),
    todayPnl: num(today[0]?.pnl),
    todayTrades: Number(today[0]?.trades ?? 0),
    paperMode: config.paperMode,
    lastCycleAt: getSoccerLastCycleAt()?.toISOString() ?? null,
    betfairConnected: !!getSession(),
  };
}

router.get("/soccer/config", async (_req, res) => {
  res.json(serializeConfig(await getSoccerConfig()));
});

router.patch("/soccer/config", async (req, res) => {
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  const numeric2 = (v: unknown) => Number(v).toFixed(2);
  if (b.stake !== undefined) patch.stake = numeric2(b.stake);
  if (b.minOdds !== undefined) patch.minOdds = numeric2(b.minOdds);
  if (b.maxOdds !== undefined) patch.maxOdds = numeric2(b.maxOdds);
  if (b.entryMinute !== undefined) patch.entryMinute = Math.trunc(Number(b.entryMinute));
  if (b.minGoalGap !== undefined) patch.minGoalGap = Math.trunc(Number(b.minGoalGap));
  if (b.maxConcurrent !== undefined) patch.maxConcurrent = Math.trunc(Number(b.maxConcurrent));
  if (b.minLiquidity !== undefined) patch.minLiquidity = numeric2(b.minLiquidity);
  if (b.checkIntervalSeconds !== undefined)
    patch.checkIntervalSeconds = Math.max(10, Math.trunc(Number(b.checkIntervalSeconds)));
  if (b.paperMode !== undefined) patch.paperMode = Boolean(b.paperMode);
  if (b.blockReEntryAfterProfit !== undefined) patch.blockReEntryAfterProfit = Boolean(b.blockReEntryAfterProfit);
  if (b.layTargetPct !== undefined) {
    const v = Number(b.layTargetPct);
    if (Number.isFinite(v) && v >= 0) patch.layTargetPct = v.toFixed(2);
  }

  const current = await getSoccerConfig();
  if (Object.keys(patch).length > 0) {
    await db.update(soccerConfigTable).set(patch).where(eq(soccerConfigTable.id, current.id));
  }
  res.json(serializeConfig(await getSoccerConfig()));
});

router.post("/soccer/start", async (_req, res) => {
  await startSoccerBot();
  res.json(await statusPayload());
});

router.post("/soccer/stop", async (_req, res) => {
  await stopSoccerBot();
  res.json(await statusPayload());
});

router.get("/soccer/status", async (_req, res) => {
  res.json(await statusPayload());
});

router.get("/soccer/candidates", async (_req, res) => {
  res.json(getSoccerCandidatesSnapshot());
});

router.get("/soccer/trades", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const base = db.select().from(soccerTradesTable);
  const rows =
    status
      ? await base
          .where(eq(soccerTradesTable.status, status))
          .orderBy(desc(soccerTradesTable.placedAt))
          .limit(limit)
      : await base.orderBy(desc(soccerTradesTable.placedAt)).limit(limit);
  res.json(rows.map(serializeTrade));
});

router.get("/soccer/summary", async (_req, res) => {
  const rows = await db.select().from(soccerTradesTable);
  const closed = rows.filter((t) => t.status !== "OPEN" && t.status !== "HEDGED");
  const count = (s: string) => rows.filter((t) => t.status === s).length;
  const totalPnl = closed.reduce((s, t) => s + num(t.profit), 0);
  const totalStaked = closed.reduce((s, t) => s + num(t.stake), 0);
  const winners = closed.filter((t) => num(t.profit) > 0).length;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayClosed = closed.filter((t) => t.closedAt && t.closedAt >= todayStart);
  const todayPnl = todayClosed.reduce((s, t) => s + num(t.profit), 0);

  const byDay = new Map<string, { pnl: number; trades: number }>();
  for (const t of closed) {
    const d = (t.closedAt ?? t.placedAt).toISOString().slice(0, 10);
    const e = byDay.get(d) ?? { pnl: 0, trades: 0 };
    e.pnl += num(t.profit);
    e.trades += 1;
    byDay.set(d, e);
  }

  res.json({
    totalTrades: rows.length,
    openTrades: count("OPEN") + count("HEDGED"),
    settledWon: count("SETTLED_WON"),
    settledLost: count("SETTLED_LOST"),
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalStaked: Math.round(totalStaked * 100) / 100,
    roiPct: totalStaked > 0 ? Math.round((totalPnl / totalStaked) * 10000) / 100 : 0,
    todayPnl: Math.round(todayPnl * 100) / 100,
    todayTrades: todayClosed.length,
    avgEntryOdds:
      rows.length > 0
        ? Math.round((rows.reduce((s, t) => s + num(t.entryOdds), 0) / rows.length) * 100) / 100
        : 0,
    winRatePct: closed.length > 0 ? Math.round((winners / closed.length) * 10000) / 100 : 0,
    dailyPnl: [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, e]) => ({ date, pnl: Math.round(e.pnl * 100) / 100, trades: e.trades })),
  });
});

router.get("/soccer/logs", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const rows = await db
    .select()
    .from(botLogsTable)
    .where(like(botLogsTable.message, "[SOCCER]%"))
    .orderBy(desc(botLogsTable.createdAt))
    .limit(limit);
  res.json(
    rows.map((r) => ({
      id: r.id,
      level: r.level,
      message: r.message.replace(/^\[SOCCER\]\s*/, ""),
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

export default router;
