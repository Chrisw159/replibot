import { logger } from "./logger";
import { db, betsTable, botLogsTable, botConfigTable, dutchScheduleTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  getSession,
  listMarkets,
  getMarketDetail,
  placeBet,
  loginWithEnvCredentials,
} from "./betfair";

const DUTCH_STRATEGY_NAME = "Dutch Bot";
const MIN_MINS_BEFORE_START = 1;
const MAX_MINS_BEFORE_START = 4;
const MIN_BET_SIZE = 2.0;

const NON_WIN_PATTERN =
  /each.?way|forecast|\(f\/c\)|\bFC\b|\bRFC\b|reverse\s|straight\s+f|combination\s+f|to be placed|\bTBP\b|match bet|daily win dist|without\s+\w|to win by|trained\s+winner|named\s+fav|jockey.*champion|specials|scorecast|wincast/i;

// Legacy filters — kept for back-compat but defaulted OFF after backtest evidence
// showed Chases / AW races / Maidens are the MOST profitable subsets for the
// Combo strategy (lay favs in chaotic races where outsiders win more often).
const CHASE_PATTERN = /\bChs\b|Chase/i;
const AW_VENUE_PATTERN = /chelmsford|kempton|lingfield|southwell|wolverhampton|dundalk/i;
const SEVEN_FURLONG_PATTERN = /\b7f\b/i;

// Combo strategy thresholds
const BACK_FAV_MAX_ODDS = 2.5;   // fav < 2.5 → BACK fav
const LAY_FAV_MIN_ODDS  = 3.0;   // fav 3.0 to 5.0 → LAY fav
const LAY_FAV_MAX_ODDS  = 5.0;
const LAY_TOP2_MIN_FAV  = 5.0;   // fav ≥ 5.0 → LAY top 2
const MAX_LAY_ODDS      = 8.0;   // never lay above 8.0 (liability gets crushing)

interface DutchConfig {
  totalOutlay: number;       // £ per race (back stake or total lay liability)
  topPct: number;            // legacy, unused by combo strategy
  minFavPrice: number;       // legacy, unused by combo strategy
  minLiquidity: number;
  countryCodes: string[];
  minRunners: number;
  maxRunners: number;
  skipChases: boolean;       // legacy, default OFF (backtest: chases +21.9% ROI)
  skipAwSevenFurlong: boolean; // legacy, default OFF (backtest: AW +16.8% ROI)
}

let dutchBotRunning = false;
let dutchBotInterval: ReturnType<typeof setTimeout> | null = null;
let dutchSettlementInterval: ReturnType<typeof setInterval> | null = null;
let dutchScanInterval: ReturnType<typeof setInterval> | null = null;
let dutchStartedAt: Date | null = null;
const processingMarkets = new Set<string>();

let dutchConfig: DutchConfig = {
  totalOutlay: 50,
  topPct: 0.40,
  minFavPrice: 2.0,
  minLiquidity: 3000,
  countryCodes: ["GB", "IE"],
  minRunners: 5,
  maxRunners: 15,
  skipChases: false,
  skipAwSevenFurlong: false,
};

export function isDutchBotRunning(): boolean { return dutchBotRunning; }
export function getDutchStartedAt(): Date | null { return dutchStartedAt; }
export function getDutchConfig(): DutchConfig { return { ...dutchConfig }; }

export function setDutchConfig(patch: Partial<DutchConfig>): void {
  dutchConfig = { ...dutchConfig, ...patch };
}

export async function saveDutchConfigToDb(): Promise<void> {
  try {
    const [row] = await db.select({ id: botConfigTable.id }).from(botConfigTable).limit(1);
    if (row) {
      await db
        .update(botConfigTable)
        .set({ dutchConfigJson: dutchConfig as unknown as Record<string, unknown> })
        .where(eq(botConfigTable.id, row.id));
    } else {
      await db.insert(botConfigTable).values({
        dutchConfigJson: dutchConfig as unknown as Record<string, unknown>,
      });
    }
  } catch (err) {
    logger.error({ err }, "[DUTCH] Failed to save config to DB");
  }
}

