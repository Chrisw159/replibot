import { logger } from "./logger";
import { db, betsTable, botLogsTable, botConfigTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  getSession,
  listMarkets,
  getMarketDetail,
  placeBet,
  loginWithEnvCredentials,
} from "./betfair";

const BOOKIE_STRATEGY_NAME = "Bookie Bot";
const MIN_MINS_BEFORE_START = 1;
const MAX_MINS_BEFORE_START = 4;
const MIN_ODDS = 1.5;
const MAX_ODDS = 50;

const NON_WIN_PATTERN =
  /each.?way|forecast|\(f\/c\)|to be placed|\bTBP\b|match bet|daily win dist|without\s+\w|to win by|jockey.*champion|specials/i;

interface BookieConfig {
  // Maximum net loss allowed for any single race outcome.
  // The bot back-calculates the total lay stake from this figure each race.
  maxRaceNetLoss: number;
  // Minimum market totalMatched (£) — filters out illiquid/skewed markets.
  minLiquidity: number;
  // Country codes to scan.
  countryCodes: string[];
  // Minimum number of runners with valid volume data before we act.
  minRunners: number;
}

let bookieBotRunning = false;
let bookieBotInterval: ReturnType<typeof setTimeout> | null = null;
let bookieSettlementInterval: ReturnType<typeof setInterval> | null = null;
let bookieStartedAt: Date | null = null;
const processingMarkets = new Set<string>();

let bookieConfig: BookieConfig = {
  maxRaceNetLoss: 200,
  minLiquidity: 8000,
  countryCodes: ["GB", "IE"],
  minRunners: 4,
};

export function isBookieBotRunning(): boolean { return bookieBotRunning; }
export function getBookieStartedAt(): Date | null { return bookieStartedAt; }
export function getBookieConfig(): BookieConfig { return { ...bookieConfig }; }

export function setBookieConfig(patch: Partial<BookieConfig>): void {
  bookieConfig = { ...bookieConfig, ...patch };
  if (patch.countryCodes && bookieBotRunning && bookieBotInterval) {
    clearTimeout(bookieBotInterval);
    bookieBotInterval = null;
    void scheduleBookieCycle();
  }
}

export async function saveBookieConfigToDb(): Promise<void> {
  try {
    const [row] = await db.select({ id: botConfigTable.id }).from(botConfigTable).limit(1);
    if (row) {
      await db
        .update(botConfigTable)
        .set({ bookieConfigJson: bookieConfig as unknown as Record<string, unknown> })
        .where(eq(botConfigTable.id, row.id));
    } else {
      await db.insert(botConfigTable).values({
        bookieConfigJson: bookieConfig as unknown as Record<string, unknown>,
      });
    }
  } catch (err) {
    logger.error({ err }, "[BOOKIE] Failed to save config to DB");
  }
}

async function loadBookieConfigFromDb(): Promise<void> {
  try {
    const [row] = await db
      .select({ bookieConfigJson: botConfigTable.bookieConfigJson })
      .from(botConfigTable)
      .limit(1);
    if (row?.bookieConfigJson) {
      const saved = row.bookieConfigJson as Partial<BookieConfig>;
      if (typeof saved.maxRaceNetLoss === "number") bookieConfig.maxRaceNetLoss = saved.maxRaceNetLoss;
      if (typeof saved.minLiquidity === "number") bookieConfig.minLiquidity = saved.minLiquidity;
      if (Array.isArray(saved.countryCodes)) bookieConfig.countryCodes = saved.countryCodes;
      if (typeof saved.minRunners === "number") bookieConfig.minRunners = saved.minRunners;
      logger.info({ bookieConfig }, "[BOOKIE] Loaded config from DB");
    }
  } catch (err) {
    logger.error({ err }, "[BOOKIE] Failed to load config from DB — using defaults");
  }
}

function log(level: string, message: string, metadata?: Record<string, unknown>): void {
  const fullMessage = `[BOOKIE] ${message}`;
  logger.info({ level, metadata }, fullMessage);
  db.insert(botLogsTable).values({
    level,
    message: fullMessage,
    metadata: metadata ? JSON.stringify(metadata) : null,
  }).catch((err: unknown) => logger.error({ err }, "[BOOKIE] Failed to write log to DB"));
}

