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
// Fixed parameters — not user-configurable
const MIN_RUNNER_SHARE = 0.02;
const MIN_MINS_BEFORE_START = 1;
const MAX_MINS_BEFORE_START = 4;
const MIN_ODDS = 1.5;
const HARD_MAX_ODDS = 1000;

const NON_WIN_PATTERN =
  /each.?way|forecast|\(f\/c\)|to be placed|\bTBP\b|match bet|daily win dist|without\s+\w|to win by|jockey.*champion|specials/i;

interface BookieConfig {
  // Lay stake per runner — this is the backer's stake you're accepting.
  // Your liability if that runner wins = stakePerRunner × (odds − 1).
  stakePerRunner: number;
  // Skip the race if worst-case net loss (highest-odds runner wins) exceeds this.
  maxRaceNetLoss: number;
  // Don't lay runners above this price — caps your maximum liability per runner.
  maxOdds: number;
  // Skip races with fewer eligible runners than this.
  minRunners: number;
  // Countries to scan. Common codes: GB, IE, US, AU, ZA, FR
  countryCodes: string[];
  // Minimum market totalMatched.
  minLiquidity: number;
}

let bookieBotRunning = false;
let bookieBotInterval: ReturnType<typeof setTimeout> | null = null;
let bookieSettlementInterval: ReturnType<typeof setInterval> | null = null;
let bookieStartedAt: Date | null = null;
const processingMarkets = new Set<string>();

let bookieConfig: BookieConfig = {
  stakePerRunner: 10,
  maxRaceNetLoss: 150,
  maxOdds: 20,
  minRunners: 5,
  countryCodes: ["GB", "IE"],
  minLiquidity: 1000,
};

