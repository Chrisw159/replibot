import { logger } from "./logger";
import { db, betsTable, botLogsTable, botConfigTable } from "@workspace/db";
import { eq, sql, desc } from "drizzle-orm";
import {
  getSession,
  listMarkets,
  getMarketDetail,
  getMarketResultWithBSP,
  loginWithEnvCredentials,
} from "./betfair";

const STRATEGY_NAME = "Martingale Fav";
const LOG_TAG = "MARTINGALE";
const NON_WIN_PATTERN =
  /each.?way|forecast|\(f\/c\)|\bFC\b|\bRFC\b|reverse\s|straight\s+f|combination\s+f|to be placed|\bTBP\b|match bet|daily win dist|without\s+\w|to win by|trained\s+winner|named\s+fav|jockey.*champion|specials|scorecast|wincast/i;

const CYCLE_INTERVAL_MS = 60_000;
const SETTLEMENT_INTERVAL_MS = 2 * 60_000;

export interface MartingaleConfig {
  startStake: number;
  minOdds: number;
  maxOdds: number;
  maxDoubles: number;
  minLiquidity: number;
  eventTypeIds: string[];
  minMinsBeforeStart: number;
  maxMinsBeforeStart: number;
}

interface MartingaleState {
  currentStake: number;
  lossStreak: number;
  lastProcessedBetId: number | null;
}

interface SportDef {
  eventTypeId: string;
  name: string;
  marketType: string;
  countries: string[] | null;
}

const SPORTS: SportDef[] = [
  { eventTypeId: "7",    name: "Horse Racing", marketType: "WIN",        countries: ["GB", "IE"] },
  { eventTypeId: "1",    name: "Soccer",       marketType: "MATCH_ODDS", countries: null },
  { eventTypeId: "2",    name: "Tennis",       marketType: "MATCH_ODDS", countries: null },
  { eventTypeId: "7522", name: "Basketball",   marketType: "MATCH_ODDS", countries: null },
];

const DEFAULT_CONFIG: MartingaleConfig = {
  startStake: 2,
  minOdds: 2.5,
  maxOdds: 3.5,
  maxDoubles: 6, // → max stake = startStake × 2^6 = £128 with default £2 start
  minLiquidity: 5000,
  eventTypeIds: SPORTS.map(s => s.eventTypeId),
  minMinsBeforeStart: 1,
  maxMinsBeforeStart: 30,
};

interface Runtime {
  running: boolean;
  starting: boolean;
  startedAt: Date | null;
  cycleTimer: ReturnType<typeof setTimeout> | null;
  config: MartingaleConfig;
  state: MartingaleState;
}

const rt: Runtime = {
  running: false,
  starting: false,
  startedAt: null,
  cycleTimer: null,
  config: { ...DEFAULT_CONFIG },
  state: { currentStake: DEFAULT_CONFIG.startStake, lossStreak: 0, lastProcessedBetId: null },
};

let settlementInterval: ReturnType<typeof setInterval> | null = null;
let settlementRunning = false;
const processingMarkets = new Set<string>();

// ─── public getters ────────────────────────────────────────────────────────────

export function isMartingaleRunning(): boolean { return rt.running; }
export function getMartingaleStartedAt(): Date | null { return rt.startedAt; }
export function getMartingaleConfig(): MartingaleConfig { return { ...rt.config }; }
export function getMartingaleState(): MartingaleState { return { ...rt.state }; }
export function getMartingaleStrategyName(): string { return STRATEGY_NAME; }

export function setMartingaleConfig(patch: Partial<MartingaleConfig>): void {
  rt.config = { ...rt.config, ...patch };
}

// ─── persistence ───────────────────────────────────────────────────────────────

async function saveConfigToDb(): Promise<void> {
  try {
    const [row] = await db.select({ id: botConfigTable.id }).from(botConfigTable).limit(1);
    if (row) {
      await db.update(botConfigTable)
        .set({ martingaleConfigJson: rt.config as unknown as Record<string, unknown> })
        .where(eq(botConfigTable.id, row.id));
    } else {
      await db.insert(botConfigTable).values({
        martingaleConfigJson: rt.config as unknown as Record<string, unknown>,
      });
    }
  } catch (err) {
    logger.error({ err }, `[${LOG_TAG}] Failed to save config`);
  }
}

export async function persistMartingaleConfig(): Promise<void> { await saveConfigToDb(); }

