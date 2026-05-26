import { Router, type IRouter } from "express";
import { sql, desc } from "drizzle-orm";
import { db, betsTable, botLogsTable, dutchScheduleTable } from "@workspace/db";
import { getV2Variant, listV2Variants } from "../lib/dutchV2Engine";

interface ScheduleRunner {
  selectionId?: number;
  name: string;
  price: number;
  backed: boolean;
  betType?: "BACK" | "LAY";
  stake?: number;
  liability?: number;
  netProfit?: number;
}

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

// V2 schedule — shares the Dutch bot's scanned race list (dutchScheduleTable
// is populated hourly by the Dutch bot for ALL UK/IE WIN races), but overlays
// THIS V2 variant's own bet/skip status and runner backing.
router.get("/dutch-v2/:variant/schedule", async (req, res): Promise<void> => {
  const v = getV2Variant(req.params.variant);
  if (!v) { res.status(404).json({ error: "unknown variant" }); return; }
  const strategyName = v.getConfig().strategyName;

  const date = typeof req.query.date === "string"
    ? req.query.date
    : new Date().toISOString().slice(0, 10);

  const entries = await db
    .select()
    .from(dutchScheduleTable)
    .where(sql`${dutchScheduleTable.scheduledDate} = ${date}`)
    .orderBy(dutchScheduleTable.marketStartTime);

  if (entries.length === 0) { res.json([]); return; }

  // V2's bets for today's markets, grouped by marketId.
  const marketIds = entries.map(e => e.marketId);
  const v2Bets = await db
    .select({
      marketId:     betsTable.marketId,
      selectionId:  betsTable.selectionId,
      selectionName:betsTable.selectionName,
      betType:      betsTable.betType,
      stake:        betsTable.stakeAmount,
      odds:         betsTable.requestedOdds,
      status:       betsTable.status,
      actualProfit: betsTable.actualProfit,
    })
    .from(betsTable)
    .where(sql`${betsTable.strategyName} = ${strategyName}
               AND ${betsTable.marketId} = ANY(ARRAY[${sql.join(marketIds.map(id => sql`${id}`), sql`, `)}])`);

  const betsByMarket = new Map<string, typeof v2Bets>();
  for (const b of v2Bets) {
    const list = betsByMarket.get(b.marketId) ?? [];
    list.push(b);
    betsByMarket.set(b.marketId, list);
  }

  const out = entries.map(e => {
    const bets = betsByMarket.get(e.marketId) ?? [];
    const v2HasBets = bets.length > 0;

    let status: string;
    let skipReason: string | null;
    if (v2HasBets) {
      status = "BET_PLACED";
      skipReason = null;
    } else if (e.status === "BET_PLACED") {
      // Dutch bet on it but V2 didn't — for V2 this means it was filtered out.
      status = "SKIPPED";
      skipReason = "V2 filters excluded this race (Hurdle/NHF/runner-count/odds band)";
    } else {
      status = e.status;
      skipReason = e.skipReason;
    }

    // Overlay V2 bet info on the snapshot runner list.
    const baseRunners = (e.runnersJson as ScheduleRunner[] | null) ?? [];
    const v2BetBySel = new Map<number, typeof bets[number]>();
    for (const b of bets) v2BetBySel.set(b.selectionId, b);

    const runnersJson: ScheduleRunner[] = baseRunners.map(r => {
      const bet = r.selectionId != null ? v2BetBySel.get(r.selectionId) : undefined;
      if (!bet) {
        return { ...r, backed: false, betType: undefined, stake: undefined, liability: undefined, netProfit: undefined };
      }
      const stake = Number(bet.stake);
      const odds  = Number(bet.odds);
      const liability = bet.betType === "LAY" ? stake * (odds - 1) : stake;
      return {
        ...r,
        backed:    true,
        betType:   (bet.betType ?? "BACK") as "BACK" | "LAY",
        stake:     Math.round(stake * 100) / 100,
        liability: Math.round(liability * 100) / 100,
        netProfit: bet.actualProfit != null ? Number(bet.actualProfit) : undefined,
      };
    });

    return {
      id:               e.id,
      marketId:         e.marketId,
      eventName:        e.eventName,
      marketName:       e.marketName,
      marketStartTime:  e.marketStartTime,
      runnerCount:      e.runnerCount,
      status,
      skipReason,
      runnersJson,
    };
  });

  res.json(out);
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