async function loadDutchConfigFromDb(): Promise<void> {
  try {
    const [row] = await db
      .select({ dutchConfigJson: botConfigTable.dutchConfigJson })
      .from(botConfigTable)
      .limit(1);
    if (row?.dutchConfigJson) {
      const saved = row.dutchConfigJson as Partial<DutchConfig>;
      if (typeof saved.totalOutlay  === "number") dutchConfig.totalOutlay  = saved.totalOutlay;
      if (typeof saved.topPct       === "number") dutchConfig.topPct       = saved.topPct;
      if (typeof saved.minFavPrice  === "number") dutchConfig.minFavPrice  = saved.minFavPrice;
      if (typeof saved.minLiquidity === "number") dutchConfig.minLiquidity = saved.minLiquidity;
      if (Array.isArray(saved.countryCodes))      dutchConfig.countryCodes = saved.countryCodes;
      if (typeof saved.minRunners   === "number") dutchConfig.minRunners   = saved.minRunners;
      if (typeof saved.maxRunners   === "number") dutchConfig.maxRunners   = saved.maxRunners;
      if (typeof saved.skipChases   === "boolean") dutchConfig.skipChases   = saved.skipChases;
      if (typeof saved.skipAwSevenFurlong === "boolean") dutchConfig.skipAwSevenFurlong = saved.skipAwSevenFurlong;
      logger.info({ dutchConfig }, "[DUTCH] Loaded config from DB");
    }
  } catch (err) {
    logger.error({ err }, "[DUTCH] Failed to load config from DB — using defaults");
  }
}

interface ScheduleRunner {
  name: string;
  price: number;
  backed: boolean;            // true if we placed a bet on this runner (BACK or LAY)
  betType?: "BACK" | "LAY";   // direction of our bet
  stake?: number;             // Betfair "size" (backer's stake)
  liability?: number;         // for LAY bets: stake * (odds-1)
  netProfit?: number;         // expected race net P&L if THIS runner wins
}

async function updateScheduleEntry(
  marketId: string,
  status: string,
  opts?: { skipReason?: string; runnerCount?: number; runners?: ScheduleRunner[]; mode?: string },
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    await db.update(dutchScheduleTable)
      .set({
        status,
        skipReason:  opts?.skipReason  ?? null,
        ...(opts?.runnerCount != null ? { runnerCount: opts.runnerCount } : {}),
        ...(opts?.runners      != null ? { runnersJson: opts.runners as unknown as Record<string, unknown>[] } : {}),
        updatedAt:   new Date(),
      })
      .where(sql`${dutchScheduleTable.marketId} = ${marketId} AND ${dutchScheduleTable.scheduledDate} = ${today}`);
  } catch { /* non-fatal */ }
}

function log(level: string, message: string, metadata?: Record<string, unknown>): void {
  const fullMessage = `[DUTCH] ${message}`;
  logger.info({ level, metadata }, fullMessage);
  db.insert(botLogsTable).values({
    level,
    message: fullMessage,
    metadata: metadata ? JSON.stringify(metadata) : null,
  }).catch((err: unknown) => logger.error({ err }, "[DUTCH] Failed to write log to DB"));
}