async function runBookieCycle(): Promise<number> {
  if (!bookieBotRunning) return 0;
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
      countryCodes: bookieConfig.countryCodes,
      marketType: "WIN",
      hoursAhead: MAX_MINS_BEFORE_START / 60,
    });

    // Filter to only races in the 1–4 min pre-start window
    const inWindow = markets.filter(m => {
      const startMs = new Date(m.marketStartTime).getTime();
      return startMs >= fromMs && startMs <= toMs;
    });

    const candidates = inWindow.filter(m => {
      if (processingMarkets.has(m.marketId)) return false;
      if (NON_WIN_PATTERN.test(m.marketName)) return false;
      return true;
    });

    // Skip markets we have already bet on (guards against double-processing across cycles)
    const alreadyBet = candidates.length > 0
      ? await db
          .select({ marketId: betsTable.marketId })
          .from(betsTable)
          .where(
            sql`${betsTable.strategyName} = ${BOOKIE_STRATEGY_NAME}
                AND ${betsTable.marketId} = ANY(ARRAY[${sql.join(
                  candidates.map(m => sql`${m.marketId}`),
                  sql`, `,
                )}])`,
          )
      : [];
    const alreadyBetIds = new Set(alreadyBet.map(r => r.marketId));

    const fresh = candidates.filter(m => !alreadyBetIds.has(m.marketId));

    log("info",
      `Cycle — ${markets.length} markets fetched, ${inWindow.length} in ${MIN_MINS_BEFORE_START}–${MAX_MINS_BEFORE_START}-min window, ${fresh.length} fresh`,
    );

    let acted = 0;
    for (const m of fresh) {
      processingMarkets.add(m.marketId);
      try {
        await runBookieMarket(
          m.marketId,
          m.eventName,
          m.marketName,
        );
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

async function scheduleBookieCycle(): Promise<void> {
  if (!bookieBotRunning) return;
  const INTERVAL_MS = 60_000;
  await runBookieCycle();
  if (bookieBotRunning) {
    bookieBotInterval = setTimeout(() => { void scheduleBookieCycle(); }, INTERVAL_MS);
  }
}

async function runBookieMarket(
  marketId: string,
  eventName: string,
  marketName: string,
): Promise<void> {
  const [config] = await db.select({ paperTradingMode: botConfigTable.paperTradingMode })
    .from(botConfigTable).limit(1);
  const paperTrading = config?.paperTradingMode ?? true;

  const marketDetail = await getMarketDetail(marketId);
  if (!marketDetail) return;

  // Market-level liquidity check
  if (marketDetail.totalMatched < bookieConfig.minLiquidity) {
    log("info",
      `Skipping ${eventName} — liquidity £${marketDetail.totalMatched.toFixed(0)} < £${bookieConfig.minLiquidity}`,
    );
    return;
  }

  // Filter to active runners with valid lay prices
  const activeRunners = marketDetail.runners.filter(r => {
    if (r.status !== "ACTIVE") return false;
    const price = r.bestLayPrice ?? r.bestBackPrice;
    if (!price || price < MIN_ODDS || price > MAX_ODDS) return false;
    return true;
  });

  if (activeRunners.length < bookieConfig.minRunners) {
    log("info",
      `Skipping ${eventName} — only ${activeRunners.length} eligible runner(s), need at least ${bookieConfig.minRunners}`,
    );
    return;
  }

  // Build runner list with volume and prices
  const runners = activeRunners.map(r => ({
    runner: r,
    layPrice: r.bestLayPrice ?? r.bestBackPrice ?? 2.0,
    volume: r.totalMatched ?? 0,
  }));

  // Total matched volume across all eligible runners
  const totalVolume = runners.reduce((s, r) => s + r.volume, 0);

  if (totalVolume < 500) {
    log("info",
      `Skipping ${eventName} — insufficient per-runner volume data (total: £${totalVolume.toFixed(0)})`,
    );
    return;
  }

  // Back-calculate total lay stake so the worst-case net loss = maxRaceNetLoss.
  //
  // stake_i = totalStake × (vol_i / totalVolume)
  // Race net if runner i wins = totalStake − stake_i × odds_i
  //                           = totalStake × (1 − vol_i × odds_i / totalVolume)
  //
  // Worst case = runner with highest (vol_i × odds_i / totalVolume).
  // Setting that equal to maxRaceNetLoss:
  //   totalStake × (maxRatio − 1) = maxRaceNetLoss
  //   totalStake = maxRaceNetLoss / (maxRatio − 1)
  //
  // Betfair minimum bet is £2. If any runner's calculated stake falls below that,
  // we drop it from the lay list and recalculate from scratch with the remaining
  // runners. We keep iterating until all stakes are ≥ £2 or fewer than minRunners
  // remain (in which case we skip the race entirely).

  const { maxRaceNetLoss, minRunners } = bookieConfig;
  const MIN_BET_SIZE = 2.0;

  type LayRunner = typeof runners[0] & { stake: number };

  let working = runners as Array<typeof runners[0]>;
  let withStakes: LayRunner[] = [];
  let totalStake = 0;

  while (working.length >= minRunners) {
    const vol = working.reduce((s, r) => s + r.volume, 0);
    const ratio = Math.max(...working.map(r => (r.volume * r.layPrice) / vol));
    const ts = ratio > 1
      ? Math.min(Math.floor((maxRaceNetLoss / (ratio - 1)) * 100) / 100, 10_000)
      : 10_000;

    const staked: LayRunner[] = working.map(r => ({
      ...r,
      stake: Math.round(ts * (r.volume / vol) * 100) / 100,
    }));

    const tooSmall = staked.filter(r => r.stake < MIN_BET_SIZE);

    if (tooSmall.length === 0) {
      withStakes = staked;
      totalStake = ts;
      break;
    }

    // Drop the runner with the smallest stake and retry
    const drop = tooSmall.reduce((a, b) => a.stake < b.stake ? a : b);
    log("info",
      `${eventName} — dropping ${drop.runner.runnerName} (stake £${drop.stake.toFixed(2)} < £${MIN_BET_SIZE} Betfair minimum), recalculating`,
    );
    working = working.filter(r => r.runner.selectionId !== drop.runner.selectionId);
  }

  if (withStakes.length < minRunners) {
    log("info",
      `Skipping ${eventName} — only ${withStakes.length} runner(s) left after removing sub-£${MIN_BET_SIZE} stakes (need ${minRunners})`,
    );
    return;
  }

  // Race P&L if runner i wins:
  //   = sum of all other stakes collected − liability on winner
  //   = totalStake − stake_i × odds_i
  const raceNets = withStakes.map(r => ({
    selectionId: r.runner.selectionId,
    name: r.runner.runnerName,
    odds: r.layPrice,
    stake: r.stake,
    raceNetIfWins: Math.round((totalStake - r.stake * r.layPrice) * 100) / 100,
  }));

  const worstCase = Math.min(...raceNets.map(r => r.raceNetIfWins));

  const summary = withStakes
    .map(r => `${r.runner.runnerName} £${r.stake.toFixed(2)} @ ${r.layPrice} (vol £${r.volume.toFixed(0)})`)
    .join(" | ");

  const finalTotalVolume = withStakes.reduce((s, r) => s + r.volume, 0);
  const finalMaxRatio = Math.max(...withStakes.map(r => (r.volume * r.layPrice) / finalTotalVolume));

  log("info",
    `LAYING ${withStakes.length} runners in ${eventName} — total stake £${totalStake.toFixed(2)} · worst-case -£${Math.abs(worstCase).toFixed(2)}${paperTrading ? " [PAPER]" : ""}`,
    { marketId, totalStake, runners: withStakes.length, worstCase, maxRatio: finalMaxRatio, summary },
  );

  for (const r of withStakes) {
    const net = raceNets.find(n => n.selectionId === r.runner.selectionId);
    const netStr = net
      ? `${net.raceNetIfWins >= 0 ? "+" : ""}£${net.raceNetIfWins.toFixed(2)}`
      : "unknown";
    const reasoning =
      `[BOOKIE] LAY £${r.stake.toFixed(2)} @ ${r.layPrice} · vol share ${((r.volume / finalTotalVolume) * 100).toFixed(1)}% · race net if wins: ${netStr}`;

    if (paperTrading) {
      await db.insert(betsTable).values({
        strategyId: null,
        strategyName: BOOKIE_STRATEGY_NAME,
        marketId,
        marketName,
        eventName,
        selectionId: r.runner.selectionId,
        selectionName: r.runner.runnerName,
        betType: "LAY",
        requestedOdds: r.layPrice.toFixed(2),
        matchedOdds: r.layPrice.toFixed(2),
        stakeAmount: r.stake.toFixed(2),
        potentialProfit: r.stake.toFixed(2),
        status: "MATCHED",
        aiReasoning: reasoning,
        betId: `BOOKIE-PAPER-${Date.now()}-${r.runner.selectionId}`,
      });
    } else {
      const result = await placeBet({
        marketId,
        selectionId: r.runner.selectionId,
        betType: "LAY",
        price: r.layPrice,
        size: r.stake,
      });
      await db.insert(betsTable).values({
        strategyId: null,
        strategyName: BOOKIE_STRATEGY_NAME,
        marketId,
        marketName,
        eventName,
        selectionId: r.runner.selectionId,
        selectionName: r.runner.runnerName,
        betType: "LAY",
        requestedOdds: r.layPrice.toFixed(2),
        stakeAmount: r.stake.toFixed(2),
        potentialProfit: r.stake.toFixed(2),
        status: result.status === "PLACED" ? "PLACED" : "CANCELLED",
        aiReasoning: reasoning,
        betId: result.betId ?? `BOOKIE-${Date.now()}-${r.runner.selectionId}`,
      });
    }
  }
}

export async function startBookieBot(): Promise<void> {
  if (bookieBotRunning) return;
  await loadBookieConfigFromDb();
  bookieBotRunning = true;
  bookieStartedAt = new Date();
  db.update(botConfigTable).set({ bookieIsRunning: true })
    .catch((err: unknown) => logger.error({ err }, "[BOOKIE] Failed to persist bookieIsRunning=true"));
  log("info", "Bookie Bot started");
  void scheduleBookieCycle();
  bookieSettlementInterval = setInterval(() => { void runBookieSettlement(); }, 2 * 60_000);
}

export async function stopBookieBot(): Promise<void> {
  if (!bookieBotRunning) return;
  bookieBotRunning = false;
  bookieStartedAt = null;
  if (bookieBotInterval) { clearTimeout(bookieBotInterval); bookieBotInterval = null; }
  if (bookieSettlementInterval) { clearInterval(bookieSettlementInterval); bookieSettlementInterval = null; }
  db.update(botConfigTable).set({ bookieIsRunning: false })
    .catch((err: unknown) => logger.error({ err }, "[BOOKIE] Failed to persist bookieIsRunning=false"));
  log("info", "Bookie Bot stopped");
}

async function runBookieSettlement(): Promise<void> {
  if (!getSession()) return;
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const unsettled = await db
      .select()
      .from(betsTable)
      .where(
        sql`${betsTable.strategyName} = ${BOOKIE_STRATEGY_NAME}
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

        // LAY bet settlement:
        // Horse WON  → we pay liability = stake × (odds − 1) → actualProfit negative
        // Horse LOST → we collect the backer's stake           → actualProfit positive
        const actualProfit = selectionWon
          ? -(stake * (odds - 1))
          :   stake;

        raceNet += actualProfit;

        await db.update(betsTable).set({
          // status from the LAY perspective: WON = horse lost (we collected), LOST = horse won (we paid)
          status: selectionWon ? "LOST" : "WON",
          actualProfit: actualProfit.toFixed(2),
          settledAt,
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

export async function autoResumeBookieBot(): Promise<void> {
  try {
    const [row] = await db.select({ bookieIsRunning: botConfigTable.bookieIsRunning })
      .from(botConfigTable).limit(1);
    if (row?.bookieIsRunning) {
      logger.info("[BOOKIE] Auto-resuming Bookie Bot from DB state");
      await startBookieBot();
    }
  } catch (err) {
    logger.error({ err }, "[BOOKIE] Failed to auto-resume");
  }
}
