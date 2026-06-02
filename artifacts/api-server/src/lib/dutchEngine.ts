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

// Combo strategy thresholds — PHASE 1 (cutover 2026-05-13 ~17:00 UTC)
// Tightened based on 152-race lifetime review (was +£166 baseline; phase 1 simulated +£571).
const BACK_FAV_MIN_ODDS    = 1.5;   // skip <1.5 (75% strike but math doesn't pay)
const BACK_FAV_DEAD_LO     = 1.8;   // dead zone — 1.8-2.0 was 45%/-£74
const BACK_FAV_DEAD_HI     = 2.0;
const BACK_FAV_MAX_ODDS    = 2.5;   // fav < 2.5 → BACK fav
const LAY_FAV_MIN_ODDS     = 3.0;   // fav 3.0 to 3.6 → LAY fav (was 3.0-5.0)
const LAY_FAV_MAX_ODDS     = 3.6;   // tightened from 5.0 — 3.6-5.0 lost lifetime
const LAY_TOP2_MIN_FAV     = 5.0;   // fav ≥ 5.0 → LAY top 2
const MAX_LAY_ODDS         = 8.0;   // never lay above 8.0 (liability gets crushing)
// LAY_FAV in Group/Listed: 0/2 wins, -£100. Always skip.
const LAY_FAV_RACE_BLOCKLIST = /\b(Grp|Group|Listed)\b/i;

// Phase 1 cutover — bets placed at/after this point use the tightened ruleset.
// Used by /dutch/status to split lifetime P&L into "before" and "since" buckets.
export const PHASE1_CUTOVER_ISO = "2026-05-13T17:00:00.000Z";

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
  dailyProfitLockGBP: number; // stop placing new bets once today's settled net ≥ this £
  dailyLossStopGBP: number;   // stop placing new bets once today's settled net ≤ -this £ (0 disables)
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
  dailyProfitLockGBP: 120,
  dailyLossStopGBP: 150,
};

let dailyLockLatched = false;
let dailyLockLatchedDate: string | null = null;
let dailyLossLatched = false;
let dailyLossLatchedDate: string | null = null;

function utcDayBounds(now: Date = new Date()): { start: Date; nextStart: Date; key: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const nextStart = new Date(start.getTime() + 24 * 60 * 60_000);
  return { start, nextStart, key: start.toISOString().slice(0, 10) };
}

async function getTodaysDutchSettledNet(): Promise<number> {
  const { start, nextStart } = utcDayBounds();
  try {
    const [row] = await db
      .select({
        net: sql<string>`coalesce(sum(${betsTable.actualProfit}::numeric), 0)::text`,
      })
      .from(betsTable)
      .where(sql`${betsTable.strategyName} = ${DUTCH_STRATEGY_NAME}
                 AND ${betsTable.settledAt} IS NOT NULL
                 AND ${betsTable.settledAt} >= ${start}
                 AND ${betsTable.settledAt} <  ${nextStart}
                 AND ${betsTable.status} IN ('WON','LOST','VOID')
                 AND ${betsTable.actualProfit} IS NOT NULL`);
    return Number(row?.net ?? 0);
  } catch (err) {
    logger.error({ err }, "[DUTCH] getTodaysDutchSettledNet failed");
    return 0;
  }
}

export async function isDailyProfitLocked(): Promise<{ locked: boolean; net: number; target: number }> {
  const target = dutchConfig.dailyProfitLockGBP;
  if (target <= 0) return { locked: false, net: 0, target };
  const net = await getTodaysDutchSettledNet();
  return { locked: net >= target, net, target };
}

export async function isDailyLossStopped(): Promise<{ stopped: boolean; net: number; threshold: number }> {
  const threshold = dutchConfig.dailyLossStopGBP;
  if (threshold <= 0) return { stopped: false, net: 0, threshold };
  const net = await getTodaysDutchSettledNet();
  return { stopped: net <= -threshold, net, threshold };
}

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
      if (typeof saved.dailyProfitLockGBP === "number") dutchConfig.dailyProfitLockGBP = saved.dailyProfitLockGBP;
      if (typeof saved.dailyLossStopGBP   === "number") dutchConfig.dailyLossStopGBP   = saved.dailyLossStopGBP;
      logger.info({ dutchConfig }, "[DUTCH] Loaded config from DB");
    }
  } catch (err) {
    logger.error({ err }, "[DUTCH] Failed to load config from DB — using defaults");
  }
}

