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
const COUNTRIES = ["GB", "IE"];
const MIN_LIQUIDITY = 2000;
// Runners with less than this share of the total pool are skipped.
// Scales with market size: 2% of £5k = £100, 2% of £100k = £2k.
const MIN_RUNNER_SHARE = 0.02;
// Only bet on races starting in this window (minutes before the off).
// 1–4 min ensures the money distribution is mature (~90% of pre-race
// volume is already in) while still leaving time for lays to be matched.
const MIN_MINS_BEFORE_START = 1;
const MAX_MINS_BEFORE_START = 4;
const MIN_ODDS = 1.5;
const MAX_ODDS = 50;

const NON_WIN_PATTERN =
  /each.?way|forecast|\(f\/c\)|to be placed|\bTBP\b|match bet|daily win dist|without\s+\w|to win by|jockey.*champion|specials/i;

interface BookieConfig {
  maxRaceNetLoss: number;
  maxRunnerLiability: number;
}

let bookieBotRunning = false;
let bookieBotInterval: ReturnType<typeof setInterval> | null = null;
let bookieSettlementInterval: ReturnType<typeof setInterval> | null = null;
let bookieStartedAt: Date | null = null;
const processingMarkets = new Set<string>();

let bookieConfig: BookieConfig = {
  maxRaceNetLoss: 100,
  maxRunnerLiability: 300,
};

export function isBookieBotRunning(): boolean { return bookieBotRunning; }
export function getBookieStartedAt(): Date | null { return bookieStartedAt; }
export function getBookieConfig(): BookieConfig { return { ...bookieConfig }; }
export function setBookieConfig(patch: Partial<BookieConfig>): void {
  bookieConfig = { ...bookieConfig, ...patch };
}

