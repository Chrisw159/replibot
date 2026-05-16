import { logger } from "./logger";
import { db, betsTable, botLogsTable, botConfigTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  getSession,
  listMarkets,
  getMarketDetail,
  getMarketResultWithBSP,
  loginWithEnvCredentials,
} from "./betfair";

const NON_WIN_PATTERN =
  /each.?way|forecast|\(f\/c\)|\bFC\b|\bRFC\b|reverse\s|straight\s+f|combination\s+f|to be placed|\bTBP\b|match bet|daily win dist|without\s+\w|to win by|trained\s+winner|named\s+fav|jockey.*champion|specials|scorecast|wincast/i;

const MIN_MINS_BEFORE_START = 1;
const MAX_MINS_BEFORE_START = 4;

export type PaperStrategyKey = "back_fav" | "lay_short_fav";

export interface PaperConfig {
  stake: number;
  minOdds: number;
  maxOdds: number;
  minLiquidity: number;
  countryCodes: string[];
}

interface StrategyDef {
  key: PaperStrategyKey;
  strategyName: string; // betsTable.strategyName
  logTag: string;       // bot_logs prefix
  betSide: "BACK" | "LAY";
  configCol:    "paperBackFavConfigJson"  | "paperLayShortFavConfigJson";
  runningCol:   "paperBackFavIsRunning"   | "paperLayShortFavIsRunning";
  defaultConfig: PaperConfig;
}

const STRATEGIES: Record<PaperStrategyKey, StrategyDef> = {
  back_fav: {
    key: "back_fav",
    strategyName: "Paper Back Fav",
    logTag: "PAPER:BACK",
    betSide: "BACK",
    configCol:  "paperBackFavConfigJson",
    runningCol: "paperBackFavIsRunning",
    defaultConfig: {
      stake: 10,
      minOdds: 1.8,
      maxOdds: 3.5,
      minLiquidity: 8000,
      countryCodes: ["GB", "IE"],
    },
  },
  lay_short_fav: {
    key: "lay_short_fav",
    strategyName: "Paper Lay Short Fav",
    logTag: "PAPER:LAY",
    betSide: "LAY",
    configCol:  "paperLayShortFavConfigJson",
    runningCol: "paperLayShortFavIsRunning",
    defaultConfig: {
      stake: 10,
      minOdds: 1.01,
      maxOdds: 1.8,
      minLiquidity: 8000,
      countryCodes: ["GB", "IE"],
    },
  },
};

interface RuntimeState {
  running: boolean;
  starting: boolean;
  startedAt: Date | null;
  cycleTimer: ReturnType<typeof setTimeout> | null;
  config: PaperConfig;
}

const state: Record<PaperStrategyKey, RuntimeState> = {
  back_fav:       { running: false, starting: false, startedAt: null, cycleTimer: null, config: { ...STRATEGIES.back_fav.defaultConfig } },
  lay_short_fav:  { running: false, starting: false, startedAt: null, cycleTimer: null, config: { ...STRATEGIES.lay_short_fav.defaultConfig } },
};

// One shared settlement timer settling both strategies
let settlementInterval: ReturnType<typeof setInterval> | null = null;
const processing = new Set<string>();

export function isPaperRunning(key: PaperStrategyKey): boolean {
  return state[key].running;
}
export function getPaperStartedAt(key: PaperStrategyKey): Date | null {
  return state[key].startedAt;
}
export function getPaperConfig(key: PaperStrategyKey): PaperConfig {
  return { ...state[key].config };
}
export function getPaperStrategyName(key: PaperStrategyKey): string {
  return STRATEGIES[key].strategyName;
}
export function getPaperBetSide(key: PaperStrategyKey): "BACK" | "LAY" {
  return STRATEGIES[key].betSide;
}

export function setPaperConfig(key: PaperStrategyKey, patch: Partial<PaperConfig>): void {
  state[key].config = { ...state[key].config, ...patch };
}

export async function savePaperConfigToDb(key: PaperStrategyKey): Promise<void> {
  const def = STRATEGIES[key];
  try {
    const [row] = await db.select({ id: botConfigTable.id }).from(botConfigTable).limit(1);
    if (row) {
      await db
        .update(botConfigTable)
        .set({ [def.configCol]: state[key].config as unknown as Record<string, unknown> })
        .where(eq(botConfigTable.id, row.id));
    } else {
      await db.insert(botConfigTable).values({
        [def.configCol]: state[key].config as unknown as Record<string, unknown>,
      });
    }
  } catch (err) {
    logger.error({ err }, `[${def.logTag}] Failed to save config to DB`);
  }
}