async function saveStateToDb(): Promise<void> {
  try {
    const [row] = await db.select({ id: botConfigTable.id }).from(botConfigTable).limit(1);
    if (row) {
      await db.update(botConfigTable)
        .set({ martingaleStateJson: rt.state as unknown as Record<string, unknown> })
        .where(eq(botConfigTable.id, row.id));
    }
  } catch (err) {
    logger.error({ err }, `[${LOG_TAG}] Failed to save state`);
  }
}

async function loadConfigFromDb(): Promise<void> {
  try {
    const [row] = await db
      .select({ cfg: botConfigTable.martingaleConfigJson, st: botConfigTable.martingaleStateJson })
      .from(botConfigTable)
      .limit(1);
    const saved = row?.cfg as Partial<MartingaleConfig> | null | undefined;
    if (saved) {
      const c = rt.config;
      if (typeof saved.startStake   === "number") c.startStake   = saved.startStake;
      if (typeof saved.minOdds      === "number") c.minOdds      = saved.minOdds;
      if (typeof saved.maxOdds      === "number") c.maxOdds      = saved.maxOdds;
      if (typeof saved.maxDoubles   === "number") c.maxDoubles   = saved.maxDoubles;
      if (typeof saved.minLiquidity === "number") c.minLiquidity = saved.minLiquidity;
      if (Array.isArray(saved.eventTypeIds))      c.eventTypeIds = saved.eventTypeIds;
      if (typeof saved.minMinsBeforeStart === "number") c.minMinsBeforeStart = saved.minMinsBeforeStart;
      if (typeof saved.maxMinsBeforeStart === "number") c.maxMinsBeforeStart = saved.maxMinsBeforeStart;
    }
    const savedState = row?.st as Partial<MartingaleState> | null | undefined;
    if (savedState) {
      if (typeof savedState.currentStake       === "number") rt.state.currentStake = savedState.currentStake;
      if (typeof savedState.lossStreak         === "number") rt.state.lossStreak   = savedState.lossStreak;
      if (typeof savedState.lastProcessedBetId === "number" || savedState.lastProcessedBetId === null) {
        rt.state.lastProcessedBetId = savedState.lastProcessedBetId ?? null;
      }
    }
  } catch (err) {
    logger.error({ err }, `[${LOG_TAG}] Failed to load config/state`);
  }
}

// ─── logging ───────────────────────────────────────────────────────────────────

function log(level: string, message: string, metadata?: Record<string, unknown>): void {
  const full = `[${LOG_TAG}] ${message}`;
  logger.info({ level, metadata }, full);
  db.insert(botLogsTable).values({
    level,
    message: full,
    metadata: metadata ? JSON.stringify(metadata) : null,
  }).catch((err: unknown) => logger.error({ err }, `[${LOG_TAG}] Failed to write log to DB`));
}

// ─── martingale step (apply latest settled bet to state) ──────────────────────

async function applyLatestSettled(): Promise<void> {
  const [latest] = await db
    .select()
    .from(betsTable)
    .where(sql`${betsTable.strategyName} = ${STRATEGY_NAME}
               AND ${betsTable.status} IN ('WON','LOST','VOID')`)
    .orderBy(desc(betsTable.placedAt))
    .limit(1);
  if (!latest) return;
  if (latest.id === rt.state.lastProcessedBetId) return;

  if (latest.status === "WON" || latest.status === "VOID") {
    rt.state.currentStake = rt.config.startStake;
    rt.state.lossStreak   = 0;
    log("info", `${latest.status} on ${latest.eventName} → reset to £${rt.config.startStake.toFixed(2)}`);
  } else {
    const newStreak = rt.state.lossStreak + 1;
    if (newStreak > rt.config.maxDoubles) {
      log(
        "warn",
        `Cap hit after ${newStreak} consecutive losses (£${Number(latest.stakeAmount).toFixed(2)}) — resetting to £${rt.config.startStake.toFixed(2)}`,
      );
      rt.state.currentStake = rt.config.startStake;
      rt.state.lossStreak   = 0;
    } else {
      rt.state.lossStreak   = newStreak;
      rt.state.currentStake = rt.config.startStake * Math.pow(2, newStreak);
      log(
        "warn",
        `Loss #${newStreak} on ${latest.eventName} — next stake £${rt.state.currentStake.toFixed(2)}`,
      );
    }
  }
  rt.state.lastProcessedBetId = latest.id;
  await saveStateToDb();
}

// ─── cycle ─────────────────────────────────────────────────────────────────────

