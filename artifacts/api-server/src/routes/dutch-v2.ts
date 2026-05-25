import { Router, type IRouter } from "express";
import { sql, desc } from "drizzle-orm";
import { db, betsTable, botLogsTable } from "@workspace/db";
import { getV2Variant, listV2Variants } from "../lib/dutchV2Engine";

const router: IRouter = Router();

async function getV2Stats(strategyName: string) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const FILTER = sql`${betsTable.strategyName} = ${strategyName}`;

  const [today] = await db
    .select({
      racesToday:  sql<number>`count(distinct ${betsTable.marketId})::int`,
      betsToday:   sql<number>`count(*)::int`,
      profitToday: sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
    })
    .from(betsTable)
    .where(sql`${FILTER} AND ${betsTable.placedAt} >= ${todayStart}`);

  const [allTime] = await db
    .select({
      totalRaces:     sql<number>`count(distinct ${betsTable.marketId})::int`,
      totalNetProfit: sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
      totalBets:      sql<number>`count(*)::int`,
    })
    .from(betsTable)
    .where(FILTER);

  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    racesToday:     today?.racesToday  ?? 0,
    betsToday:      today?.betsToday   ?? 0,
    profitToday:    round2(today?.profitToday    ?? 0),
    totalRaces:     allTime?.totalRaces ?? 0,
    totalBets:      allTime?.totalBets  ?? 0,
    totalNetProfit: round2(allTime?.totalNetProfit ?? 0),
  };
}

router.get("/dutch-v2/list", (_req, res): void => {
  res.json(
    listV2Variants().map(v => {
      const c = v.getConfig();
      return { id: c.id, label: c.label, totalOutlay: c.totalOutlay, profitLockGBP: c.profitLockGBP, lossStopGBP: c.lossStopGBP };
    }),
  );
});

router.get("/dutch-v2/:variant/status", async (req, res): Promise<void> => {
  const v = getV2Variant(req.params.variant);
  if (!v) { res.status(404).json({ error: "unknown variant" }); return; }
  const cfg = v.getConfig();
  const stats = await getV2Stats(cfg.strategyName);
  const locks = await v.getLockStatus();
  res.json({
    id: cfg.id,
    label: cfg.label,
    isRunning: v.isRunning(),
    startedAt: v.getStartedAt()?.toISOString() ?? null,
    config: cfg,
    ...stats,
    dailyProfitLock: locks.profitLock,
    dailyLossStop:   locks.lossStop,
  });
});

router.post("/dutch-v2/:variant/start", async (req, res): Promise<void> => {
  const v = getV2Variant(req.params.variant);
  if (!v) { res.status(404).json({ error: "unknown variant" }); return; }
  await v.start();
  res.json({ id: v.getConfig().id, isRunning: v.isRunning() });
});

router.post("/dutch-v2/:variant/stop", async (req, res): Promise<void> => {
  const v = getV2Variant(req.params.variant);
  if (!v) { res.status(404).json({ error: "unknown variant" }); return; }
  await v.stop();
  res.json({ id: v.getConfig().id, isRunning: v.isRunning() });
});

router.get("/dutch-v2/:variant/races", async (req, res): Promise<void> => {
  const v = getV2Variant(req.params.variant);
  if (!v) { res.status(404).json({ error: "unknown variant" }); return; }
  const strategyName = v.getConfig().strategyName;
  const rows = await db
    .select({
      marketId:    betsTable.marketId,
      marketName:  betsTable.marketName,
      eventName:   betsTable.eventName,
      placedAt:    sql<string>`min(${betsTable.placedAt})`,
      betCount:    sql<number>`count(*)::int`,
      totalStaked: sql<number>`sum(case
        when ${betsTable.betType} = 'LAY'
          then ${betsTable.stakeAmount}::float * (${betsTable.requestedOdds}::float - 1)
        else ${betsTable.stakeAmount}::float
      end)`,
      netProfit:   sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
      settled:     sql<boolean>`bool_and(${betsTable.status} in ('WON','LOST','VOID'))`,
      winnerName:  sql<string>`max(case when ${betsTable.aiReasoning} like '%||WINNER:%'
            then split_part(split_part(${betsTable.aiReasoning}, '||WINNER:', 2), '||', 1)
            end)`,
    })
    .from(betsTable)
    .where(sql`${betsTable.strategyName} = ${strategyName}`)
    .groupBy(betsTable.marketId, betsTable.marketName, betsTable.eventName)
    .orderBy(desc(sql`min(${betsTable.placedAt})`))
    .limit(100);

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

router.get("/dutch-v2/:variant/logs", async (req, res): Promise<void> => {
  const v = getV2Variant(req.params.variant);
  if (!v) { res.status(404).json({ error: "unknown variant" }); return; }
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
  const prefix = `[DUTCH-V2-${v.getConfig().id.toUpperCase()}]`;
  res.setHeader("Cache-Control", "no-store");
  const logs = await db
    .select()
    .from(botLogsTable)
    .where(sql`${botLogsTable.message} LIKE ${prefix + "%"}`)
    .orderBy(desc(botLogsTable.createdAt))
    .limit(limit);
  res.json(
    logs.map(l => ({
      id:        l.id,
      level:     l.level,
      message:   l.message.replace(new RegExp(`^\\${prefix}\\s*`), ""),
      createdAt: l.createdAt.toISOString(),
    })),
  );
});

export default router;