async function loadPaperConfigFromDb(key: PaperStrategyKey): Promise<void> {
  const def = STRATEGIES[key];
  try {
    const [row] = await db
      .select({ json: botConfigTable[def.configCol] })
      .from(botConfigTable)
      .limit(1);
    const saved = row?.json as Partial<PaperConfig> | null | undefined;
    if (saved) {
      const cfg = state[key].config;
      if (typeof saved.stake === "number") cfg.stake = saved.stake;
      if (typeof saved.minOdds === "number") cfg.minOdds = saved.minOdds;
      if (typeof saved.maxOdds === "number") cfg.maxOdds = saved.maxOdds;
      if (typeof saved.minLiquidity === "number") cfg.minLiquidity = saved.minLiquidity;
      if (Array.isArray(saved.countryCodes)) cfg.countryCodes = saved.countryCodes;
      logger.info({ key, config: cfg }, `[${def.logTag}] Loaded config from DB`);
    }
  } catch (err) {
    logger.error({ err }, `[${def.logTag}] Failed to load config from DB`);
  }
}

function log(key: PaperStrategyKey, level: string, message: string, metadata?: Record<string, unknown>): void {
  const fullMessage = `[${STRATEGIES[key].logTag}] ${message}`;
  logger.info({ level, metadata }, fullMessage);
  db.insert(botLogsTable).values({
    level,
    message: fullMessage,
    metadata: metadata ? JSON.stringify(metadata) : null,
  }).catch((err: unknown) => logger.error({ err }, `[${STRATEGIES[key].logTag}] Failed to write log to DB`));
}

async function runPaperCycle(key: PaperStrategyKey): Promise<void> {
  const s = state[key];
  const def = STRATEGIES[key];
  if (!s.running) return;
  try {
    if (!getSession()) {
      const r = await loginWithEnvCredentials();
      if (!r.success) {
        log(key, "warn", "Not connected to Betfair — skipping cycle");
        return;
      }
      log(key, "info", "Auto-connected to Betfair");
    }

    const now = new Date();
    const fromMs = now.getTime() + MIN_MINS_BEFORE_START * 60_000;
    const toMs   = now.getTime() + MAX_MINS_BEFORE_START * 60_000;

    const markets = await listMarkets({
      eventTypeId: "7",
      countryCodes: s.config.countryCodes,
      marketType: "WIN",
      hoursAhead: MAX_MINS_BEFORE_START / 60,
    });

    const inWindow = markets.filter(m => {
      const startMs = new Date(m.marketStartTime).getTime();
      return startMs >= fromMs && startMs <= toMs;
    });

    const candidates = inWindow.filter(m => {
      if (NON_WIN_PATTERN.test(m.marketName)) return false;
      const procKey = `${key}:${m.marketId}`;
      if (processing.has(procKey)) return false;
      return true;
    });

    // Skip markets we've already bet on for THIS strategy
    const alreadyBet = candidates.length > 0
      ? await db
          .select({ marketId: betsTable.marketId })
          .from(betsTable)
          .where(
            sql`${betsTable.strategyName} = ${def.strategyName}
                AND ${betsTable.marketId} = ANY(ARRAY[${sql.join(
                  candidates.map(m => sql`${m.marketId}`),
                  sql`, `,
                )}])`,
          )
      : [];
    const alreadyBetIds = new Set(alreadyBet.map(r => r.marketId));
    const fresh = candidates.filter(m => !alreadyBetIds.has(m.marketId));

    log(key, "info",
      `Cycle — ${markets.length} fetched, ${inWindow.length} in window, ${fresh.length} fresh`,
    );

    for (const m of fresh) {
      const procKey = `${key}:${m.marketId}`;
      processing.add(procKey);
      try {
        await runPaperMarket(key, m.marketId, m.eventName, m.marketName);
      } catch (err) {
        log(key, "error", `Error processing ${m.eventName}: ${String(err)}`);
      } finally {
        processing.delete(procKey);
      }
    }
  } catch (err) {
    log(key, "error", `Cycle error: ${String(err)}`);
  }
}

async function schedulePaperCycle(key: PaperStrategyKey): Promise<void> {
  const s = state[key];
  if (!s.running) return;
  const INTERVAL_MS = 60_000;
  await runPaperCycle(key);
  if (s.running) {
    s.cycleTimer = setTimeout(() => { void schedulePaperCycle(key); }, INTERVAL_MS);
  }
}