export function isBookieBotRunning(): boolean { return bookieBotRunning; }
export function getBookieStartedAt(): Date | null { return bookieStartedAt; }
export function getBookieConfig(): BookieConfig { return { ...bookieConfig }; }
export function setBookieConfig(patch: Partial<BookieConfig>): void {
  bookieConfig = { ...bookieConfig, ...patch };
  // If country codes changed while the bot is sleeping, cancel the timer and
  // reschedule immediately so the new countries take effect without a restart.
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
    const [row] = await db.select({ bookieConfigJson: botConfigTable.bookieConfigJson }).from(botConfigTable).limit(1);
    if (row?.bookieConfigJson) {
      const saved = row.bookieConfigJson as Partial<BookieConfig>;
      if (Array.isArray(saved.countryCodes)) bookieConfig.countryCodes = saved.countryCodes;
      if (typeof saved.minLiquidity === "number") bookieConfig.minLiquidity = saved.minLiquidity;
      if (typeof saved.stakePerRunner === "number") bookieConfig.stakePerRunner = saved.stakePerRunner;
      if (typeof saved.maxRaceNetLoss === "number") bookieConfig.maxRaceNetLoss = saved.maxRaceNetLoss;
      if (typeof saved.maxOdds === "number") bookieConfig.maxOdds = saved.maxOdds;
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
  // Fire-and-forget — never let a DB write block or crash the cycle
  db.insert(botLogsTable).values({
    level,
    message: fullMessage,
    metadata: metadata ? JSON.stringify(metadata) : null,
  }).catch((err: unknown) => logger.error({ err }, "[BOOKIE] Failed to write log to DB"));
}

// Returns the number of candidates acted on (used by scheduler)
async function runBookieCycle(): Promise<number> {
  if (!bookieBotRunning) return 0;
  try {
    if (!getSession()) {
      const r = await loginWithEnvCredentials();
      if (!r.success) {
        log("warn", `Auto-connect failed: ${r.error}`);
        return 0;
      }
    }

    const [config] = await db.select().from(botConfigTable).limit(1);
    const paperTrading = config?.paperTradingMode ?? true;

    const countryCodes = bookieConfig.countryCodes?.length ? bookieConfig.countryCodes : ["GB", "IE"];
    const { minLiquidity } = bookieConfig;
    let markets: Awaited<ReturnType<typeof listMarkets>> = [];
    try {
      // hoursAhead: 2 ensures we only get markets starting in the next 2 hours,
      // excluding already-started/in-play races that listMarketCatalogue returns
      // by default when no time filter is applied.
      markets = await listMarkets({
        eventTypeId: "7",
        countryCodes,
        marketType: "WIN",
        limit: 50,
        hoursAhead: 2,
      });
    } catch (err) {
      log("error", `API error fetching markets: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    const now = Date.now();
    const candidates = markets.filter(m => {
      const fullName = `${m.eventName} ${m.marketName}`;
      if (NON_WIN_PATTERN.test(fullName)) return false;
      const startMs = new Date(m.marketStartTime).getTime();
      const minsToStart = (startMs - now) / 60_000;
      return minsToStart >= MIN_MINS_BEFORE_START && minsToStart <= MAX_MINS_BEFORE_START;
    });

    log("info", `Cycle — ${markets.length} markets fetched, ${candidates.length} in ${MIN_MINS_BEFORE_START}–${MAX_MINS_BEFORE_START}-min window`);

    let acted = 0;
    for (const market of candidates) {
      if (!bookieBotRunning) break;
      if (processingMarkets.has(market.marketId)) continue;

      const [existing] = await db
        .select({ id: betsTable.id })
        .from(betsTable)
        .where(
          sql`${betsTable.marketId} = ${market.marketId}
              AND ${betsTable.strategyName} = ${BOOKIE_STRATEGY_NAME}`
        )
        .limit(1);
      if (existing) continue;

      processingMarkets.add(market.marketId);
      acted++;
      try {
        await runBookieMarket(market.marketId, market.eventName, market.marketName, paperTrading, minLiquidity);
      } finally {
        processingMarkets.delete(market.marketId);
      }
    }
    return acted;
  } catch (err) {
    logger.error({ err }, "[BOOKIE] Cycle error");
    log("error", `Cycle error: ${err instanceof Error ? err.message : "Unknown"}`);
    return 0;
  }
}

// ── Smart scheduler ───────────────────────────────────────────────────────────
// Wake up 5 min before the next unbet race in the configured countries.
// Falls back to 60 s polling when a race is imminent or 1 h when nothing is
// visible on the card (e.g. early morning or between cards).
const WAKE_BEFORE_MS   = 5 * 60_000;   // wake 5 min before the race
const MIN_SLEEP_MS     = 30_000;        // never faster than 30 s
const MAX_LOOK_AHEAD_H = 36;            // look up to 36 h ahead

async function computeBookieSleepMs(): Promise<number> {
  try {
    const countryCodes = bookieConfig.countryCodes?.length ? bookieConfig.countryCodes : ["GB", "IE"];
    const markets = await listMarkets({
      eventTypeId: "7",
      countryCodes,
      marketType: "WIN",
      limit: 100,
      hoursAhead: MAX_LOOK_AHEAD_H,
    });

    // Markets already bet on by Bookie Bot
    const betMarketIds = new Set(
      (await db
        .select({ marketId: betsTable.marketId })
        .from(betsTable)
        .where(sql`${betsTable.strategyName} = ${BOOKIE_STRATEGY_NAME}`)
      ).map(b => b.marketId)
    );

    const now = Date.now();
    const futureUnbet = markets
      .filter(m => {
        const fullName = `${m.eventName} ${m.marketName}`;
        return !NON_WIN_PATTERN.test(fullName) && !betMarketIds.has(m.marketId);
      })
      .map(m => new Date(m.marketStartTime).getTime())
      .filter(t => t > now + MAX_MINS_BEFORE_START * 60_000) // skip ones already in the window
      .sort((a, b) => a - b);

    if (futureUnbet.length === 0) {
      log("info", "[SCHEDULER] No upcoming races in the next 36 h — sleeping 1 hour");
      return 60 * 60_000;
    }

    const firstRace = futureUnbet[0];
    const sleepUntil = firstRace - WAKE_BEFORE_MS;
    const sleepMs = Math.max(MIN_SLEEP_MS, sleepUntil - now);

    const firstRaceDate = new Date(firstRace);
    const wakeDate = new Date(now + sleepMs);
    const isNextDay = firstRaceDate.getDate() !== new Date(now).getDate();
    const raceLabel = firstRaceDate.toLocaleString("en-GB", {
      weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
      ...(isNextDay ? { day: "numeric", month: "short" } : {}),
    });
    const wakeLabel = wakeDate.toLocaleString("en-GB", {
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
      ...(isNextDay ? { weekday: "short", day: "numeric", month: "short" } : {}),
    });
    const sleepHours = sleepMs / 3_600_000;
    const sleepDesc = sleepHours >= 1
      ? `${sleepHours.toFixed(1)} h`
      : `${(sleepMs / 60_000).toFixed(1)} min`;

    if (sleepMs > 30 * 60_000) {
      log("info",
        `[SCHEDULER] Next race at ${raceLabel} — sleeping ${sleepDesc}, waking at ${wakeLabel}`
      );
    }
    return sleepMs;
  } catch {
    return MIN_SLEEP_MS;
  }
}

async function scheduleBookieCycle(): Promise<void> {
  if (!bookieBotRunning) return;

  try {
    await runBookieCycle();
  } catch (err) {
    logger.error({ err }, "[BOOKIE] Unhandled cycle error — will reschedule");
  }

  if (!bookieBotRunning) return;

  let sleepMs = MIN_SLEEP_MS;
  try {
    sleepMs = await computeBookieSleepMs();
  } catch (err) {
    logger.error({ err }, "[BOOKIE] computeBookieSleepMs threw — falling back to 30 s");
  }

  if (bookieBotRunning) {
    bookieBotInterval = setTimeout(() => void scheduleBookieCycle(), sleepMs);
  }
}

async function runBookieMarket(
  marketId: string,
  eventName: string,
  marketName: string,
  paperTrading: boolean,
  minLiquidity: number,
): Promise<void> {
  const marketDetail = await getMarketDetail(marketId);
  if (!marketDetail) return;

  // Real liquidity check — marketDetail.totalMatched comes from listMarketBook,
  // unlike listMarketCatalogue which always returns 0 for totalMatched.
  if (marketDetail.totalMatched < minLiquidity) {
    log("info", `Skipping ${eventName} — liquidity £${marketDetail.totalMatched.toFixed(0)} < £${minLiquidity}`);
    return;
  }

  const { maxOdds } = bookieConfig;

  // Pass 1: filter by status and odds only.
  // Use lay price for LAY bets; fall back to back price if lay not available.
  const priceEligible = marketDetail.runners.filter(r => {
    if (r.status !== "ACTIVE") return false;
    const layPrice = r.bestLayPrice ?? r.bestBackPrice;
    if (!layPrice || layPrice < MIN_ODDS || layPrice > Math.min(maxOdds, HARD_MAX_ODDS)) return false;
    return true;
  });

  if (priceEligible.length < 2) {
    log("info", `Skipping ${eventName} — only ${priceEligible.length} runner(s) with valid odds`);
    return;
  }

  // Use lay price for the bet; back price for implied probability calculation.
  const withPrices = priceEligible.map(r => {
    const layPrice  = r.bestLayPrice  ?? r.bestBackPrice ?? 2.0;
    const backPrice = r.bestBackPrice ?? r.bestLayPrice  ?? 2.0;
    const impliedProb = 1 / backPrice;
    return { runner: r, layPrice, backPrice, impliedProb };
  });

  const totalImplied = withPrices.reduce((s, r) => s + r.impliedProb, 0);

  // Pass 2: drop runners with less than MIN_RUNNER_SHARE of the implied pool.
  const eligible = withPrices.filter(r => (r.impliedProb / totalImplied) >= MIN_RUNNER_SHARE);

  const dropped = withPrices.length - eligible.length;
  if (dropped > 0) {
    log("info",
      `${eventName} — dropped ${dropped} runner(s) with < ${(MIN_RUNNER_SHARE * 100).toFixed(0)}% implied probability`,
    );
  }

  if (eligible.length < 2) {
    log("info", `Skipping ${eventName} — only ${eligible.length} eligible runner(s) after share filter`);
    return;
  }

  const { stakePerRunner, maxRaceNetLoss, minRunners } = bookieConfig;

  if (eligible.length < minRunners) {
    log("info",
      `Skipping ${eventName} — only ${eligible.length} eligible runner(s), need at least ${minRunners}`,
    );
    return;
  }

  // LAY ALL eligible runners at equal stake.
  //
  // P&L when runner i wins:
  //   = (n−1) × stakePerRunner  [collected from all other lays]
  //   − stakePerRunner × (odds_i − 1)  [liability paid on the winner]
  //   = stakePerRunner × (n − odds_i)
  //
  // Profit   when odds_i < n  (favourite / short-priced runners)
  // Breakeven when odds_i = n
  // Loss     when odds_i > n  (outsiders)
  //
  // Max liability (worst case): stakePerRunner × (maxOdds − 1)
  const n = eligible.length;
  const breakevenOdds = n; // the decimal odds value that produces zero P&L
  const maxLiability  = Math.round(stakePerRunner * (eligible[eligible.length - 1].layPrice - 1) * 100) / 100;
  const worstCaseLoss = Math.round(stakePerRunner * (eligible[eligible.length - 1].layPrice - n) * 100) / 100;

  if (worstCaseLoss > maxRaceNetLoss) {
    log("info",
      `Skipping ${eventName} — worst-case loss £${worstCaseLoss.toFixed(2)} exceeds limit £${maxRaceNetLoss} (raise maxOdds or maxRaceNetLoss)`,
    );
    return;
  }

  const runnerSummary = eligible
    .map(r => `${r.runner.runnerName} (${r.layPrice})`)
    .join(", ");

  log(
    "info",
    `LAYING ${n} runners in ${eventName} — £${stakePerRunner}/runner · breakeven @ ${breakevenOdds} odds · worst-case -£${Math.abs(worstCaseLoss).toFixed(2)} if outsider wins · [${runnerSummary}]${paperTrading ? " [PAPER]" : ""}`,
    { marketId, stakePerRunner, runners: n, breakevenOdds, maxLiability, worstCaseLoss },
  );

  for (const r of eligible) {
    const odds = r.layPrice;
    // Net P&L for this race if THIS runner wins
    const netIfThisWins = Math.round(stakePerRunner * (n - odds) * 100) / 100;
    const reasoning =
      `[BOOKIE] LAY @ ${odds} · £${stakePerRunner} stake · net if wins ${netIfThisWins >= 0 ? "+" : ""}£${netIfThisWins.toFixed(2)} · ${n} runners · breakeven ${breakevenOdds}`;

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
        requestedOdds: odds.toFixed(2),
        matchedOdds: odds.toFixed(2),
        stakeAmount: stakePerRunner.toFixed(2),
        // potentialProfit = what we collect if this runner LOSES (the common outcome)
        potentialProfit: stakePerRunner.toFixed(2),
        status: "MATCHED",
        aiReasoning: reasoning,
        betId: `BOOKIE-PAPER-${Date.now()}-${r.runner.selectionId}`,
      });
    } else {
      const result = await placeBet({
        marketId,
        selectionId: r.runner.selectionId,
        betType: "LAY",
        price: odds,
        size: stakePerRunner,
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
        requestedOdds: odds.toFixed(2),
        stakeAmount: stakePerRunner.toFixed(2),
        potentialProfit: stakePerRunner.toFixed(2),
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
  // Persist running state so auto-resume works after server restart
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
  // Persist stopped state
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
            AND ${betsTable.placedAt} >= ${cutoff}`
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
      let totalCollected = 0;
      let totalPaidOut = 0;

      for (const bet of bets) {
        if (bet.status === "UNMATCHED") {
          await db.update(betsTable).set({ status: "VOID", actualProfit: "0", settledAt }).where(eq(betsTable.id, bet.id));
          continue;
        }

        const selectionWon = bet.selectionId === winnerSelectionId;
        const odds = Number(bet.matchedOdds ?? bet.requestedOdds);
        const stake = Number(bet.stakeAmount);

        // LAY bet settlement:
        // WON  = horse LOST the race  → we collect backer's stake  = +stake
        // LOST = horse WON the race   → we pay liability           = −stake × (odds − 1)
        const actualProfit = selectionWon
          ? -(stake * (odds - 1))   // we pay the liability
          :   stake;                // we collect the backer's stake

        if (!selectionWon) totalCollected += stake;
        else totalPaidOut += stake * (odds - 1);

        await db.update(betsTable).set({
          // For a LAY bet: WON means the horse LOST (we keep the stake)
          status: selectionWon ? "LOST" : "WON",
          actualProfit: actualProfit.toFixed(2),
          settledAt,
        }).where(eq(betsTable.id, bet.id));
      }

      const netProfit = totalCollected - totalPaidOut;
      const winnerBet = bets.find(b => b.selectionId === winnerSelectionId);
      log(
        "info",
        `[SETTLED] ${bets[0]?.eventName} — WINNER: ${winnerBet?.selectionName ?? "Unknown"} | Collected £${totalCollected.toFixed(2)}, Paid out £${totalPaidOut.toFixed(2)}, Net: ${netProfit >= 0 ? "+" : ""}£${netProfit.toFixed(2)}`,
        { marketId, totalCollected, totalPaidOut, netProfit },
      );
    }
  } catch (err) {
    logger.error({ err }, "[BOOKIE] Settlement error");
  }
}
