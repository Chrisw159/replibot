import { logger } from "./logger";
import { db } from "@workspace/db";
import { goalSignalsTable } from "@workspace/db/schema";
import { desc, gte } from "drizzle-orm";
import { getSession, listMarkets, apiBetfairRequest } from "./betfair";

const POLL_INTERVAL_MS = 2500; // poll every 2.5 seconds
const FOOTBALL_EVENT_TYPE_ID = "1"; // Betfair football = event type 1
const MATCH_ODDS_MARKET_TYPE = "MATCH_ODDS";

// How much the back price of a runner must drop (%) to flag as a goal signal
const GOAL_SIGNAL_DROP_PCT = 25;
// A market suspension is itself a goal signal (Betfair suspends in-play on goals)
// We combine suspension + subsequent price move for high-confidence detection

interface WatchedMarket {
  marketId: string;
  eventId: string;
  eventName: string;
  marketName: string;
  homeTeam: string;
  awayTeam: string;
  lastPrices: Map<number, number>; // selectionId → last known bestBackPrice
  wasSupended: boolean;
  startedAt: Date;
}

let detectorInterval: ReturnType<typeof setInterval> | null = null;
let isDetectorRunning = false;
let watchedMarkets: Map<string, WatchedMarket> = new Map();
let lastDiscoveryAt = 0;
const DISCOVERY_INTERVAL_MS = 60_000; // re-scan for new live matches every minute

export function isGoalDetectorRunning(): boolean {
  return isDetectorRunning;
}

export function getWatchedMarketCount(): number {
  return watchedMarkets.size;
}

export function startGoalDetector(): void {
  if (isDetectorRunning) return;
  isDetectorRunning = true;
  watchedMarkets = new Map();
  lastDiscoveryAt = 0;
  logger.info("[GOALBOT] Goal detector started");
  detectorInterval = setInterval(runDetectorCycle, POLL_INTERVAL_MS);
  // Run immediately
  runDetectorCycle().catch(err =>
    logger.error({ err }, "[GOALBOT] Error in first detector cycle")
  );
}

export function stopGoalDetector(): void {
  if (!isDetectorRunning) return;
  isDetectorRunning = false;
  if (detectorInterval) {
    clearInterval(detectorInterval);
    detectorInterval = null;
  }
  watchedMarkets = new Map();
  logger.info("[GOALBOT] Goal detector stopped");
}

async function runDetectorCycle(): Promise<void> {
  if (!isDetectorRunning) return;
  const session = getSession();
  if (!session) {
    logger.warn("[GOALBOT] No Betfair session — skipping cycle");
    return;
  }

  try {
    // Re-discover live football markets periodically
    const now = Date.now();
    if (now - lastDiscoveryAt > DISCOVERY_INTERVAL_MS) {
      await discoverLiveMatches();
      lastDiscoveryAt = now;
    }

    if (watchedMarkets.size === 0) return;

    await pollWatchedMarkets();
  } catch (err) {
    logger.error({ err }, "[GOALBOT] Cycle error");
  }
}

async function discoverLiveMatches(): Promise<void> {
  try {
    const markets = await listMarkets({
      eventTypeId: FOOTBALL_EVENT_TYPE_ID,
      marketType: MATCH_ODDS_MARKET_TYPE,
      hoursAhead: 0, // only currently live / just started
    });

    // Filter to in-play markets
    const liveMarkets = markets.filter(m => m.inPlay && m.status === "OPEN");

    // Remove markets no longer in play
    for (const [marketId] of watchedMarkets) {
      if (!liveMarkets.find(m => m.marketId === marketId)) {
        watchedMarkets.delete(marketId);
        logger.info({ marketId }, "[GOALBOT] Removed market no longer in play");
      }
    }

    // Add newly discovered live markets
    for (const market of liveMarkets) {
      if (watchedMarkets.has(market.marketId)) continue;

      // Parse team names from event name (e.g. "Liverpool v Man Utd")
      const parts = market.eventName.split(/\s+v\s+/i);
      const homeTeam = parts[0]?.trim() ?? market.eventName;
      const awayTeam = parts[1]?.trim() ?? "";

      watchedMarkets.set(market.marketId, {
        marketId: market.marketId,
        eventId: market.marketId,
        eventName: market.eventName,
        marketName: market.marketName,
        homeTeam,
        awayTeam,
        lastPrices: new Map(),
        wasSupended: false,
        startedAt: new Date(market.marketStartTime),
      });

      logger.info({ marketId: market.marketId, event: market.eventName }, "[GOALBOT] Now watching live match");
    }

    logger.info({ watching: watchedMarkets.size, found: liveMarkets.length }, "[GOALBOT] Discovery complete");
  } catch (err) {
    logger.error({ err }, "[GOALBOT] Discovery error");
  }
}