interface ScheduleRunner {
  selectionId: number;        // Betfair selection ID (for result resolution)
  name: string;
  price: number | null;       // best back price at decision time (null if no back offer)
  lastPriceTraded?: number;   // last traded price at decision time
  backed: boolean;            // true if we placed a bet on this runner (BACK or LAY)
  betType?: "BACK" | "LAY";   // direction of our bet
  stake?: number;             // Betfair "size" (backer's stake)
  liability?: number;         // for LAY bets: stake * (odds-1)
  netProfit?: number;         // expected race net P&L if THIS runner wins
  // ── Decision-time liquidity (per-runner) ──
  layPrice?: number;          // best lay price at decision time
  backSize?: number;          // £ available to back at bestBack
  laySize?: number;           // £ available to lay at bestLay
  tradedVolume?: number;      // £ matched on this runner so far
  sortPriority?: number;      // market favouritism order (1 = favourite)
  // ── Research metadata (Betfair RUNNER_METADATA) ──
  jockeyName?: string;
  jockeyClaim?: string;
  trainerName?: string;       // the stable
  ownerName?: string;
  age?: number;
  sex?: string;
  form?: string;
  daysSinceLastRun?: number;
  officialRating?: number;
  adjustedRating?: number;
  stallDraw?: number;
  weightValue?: number;
  weightUnits?: string;
  wearing?: string;           // headgear (blinkers, etc.)
  clothNumber?: number;
  sireName?: string;
  damName?: string;
  bredCountry?: string;
  colour?: string;
  forecastPrice?: number;
  // Filled in by runScheduleSettlement once the market closes:
  bsp?: number;               // Betfair Starting Price (actualSP)
  finalStatus?: "WINNER" | "LOSER" | "REMOVED";
}

