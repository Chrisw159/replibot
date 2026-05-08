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
const MAX_ODDS = 300; // runners above 300/1 are excluded from the lay field; race still runs without them

const NON_WIN_PATTERN =
  /each.?way|forecast|\(f\/c\)|\bFC\b|\bRFC\b|reverse\s|straight\s+f|combination\s+f|to be placed|\bTBP\b|match bet|daily win dist|without\s+\w|to win by|named\s+fav|jockey.*champion|specials|scorecast|wincast/i;

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

  // Filter to active runners within odds range.
  // Runners above 300/1 are excluded from the lay field — race still runs without them.
  const allActive = marketDetail.runners.filter(r => r.status === "ACTIVE");
  const excluded300 = allActive.filter(r => {
    const price = r.bestLayPrice ?? r.bestBackPrice ?? 0;
    return price > MAX_ODDS;
  });
  if (excluded300.length > 0) {
    log("info",
      `${eventName} — excluding ${excluded300.length} runner(s) above ${MAX_ODDS}/1 from lay field: ${excluded300.map(r => `${r.runnerName} (${r.bestLayPrice ?? r.bestBackPrice})`).join(", ")}`,
    );
  }

  const activeRunners = allActive.filter(r => {
    const price = r.bestLayPrice ?? r.bestBackPrice;
    return price && price >= MIN_ODDS && price <= MAX_ODDS;
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
  // Strategy requires laying ALL runners in the field.
  // Betfair minimum bet is £2 — if any single runner's calculated stake falls
  // below that, the race does not match the strategy and is skipped entirely.
  // No partial fields, no runner substitutions.

  const { maxRaceNetLoss } = bookieConfig;
  const MIN_BET_SIZE = 2.0;

  const maxRatio = Math.max(...runners.map(r => (r.volume * r.layPrice) / totalVolume));
  const totalStake = maxRatio > 1
    ? Math.min(Math.floor((maxRaceNetLoss / (maxRatio - 1)) * 100) / 100, 10_000)
    : 10_000;

  const withStakes = runners.map(r => ({
    ...r,
    stake: Math.round(totalStake * (r.volume / totalVolume) * 100) / 100,
  }));

  const belowMin = withStakes.filter(r => r.stake < MIN_BET_SIZE);
  if (belowMin.length > 0) {
    const names = belowMin.map(r => `${r.runner.runnerName} £${r.stake.toFixed(2)}`).join(", ");
    log("info",
      `Skipping ${eventName} — ${belowMin.length} runner(s) below £${MIN_BET_SIZE} Betfair minimum (${names}); race does not match strategy`,
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
  const bestCase  = Math.max(...raceNets.map(r => r.raceNetIfWins));

  if (bestCase < 0) {
    log("info",
      `Skipping ${eventName} — every outcome is a loss (best case: £${bestCase.toFixed(2)}); race does not match strategy`,
    );
    return;
  }

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
