import { Router, type IRouter } from "express";
import { sql, desc } from "drizzle-orm";
import { db, betsTable, botConfigTable, botLogsTable } from "@workspace/db";
import {
  startMartingaleBot,
  stopMartingaleBot,
  resetMartingaleState,
  isMartingaleRunning,
  getMartingaleStartedAt,
  getMartingaleConfig,
  getMartingaleState,
  setMartingaleConfig,
  persistMartingaleConfig,
  getMartingaleStrategyName,
  type MartingaleConfig,
} from "../lib/martingaleEngine";

const router: IRouter = Router();
const LOG_TAG = "[MARTINGALE]";

async function getStats() {
  const strategyName = getMartingaleStrategyName();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [today] = await db
    .select({
      racesToday:  sql<number>`count(distinct ${betsTable.marketId})::int`,
      betsToday:   sql<number>`count(*)::int`,
      profitToday: sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
    })
    .from(betsTable)
    .where(sql`${betsTable.strategyName} = ${strategyName} AND ${betsTable.placedAt} >= ${todayStart}`);

  const [allTime] = await db
    .select({
      totalRaces:     sql<number>`count(distinct ${betsTable.marketId})::int`,
      totalBets:      sql<number>`count(*)::int`,
      totalNetProfit: sql<number>`coalesce(sum(${betsTable.actualProfit}), 0)::float`,
      winRaces:       sql<number>`count(distinct case when ${betsTable.actualProfit}::float > 0 then ${betsTable.marketId} end)::int`,
      settledRaces:   sql<number>`count(distinct case when ${betsTable.status} in ('WON','LOST','VOID') then ${betsTable.marketId} end)::int`,
      totalStaked:    sql<number>`coalesce(sum(${betsTable.stakeAmount}::float), 0)::float`,
    })
    .from(betsTable)
    .where(sql`${betsTable.strategyName} = ${strategyName}`);

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const settledRaces = allTime?.settledRaces ?? 0;
  const winRaces = allTime?.winRaces ?? 0;
  const totalStaked = round2(allTime?.totalStaked ?? 0);
  const totalNet = round2(allTime?.totalNetProfit ?? 0);

  return {
    racesToday:     today?.racesToday ?? 0,
    betsToday:      today?.betsToday ?? 0,
    profitToday:    round2(today?.profitToday ?? 0),
    totalRaces:     allTime?.totalRaces ?? 0,
    totalBets:      allTime?.totalBets ?? 0,
    totalNetProfit: totalNet,
    totalStaked,
    roiPct:         totalStaked > 0 ? round2((totalNet / totalStaked) * 100) : 0,
    winRate:        settledRaces > 0 ? Math.round((winRaces / settledRaces) * 100) : 0,
    settledRaces,
    winRaces,
  };
}

function statusPayload() {
  const cfg = getMartingaleConfig();
  const st  = getMartingaleState();
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const nextStakeIfLoss = st.lossStreak + 1 > cfg.maxDoubles
    ? cfg.startStake
    : cfg.startStake * Math.pow(2, st.lossStreak + 1);
  return {
    strategyName: getMartingaleStrategyName(),
    isRunning: isMartingaleRunning(),
    startedAt: getMartingaleStartedAt()?.toISOString() ?? null,
    martingaleConfig: cfg,
    martingaleState: {
      currentStake: round2(st.currentStake),
      lossStreak:   st.lossStreak,
      nextStakeIfLoss: round2(nextStakeIfLoss),
      atCap: st.lossStreak >= cfg.maxDoubles,
    },
  };
}

router.get("/martingale/status", async (_req, res): Promise<void> => {
  const [cfg] = await db.select().from(botConfigTable).limit(1);
  const stats = await getStats();
  res.json({ ...statusPayload(), paperTradingMode: cfg?.paperTradingMode ?? true, ...stats });
});

router.post("/martingale/start", async (_req, res): Promise<void> => {
  await startMartingaleBot();
  const stats = await getStats();
  res.json({ ...statusPayload(), ...stats });
});

router.post("/martingale/stop", async (_req, res): Promise<void> => {
  await stopMartingaleBot();
  const stats = await getStats();
  res.json({ ...statusPayload(), ...stats });
});

router.post("/martingale/reset", async (_req, res): Promise<void> => {
  await resetMartingaleState();
  res.json(statusPayload());
});