async function findCandidateMarket(): Promise<{
  marketId: string;
  marketName: string;
  eventName: string;
  sport: string;
} | null> {
  const cfg = rt.config;
  const now = new Date();
  const fromMs = now.getTime() + cfg.minMinsBeforeStart * 60_000;
  const toMs   = now.getTime() + cfg.maxMinsBeforeStart * 60_000;

  const diag: string[] = [];

  for (const sport of SPORTS) {
    if (!cfg.eventTypeIds.includes(sport.eventTypeId)) continue;
    let markets;
    try {
      markets = await listMarkets({
        eventTypeId: sport.eventTypeId,
        countryCodes: sport.countries ?? undefined,
        marketType: sport.marketType,
        hoursAhead: Math.max(cfg.maxMinsBeforeStart / 60, 0.05),
        limit: 50,
      });
    } catch (err) {
      log("warn", `listMarkets failed for ${sport.name}: ${String(err)}`);
      continue;
    }

    const inWindow = markets.filter(m => {
      const startMs = new Date(m.marketStartTime).getTime();
      return startMs >= fromMs && startMs <= toMs;
    });

    let rejNameFilter = 0, rejAlreadyBet = 0, rejNoDetail = 0;
    let rejLiquidity = 0, rejRunners = 0, rejOdds = 0;
    let lowestFav: number | null = null, highestFav: number | null = null;
    let bestLiquidity = 0;

    if (inWindow.length === 0) {
      diag.push(`${sport.name}:${markets.length}fetched/0inWin`);
      continue;
    }

    inWindow.sort((a, b) =>
      new Date(a.marketStartTime).getTime() - new Date(b.marketStartTime).getTime(),
    );

    for (const m of inWindow) {
      if (NON_WIN_PATTERN.test(m.marketName)) { rejNameFilter++; continue; }
      if (processingMarkets.has(m.marketId)) continue;

      const [existing] = await db
        .select({ id: betsTable.id })
        .from(betsTable)
        .where(sql`${betsTable.strategyName} = ${STRATEGY_NAME} AND ${betsTable.marketId} = ${m.marketId}`)
        .limit(1);
      if (existing) { rejAlreadyBet++; continue; }

      const detail = await getMarketDetail(m.marketId);
      if (!detail) { rejNoDetail++; continue; }
      if (detail.totalMatched > bestLiquidity) bestLiquidity = detail.totalMatched;
      // (Liquidity filter intentionally disabled — user request.)

      const active = detail.runners.filter(r => r.status === "ACTIVE" && (r.bestBackPrice ?? 0) > 1);
      if (active.length < 2) { rejRunners++; continue; }

      const sorted = [...active].sort((a, b) => (a.bestBackPrice ?? 999) - (b.bestBackPrice ?? 999));
      const fav = sorted[0];
      const favBack = fav.bestBackPrice ?? 0;
      if (lowestFav === null || favBack < lowestFav) lowestFav = favBack;
      if (highestFav === null || favBack > highestFav) highestFav = favBack;
      if (favBack < cfg.minOdds || favBack >= cfg.maxOdds) { rejOdds++; continue; }

      log("info",
        `Candidate found in ${sport.name}: ${m.eventName} (fav £${favBack.toFixed(2)}, liq £${detail.totalMatched.toFixed(0)})`,
      );
      return {
        marketId: m.marketId,
        marketName: m.marketName,
        eventName: m.eventName,
        sport: sport.name,
      };
    }

    const favRange = lowestFav !== null && highestFav !== null
      ? `favs ${lowestFav.toFixed(2)}-${highestFav.toFixed(2)}`
      : "favs n/a";
    diag.push(
      `${sport.name}:${inWindow.length}inWin,bestLiq£${bestLiquidity.toFixed(0)},${favRange}` +
      `,rej{name:${rejNameFilter},bet:${rejAlreadyBet},nodet:${rejNoDetail},liq:${rejLiquidity},run:${rejRunners},odds:${rejOdds}}`,
    );
  }

  if (diag.length > 0) log("info", `No candidate. Breakdown: ${diag.join(" | ")}`);
  return null;
}