async function runPaperMarket(
  key: PaperStrategyKey,
  marketId: string,
  eventName: string,
  marketName: string,
): Promise<void> {
  const s = state[key];
  const def = STRATEGIES[key];
  const cfg = s.config;

  const marketDetail = await getMarketDetail(marketId);
  if (!marketDetail) return;

  if (marketDetail.totalMatched < cfg.minLiquidity) {
    log(key, "info",
      `Skipping ${eventName} — liquidity £${marketDetail.totalMatched.toFixed(0)} < £${cfg.minLiquidity}`,
    );
    return;
  }

  // Identify the favourite = ACTIVE runner with the lowest bestBackPrice
  const activeRunners = marketDetail.runners.filter(r => r.status === "ACTIVE" && (r.bestBackPrice ?? 0) > 1);
  if (activeRunners.length < 2) {
    log(key, "info", `Skipping ${eventName} — only ${activeRunners.length} active runner(s) with prices`);
    return;
  }

  const sorted = [...activeRunners].sort((a, b) => (a.bestBackPrice ?? 999) - (b.bestBackPrice ?? 999));
  const fav = sorted[0];
  const favBack = fav.bestBackPrice ?? 0;
  const favLay  = fav.bestLayPrice  ?? favBack;

  // Trigger price = the side we will bet on. BACK strategies look at back price,
  // LAY strategies look at lay price (what we'd need to lay at). For the
  // "is this the right favourite price?" criterion we use the back price,
  // which is the standard exchange "fav price" indicator.
  const favPrice = favBack;
  if (favPrice < cfg.minOdds || favPrice >= cfg.maxOdds) {
    log(key, "info",
      `Skipping ${eventName} — fav ${fav.runnerName} @ ${favPrice} outside [${cfg.minOdds}, ${cfg.maxOdds})`,
    );
    return;
  }

  const triggerPrice = def.betSide === "BACK" ? favBack : favLay;
  const stake = cfg.stake;

  log(key, "info",
    `${def.betSide} ${fav.runnerName} £${stake.toFixed(2)} @ ${triggerPrice} in ${eventName} [PAPER]`,
    { marketId, selectionId: fav.selectionId, fav: fav.runnerName, triggerPrice, stake },
  );

  await db.insert(betsTable).values({
    strategyId: null,
    strategyName: def.strategyName,
    marketId,
    marketName,
    eventName,
    selectionId: fav.selectionId,
    selectionName: fav.runnerName,
    betType: def.betSide,
    requestedOdds: triggerPrice.toFixed(2),
    matchedOdds: null,
    stakeAmount: stake.toFixed(2),
    potentialProfit: def.betSide === "BACK"
      ? (stake * (triggerPrice - 1)).toFixed(2)
      : stake.toFixed(2),
    status: "MATCHED",
    aiReasoning: `[${def.logTag}] ${def.betSide} fav ${fav.runnerName} @ ${triggerPrice} (trigger). Settled at BSP.`,
    betId: `${def.logTag}-${Date.now()}-${fav.selectionId}`,
  });
}

