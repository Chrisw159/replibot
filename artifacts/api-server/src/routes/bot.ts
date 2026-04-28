import { Router, type IRouter } from "express";
import { eq, desc, gte, sql } from "drizzle-orm";

import { db, botConfigTable, botLogsTable, betsTable } from "@workspace/db";
import {
  UpdateBotConfigBody,
  GetBotLogsQueryParams,
  GetBotConfigResponse,
  UpdateBotConfigResponse,
  StartBotResponse,
  StopBotResponse,
  GetBotStatusResponse,
  GetBotLogsResponse,
} from "@workspace/api-zod";
import {
  startBot,
  stopBot,
  isBotRunning,
  getStartedAt,
} from "../lib/botEngine";

const router: IRouter = Router();

async function getOrCreateConfig() {
  const [config] = await db.select().from(botConfigTable).limit(1);
  if (!config) {
    const [newConfig] = await db.insert(botConfigTable).values({}).returning();
    return newConfig;
  }
  return config;
}

function mapConfig(c: typeof botConfigTable.$inferSelect) {
  return {
    id: c.id,
    isRunning: c.isRunning,
    checkIntervalSeconds: c.checkIntervalSeconds,
    maxConcurrentBets: c.maxConcurrentBets,
    dailyLossLimit: Number(c.dailyLossLimit),
    dailyProfitTarget: c.dailyProfitTarget !== null ? Number(c.dailyProfitTarget) : null,
    enabledEventTypes: c.enabledEventTypes,
    paperTradingMode: c.paperTradingMode,
    updatedAt: c.updatedAt.toISOString(),
  };
}

async function getTodayStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [stats] = await db
    .select({
      betsPlacedToday: sql<number>`count(*)`,
      profitToday: sql<number>`coalesce(sum(case when actual_profit > 0 then actual_profit else 0 end), 0)`,
      lossToday: sql<number>`coalesce(sum(case when actual_profit < 0 then abs(actual_profit) else 0 end), 0)`,
    })
    .from(betsTable)
    .where(gte(betsTable.placedAt, todayStart));

  return {
    betsPlacedToday: Number(stats?.betsPlacedToday ?? 0),
    profitToday: Math.round(Number(stats?.profitToday ?? 0) * 100) / 100,
    lossToday: Math.round(Number(stats?.lossToday ?? 0) * 100) / 100,
  };
}

router.get("/bot/config", async (_req, res): Promise<void> => {
  const config = await getOrCreateConfig();
  res.json(GetBotConfigResponse.parse(mapConfig(config)));
});

router.patch("/bot/config", async (req, res): Promise<void> => {
  const parsed = UpdateBotConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const config = await getOrCreateConfig();
  const updates: Record<string, unknown> = {};
  const d = parsed.data;

  if (d.checkIntervalSeconds != null) updates.checkIntervalSeconds = d.checkIntervalSeconds;
  if (d.maxConcurrentBets != null) updates.maxConcurrentBets = d.maxConcurrentBets;
  if (d.dailyLossLimit != null) updates.dailyLossLimit = d.dailyLossLimit.toString();
  if (d.dailyProfitTarget != null) updates.dailyProfitTarget = d.dailyProfitTarget.toString();
  if (d.enabledEventTypes != null) updates.enabledEventTypes = d.enabledEventTypes;
  if (d.paperTradingMode != null) updates.paperTradingMode = d.paperTradingMode;

  const [updated] = await db
    .update(botConfigTable)
    .set(updates)
    .where(eq(botConfigTable.id, config.id))
    .returning();

  res.json(UpdateBotConfigResponse.parse(mapConfig(updated)));
});

router.post("/bot/start", async (_req, res): Promise<void> => {
  await startBot();
  const [config] = await db.select().from(botConfigTable).limit(1);
  const todayStats = await getTodayStats();
  const sa = getStartedAt();

  res.json(
    StartBotResponse.parse({
      isRunning: true,
      startedAt: sa ? sa.toISOString() : null,
      paperTradingMode: config?.paperTradingMode ?? true,
      ...todayStats,
    })
  );
});

router.post("/bot/stop", async (_req, res): Promise<void> => {
  await stopBot();
  const [config] = await db.select().from(botConfigTable).limit(1);
  const todayStats = await getTodayStats();

  res.json(
    StopBotResponse.parse({
      isRunning: false,
      startedAt: null,
      paperTradingMode: config?.paperTradingMode ?? true,
      ...todayStats,
    })
  );
});

router.get("/bot/status", async (_req, res): Promise<void> => {
  const running = isBotRunning();
  const sa = getStartedAt();
  const [config] = await db.select().from(botConfigTable).limit(1);
  const todayStats = await getTodayStats();

  res.json(
    GetBotStatusResponse.parse({
      isRunning: running,
      startedAt: sa ? sa.toISOString() : null,
      paperTradingMode: config?.paperTradingMode ?? true,
      ...todayStats,
    })
  );
});

router.get("/bot/logs", async (req, res): Promise<void> => {
  const parsed = GetBotLogsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const logs = await db
    .select()
    .from(botLogsTable)
    .orderBy(desc(botLogsTable.createdAt))
    .limit(parsed.data.limit ?? 100);

  res.json(
    GetBotLogsResponse.parse(
      logs.map((l) => ({
        id: l.id,
        level: l.level,
        message: l.message,
        metadata: l.metadata ?? null,
        createdAt: l.createdAt.toISOString(),
      }))
    )
  );
});

export default router;