async function pollWatchedMarkets(): Promise<void> {
  const marketIds = Array.from(watchedMarkets.keys());
  if (marketIds.length === 0) return;

  interface BookRunner {
    selectionId: number;
    status: string;
    lastPriceTraded?: number;
    ex?: {
      availableToBack?: Array<{ price: number; size: number }>;
    };
  }

  interface BookResult {
    marketId: string;
    status: string;
    inplay?: boolean;
    totalMatched?: number;
    runners?: BookRunner[];
  }

  let books: BookResult[];
  try {
    books = await apiBetfairRequest<BookResult[]>(
      "SportsAPING/v1.0/listMarketBook",
      {
        marketIds,
        priceProjection: {
          priceData: ["EX_BEST_OFFERS"],
          exBestOffersOverrides: { bestPricesDepth: 1 },
        },
      }
    );
  } catch (err) {
    logger.error({ err }, "[GOALBOT] listMarketBook error");
    return;
  }

  if (!Array.isArray(books)) return;

  for (const book of books) {
    const watched = watchedMarkets.get(book.marketId);
    if (!watched) continue;

    const isSuspended = book.status === "SUSPENDED";
    const wasAlreadySuspended = watched.wasSupended;
    watched.wasSupended = isSuspended;

    // Market closed — remove it
    if (book.status === "CLOSED") {
      watchedMarkets.delete(book.marketId);
      continue;
    }

    // Market no longer in play — remove
    if (!book.inplay) {
      watchedMarkets.delete(book.marketId);
      continue;
    }

    const secondsIntoMatch = Math.round(
      (Date.now() - watched.startedAt.getTime()) / 1000
    );

    // Detect suspension (Betfair suspends in-play markets the instant a goal is scored)
    if (isSuspended && !wasAlreadySuspended) {
      logger.info({ event: watched.eventName }, "[GOALBOT] Market suspended — likely goal!");
      await logSignal({
        watched,
        signalType: "GOAL_DETECTED",
        triggerDescription: `Market suspended mid-play — Betfair suspends immediately on goals`,
        marketSuspended: true,
        confirmed: false,
        secondsIntoMatch,
        totalMatched: book.totalMatched,
      });
    }

    // Check for sharp price moves on individual runners
    for (const runner of book.runners ?? []) {
      const bestBack = runner.ex?.availableToBack?.[0]?.price;
      if (!bestBack) continue;

      const prevPrice = watched.lastPrices.get(runner.selectionId);
      watched.lastPrices.set(runner.selectionId, bestBack);

      if (!prevPrice) continue;

      const changePct = ((prevPrice - bestBack) / prevPrice) * 100;

      // Sharp price DROP on a team (their odds shorten a lot = goal scored by them)
      if (changePct >= GOAL_SIGNAL_DROP_PCT) {
        // Find runner name — we stored it during discovery? No — use selectionId for now
        // The odds on a team collapse when they score
        const description =
          `Sharp odds drop on selection ${runner.selectionId}: ` +
          `${prevPrice.toFixed(2)} → ${bestBack.toFixed(2)} (−${changePct.toFixed(1)}%)`;

        logger.info({ event: watched.eventName, changePct: changePct.toFixed(1), selectionId: runner.selectionId }, "[GOALBOT] Sharp price move detected");

        await logSignal({
          watched,
          signalType: isSuspended ? "GOAL_DETECTED" : "ODDS_SPIKE",
          triggerDescription: description,
          marketSuspended: isSuspended,
          confirmed: isSuspended, // high confidence if suspended + price move
          oddsMovePct: changePct,
          oddsBeforeMove: prevPrice,
          oddsAfterMove: bestBack,
          affectedSelection: String(runner.selectionId),
          secondsIntoMatch,
          totalMatched: book.totalMatched,
        });
      }
    }
  }
}

async function logSignal(params: {
  watched: WatchedMarket;
  signalType: string;
  triggerDescription: string;
  marketSuspended: boolean;
  confirmed: boolean;
  oddsMovePct?: number;
  oddsBeforeMove?: number;
  oddsAfterMove?: number;
  affectedSelection?: string;
  secondsIntoMatch?: number;
  totalMatched?: number;
}): Promise<void> {
  try {
    await db.insert(goalSignalsTable).values({
      eventId: params.watched.eventId,
      eventName: params.watched.eventName,
      marketId: params.watched.marketId,
      marketName: params.watched.marketName,
      signalType: params.signalType,
      homeTeam: params.watched.homeTeam,
      awayTeam: params.watched.awayTeam,
      triggerDescription: params.triggerDescription,
      marketSuspended: params.marketSuspended,
      confirmed: params.confirmed,
      oddsMovePct: params.oddsMovePct ?? null,
      oddsBeforeMove: params.oddsBeforeMove ?? null,
      oddsAfterMove: params.oddsAfterMove ?? null,
      affectedSelection: params.affectedSelection ?? null,
      secondsIntoMatch: params.secondsIntoMatch ?? null,
      totalMatched: params.totalMatched ?? null,
    });
  } catch (err) {
    logger.error({ err }, "[GOALBOT] Failed to log signal");
  }
}

export async function getRecentSignals(limit = 50) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return db
    .select()
    .from(goalSignalsTable)
    .where(gte(goalSignalsTable.createdAt, since))
    .orderBy(desc(goalSignalsTable.createdAt))
    .limit(limit);
}