async function updateScheduleEntry(
  marketId: string,
  status: string,
  opts?: {
    skipReason?: string;
    runnerCount?: number;
    runners?: ScheduleRunner[];
    mode?: string;
    totalMatched?: number;
  },
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    await db.update(dutchScheduleTable)
      .set({
        status,
        skipReason:  opts?.skipReason  ?? null,
        ...(opts?.runnerCount != null ? { runnerCount: opts.runnerCount } : {}),
        ...(opts?.runners      != null ? { runnersJson: opts.runners as unknown as Record<string, unknown>[] } : {}),
        ...(opts?.totalMatched != null ? { totalMatched: opts.totalMatched.toFixed(2) } : {}),
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
    // Daily profit lock — once today's settled net ≥ dailyProfitLockGBP, stop
    // placing new bets until UTC midnight rollover. Reset latch on new UTC day.
    const todayKey = utcDayBounds().key;
    if (dailyLockLatchedDate !== todayKey) {
      if (dailyLockLatched) log("info", `Daily profit lock reset for new day ${todayKey}`);
      dailyLockLatched = false;
      dailyLockLatchedDate = todayKey;
    }
    if (dailyLossLatchedDate !== todayKey) {
      if (dailyLossLatched) log("info", `Daily loss stop reset for new day ${todayKey}`);
      dailyLossLatched = false;
      dailyLossLatchedDate = todayKey;
    }
    {
      const { locked, net, target } = await isDailyProfitLocked();
      if (locked) {
        if (!dailyLockLatched) {
          log("info",
            `🔒 Daily profit lock TRIGGERED — today's settled net £${net.toFixed(2)} ≥ £${target.toFixed(2)}. No more bets until tomorrow.`,
          );
          dailyLockLatched = true;
        }
        return 0;
      }
    }
    {
      const { stopped, net, threshold } = await isDailyLossStopped();
      if (stopped) {
        if (!dailyLossLatched) {
          log("warn",
            `🛑 Daily loss stop TRIGGERED — today's settled net £${net.toFixed(2)} ≤ -£${threshold.toFixed(2)}. No more bets until tomorrow.`,
          );
          dailyLossLatched = true;
        }
        return 0;
      }
    }

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
      // Re-check the daily profit lock between each market — settlements run on
      // a 2-min loop and may push net over the threshold mid-cycle.
      const recheck = await isDailyProfitLocked();
      if (recheck.locked) {
        if (!dailyLockLatched) {
          log("info",
            `🔒 Daily profit lock TRIGGERED mid-cycle — today's settled net £${recheck.net.toFixed(2)} ≥ £${recheck.target.toFixed(2)}. Aborting remaining markets.`,
          );
          dailyLockLatched = true;
        }
        break;
      }
      const lossCheck = await isDailyLossStopped();
      if (lossCheck.stopped) {
        if (!dailyLossLatched) {
          log("warn",
            `🛑 Daily loss stop TRIGGERED mid-cycle — today's settled net £${lossCheck.net.toFixed(2)} ≤ -£${lossCheck.threshold.toFixed(2)}. Aborting remaining markets.`,
          );
          dailyLossLatched = true;
        }
        break;
      }
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
  marketName: string = "",
): ComboPlan {
  if (eligible.length === 0) {
    return { mode: "SKIP", bets: [], reason: "No eligible runners" };
  }

  const sorted = [...eligible].sort((a, b) => a.bestBackPrice - b.bestBackPrice);
  const fav = sorted[0];

  // BACK heavy favourite — phase 1: skip <1.5 and the 1.8-2.0 dead zone
  if (fav.bestBackPrice < BACK_FAV_MAX_ODDS) {
    if (fav.bestBackPrice < BACK_FAV_MIN_ODDS) {
      return {
        mode: "SKIP",
        bets: [],
        reason: `Phase 1: BACK_FAV skipped — fav ${fav.bestBackPrice.toFixed(2)} < ${BACK_FAV_MIN_ODDS} (negative EV at heavy odds)`,
      };
    }
    if (fav.bestBackPrice >= BACK_FAV_DEAD_LO && fav.bestBackPrice < BACK_FAV_DEAD_HI) {
      return {
        mode: "SKIP",
        bets: [],
        reason: `Phase 1: BACK_FAV skipped — fav ${fav.bestBackPrice.toFixed(2)} in dead zone ${BACK_FAV_DEAD_LO}-${BACK_FAV_DEAD_HI} (45% strike historically)`,
      };
    }
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

  // LAY favourite (sweet spot — phase 1 narrowed to 3.0-3.6, skip Group/Listed)
  if (fav.bestBackPrice >= LAY_FAV_MIN_ODDS && fav.bestBackPrice < LAY_FAV_MAX_ODDS) {
    if (LAY_FAV_RACE_BLOCKLIST.test(marketName)) {
      return {
        mode: "SKIP",
        bets: [],
        reason: `Phase 1: LAY_FAV skipped — Group/Listed race "${marketName}" (0/2 historically, -£100)`,
      };
    }
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
  const [config] = await db.select({
      paperTradingMode: botConfigTable.paperTradingMode,
      dataCollectionMode: botConfigTable.dataCollectionMode,
    })
    .from(botConfigTable).limit(1);
  const paperTrading = config?.paperTradingMode ?? true;
  const dataCollectionMode = config?.dataCollectionMode ?? false;

  const marketDetail = await getMarketDetail(marketId);
  if (!marketDetail) return;

  // Helper: snapshot all active runners for the schedule entry
  const buildSnapshot = (
    eligibleRunners: typeof marketDetail.runners,
    plan?: ComboPlan,
    includeUnpriced = false,
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
      .filter(r => r.status === "ACTIVE" && (includeUnpriced || r.bestBackPrice != null))
      .map(r => {
        const planned = planMap.get(String(r.selectionId));
        return {
          selectionId: r.selectionId,
          name: r.runnerName,
          price: r.bestBackPrice ?? null,
          lastPriceTraded: r.lastPriceTraded,
          backed: !!planned,
          betType: planned?.side,
          stake: planned?.stake,
          liability: planned?.liability,
          netProfit: plan && plan.bets.length > 0 ? netIfWins(String(r.selectionId)) : undefined,
          // Decision-time liquidity
          layPrice: r.bestLayPrice,
          backSize: r.bestBackSize,
          laySize: r.bestLaySize,
          tradedVolume: r.totalMatched,
          sortPriority: r.sortPriority,
          // Research metadata
          jockeyName: r.jockeyName,
          jockeyClaim: r.jockeyClaim,
          trainerName: r.trainerName,
          ownerName: r.ownerName,
          age: r.age,
          sex: r.sex,
          form: r.form,
          daysSinceLastRun: r.daysSinceLastRun,
          officialRating: r.officialRating,
          adjustedRating: r.adjustedRating,
          stallDraw: r.stallDraw,
          weightValue: r.weightValue,
          weightUnits: r.weightUnits,
          wearing: r.wearing,
          clothNumber: r.clothNumber,
          sireName: r.sireName,
          damName: r.damName,
          bredCountry: r.bredCountry,
          colour: r.colour,
          forecastPrice: r.forecastPrice,
        } as ScheduleRunner;
      })
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  };

  // ── DATA-COLLECTION MODE ──────────────────────────────────────────────────
  // Place NO bets (paper or real). Snapshot the FULL active field with all
  // research metadata + liquidity, record it to the schedule and the permanent
  // research dataset, then return. No filters — we want every race we observe.
  if (dataCollectionMode) {
    const snapshot = buildSnapshot(marketDetail.runners, undefined, true);
    log("info",
      `OBSERVE ${eventName} — data-collection only, ${snapshot.length} runners, £${marketDetail.totalMatched.toFixed(0)} matched`,
      { marketId, runnerCount: snapshot.length },
    );
    void updateScheduleEntry(marketId, "OBSERVED", {
      runnerCount: snapshot.length,
      runners: snapshot,
      totalMatched: marketDetail.totalMatched,
    });
    void (async () => {
      const { enrichRaceWithRunners } = await import("./raceDataset");
      await enrichRaceWithRunners(marketId, {
        runners: snapshot as unknown as unknown[],
        preRaceTotalMatched: marketDetail.totalMatched ?? null,
      });
    })();
    return;
  }

  if (marketDetail.totalMatched < dutchConfig.minLiquidity) {
    log("info",
      `Skipping ${eventName} — liquidity £${marketDetail.totalMatched.toFixed(0)} < £${dutchConfig.minLiquidity}`,
    );
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: `Low liquidity — £${marketDetail.totalMatched.toFixed(0)} matched (min £${dutchConfig.minLiquidity})`,
      runners: buildSnapshot(marketDetail.runners),
      totalMatched: marketDetail.totalMatched,
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
      totalMatched: marketDetail.totalMatched,
    });
    return;
  }

  if (eligible.length > dutchConfig.maxRunners) {
    log("info", `Skipping ${eventName} — ${eligible.length} runners exceeds max ${dutchConfig.maxRunners}`);
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: `${eligible.length} runners — exceeds max of ${dutchConfig.maxRunners} (large fields are noise)`,
      runnerCount: eligible.length,
      runners: buildSnapshot(eligible),
      totalMatched: marketDetail.totalMatched,
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
    marketName,
  );

  if (plan.mode === "SKIP") {
    log("info", `Skipping ${eventName} — ${plan.reason}`);
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: plan.reason,
      runnerCount: eligible.length,
      runners: buildSnapshot(eligible),
      totalMatched: marketDetail.totalMatched,
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
      totalMatched: marketDetail.totalMatched,
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
  const snapshot = buildSnapshot(eligible, plan);
  void updateScheduleEntry(marketId, "BET_PLACED", {
    runnerCount: eligible.length,
    runners: snapshot,
    mode: plan.mode,
    totalMatched: marketDetail.totalMatched,
  });

  // Also enrich the permanent research dataset
  void (async () => {
    const { enrichRaceWithRunners } = await import("./raceDataset");
    await enrichRaceWithRunners(marketId, {
      runners: snapshot as unknown as unknown[],
      preRaceTotalMatched: marketDetail.totalMatched ?? null,
    });
  })();
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

    // Permanent research dataset: capture EVERY race we discover, before any
    // filtering. Append/enrich only; never deleted by any reset endpoint.
    const { upsertDiscoveredRaces } = await import("./raceDataset");
    await upsertDiscoveredRaces(markets.map(m => ({
      marketId: m.marketId,
      eventName: m.eventName,
      marketName: m.marketName,
      marketStartTime: m.marketStartTime,
      runnerCount: m.runnerCount ?? null,
      marketType: "WIN",
      countryCode: null,
    })));

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
  log("info", `Dutch Bot started — PHASE 1 (BACK fav 1.5-1.8 & 2.0-2.5 / LAY fav 3.0-3.6 ex Group/Listed / LAY top2 if fav≥5) — cutover ${PHASE1_CUTOVER_ISO}`);
  void scheduleNextCycle();
  dutchSettlementInterval = setInterval(() => {
    void runDutchSettlement();
    void runScheduleSettlement();
    void runDatasetSettlement();
  }, 30_000);
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

    const { getMarketSettlement } = await import("./betfair");
    for (const [marketId, bets] of byMarket) {
      let settlement: Awaited<ReturnType<typeof getMarketSettlement>> = null;
      try {
        settlement = await getMarketSettlement(marketId);
      } catch (err) {
        // One bad market must NOT abort the whole settlement run.
        logger.warn({ err, marketId }, "[DUTCH] Settlement lookup failed — will retry next cycle");
        continue;
      }
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

/**
 * Record race outcomes for EVERY UK/IE race the bot saw today (and the last
 * 48 h), not just the ones we bet on. For each schedule row without a winner
 * yet, fetch listMarketBook with SP_AVAILABLE and write:
 *   - dutch_schedule: winner_selection_id, winner_name, total_matched, result_recorded_at
 *   - runners_json: enrich each runner with { bsp, finalStatus }
 *
 * This builds the strategy-tweak dataset: every race we passed over (skipped,
 * missed, low-liquidity, etc.) ends up with full outcome data we can mine.
 */
let scheduleSettlementInFlight = false;

/**
 * Permanent-dataset settlement: backfills winner + going on race_dataset rows
 * for EVERY race we've ever observed, regardless of whether the bot bet on it
 * or whether it survived the schedule filters. Never deletes anything.
 */
let datasetSettlementInFlight = false;
async function runDatasetSettlement(): Promise<void> {
  if (!getSession()) return;
  if (datasetSettlementInFlight) return;
  datasetSettlementInFlight = true;
  try {
    const { raceDatasetTable } = await import("@workspace/db");
    const { recordRaceResult } = await import("./raceDataset");
    const resultCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const goingCutoff  = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const rows = await db
      .select({
        marketId:        raceDatasetTable.marketId,
        eventName:       raceDatasetTable.eventName,
        scheduledDate:   raceDatasetTable.scheduledDate,
        marketStartTime: raceDatasetTable.marketStartTime,
        going:           raceDatasetTable.going,
        winnerSelectionId: raceDatasetTable.winnerSelectionId,
      })
      .from(raceDatasetTable)
      .where(
        sql`${raceDatasetTable.marketStartTime} <= ${now}
            AND (
              (${raceDatasetTable.winnerSelectionId} IS NULL
               AND ${raceDatasetTable.marketStartTime} >= ${resultCutoff})
              OR
              (${raceDatasetTable.going} IS NULL
               AND ${raceDatasetTable.marketStartTime} >= ${goingCutoff})
            )`,
      )
      .limit(50);
    if (rows.length === 0) return;

    const { getMarketResultWithBSP } = await import("./betfair");
    const { getGoingByCourseForDate, courseFromEventName } = await import("./racingPost");
    const datesNeeded = [...new Set(rows.map(r => r.scheduledDate))];
    const goingByDate = new Map<string, Map<string, string>>();
    for (const d of datesNeeded) {
      goingByDate.set(d, await getGoingByCourseForDate(d));
    }

    let updated = 0;
    for (const row of rows) {
      const courseKey = courseFromEventName(row.eventName);
      const going = courseKey
        ? goingByDate.get(row.scheduledDate)?.get(courseKey) ?? null
        : null;

      let result: Awaited<ReturnType<typeof getMarketResultWithBSP>> = null;
      if (row.winnerSelectionId == null) {
        try {
          result = await getMarketResultWithBSP(row.marketId);
        } catch {
          // ignore — try again next tick
        }
      }
      const winnerSelectionId = result?.winnerSelectionId ?? null;
      const goingChanged = going != null && going !== row.going;
      const winnerChanged = winnerSelectionId != null;
      if (!goingChanged && !winnerChanged) continue;

      await recordRaceResult(row.marketId, {
        winnerSelectionId,
        going: goingChanged ? going : null,
      });
      updated++;
    }
    if (updated > 0) {
      logger.info({ updated }, "[DATASET] backfilled winner/going on permanent rows");
    }
  } catch (err) {
    logger.error({ err }, "[DATASET] settlement loop failed");
  } finally {
    datasetSettlementInFlight = false;
  }
}

async function runScheduleSettlement(): Promise<void> {
  if (!getSession()) return;
  if (scheduleSettlementInFlight) {
    logger.info("[DUTCH] Schedule settlement already running — skipping this tick");
    return;
  }
  scheduleSettlementInFlight = true;
  try {
    // Result recovery only attempts the recent window (Betfair drops settled
    // markets fast). Going can be backfilled much further back from Racing
    // Post, so null-going rows get a 14-day lookback.
    const resultCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const goingCutoff  = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const now    = new Date();
    const rows = await db
      .select({
        id:              dutchScheduleTable.id,
        marketId:        dutchScheduleTable.marketId,
        eventName:       dutchScheduleTable.eventName,
        scheduledDate:   dutchScheduleTable.scheduledDate,
        runnersJson:     dutchScheduleTable.runnersJson,
        marketStartTime: dutchScheduleTable.marketStartTime,
        totalMatched:    dutchScheduleTable.totalMatched,
        going:           dutchScheduleTable.going,
      })
      .from(dutchScheduleTable)
      .where(
        sql`${dutchScheduleTable.marketStartTime} <= ${now}
            AND (
              (${dutchScheduleTable.winnerSelectionId} IS NULL
               AND ${dutchScheduleTable.marketStartTime} >= ${resultCutoff})
              OR
              (${dutchScheduleTable.going} IS NULL
               AND ${dutchScheduleTable.marketStartTime} >= ${goingCutoff})
            )`,
      );
    if (rows.length === 0) return;

    const { getMarketResultWithBSP } = await import("./betfair");
    const { getGoingByCourseForDate, courseFromEventName } = await import("./racingPost");

    // Pre-load going maps for every date we're about to settle (typically 1-2).
    const datesNeeded = [...new Set(rows.map(r => r.scheduledDate))];
    const goingByDate = new Map<string, Map<string, string>>();
    for (const d of datesNeeded) {
      goingByDate.set(d, await getGoingByCourseForDate(d));
    }

    let recorded = 0;

    for (const row of rows) {
      // Going lookup (independent of Betfair result — Racing Post has it as
      // soon as the meeting starts). May be undefined for foreign meetings or
      // when the RP page hasn't published yet.
      const courseKey = courseFromEventName(row.eventName);
      const going = courseKey
        ? goingByDate.get(row.scheduledDate)?.get(courseKey) ?? null
        : null;

      let result: Awaited<ReturnType<typeof getMarketResultWithBSP>> = null;
      try {
        result = await getMarketResultWithBSP(row.marketId);
      } catch (err) {
        logger.warn({ err, marketId: row.marketId }, "[DUTCH] schedule-settle lookup failed");
        continue;
      }
      // If the market hasn't closed yet (or this row was reselected purely to
      // backfill going on an already-settled race), persist going alone and
      // move on. Result recovery will fill in the rest next tick.
      const goingChanged = going != null && going !== row.going;
      if (!result || !result.closed || result.winnerSelectionId == null) {
        if (goingChanged) {
          await db.update(dutchScheduleTable)
            .set({ going, updatedAt: new Date() })
            .where(eq(dutchScheduleTable.id, row.id));
        }
        continue;
      }

      // Enrich runners_json with per-runner BSP + finalStatus
      const bspMap = new Map(result.runners.map(r => [r.selectionId, r]));
      const existing = (row.runnersJson as ScheduleRunner[] | null) ?? [];
      const enriched: ScheduleRunner[] = existing.map(r => {
        const res = r.selectionId != null ? bspMap.get(r.selectionId) : undefined;
        return {
          ...r,
          bsp:         res?.bsp ?? r.bsp,
          finalStatus: (res?.status as ScheduleRunner["finalStatus"]) ?? r.finalStatus,
        };
      });

      // Add any runners that weren't in our decision-time snapshot (e.g. SCHEDULED
      // rows that never reached the betting window — we still want BSPs for them).
      const seen = new Set(enriched.map(r => r.selectionId));
      const missing = result.runners.filter(r => !seen.has(r.selectionId));

      // If we have to add runners, or any existing runner lacks a real name,
      // fetch the catalogue once so the dataset has human-readable names.
      const needsNames =
        missing.length > 0 ||
        enriched.some(r => !r.name || /^Selection \d+$/.test(r.name));
      let nameMap: Map<number, string> | null = null;
      if (needsNames) {
        const { getMarketRunnerNames } = await import("./betfair");
        nameMap = await getMarketRunnerNames(row.marketId);
      }

      if (nameMap) {
        for (let i = 0; i < enriched.length; i++) {
          const r = enriched[i];
          if (!r.name || /^Selection \d+$/.test(r.name)) {
            const realName = nameMap.get(r.selectionId);
            if (realName) enriched[i] = { ...r, name: realName };
          }
        }
      }
      for (const res of missing) {
        enriched.push({
          selectionId: res.selectionId,
          name: nameMap?.get(res.selectionId) ?? `Selection ${res.selectionId}`,
          price: 0,
          backed: false,
          bsp: res.bsp ?? undefined,
          finalStatus: res.status as ScheduleRunner["finalStatus"],
        });
      }

      const winnerName = enriched.find(r => r.selectionId === result!.winnerSelectionId)?.name ?? null;

      // Only fill totalMatched from settlement if we never captured a live
      // decision-time value. CLOSED-market totalMatched is often 0 and we want
      // to preserve the real liquidity recorded during runDutchMarket.
      const haveLiveLiquidity = row.totalMatched != null && Number(row.totalMatched) > 0;
      const settlementHasValue = result.totalMatched > 0;

      await db.update(dutchScheduleTable)
        .set({
          runnersJson:        enriched as unknown as Record<string, unknown>[],
          winnerSelectionId:  result.winnerSelectionId,
          winnerName,
          ...(going ? { going } : {}),
          ...(!haveLiveLiquidity && settlementHasValue
            ? { totalMatched: result.totalMatched.toFixed(2) }
            : {}),
          resultRecordedAt:   new Date(),
          updatedAt:          new Date(),
        })
        .where(eq(dutchScheduleTable.id, row.id));

      // Mirror the result into the permanent research dataset
      void (async () => {
        const { recordRaceResult } = await import("./raceDataset");
        await recordRaceResult(row.marketId, {
          winnerSelectionId: result.winnerSelectionId,
          winnerName,
          going: going ?? null,
          runners: enriched as unknown as unknown[],
          preRaceTotalMatched:
            !haveLiveLiquidity && settlementHasValue ? result.totalMatched : null,
        });
      })();

      recorded++;
    }

    if (recorded > 0) {
      log("info", `Schedule settlement — recorded results for ${recorded}/${rows.length} race(s)`);
    }
  } catch (err) {
    log("error", `Schedule settlement error: ${String(err)}`);
  } finally {
    scheduleSettlementInFlight = false;
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