async function placeMartingaleBet(
  marketId: string,
  marketName: string,
  eventName: string,
  sport: string,
): Promise<void> {
  const detail = await getMarketDetail(marketId);
  if (!detail) return;

  const active = detail.runners.filter(r => r.status === "ACTIVE" && (r.bestBackPrice ?? 0) > 1);
  if (active.length < 2) return;
  const sorted = [...active].sort((a, b) => (a.bestBackPrice ?? 999) - (b.bestBackPrice ?? 999));
  const fav = sorted[0];
  const favBack = fav.bestBackPrice ?? 0;
  if (favBack < rt.config.minOdds || favBack >= rt.config.maxOdds) return;

  const stake = rt.state.currentStake;
  log(
    "info",
    `BACK ${fav.runnerName} £${stake.toFixed(2)} @ ${favBack} in ${eventName} [${sport}, streak ${rt.state.lossStreak}] [PAPER]`,
    { marketId, selectionId: fav.selectionId, stake, lossStreak: rt.state.lossStreak, sport },
  );

  await db.insert(betsTable).values({
    strategyId: null,
    strategyName: STRATEGY_NAME,
    marketId,
    marketName,
    eventName,
    selectionId: fav.selectionId,
    selectionName: fav.runnerName,
    betType: "BACK",
    requestedOdds: favBack.toFixed(2),
    matchedOdds: null,
    stakeAmount: stake.toFixed(2),
    potentialProfit: (stake * (favBack - 1)).toFixed(2),
    status: "MATCHED",
    aiReasoning: `[${LOG_TAG}] BACK fav ${fav.runnerName} @ ${favBack} (${sport}, streak ${rt.state.lossStreak}). Settled at BSP/last.`,
    betId: `${LOG_TAG}-${Date.now()}-${fav.selectionId}`,
  });
}

async function hasPendingBet(): Promise<boolean> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const [pending] = await db
    .select({ id: betsTable.id })
    .from(betsTable)
    .where(sql`${betsTable.strategyName} = ${STRATEGY_NAME}
               AND ${betsTable.status} IN ('MATCHED','PLACED','UNMATCHED')
               AND ${betsTable.placedAt} >= ${cutoff}`)
    .limit(1);
  return !!pending;
}

async function runCycle(): Promise<void> {
  if (!rt.running) return;
  try {
    if (!getSession()) {
      const r = await loginWithEnvCredentials();
      if (!r.success) {
        log("warn", "Not connected to Betfair — skipping cycle");
        return;
      }
      log("info", "Auto-connected to Betfair");
    }

    // 1. Don't place a new bet if one is still pending.
    //    Check pending FIRST: if there is a pending bet, state is still in sync
    //    from a prior cycle and the settlement loop will resolve it.
    if (await hasPendingBet()) {
      log("info", `Cycle — pending bet in flight, waiting (next stake £${rt.state.currentStake.toFixed(2)})`);
      return;
    }

    // 2. With no pending bet, the latest settled bet IS authoritative for state.
    //    Apply it (it may have settled since the previous cycle).
    await applyLatestSettled();

    // 3. Find a viable market and place exactly one bet
    const candidate = await findCandidateMarket();
    if (!candidate) {
      log("info", `Cycle — no candidate in window (next stake £${rt.state.currentStake.toFixed(2)})`);
      return;
    }

    processingMarkets.add(candidate.marketId);
    try {
      await placeMartingaleBet(candidate.marketId, candidate.marketName, candidate.eventName, candidate.sport);
    } finally {
      processingMarkets.delete(candidate.marketId);
    }
  } catch (err) {
    log("error", `Cycle error: ${String(err)}`);
  }
}

async function scheduleCycle(): Promise<void> {
  if (!rt.running) return;
  await runCycle();
  if (rt.running) {
    rt.cycleTimer = setTimeout(() => { void scheduleCycle(); }, CYCLE_INTERVAL_MS);
  }
}

// ─── settlement ────────────────────────────────────────────────────────────────