router.patch("/martingale/config", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const startStake   = typeof body.startStake   === "number" ? body.startStake   : undefined;
  const minOdds      = typeof body.minOdds      === "number" ? body.minOdds      : undefined;
  const maxOdds      = typeof body.maxOdds      === "number" ? body.maxOdds      : undefined;
  const maxDoubles   = typeof body.maxDoubles   === "number" ? body.maxDoubles   : undefined;
  const minLiquidity = typeof body.minLiquidity === "number" ? body.minLiquidity : undefined;
  const eventTypeIds = Array.isArray(body.eventTypeIds)
    ? (body.eventTypeIds as string[]).map(c => String(c).trim()).filter(Boolean)
    : undefined;
  const minMinsBeforeStart = typeof body.minMinsBeforeStart === "number" ? body.minMinsBeforeStart : undefined;
  const maxMinsBeforeStart = typeof body.maxMinsBeforeStart === "number" ? body.maxMinsBeforeStart : undefined;

  if (startStake   !== undefined && (startStake   < 1   || startStake   > 100))  { res.status(400).json({ error: "startStake must be £1–£100" }); return; }
  if (minOdds      !== undefined && (minOdds      < 1.01 || minOdds     > 100))  { res.status(400).json({ error: "minOdds must be 1.01–100" }); return; }
  if (maxOdds      !== undefined && (maxOdds      < 1.01 || maxOdds     > 100))  { res.status(400).json({ error: "maxOdds must be 1.01–100" }); return; }
  if (maxDoubles   !== undefined && (maxDoubles   < 1   || maxDoubles   > 12))   { res.status(400).json({ error: "maxDoubles must be 1–12" }); return; }
  if (minLiquidity !== undefined && (minLiquidity < 0   || minLiquidity > 1_000_000)) { res.status(400).json({ error: "minLiquidity out of range" }); return; }
  if (eventTypeIds !== undefined && eventTypeIds.length === 0) { res.status(400).json({ error: "Pick at least one sport" }); return; }
  if (minMinsBeforeStart !== undefined && (minMinsBeforeStart < 0 || minMinsBeforeStart > 1440)) { res.status(400).json({ error: "minMinsBeforeStart must be 0–1440" }); return; }
  if (maxMinsBeforeStart !== undefined && (maxMinsBeforeStart < 1 || maxMinsBeforeStart > 1440)) { res.status(400).json({ error: "maxMinsBeforeStart must be 1–1440" }); return; }

  const current = getMartingaleConfig();
  const effectiveMin = minOdds ?? current.minOdds;
  const effectiveMax = maxOdds ?? current.maxOdds;
  if (effectiveMin >= effectiveMax) {
    res.status(400).json({ error: "minOdds must be strictly less than maxOdds" });
    return;
  }
  const effMinMins = minMinsBeforeStart ?? current.minMinsBeforeStart;
  const effMaxMins = maxMinsBeforeStart ?? current.maxMinsBeforeStart;
  if (effMinMins >= effMaxMins) {
    res.status(400).json({ error: "minMinsBeforeStart must be strictly less than maxMinsBeforeStart" });
    return;
  }

  const patch: Partial<MartingaleConfig> = {};
  if (startStake   !== undefined) patch.startStake   = startStake;
  if (minOdds      !== undefined) patch.minOdds      = minOdds;
  if (maxOdds      !== undefined) patch.maxOdds      = maxOdds;
  if (maxDoubles   !== undefined) patch.maxDoubles   = maxDoubles;
  if (minLiquidity !== undefined) patch.minLiquidity = minLiquidity;
  if (eventTypeIds !== undefined) patch.eventTypeIds = eventTypeIds;
  if (minMinsBeforeStart !== undefined) patch.minMinsBeforeStart = minMinsBeforeStart;
  if (maxMinsBeforeStart !== undefined) patch.maxMinsBeforeStart = maxMinsBeforeStart;
  setMartingaleConfig(patch);
  await persistMartingaleConfig();
  res.json({ martingaleConfig: getMartingaleConfig() });
});

router.get("/martingale/logs", async (req, res): Promise<void> => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
  res.setHeader("Cache-Control", "no-store");
  const logs = await db
    .select()
    .from(botLogsTable)
    .where(sql`${botLogsTable.message} LIKE ${LOG_TAG + "%"}`)
    .orderBy(desc(botLogsTable.createdAt))
    .limit(limit);
  res.json(
    logs.map(l => ({
      id: l.id,
      level: l.level,
      message: l.message.replace(/^\[MARTINGALE\]\s*/, ""),
      createdAt: l.createdAt.toISOString(),
    })),
  );
});

router.get("/martingale/races", async (_req, res): Promise<void> => {
  const strategyName = getMartingaleStrategyName();
  const rows = await db
    .select({
      marketId:      betsTable.marketId,
      marketName:    betsTable.marketName,
      eventName:     betsTable.eventName,
      selectionName: betsTable.selectionName,
      betType:       betsTable.betType,
      triggerOdds:   betsTable.requestedOdds,
      matchedOdds:   betsTable.matchedOdds,
      stakeAmount:   betsTable.stakeAmount,
      actualProfit:  betsTable.actualProfit,
      status:        betsTable.status,
      placedAt:      betsTable.placedAt,
      settledAt:     betsTable.settledAt,
    })
    .from(betsTable)
    .where(sql`${betsTable.strategyName} = ${strategyName}`)
    .orderBy(desc(betsTable.placedAt))
    .limit(100);

  res.json(rows.map(r => ({
    marketId:      r.marketId,
    marketName:    r.marketName,
    eventName:     r.eventName,
    selectionName: r.selectionName,
    betType:       r.betType,
    triggerOdds:   Number(r.triggerOdds),
    matchedOdds:   r.matchedOdds != null ? Number(r.matchedOdds) : null,
    stake:         Number(r.stakeAmount),
    netProfit:     r.actualProfit != null ? Number(r.actualProfit) : null,
    status:        r.status,
    placedAt:      r.placedAt.toISOString(),
    settledAt:     r.settledAt ? r.settledAt.toISOString() : null,
    settled:       ["WON","LOST","VOID"].includes(r.status),
  })));
});

export default router;