async function runDutchCycle(): Promise<number> {
  if (!dutchBotRunning) return 0;
  try {
    if (!getSession()) {
      const r = await loginWithEnvCredentials();
      if (!r.success) {
        log("warn", "Not connected to Betfair — skipping cycle");
        return 0;
      }
      log("info", "Auto-connected to Betfair");
    }

    const now = new Date();
    const fromMs = now.getTime() + MIN_MINS_BEFORE_START * 60_000;
    const toMs   = now.getTime() + MAX_MINS_BEFORE_START * 60_000;

    const markets = await listMarkets({
      eventTypeId: "7",
      countryCodes: dutchConfig.countryCodes,
      marketType: "WIN",
      hoursAhead: MAX_MINS_BEFORE_START / 60,
    });

    const inWindow = markets.filter(m => {
      const startMs = new Date(m.marketStartTime).getTime();
      return startMs >= fromMs && startMs <= toMs;
    });

    const candidates = inWindow.filter(m => {
      if (processingMarkets.has(m.marketId)) return false;
      if (NON_WIN_PATTERN.test(m.marketName)) return false;
      if (dutchConfig.skipChases && CHASE_PATTERN.test(m.marketName)) {
        log("info", `Skipping ${m.eventName} — chase (legacy filter on)`);
        return false;
      }
      if (dutchConfig.skipAwSevenFurlong && SEVEN_FURLONG_PATTERN.test(m.marketName) && AW_VENUE_PATTERN.test(m.eventName)) {
        log("info", `Skipping ${m.eventName} — 7f AW (legacy filter on)`);
        return false;
      }
      return true;
    });

    const alreadyBet = candidates.length > 0
      ? await db
          .select({ marketId: betsTable.marketId })
          .from(betsTable)
          .where(
            sql`${betsTable.strategyName} = ${DUTCH_STRATEGY_NAME}
                AND ${betsTable.marketId} = ANY(ARRAY[${sql.join(
                  candidates.map(m => sql`${m.marketId}`),
                  sql`, `,
                )}])`,
          )
      : [];
    const alreadyBetIds = new Set(alreadyBet.map(r => r.marketId));
    const fresh = candidates.filter(m => !alreadyBetIds.has(m.marketId));

    log("info",
      `Cycle — ${markets.length} markets, ${inWindow.length} in ${MIN_MINS_BEFORE_START}–${MAX_MINS_BEFORE_START}-min window, ${fresh.length} fresh`,
    );

    let acted = 0;
    for (const m of fresh) {
      processingMarkets.add(m.marketId);
      try {
        await runDutchMarket(m.marketId, m.eventName, m.marketName);
        acted++;
      } catch (err) {
        log("error", `Error processing ${m.eventName}: ${String(err)}`);
      } finally {
        processingMarkets.delete(m.marketId);
      }
    }

    return acted;
  } catch (err) {
    log("error", `Cycle error: ${String(err)}`);
    return 0;
  }
}