async function runSettlement(): Promise<void> {
  if (!getSession()) return;
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const unsettled = await db
      .select()
      .from(betsTable)
      .where(sql`${betsTable.strategyName} = ${STRATEGY_NAME}
                 AND ${betsTable.status} IN ('MATCHED','PLACED','UNMATCHED')
                 AND ${betsTable.placedAt} >= ${cutoff}`);
    if (unsettled.length === 0) return;

    for (const bet of unsettled) {
      const result = await getMarketResultWithBSP(bet.marketId);
      if (!result?.closed) continue;
      const winnerId = result.winnerSelectionId;
      const settledAt = new Date();
      const runner = result.runners.find(r => r.selectionId === bet.selectionId);

      if (runner?.status === "REMOVED") {
        await db.update(betsTable).set({
          status: "VOID",
          actualProfit: "0",
          settledAt,
        }).where(eq(betsTable.id, bet.id));
        continue;
      }
      if (winnerId == null) continue; // not determinable yet — retry next tick

      const stake = Number(bet.stakeAmount);
      const trigger = Number(bet.requestedOdds);
      const bsp = runner?.bsp ?? null;
      const settlePrice = bsp ?? trigger;
      const selectionWon = bet.selectionId === winnerId;

      // BACK only: win → stake × (price − 1); lose → −stake
      const actualProfit = selectionWon ? stake * (settlePrice - 1) : -stake;
      const status: "WON" | "LOST" = selectionWon ? "WON" : "LOST";

      const baseReason = (bet.aiReasoning ?? "").split("||")[0];
      await db.update(betsTable).set({
        status,
        matchedOdds: settlePrice.toFixed(2),
        actualProfit: actualProfit.toFixed(2),
        settledAt,
        aiReasoning: `${baseReason}||BSP:${bsp ?? "n/a"}||SETTLED@${settlePrice.toFixed(2)}`,
      }).where(eq(betsTable.id, bet.id));

      log(
        actualProfit >= 0 ? "info" : "warn",
        `Settled ${bet.eventName} ${bet.selectionName} @ ${settlePrice.toFixed(2)} → ${actualProfit >= 0 ? "+" : "-"}£${Math.abs(actualProfit).toFixed(2)} (${status})`,
        { marketId: bet.marketId, bsp, settlePrice, actualProfit },
      );
    }
  } catch (err) {
    logger.error({ err }, `[${LOG_TAG}] Settlement error`);
  }
}

function ensureSettlementTimer(): void {
  if (!settlementInterval) {
    settlementInterval = setInterval(() => {
      if (settlementRunning) return;
      settlementRunning = true;
      void runSettlement().finally(() => { settlementRunning = false; });
    }, SETTLEMENT_INTERVAL_MS);
  }
}

// ─── lifecycle ─────────────────────────────────────────────────────────────────

export async function startMartingaleBot(): Promise<void> {
  if (rt.running || rt.starting) return;
  rt.starting = true;
  try {
    await loadConfigFromDb();
  } finally {
    rt.starting = false;
  }
  if (rt.running) return;
  rt.running = true;
  rt.startedAt = new Date();
  db.update(botConfigTable).set({ martingaleIsRunning: true })
    .catch((err: unknown) => logger.error({ err }, `[${LOG_TAG}] Failed to persist running=true`));
  log("info", `Martingale Bot started — BACK fav ${rt.config.minOdds}-${rt.config.maxOdds}, start £${rt.config.startStake}, cap ${rt.config.maxDoubles} doubles (current stake £${rt.state.currentStake.toFixed(2)}, streak ${rt.state.lossStreak})`);
  void scheduleCycle();
  ensureSettlementTimer();
}

export async function stopMartingaleBot(): Promise<void> {
  if (!rt.running) return;
  rt.running = false;
  rt.startedAt = null;
  if (rt.cycleTimer) { clearTimeout(rt.cycleTimer); rt.cycleTimer = null; }
  db.update(botConfigTable).set({ martingaleIsRunning: false })
    .catch((err: unknown) => logger.error({ err }, `[${LOG_TAG}] Failed to persist running=false`));
  log("info", "Martingale Bot stopped");
  // Settlement timer intentionally remains alive so any pending bet still settles.
}

export async function resetMartingaleState(): Promise<void> {
  rt.state.currentStake = rt.config.startStake;
  rt.state.lossStreak = 0;
  // Don't reset lastProcessedBetId — we don't want to re-apply a historical bet on next cycle.
  // Move it to the latest settled bet so the engine considers state "in sync".
  try {
    const [latest] = await db
      .select({ id: betsTable.id })
      .from(betsTable)
      .where(sql`${betsTable.strategyName} = ${STRATEGY_NAME}
                 AND ${betsTable.status} IN ('WON','LOST','VOID')`)
      .orderBy(desc(betsTable.placedAt))
      .limit(1);
    rt.state.lastProcessedBetId = latest?.id ?? null;
  } catch {
    /* non-fatal */
  }
  await saveStateToDb();
  log("info", `State manually reset → £${rt.config.startStake.toFixed(2)}, streak 0`);
}

export async function autoResumeMartingaleBot(): Promise<void> {
  ensureSettlementTimer();
  try {
    const [row] = await db
      .select({ run: botConfigTable.martingaleIsRunning })
      .from(botConfigTable)
      .limit(1);
    if (row?.run) {
      logger.info(`[${LOG_TAG}] Auto-resuming`);
      await startMartingaleBot();
    }
  } catch (err) {
    logger.error({ err }, `[${LOG_TAG}] Failed to auto-resume`);
  }
}