async function runPaperSettlement(): Promise<void> {
  if (!getSession()) return;
  // Settle paper bets for both strategies in one pass. We deliberately do
  // NOT gate on `running` here: bets placed before a bot is stopped must
  // still settle after their market closes, even if both bots are stopped.
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const unsettled = await db
      .select()
      .from(betsTable)
      .where(
        sql`${betsTable.strategyName} IN ('Paper Back Fav','Paper Lay Short Fav')
            AND ${betsTable.status} IN ('MATCHED','PLACED','UNMATCHED')
            AND ${betsTable.placedAt} >= ${cutoff}`,
      );
    if (unsettled.length === 0) return;

    const byMarket = new Map<string, typeof unsettled>();
    for (const bet of unsettled) {
      const list = byMarket.get(bet.marketId) ?? [];
      list.push(bet);
      byMarket.set(bet.marketId, list);
    }

    for (const [marketId, bets] of byMarket) {
      const result = await getMarketResultWithBSP(marketId);
      if (!result?.closed) continue;
      const winnerId = result.winnerSelectionId;
      const settledAt = new Date();

      for (const bet of bets) {
        const def = bet.strategyName === "Paper Back Fav" ? STRATEGIES.back_fav : STRATEGIES.lay_short_fav;
        const stake = Number(bet.stakeAmount);
        const trigger = Number(bet.requestedOdds);
        const runner = result.runners.find(r => r.selectionId === bet.selectionId);

        // VOID if runner was removed
        if (runner?.status === "REMOVED") {
          await db.update(betsTable).set({
            status: "VOID",
            actualProfit: "0",
            settledAt,
          }).where(eq(betsTable.id, bet.id));
          continue;
        }

        // Cannot determine winner yet — leave pending and retry next settlement tick.
        // Avoids fabricating LOST outcomes when the result feed hasn't published a winner.
        if (winnerId == null) {
          continue;
        }

        // Settlement price: prefer BSP; fall back to trigger price if BSP unavailable
        const bsp = runner?.bsp ?? null;
        const settlePrice = bsp ?? trigger;
        const selectionWon = bet.selectionId === winnerId;

        let actualProfit: number;
        let status: "WON" | "LOST";
        if (def.betSide === "BACK") {
          // BACK: win → stake × (price − 1); lose → −stake
          actualProfit = selectionWon ? stake * (settlePrice - 1) : -stake;
          status = selectionWon ? "WON" : "LOST";
        } else {
          // LAY: horse wins → −liability; horse loses → +stake
          actualProfit = selectionWon ? -(stake * (settlePrice - 1)) : stake;
          status = selectionWon ? "LOST" : "WON";
        }

        const baseReason = (bet.aiReasoning ?? "").split("||")[0];
        await db.update(betsTable).set({
          status,
          matchedOdds: settlePrice.toFixed(2),
          actualProfit: actualProfit.toFixed(2),
          settledAt,
          aiReasoning: `${baseReason}||BSP:${bsp ?? "n/a"}||SETTLED@${settlePrice.toFixed(2)}`,
        }).where(eq(betsTable.id, bet.id));

        log(
          def.key,
          actualProfit >= 0 ? "info" : "warn",
          `Settled ${bet.eventName} ${bet.selectionName} ${def.betSide} @ ${settlePrice.toFixed(2)} → ${actualProfit >= 0 ? "+" : ""}£${actualProfit.toFixed(2)} (${status})`,
          { marketId, bsp, settlePrice, actualProfit },
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "[PAPER] Settlement error");
  }
}

export async function startPaperBot(key: PaperStrategyKey): Promise<void> {
  const s = state[key];
  const def = STRATEGIES[key];
  if (s.running || s.starting) return;
  s.starting = true;
  try {
    await loadPaperConfigFromDb(key);
  } finally {
    s.starting = false;
  }
  if (s.running) return; // raced with another start that finished first
  s.running = true;
  s.startedAt = new Date();
  db.update(botConfigTable).set({ [def.runningCol]: true })
    .catch((err: unknown) => logger.error({ err }, `[${def.logTag}] Failed to persist running=true`));
  log(key, "info", `${def.strategyName} started`);
  void schedulePaperCycle(key);
  ensureSettlementTimer();
}

export async function stopPaperBot(key: PaperStrategyKey): Promise<void> {
  const s = state[key];
  const def = STRATEGIES[key];
  if (!s.running) return;
  s.running = false;
  s.startedAt = null;
  if (s.cycleTimer) { clearTimeout(s.cycleTimer); s.cycleTimer = null; }
  db.update(botConfigTable).set({ [def.runningCol]: false })
    .catch((err: unknown) => logger.error({ err }, `[${def.logTag}] Failed to persist running=false`));
  log(key, "info", `${def.strategyName} stopped`);
  // Intentionally leave the settlement timer running so any bets placed
  // before the stop still settle after their market closes.
}

function ensureSettlementTimer(): void {
  if (!settlementInterval) {
    settlementInterval = setInterval(() => { void runPaperSettlement(); }, 2 * 60_000);
  }
}

export async function autoResumePaperBots(): Promise<void> {
  // Always start the settlement loop so paper bets placed before a restart
  // (or before the user stops a bot) will settle once their markets close.
  ensureSettlementTimer();
  try {
    const [row] = await db.select({
      back: botConfigTable.paperBackFavIsRunning,
      lay:  botConfigTable.paperLayShortFavIsRunning,
    }).from(botConfigTable).limit(1);
    if (row?.back) {
      logger.info("[PAPER:BACK] Auto-resuming");
      await startPaperBot("back_fav");
    }
    if (row?.lay) {
      logger.info("[PAPER:LAY] Auto-resuming");
      await startPaperBot("lay_short_fav");
    }
  } catch (err) {
    logger.error({ err }, "[PAPER] Failed to auto-resume");
  }
}