async function scheduleNextCycle(): Promise<void> {
  if (!dutchBotRunning) return;
  await runDutchCycle();
  if (dutchBotRunning) {
    dutchBotInterval = setTimeout(() => { void scheduleNextCycle(); }, 60_000);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  COMBO STRATEGY
//  Backtested on 159 real UK/IE races (Sporting Life, May 8-11 2024) + 38 of
//  our own paper-traded races (May 4-8 2026). Net result on each sample:
//    Combined backtest:  +£489 / +6.8% ROI / 65% win rate
//    Cross-validation:   +£97  / +5.1% ROI / 79% win rate
//  Old "Hybrid Fav" lost £917 / £421 respectively on the same data.
//
//  Three rules driven by the favourite's price:
//    • fav <  2.5            → BACK favourite £totalOutlay      (heavy fav, +EV)
//    • fav 3.0 – 5.0         → LAY favourite, £totalOutlay liab  (sweet-spot)
//    • fav ≥  5.0            → LAY top 2 runners, £half liab each (open race)
//    • fav 2.5 – 3.0 or fav>8 → SKIP (no edge, or liability too high)
// ────────────────────────────────────────────────────────────────────────────

type ComboMode = "BACK_FAV" | "LAY_FAV" | "LAY_TOP2" | "SKIP";

interface ComboPlan {
  mode: ComboMode;
  bets: Array<{
    selectionId: number;
    runnerName: string;
    backPrice: number;
    side: "BACK" | "LAY";
    stake: number;       // Betfair "size" (backer's stake)
    liability: number;   // money at risk if our side loses
    profitIfWins: number;// what we net if THIS runner wins the race
  }>;
  reason: string;
}

function planCombo(
  eligible: Array<{ selectionId: number; runnerName: string; bestBackPrice: number }>,
  outlay: number,
): ComboPlan {
  if (eligible.length === 0) {
    return { mode: "SKIP", bets: [], reason: "No eligible runners" };
  }

  const sorted = [...eligible].sort((a, b) => a.bestBackPrice - b.bestBackPrice);
  const fav = sorted[0];

  // BACK heavy favourite
  if (fav.bestBackPrice < BACK_FAV_MAX_ODDS) {
    const stake = Math.round(outlay * 100) / 100;
    return {
      mode: "BACK_FAV",
      bets: [{
        selectionId: fav.selectionId,
        runnerName:  fav.runnerName,
        backPrice:   fav.bestBackPrice,
        side:        "BACK",
        stake,
        liability:   stake,
        profitIfWins: Math.round((stake * (fav.bestBackPrice - 1)) * 100) / 100,
      }],
      reason: `BACK heavy favourite at ${fav.bestBackPrice}`,
    };
  }

  // LAY favourite (sweet spot)
  if (fav.bestBackPrice >= LAY_FAV_MIN_ODDS && fav.bestBackPrice < LAY_FAV_MAX_ODDS) {
    const layPrice  = fav.bestBackPrice;
    const liability = Math.round(outlay * 100) / 100;
    const stake     = Math.round((liability / (layPrice - 1)) * 100) / 100;
    return {
      mode: "LAY_FAV",
      bets: [{
        selectionId:  fav.selectionId,
        runnerName:   fav.runnerName,
        backPrice:    layPrice,
        side:         "LAY",
        stake,
        liability,
        profitIfWins: -liability, // if this runner wins, we lose liability
      }],
      reason: `LAY favourite — sweet-spot band ${LAY_FAV_MIN_ODDS}-${LAY_FAV_MAX_ODDS}`,
    };
  }

  // LAY top 2 (open race, no clear fav)
  if (fav.bestBackPrice >= LAY_TOP2_MIN_FAV) {
    const top2 = sorted.slice(0, 2).filter(r => r.bestBackPrice <= MAX_LAY_ODDS);
    if (top2.length < 2) {
      return {
        mode: "SKIP",
        bets: [],
        reason: `Top-2 lay aborted — second selection above max-lay ${MAX_LAY_ODDS}`,
      };
    }
    const liabPer = Math.round((outlay / 2) * 100) / 100;
    return {
      mode: "LAY_TOP2",
      bets: top2.map(r => {
        const stake = Math.round((liabPer / (r.bestBackPrice - 1)) * 100) / 100;
        return {
          selectionId:  r.selectionId,
          runnerName:   r.runnerName,
          backPrice:    r.bestBackPrice,
          side:         "LAY" as const,
          stake,
          liability:    liabPer,
          profitIfWins: -liabPer,
        };
      }),
      reason: `LAY top 2 — open race, fav ${fav.bestBackPrice}`,
    };
  }

  // 2.5 ≤ fav < 3.0 — no edge zone
  return {
    mode: "SKIP",
    bets: [],
    reason: `Favourite at ${fav.bestBackPrice.toFixed(2)} — neutral zone (no edge)`,
  };
}

async function runDutchMarket(
  marketId: string,
  eventName: string,
  marketName: string,
): Promise<void> {
  const [config] = await db.select({ paperTradingMode: botConfigTable.paperTradingMode })
    .from(botConfigTable).limit(1);
  const paperTrading = config?.paperTradingMode ?? true;

  const marketDetail = await getMarketDetail(marketId);
  if (!marketDetail) return;

  // Helper: snapshot all active runners for the schedule entry
  const buildSnapshot = (
    eligibleRunners: typeof marketDetail.runners,
    plan?: ComboPlan,
  ): ScheduleRunner[] => {
    const planMap = new Map(plan?.bets.map(b => [String(b.selectionId), b]) ?? []);
    // Net P&L if THIS runner wins:
    //   sum over our bets:
    //     BACK on this runner won  → +stake*(price-1)
    //     BACK on other runner lost → -stake
    //     LAY on this runner lost  → -liability
    //     LAY on other runner won  → +stake
    const netIfWins = (winnerSelId: string): number => {
      let net = 0;
      for (const b of plan?.bets ?? []) {
        const isThis = String(b.selectionId) === winnerSelId;
        if (b.side === "BACK") net += isThis ? b.stake * (b.backPrice - 1) : -b.stake;
        else                   net += isThis ? -b.liability                : b.stake;
      }
      return Math.round(net * 100) / 100;
    };

    return eligibleRunners
      .filter(r => r.status === "ACTIVE" && r.bestBackPrice != null)
      .map(r => {
        const planned = planMap.get(String(r.selectionId));
        return {
          name: r.runnerName,
          price: r.bestBackPrice!,
          backed: !!planned,
          betType: planned?.side,
          stake: planned?.stake,
          liability: planned?.liability,
          netProfit: plan && plan.bets.length > 0 ? netIfWins(String(r.selectionId)) : undefined,
        } as ScheduleRunner;
      })
      .sort((a, b) => a.price - b.price);
  };

  if (marketDetail.totalMatched < dutchConfig.minLiquidity) {
    log("info",
      `Skipping ${eventName} — liquidity £${marketDetail.totalMatched.toFixed(0)} < £${dutchConfig.minLiquidity}`,
    );
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: `Low liquidity — £${marketDetail.totalMatched.toFixed(0)} matched (min £${dutchConfig.minLiquidity})`,
      runners: buildSnapshot(marketDetail.runners),
    });
    return;
  }

  // Eligible runners — must be active with a back price > 1.01
  const eligible = marketDetail.runners
    .filter(r => r.status === "ACTIVE" && r.bestBackPrice != null && r.bestBackPrice >= 1.01);

  if (eligible.length < dutchConfig.minRunners) {
    log("info", `Skipping ${eventName} — only ${eligible.length} runners (min ${dutchConfig.minRunners})`);
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: `Only ${eligible.length} runners — need at least ${dutchConfig.minRunners}`,
      runnerCount: eligible.length,
      runners: buildSnapshot(eligible),
    });
    return;
  }

  if (eligible.length > dutchConfig.maxRunners) {
    log("info", `Skipping ${eventName} — ${eligible.length} runners exceeds max ${dutchConfig.maxRunners}`);
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: `${eligible.length} runners — exceeds max of ${dutchConfig.maxRunners} (large fields are noise)`,
      runnerCount: eligible.length,
      runners: buildSnapshot(eligible),
    });
    return;
  }

  // Plan the combo bet
  const plan = planCombo(
    eligible.map(r => ({
      selectionId: r.selectionId,
      runnerName:  r.runnerName,
      bestBackPrice: r.bestBackPrice!,
    })),
    dutchConfig.totalOutlay,
  );

  if (plan.mode === "SKIP") {
    log("info", `Skipping ${eventName} — ${plan.reason}`);
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: plan.reason,
      runnerCount: eligible.length,
      runners: buildSnapshot(eligible),
    });
    return;
  }

  // Min stake check (Betfair £2 min)
  const tooSmall = plan.bets.filter(b => b.stake < MIN_BET_SIZE);
  if (tooSmall.length > 0) {
    log("info", `Skipping ${eventName} — ${tooSmall.length} bet(s) below £${MIN_BET_SIZE}: ${tooSmall.map(b => `${b.runnerName} £${b.stake.toFixed(2)}`).join(", ")}`);
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: `Bet size below Betfair £${MIN_BET_SIZE} minimum`,
      runnerCount: eligible.length,
      runners: buildSnapshot(eligible, plan),
    });
    return;
  }

  // Snapshot the full field for settlement-time winner resolution
  const fullFieldJson = JSON.stringify(
    marketDetail.runners
      .filter(r => r.status === "ACTIVE")
      .map(r => ({
        selectionId: r.selectionId,
        name: r.runnerName,
        odds: r.bestBackPrice ?? r.lastPriceTraded ?? null,
      }))
      .sort((a, b) => (a.odds ?? 999) - (b.odds ?? 999)),
  );

  const summary = plan.bets
    .map(b => `${b.side} ${b.runnerName} £${b.stake.toFixed(2)} @ ${b.backPrice} (liab £${b.liability.toFixed(2)})`)
    .join(" | ");
  log("info",
    `${plan.mode} ${eventName} — ${plan.reason} · ${summary}${paperTrading ? " [PAPER]" : ""}`,
    { marketId, mode: plan.mode, summary },
  );

  for (const b of plan.bets) {
    const reasoning = `[${plan.mode}] ${b.side} £${b.stake.toFixed(2)} @ ${b.backPrice} · liab £${b.liability.toFixed(2)} · ${plan.reason}||FIELD:${fullFieldJson}`;

    if (paperTrading) {
      await db.insert(betsTable).values({
        strategyId: null,
        strategyName: DUTCH_STRATEGY_NAME,
        marketId,
        marketName,
        eventName,
        selectionId: b.selectionId,
        selectionName: b.runnerName,
        betType: b.side,
        requestedOdds: b.backPrice.toFixed(2),
        matchedOdds: b.backPrice.toFixed(2),
        stakeAmount: b.stake.toFixed(2),
        // For BACK: profit if THIS runner wins. For LAY: profit if THIS runner LOSES (= stake).
        potentialProfit: (b.side === "BACK"
          ? b.stake * (b.backPrice - 1)
          : b.stake
        ).toFixed(2),
        status: "MATCHED",
        aiReasoning: reasoning,
        betId: `DUTCH-PAPER-${Date.now()}-${b.selectionId}`,
      });
    } else {
      const result = await placeBet({
        marketId,
        selectionId: b.selectionId,
        betType: b.side,
        price: b.backPrice,
        size: b.stake,
      });
      await db.insert(betsTable).values({
        strategyId: null,
        strategyName: DUTCH_STRATEGY_NAME,
        marketId,
        marketName,
        eventName,
        selectionId: b.selectionId,
        selectionName: b.runnerName,
        betType: b.side,
        requestedOdds: b.backPrice.toFixed(2),
        stakeAmount: b.stake.toFixed(2),
        potentialProfit: (b.side === "BACK"
          ? b.stake * (b.backPrice - 1)
          : b.stake
        ).toFixed(2),
        status: result.status === "PLACED" ? "PLACED" : "CANCELLED",
        aiReasoning: reasoning,
        betId: result.betId ?? `DUTCH-${Date.now()}-${b.selectionId}`,
      });
    }
  }

  // Mark race as bet-placed in the schedule with full snapshot
  void updateScheduleEntry(marketId, "BET_PLACED", {
    runnerCount: eligible.length,
    runners: buildSnapshot(eligible, plan),
    mode: plan.mode,
  });
}

