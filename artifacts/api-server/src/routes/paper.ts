import { Router, type IRouter } from "express";
import { sql, desc } from "drizzle-orm";
import { db, betsTable, botConfigTable, botLogsTable } from "@workspace/db";
import {
  startPaperBot,
  stopPaperBot,
  isPaperRunning,
  getPaperStartedAt,
  getPaperConfig,
  setPaperConfig,
  savePaperConfigToDb,
  getPaperStrategyName,
  getPaperBetSide,
  type PaperStrategyKey,
  type PaperConfig,
} from "../lib/paperEngine";

const router: IRouter = Router();

const SLUG_TO_KEY: Record<string, PaperStrategyKey> = {
  "back-fav": "back_fav",
  "lay-short-fav": "lay_short_fav",
};

function resolveKey(slug: string): PaperStrategyKey | null {
  return SLUG_TO_KEY[slug] ?? null;
}

async function getPaperStats(key: PaperStrategyKey) {
  const strategyName = getPaperStrategyName(key);
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
  const races = allTime?.totalRaces ?? 0;
  const settledRaces = allTime?.settledRaces ?? 0;
  const winRaces = allTime?.winRaces ?? 0;
  const totalStaked = round2(allTime?.totalStaked ?? 0);
  const totalNet = round2(allTime?.totalNetProfit ?? 0);

  return {
    racesToday:     today?.racesToday  ?? 0,
    betsToday:      today?.betsToday   ?? 0,
    profitToday:    round2(today?.profitToday ?? 0),
    totalRaces:     races,
    totalBets:      allTime?.totalBets ?? 0,
    totalNetProfit: totalNet,
    totalStaked,
    roiPct:         totalStaked > 0 ? round2((totalNet / totalStaked) * 100) : 0,
    winRate:        settledRaces > 0 ? Math.round((winRaces / settledRaces) * 100) : 0,
    settledRaces,
    winRaces,
  };
}

function statusPayload(key: PaperStrategyKey) {
  return {
    strategyKey: key,
    strategyName: getPaperStrategyName(key),
    betSide: getPaperBetSide(key),
    isRunning: isPaperRunning(key),
    startedAt: getPaperStartedAt(key)?.toISOString() ?? null,
    paperConfig: getPaperConfig(key),
  };
}

router.get("/paper/:slug/status", async (req, res): Promise<void> => {
  const key = resolveKey(req.params.slug);
  if (!key) { res.status(404).json({ error: "Unknown strategy" }); return; }
  const [config] = await db.select().from(botConfigTable).limit(1);
  const stats = await getPaperStats(key);
  res.json({ ...statusPayload(key), paperTradingMode: config?.paperTradingMode ?? true, ...stats });
});

router.post("/paper/:slug/start", async (req, res): Promise<void> => {
  const key = resolveKey(req.params.slug);
  if (!key) { res.status(404).json({ error: "Unknown strategy" }); return; }
  await startPaperBot(key);
  const stats = await getPaperStats(key);
  res.json({ ...statusPayload(key), ...stats });
});

router.post("/paper/:slug/stop", async (req, res): Promise<void> => {
  const key = resolveKey(req.params.slug);
  if (!key) { res.status(404).json({ error: "Unknown strategy" }); return; }
  await stopPaperBot(key);
  const stats = await getPaperStats(key);
  res.json({ ...statusPayload(key), ...stats });
});

router.patch("/paper/:slug/config", async (req, res): Promise<void> => {
  const key = resolveKey(req.params.slug);
  if (!key) { res.status(404).json({ error: "Unknown strategy" }); return; }
  const body = req.body as Record<string, unknown>;

  const stake        = typeof body.stake        === "number" ? body.stake        : undefined;
  const minOdds      = typeof body.minOdds      === "number" ? body.minOdds      : undefined;
  const maxOdds      = typeof body.maxOdds      === "number" ? body.maxOdds      : undefined;
  const minLiquidity = typeof body.minLiquidity === "number" ? body.minLiquidity : undefined;
  const countryCodes = Array.isArray(body.countryCodes)
    ? (body.countryCodes as string[]).map(c => String(c).trim().toUpperCase()).filter(Boolean)
    : undefined;

  if (stake        !== undefined && (stake <  1   || stake >  1000))  { res.status(400).json({ error: "stake must be £1–£1,000" }); return; }
  if (minOdds      !== undefined && (minOdds < 1.01 || minOdds > 100)) { res.status(400).json({ error: "minOdds must be 1.01–100" }); return; }
  if (maxOdds      !== undefined && (maxOdds < 1.01 || maxOdds > 100)) { res.status(400).json({ error: "maxOdds must be 1.01–100" }); return; }
  if (minLiquidity !== undefined && (minLiquidity < 0 || minLiquidity > 1_000_000)) { res.status(400).json({ error: "minLiquidity out of range" }); return; }
  if (countryCodes !== undefined && countryCodes.length === 0)        { res.status(400).json({ error: "At least one country code is required" }); return; }

  // Compose effective min/max (incoming overrides current) and enforce min < max
  const current = getPaperConfig(key);
  const effectiveMin = minOdds ?? current.minOdds;
  const effectiveMax = maxOdds ?? current.maxOdds;
  if (effectiveMin >= effectiveMax) {
    res.status(400).json({ error: "minOdds must be strictly less than maxOdds" });
    return;
  }

  const patch: Partial<PaperConfig> = {};
  if (stake        !== undefined) patch.stake        = stake;
  if (minOdds      !== undefined) patch.minOdds      = minOdds;
  if (maxOdds      !== undefined) patch.maxOdds      = maxOdds;
  if (minLiquidity !== undefined) patch.minLiquidity = minLiquidity;
  if (countryCodes !== undefined) patch.countryCodes = countryCodes;
  setPaperConfig(key, patch);
  await savePaperConfigToDb(key);
  res.json({ paperConfig: getPaperConfig(key) });
});

router.get("/paper/:slug/logs", async (req, res): Promise<void> => {
  const key = resolveKey(req.params.slug);
  if (!key) { res.status(404).json({ error: "Unknown strategy" }); return; }
  const tag = key === "back_fav" ? "[PAPER:BACK]" : "[PAPER:LAY]";
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
  res.setHeader("Cache-Control", "no-store");
  const logs = await db
    .select()
    .from(botLogsTable)
    .where(sql`${botLogsTable.message} LIKE ${tag + "%"}`)
    .orderBy(desc(botLogsTable.createdAt))
    .limit(limit);
  res.json(
    logs.map(l => ({
      id: l.id,
      level: l.level,
      message: l.message.replace(new RegExp(`^\\${tag}\\s*`), ""),
      createdAt: l.createdAt.toISOString(),
    })),
  );
});

router.get("/paper/:slug/races", async (req, res): Promise<void> => {
  const key = resolveKey(req.params.slug);
  if (!key) { res.status(404).json({ error: "Unknown strategy" }); return; }
  const strategyName = getPaperStrategyName(key);
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