async function log(level: string, message: string, metadata?: Record<string, unknown>): Promise<void> {
  await db.insert(botLogsTable).values({
    level,
    message: `[BOOKIE] ${message}`,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
  logger.info({ level, metadata }, `[BOOKIE] ${message}`);
}

async function runBookieCycle(): Promise<void> {
  if (!bookieBotRunning) return;
  try {
    if (!getSession()) {
      const r = await loginWithEnvCredentials();
      if (!r.success) {
        await log("warn", `Auto-connect failed: ${r.error}`);
        return;
      }
    }

    const [config] = await db.select().from(botConfigTable).limit(1);
    const paperTrading = config?.paperTradingMode ?? true;

    let markets: Awaited<ReturnType<typeof listMarkets>> = [];
    try {
      markets = await listMarkets({
        eventTypeId: "1",
        countryCodes: COUNTRIES,
        marketType: "WIN",
        limit: 30,
      });
    } catch (err) {
      await log("error", `API error fetching markets: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const now = Date.now();
    const candidates = markets.filter(m => {
      const fullName = `${m.eventName} ${m.marketName}`;
      if (NON_WIN_PATTERN.test(fullName)) return false;
      const startMs = new Date(m.marketStartTime).getTime();
      const minsToStart = (startMs - now) / 60_000;
      return minsToStart >= MIN_MINS_BEFORE_START && minsToStart <= MAX_MINS_BEFORE_START;
    });

    await log("info", `Cycle — ${markets.length} markets fetched, ${candidates.length} in ${MIN_MINS_BEFORE_START}–${MAX_MINS_BEFORE_START}-min window`);

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

      if (market.totalMatched < MIN_LIQUIDITY) {
        await log("info", `Skipping ${market.eventName} — liquidity £${market.totalMatched.toFixed(0)} < £${MIN_LIQUIDITY}`);
        continue;
      }

      processingMarkets.add(market.marketId);
      try {
        await runBookieMarket(market.marketId, market.eventName, market.marketName, paperTrading);
      } finally {
        processingMarkets.delete(market.marketId);
      }
    }
  } catch (err) {
    logger.error({ err }, "[BOOKIE] Cycle error");
    await log("error", `Cycle error: ${err instanceof Error ? err.message : "Unknown"}`);
  }
}

async function runBookieMarket(
  marketId: string,
  eventName: string,
  marketName: string,
  paperTrading: boolean,
): Promise<void> {
  const marketDetail = await getMarketDetail(marketId);
  if (!marketDetail) return;

  // Pass 1: filter by status and odds only
  const priceEligible = marketDetail.runners.filter(r => {
    if (r.status !== "ACTIVE") return false;
    const odds = r.bestLayPrice ?? r.bestBackPrice;
    if (!odds || odds < MIN_ODDS || odds > MAX_ODDS) return false;
    return true;
  });

  const totalMatchedSum = priceEligible.reduce((s, r) => s + (r.totalMatched ?? 0), 0);
  if (totalMatchedSum === 0) return;

  // Pass 2: drop runners with less than MIN_RUNNER_SHARE of the pool.
  // This scales with market size (2% of £5k = £100, 2% of £100k = £2k).
  const minMatchedForRunner = totalMatchedSum * MIN_RUNNER_SHARE;
  const eligible = priceEligible.filter(r => (r.totalMatched ?? 0) >= minMatchedForRunner);

  const dropped = priceEligible.length - eligible.length;
  if (dropped > 0) {
    await log("info",
      `${eventName} — dropped ${dropped} runner(s) with < ${(MIN_RUNNER_SHARE * 100).toFixed(0)}% of pool (< £${minMatchedForRunner.toFixed(0)})`,
    );
  }

  if (eligible.length < 2) {
    await log("info", `Skipping ${eventName} — only ${eligible.length} eligible runner(s) after share filter`);
    return;
  }

  const { maxRaceNetLoss, maxRunnerLiability } = bookieConfig;

  // Recompute sum from eligible runners only so shares sum to ~1 for the formula.
  const eligibleMatchedSum = eligible.reduce((s, r) => s + (r.totalMatched ?? 0), 0);

  const computations = eligible.map(r => {
    const odds = r.bestLayPrice ?? r.bestBackPrice ?? 2.0;
    const share = (r.totalMatched ?? 0) / eligibleMatchedSum;
    const netLossCoeff = share * odds - 1;
    const liabilityCoeff = share * (odds - 1);
    return { runner: r, odds, share, netLossCoeff, liabilityCoeff };
  });

  const maxNetLossCoeff = Math.max(...computations.map(c => c.netLossCoeff));
  const maxLiabilityCoeff = Math.max(...computations.map(c => c.liabilityCoeff));

  if (maxNetLossCoeff <= 0 || maxLiabilityCoeff <= 0) {
    await log("info", `Skipping ${eventName} — all runners naturally profitable to lay (rare)`);
    return;
  }

  const K = Math.min(
    maxRaceNetLoss / maxNetLossCoeff,
    maxRunnerLiability / maxLiabilityCoeff,
  );

  if (K < 1) {
    await log("info", `Skipping ${eventName} — K=${K.toFixed(2)} too small (stakes < £1)`);
    return;
  }

  const stakes = computations
    .map(c => ({
      runner: c.runner,
      odds: c.odds,
      share: c.share,
      stake: Math.round(K * c.share * 100) / 100,
      liability: Math.round(K * c.liabilityCoeff * 100) / 100,
      netLossIfWins: Math.round(K * c.netLossCoeff * 100) / 100,
    }))
    .filter(s => s.stake >= 2.00); // Betfair minimum lay stake is £2

  if (stakes.length === 0) return;

  const maxNetLoss = Math.max(...stakes.map(s => s.netLossIfWins));
  const totalStaked = stakes.reduce((s, x) => s + x.stake, 0);

  await log(
    "info",
    `Laying ${stakes.length} runners in ${eventName} — K=${K.toFixed(2)}, worst-case net loss £${maxNetLoss.toFixed(2)}, total stakes £${totalStaked.toFixed(2)}${paperTrading ? " [PAPER]" : ""}`,
    { marketId, K, maxNetLoss, totalStaked, runners: stakes.length },
  );

  for (const s of stakes) {
    const reasoning =
      `[BOOKIE] Crowd share ${(s.share * 100).toFixed(1)}% · lay @ ${s.odds} · stake £${s.stake.toFixed(2)} · liability £${s.liability.toFixed(2)} · net loss if wins £${s.netLossIfWins.toFixed(2)}`;

    if (paperTrading) {
      await db.insert(betsTable).values({
        strategyId: null,
        strategyName: BOOKIE_STRATEGY_NAME,
        marketId,
        marketName,
        eventName,
        selectionId: s.runner.selectionId,
        selectionName: s.runner.runnerName,
        betType: "LAY",
        requestedOdds: s.odds.toFixed(2),
        matchedOdds: s.odds.toFixed(2),
        stakeAmount: s.stake.toFixed(2),
        potentialProfit: s.stake.toFixed(2),
        status: "MATCHED",
        aiReasoning: reasoning,
        betId: `BOOKIE-PAPER-${Date.now()}-${s.runner.selectionId}`,
      });
    } else {
      const result = await placeBet({
        marketId,
        selectionId: s.runner.selectionId,
        betType: "LAY",
        price: s.odds,
        size: s.stake,
      });
      await db.insert(betsTable).values({
        strategyId: null,
        strategyName: BOOKIE_STRATEGY_NAME,
        marketId,
        marketName,
        eventName,
        selectionId: s.runner.selectionId,
        selectionName: s.runner.runnerName,
        betType: "LAY",
        requestedOdds: s.odds.toFixed(2),
        stakeAmount: s.stake.toFixed(2),
        potentialProfit: s.stake.toFixed(2),
        status: result.status === "PLACED" ? "PLACED" : "CANCELLED",
        aiReasoning: reasoning,
        betId: result.betId ?? `BOOKIE-${Date.now()}-${s.runner.selectionId}`,
      });
    }
  }
}

export async function startBookieBot(): Promise<void> {
  if (bookieBotRunning) return;
  bookieBotRunning = true;
  bookieStartedAt = new Date();
  await log("info", "Bookie Bot started");
  void runBookieCycle();
  bookieBotInterval = setInterval(() => { void runBookieCycle(); }, 60_000);
  bookieSettlementInterval = setInterval(() => { void runBookieSettlement(); }, 2 * 60_000);
}

export async function stopBookieBot(): Promise<void> {
  if (!bookieBotRunning) return;
  bookieBotRunning = false;
  bookieStartedAt = null;
  if (bookieBotInterval) { clearInterval(bookieBotInterval); bookieBotInterval = null; }
  if (bookieSettlementInterval) { clearInterval(bookieSettlementInterval); bookieSettlementInterval = null; }
  await log("info", "Bookie Bot stopped");
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

        const actualProfit = selectionWon
          ? -(stake * (odds - 1))
          : stake;

        if (selectionWon) totalPaidOut += stake * (odds - 1);
        else totalCollected += stake;

        await db.update(betsTable).set({
          status: selectionWon ? "LOST" : "WON",
          actualProfit: actualProfit.toFixed(2),
          settledAt,
        }).where(eq(betsTable.id, bet.id));
      }

      const netProfit = totalCollected - totalPaidOut;
      const winnerBet = bets.find(b => b.selectionId === winnerSelectionId);
      await log(
        "info",
        `[SETTLED] ${bets[0]?.eventName} — WINNER: ${winnerBet?.selectionName ?? "Unknown"} | Collected £${totalCollected.toFixed(2)}, Paid out £${totalPaidOut.toFixed(2)}, Net: ${netProfit >= 0 ? "+" : ""}£${netProfit.toFixed(2)}`,
        { marketId, totalCollected, totalPaidOut, netProfit },
      );
    }
  } catch (err) {
    logger.error({ err }, "[BOOKIE] Settlement error");
  }
}