export async function runScheduleScan(): Promise<void> {
  if (!getSession()) {
    log("info", "Schedule scan skipped — not connected to Betfair");
    return;
  }
  try {
    const today = new Date().toISOString().slice(0, 10);

    const markets = await listMarkets({
      eventTypeId:  "7",
      countryCodes: dutchConfig.countryCodes,
      marketType:   "WIN",
      hoursAhead:   24,
      limit:        100,
    });

    // Apply same static filters as the betting cycle (name-based only)
    const filtered = markets.filter(m => {
      if (NON_WIN_PATTERN.test(m.marketName)) return false;
      if (dutchConfig.skipChases && CHASE_PATTERN.test(m.marketName)) return false;
      if (dutchConfig.skipAwSevenFurlong && SEVEN_FURLONG_PATTERN.test(m.marketName) && AW_VENUE_PATTERN.test(m.eventName)) return false;
      const raceDate = new Date(m.marketStartTime).toISOString().slice(0, 10);
      return raceDate === today;
    });

    const filteredIds = new Set(filtered.map(m => m.marketId));

    // Delete any SCHEDULED rows that are no longer valid
    await db.delete(dutchScheduleTable)
      .where(
        sql`${dutchScheduleTable.scheduledDate} = ${today}
          AND ${dutchScheduleTable.status} = 'SCHEDULED'
          AND ${dutchScheduleTable.marketId} NOT IN (${sql.join(
            filtered.length ? filtered.map(m => sql`${m.marketId}`) : [sql`''`],
            sql`, `
          )})`
      );

    const existing = await db
      .select({ marketId: dutchScheduleTable.marketId, status: dutchScheduleTable.status })
      .from(dutchScheduleTable)
      .where(sql`${dutchScheduleTable.scheduledDate} = ${today}`);
    const existingMap = new Map(existing.map(e => [e.marketId, e.status]));

    let added = 0;
    for (const m of filtered) {
      if (!existingMap.has(m.marketId)) {
        await db.insert(dutchScheduleTable).values({
          marketId:        m.marketId,
          eventName:       m.eventName,
          marketName:      m.marketName,
          marketStartTime: new Date(m.marketStartTime),
          runnerCount:     m.runnerCount ?? null,
          status:          "SCHEDULED",
          scheduledDate:   today,
        });
        added++;
      }
    }

    // Mark SCHEDULED races whose start time has passed by >10 min as MISSED
    const now = Date.now();
    let missed = 0;
    for (const e of existing) {
      if (e.status !== "SCHEDULED") continue;
      const mkt = filtered.find(m => m.marketId === e.marketId);
      if (!mkt) continue;
      const startMs = new Date(mkt.marketStartTime).getTime();
      if (startMs < now - 10 * 60_000) {
        await db.update(dutchScheduleTable)
          .set({ status: "MISSED", updatedAt: new Date() })
          .where(sql`${dutchScheduleTable.marketId} = ${e.marketId} AND ${dutchScheduleTable.scheduledDate} = ${today}`);
        missed++;
      }
    }

    // Suppress unused-var warning when filtered list is empty
    void filteredIds;
    log("info", `Schedule scan complete — ${filtered.length} qualifying races, ${added} new, ${missed} marked missed`);
  } catch (err) {
    log("error", `Schedule scan error: ${String(err)}`);
  }
}

export async function startDutchBot(): Promise<void> {
  if (dutchBotRunning) return;
  await loadDutchConfigFromDb();
  dutchBotRunning = true;
  dutchStartedAt = new Date();
  db.update(botConfigTable).set({ dutchIsRunning: true })
    .catch((err: unknown) => logger.error({ err }, "[DUTCH] Failed to persist dutchIsRunning=true"));
  log("info", "Dutch Bot started — Combo strategy (BACK fav<2.5 / LAY fav 3-5 / LAY top2 if fav≥5)");
  void scheduleNextCycle();
  dutchSettlementInterval = setInterval(() => { void runDutchSettlement(); }, 2 * 60_000);
  void runScheduleScan();
  dutchScanInterval = setInterval(() => { void runScheduleScan(); }, 60 * 60_000);
}

export async function stopDutchBot(): Promise<void> {
  if (!dutchBotRunning) return;
  dutchBotRunning = false;
  dutchStartedAt = null;
  if (dutchBotInterval)        { clearTimeout(dutchBotInterval);     dutchBotInterval     = null; }
  if (dutchSettlementInterval) { clearInterval(dutchSettlementInterval); dutchSettlementInterval = null; }
  if (dutchScanInterval)       { clearInterval(dutchScanInterval);    dutchScanInterval    = null; }
  db.update(botConfigTable).set({ dutchIsRunning: false })
    .catch((err: unknown) => logger.error({ err }, "[DUTCH] Failed to persist dutchIsRunning=false"));
  log("info", "Dutch Bot stopped");
}

async function runDutchSettlement(): Promise<void> {
  if (!getSession()) return;
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const unsettled = await db
      .select()
      .from(betsTable)
      .where(
        sql`${betsTable.strategyName} = ${DUTCH_STRATEGY_NAME}
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
      const { getMarketSettlement } = await import("./betfair");
      const settlement = await getMarketSettlement(marketId);
      if (!settlement?.settled) continue;

      const winnerSelectionId = settlement.winnerSelectionId;
      const settledAt = new Date();
      let raceNet = 0;

      // Resolve winner name from stored fullField snapshot in aiReasoning
      let winnerName: string | null = null;
      if (winnerSelectionId != null) {
        for (const bet of bets) {
          const raw = bet.aiReasoning ?? "";
          const idx = raw.indexOf("||FIELD:");
          if (idx !== -1) {
            try {
              const field = JSON.parse(raw.slice(idx + 8)) as Array<{ selectionId: number; name: string }>;
              const found = field.find(r => r.selectionId === winnerSelectionId);
              if (found) { winnerName = found.name; break; }
            } catch { /* ignore */ }
          }
        }
        if (!winnerName) {
          winnerName = bets.find(b => b.selectionId === winnerSelectionId)?.selectionName ?? null;
        }
      }

      for (const bet of bets) {
        if (bet.status === "UNMATCHED") {
          await db.update(betsTable)
            .set({ status: "VOID", actualProfit: "0", settledAt })
            .where(eq(betsTable.id, bet.id));
          continue;
        }

        const selectionWon = bet.selectionId === winnerSelectionId;
        const odds  = Number(bet.matchedOdds ?? bet.requestedOdds);
        const stake = Number(bet.stakeAmount);
        const isLay = bet.betType === "LAY";

        // BACK: win → +stake*(odds-1), lose → -stake
        // LAY:  selection wins → -stake*(odds-1) [liability], selection loses → +stake
        const actualProfit = isLay
          ? (selectionWon ? -(stake * (odds - 1)) :  stake)
          : (selectionWon ?  (stake * (odds - 1)) : -stake);

        // Our bet WON if: BACK and selection won, OR LAY and selection lost
        const ourBetWon = isLay ? !selectionWon : selectionWon;

        raceNet += actualProfit;

        const winnerTag = winnerName ? `||WINNER:${winnerName}` : "";
        const baseReasoning = (bet.aiReasoning ?? "").replace(/\|\|WINNER:[^|]*$/, "");

        await db.update(betsTable).set({
          status: ourBetWon ? "WON" : "LOST",
          actualProfit: actualProfit.toFixed(2),
          settledAt,
          aiReasoning: baseReasoning + winnerTag,
        }).where(eq(betsTable.id, bet.id));
      }

      log(
        raceNet >= 0 ? "info" : "warn",
        `Settled ${marketId} — race net ${raceNet >= 0 ? "+" : ""}£${raceNet.toFixed(2)}`,
        { marketId, raceNet },
      );
    }
  } catch (err) {
    log("error", `Settlement error: ${String(err)}`);
  }
}

export async function autoResumeDutchBot(): Promise<void> {
  try {
    const [row] = await db.select({ dutchIsRunning: botConfigTable.dutchIsRunning })
      .from(botConfigTable)
      .limit(1);
    if (row?.dutchIsRunning) {
      logger.info("[DUTCH] Auto-resuming Dutch Bot from DB state");
      await startDutchBot();
    }
  } catch (err) {
    logger.error({ err }, "[DUTCH] Failed to auto-resume");
  }
}
