/**
 * SOCCER IN-PLAY "NO MORE GOALS" ENGINE
 *
 * Strategy (frozen with the user, 17 Aug 2026 — paper mode until proven):
 *  - From `entryMinute` (default 80') onward, find live soccer games with a
 *    goal gap >= `minGoalGap` (default 2) — dead games where nobody chases.
 *  - Prefer the one-goal-insured Under line (current total + 1.5, e.g. 2-0
 *    → Under 3.5) when it is above its odds threshold. Otherwise take the
 *    tight line (current total + 0.5, e.g. 2-0 → Under 2.5) only when it is
 *    above its own odds threshold.
 *  - Immediately rest one £50 lay at the valid tick that locks at least £20
 *    net when the Under wins and £0 when it loses. Never chase or replace it.
 *
 * Score inference: the Betfair betting API exposes no scoreline, so the
 * engine reads the CORRECT_SCORE market — at the 85th minute the true score
 * trades at ~1.0x. Games whose score cannot be read unambiguously (e.g. 4-3
 * territory covered only by "Any Other Home Win") are skipped and logged.
 * Match minute is estimated from kick-off time (+15 min half-time break).
 */
import { and, eq, desc, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  soccerConfigTable,
  soccerTradesTable,
  botLogsTable,
  type SoccerConfig,
  type SoccerTrade,
} from "@workspace/db/schema";
import {
  getSession,
  loginWithEnvCredentials,
  apiBetfairRequest,
} from "./betfair";
import { logger } from "./logger";
import {
  addEqualLayFill,
  FULL_MATCH_ENTRY_STAKE_GBP,
  equalStakeCombinedProfit,
  compatibleLayAggregate,
  inferScore,
  isStakeFullyMatched,
  estimateMinute,
  chooseEntryLine,
  layLockPrice,
  layLockWinProfit,
  tradedVolumeAtPrice,
  immediateLayFill,
  ouLineFromMarketType,
} from "./soccerHelpers";
import { fetchLiveScores, matchFeedScore } from "./scoreFeed";

const SOCCER_EVENT_TYPE = "1";
const RESTING_LAY_MONITOR_MS = 1_000;
const LAY_LOCK_TARGET_PCT = 40;

// ── In-memory state ─────────────────────────────────────────────────────────
let running = false;
let startedAt: Date | null = null;
let lastCycleAt: Date | null = null;
let cycleTimer: ReturnType<typeof setTimeout> | null = null;
let layMonitorTimer: ReturnType<typeof setTimeout> | null = null;
let processing = false;
let layMonitorProcessing = false;
let layMonitorPromise: Promise<void> | null = null;
let layMonitorPromiseGeneration: number | null = null;
let runGeneration = 0;

export interface SoccerCandidateSnapshot {
  eventName: string;
  competition: string | null;
  marketId: string | null;
  score: string;
  goalGap: number;
  minute: number;
  tightLine: number | null;
  tightOdds: number | null;
  bufferLine: number | null;
  bufferOdds: number | null;
  liquidity: number | null;
  verdict: "ENTERED" | "WATCHING" | "SKIPPED" | "OPEN";
  reason: string;
}

let candidates: SoccerCandidateSnapshot[] = [];
let watchedGames = 0;

export function isSoccerBotRunning(): boolean {
  return running;
}
export function getSoccerBotStartedAt(): Date | null {
  return startedAt;
}
export function getSoccerLastCycleAt(): Date | null {
  return lastCycleAt;
}
export function getSoccerCandidatesSnapshot(): SoccerCandidateSnapshot[] {
  return candidates;
}
export function getWatchedGameCount(): number {
  return watchedGames;
}

// ── Config ──────────────────────────────────────────────────────────────────
export async function getSoccerConfig(): Promise<SoccerConfig> {
  const rows = await db.select().from(soccerConfigTable).limit(1);
  if (rows.length > 0) {
    const config = rows[0]!;
    const patch: Partial<SoccerConfig> = {};
    // The full-match strategy no longer enters before the 80th minute.
    if (config.entryMinute < 80) {
      patch.entryMinute = 80;
    }
    if (Object.keys(patch).length > 0) {
      const [updated] = await db
        .update(soccerConfigTable)
        .set(patch)
        .where(eq(soccerConfigTable.id, config.id))
        .returning();
      return updated ?? { ...config, ...patch };
    }
    return config;
  }
  const inserted = await db
    .insert(soccerConfigTable)
    .values({
      entryMinute: 80,
      paperMode: true,
    })
    .returning();
  return inserted[0]!;
}

async function slog(level: string, message: string, metadata?: unknown) {
  const line = `[SOCCER] ${message}`;
  if (level === "error") logger.error({ metadata }, line);
  else logger.info({ metadata }, line);
  try {
    await db.insert(botLogsTable).values({
      level,
      message: line,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });
  } catch {
    /* logging must never kill the cycle */
  }
}

// ── Betfair helpers ─────────────────────────────────────────────────────────
interface CatalogueMarket {
  marketId: string;
  marketName: string;
  event?: { id?: string; name?: string; openDate?: string };
  competition?: { name?: string };
  marketStartTime?: string;
  totalMatched?: number;
  description?: { marketType?: string };
  runners?: Array<{ selectionId: number; runnerName: string }>;
}

interface BookRunner {
  selectionId: number;
  status: string;
  lastPriceTraded?: number;
  ex?: {
    availableToBack?: Array<{ price: number; size: number }>;
    availableToLay?: Array<{ price: number; size: number }>;
    tradedVolume?: Array<{ price: number; size: number }>;
  };
}

interface Book {
  marketId: string;
  status: string;
  inplay?: boolean;
  totalMatched?: number;
  runners?: BookRunner[];
}

async function listInPlaySoccerMarkets(
  marketTypes: string[],
  maxResults: number,
): Promise<CatalogueMarket[]> {
  return apiBetfairRequest<CatalogueMarket[]>(
    "SportsAPING/v1.0/listMarketCatalogue",
    {
      filter: {
        eventTypeIds: [SOCCER_EVENT_TYPE],
        inPlayOnly: true,
        marketTypeCodes: marketTypes,
      },
      marketProjection: [
        "EVENT",
        "COMPETITION",
        "MARKET_START_TIME",
        "MARKET_DESCRIPTION",
        "RUNNER_DESCRIPTION",
      ],
      maxResults,
      sort: "FIRST_TO_START",
    },
  );
}

async function getBooks(marketIds: string[]): Promise<Map<string, Book>> {
  const out = new Map<string, Book>();
  // listMarketBook caps at 40 markets with price data per call
  for (let i = 0; i < marketIds.length; i += 40) {
    const chunk = marketIds.slice(i, i + 40);
    const books = await apiBetfairRequest<Book[]>(
      "SportsAPING/v1.0/listMarketBook",
      {
        marketIds: chunk,
        priceProjection: {
          priceData: ["EX_BEST_OFFERS"],
          exBestOffersOverrides: { bestPricesDepth: 1 },
        },
      },
    );
    if (Array.isArray(books)) for (const b of books) out.set(b.marketId, b);
  }
  return out;
}

async function getBooksWithTradedVolume(
  marketIds: string[],
): Promise<Map<string, Book>> {
  const out = new Map<string, Book>();
  for (let i = 0; i < marketIds.length; i += 40) {
    const books = await apiBetfairRequest<Book[]>(
      "SportsAPING/v1.0/listMarketBook",
      {
        marketIds: marketIds.slice(i, i + 40),
        priceProjection: {
          priceData: ["EX_ALL_OFFERS", "EX_TRADED"],
          virtualise: true,
        },
      },
    );
    if (Array.isArray(books)) {
      for (const book of books) out.set(book.marketId, book);
    }
  }
  return out;
}

async function getRestingLayEvidence(
  marketId: string,
  selectionId: number,
  layPrice: number,
  stake: number,
): Promise<{
  tradedVolumeBaseline: number;
  queueAhead: number;
  immediateMatchedStake: number;
  immediatePriceStake: number;
}> {
  const books = await apiBetfairRequest<Book[]>(
    "SportsAPING/v1.0/listMarketBook",
    {
      marketIds: [marketId],
      priceProjection: {
        priceData: ["EX_ALL_OFFERS", "EX_TRADED"],
        virtualise: true,
      },
    },
  );
  const book = books?.[0];
  const runner = book?.runners?.find(
    (item) => item.selectionId === selectionId,
  );
  if (!book || book.status !== "OPEN" || !runner) {
    throw new Error("Market book unavailable while creating resting lay");
  }

  const queueAhead =
    runner.ex?.availableToBack?.find(
      (level) => Math.abs(level.price - layPrice) < 0.0001,
    )?.size ?? 0;

  // availableToLay is opposing BACK demand that a new lay can consume
  // immediately at the requested price or better (lower odds for the layer).
  const immediate = immediateLayFill(
    runner.ex?.availableToLay ?? [],
    layPrice,
    stake,
  );

  return {
    tradedVolumeBaseline: tradedVolumeAtPrice(
      runner.ex?.tradedVolume ?? [],
      layPrice,
    ),
    queueAhead,
    immediateMatchedStake: immediate.matchedStake,
    immediatePriceStake: immediate.priceStake,
  };
}

const num = (v: string | number | null | undefined) => Number(v ?? 0);

// ── Main cycle ──────────────────────────────────────────────────────────────
async function runCycle(generation: number): Promise<void> {
  const config = await getSoccerConfig();
  if (!config.paperMode) {
    await db
      .update(soccerConfigTable)
      .set({ paperMode: true })
      .where(eq(soccerConfigTable.id, config.id));
    throw new Error("Full-match soccer strategy is paper-only");
  }

  // Session
  if (!getSession()) {
    const login = await loginWithEnvCredentials();
    if (!login.success) {
      await slog("warn", `Betfair not connected: ${login.error}`);
      return;
    }
    await slog("info", "Connected to Betfair");
  }

  if (!running || generation !== runGeneration) return;

  // 1) Capture durable resting-lay fill evidence before settlement. The fast
  // monitor shares this same promise, so it cannot race settlement.
  await runRestingLayMonitor(generation);

  // 2) Manage open trades
  await manageOpenTrades();

  // 3) Settle closed markets
  await settleTrades();

  if (!running || generation !== runGeneration) return;

  // 4) Scan for new entries. There is deliberately no daily stop-loss.
  await scanForEntries(config);

  lastCycleAt = new Date();
}

// ── Entry scan ──────────────────────────────────────────────────────────────
async function scanForEntries(config: SoccerConfig): Promise<void> {
  const openRows = await db
    .select()
    .from(soccerTradesTable)
    .where(
      and(
        inArray(soccerTradesTable.status, ["OPEN", "HEDGED"]),
        eq(soccerTradesTable.strategy, "LAY_LOCK"),
      ),
    );
  const openEventIds = new Set(openRows.map((t) => t.eventId).filter(Boolean));
  // Concurrency is per GAME (an event may carry one trade per strategy)
  if (openEventIds.size >= config.maxConcurrent) {
    candidates = openRows.map((t) => openSnapshot(t));
    return;
  }

  // A Betfair event id is unique to one fixture. Once this bot has entered an
  // event, never enter it again: a settled loss can leave the same in-play
  // market visible for another scan and must not create another £50 position.
  const enteredEventIds = new Set<string>();
  if (config.blockReEntryAfterProfit) {
    const priorEntries = await db
      .select({ eventId: soccerTradesTable.eventId })
      .from(soccerTradesTable)
      .where(eq(soccerTradesTable.strategy, "LAY_LOCK"));
    for (const row of priorEntries) {
      if (row.eventId) enteredEventIds.add(row.eventId);
    }
  }

  // Discover: correct-score markets index the live games
  const csMarkets = await listInPlaySoccerMarkets(["CORRECT_SCORE"], 200);
  const snap: SoccerCandidateSnapshot[] = openRows.map((t) => openSnapshot(t));

  // Only games plausibly at/after the entry window
  const lateGames = csMarkets.filter(
    (m) => estimateMinute(m.marketStartTime) >= config.entryMinute,
  );
  watchedGames = csMarkets.length;

  if (lateGames.length === 0) {
    candidates = snap;
    return;
  }

  const csBooks = await getBooks(lateGames.map((m) => m.marketId));
  const feedGames = await fetchLiveScores();
  let slots = config.maxConcurrent - openEventIds.size;

  for (const cs of lateGames) {
    if (slots <= 0) break;
    const eventName = cs.event?.name ?? "Unknown fixture";
    const eventId = cs.event?.id ?? null;
    const competition = cs.competition?.name ?? null;
    const minute = estimateMinute(cs.marketStartTime);
    if (eventId && openEventIds.has(eventId)) continue;

    if (eventId && enteredEventIds.has(eventId)) {
      snap.push({
        eventName,
        competition,
        marketId: null,
        score: "?",
        goalGap: 0,
        minute,
        tightLine: null,
        tightOdds: null,
        bufferLine: null,
        bufferOdds: null,
        liquidity: null,
        verdict: "SKIPPED",
        reason: "Already entered this game — repeat entry blocked",
      });
      continue;
    }

    const book = csBooks.get(cs.marketId);
    if (!book || !book.inplay || book.status === "CLOSED") continue;

    // Primary score source: real live-score feed. Fallback: Correct Score
    // market inference (obscure competitions the feed doesn't cover).
    const inferred = inferScore(cs, book);
    const feed = matchFeedScore(feedGames, eventName);
    let score = inferred.score;
    let scoreSource = "odds";
    if (feed) {
      if (score && (score.home !== feed.home || score.away !== feed.away)) {
        // Feed and market disagree — with both sources delayed, this usually
        // means a goal is in flight. Don't enter on stale data; re-check next
        // cycle when both have caught up.
        await slog(
          "warn",
          `[SOCCER] Score disagreement in ${eventName}: feed says ${feed.home}-${feed.away}, Correct Score market says ${score.home}-${score.away} — standing aside this cycle`,
        );
        snap.push({
          eventName,
          competition,
          marketId: null,
          score: `${feed.home}-${feed.away}?`,
          goalGap: 0,
          minute,
          tightLine: null,
          tightOdds: null,
          bufferLine: null,
          bufferOdds: null,
          liquidity: null,
          verdict: "SKIPPED",
          reason: `Feed (${feed.home}-${feed.away}) and market (${score.home}-${score.away}) disagree — possible goal in flight, waiting for both to agree`,
        });
        continue;
      }
      score = { home: feed.home, away: feed.away };
      scoreSource = "feed";
    }
    if (!score) {
      snap.push({
        eventName,
        competition,
        marketId: null,
        score: "?",
        goalGap: 0,
        minute,
        tightLine: null,
        tightOdds: null,
        bufferLine: null,
        bufferOdds: null,
        liquidity: null,
        verdict: "SKIPPED",
        reason: `No live-score feed match and score not readable from Correct Score market (${inferred.detail})`,
      });
      continue;
    }

    const scoreStr = `${score.home}-${score.away}`;
    const gap = Math.abs(score.home - score.away);
    const total = score.home + score.away;

    const requiredGoalGap = Math.max(2, config.minGoalGap);
    if (gap < requiredGoalGap) {
      snap.push({
        eventName,
        competition,
        marketId: null,
        score: scoreStr,
        goalGap: gap,
        minute,
        tightLine: null,
        tightOdds: null,
        bufferLine: null,
        bufferOdds: null,
        liquidity: null,
        verdict: "SKIPPED",
        reason: `Goal gap ${gap} < ${requiredGoalGap} — game not dead, a team can still chase`,
      });
      continue;
    }

    // Fetch this event's O/U ladder
    const tightLine = total + 0.5;
    const insuredLine = total + 1.5;
    const wantedTypes = [
      `OVER_UNDER_${Math.floor(tightLine)}5`,
      `OVER_UNDER_${Math.floor(insuredLine)}5`,
    ];
    let ouMarkets: CatalogueMarket[] = [];
    try {
      ouMarkets = (
        await apiBetfairRequest<CatalogueMarket[]>(
          "SportsAPING/v1.0/listMarketCatalogue",
          {
            filter: {
              eventIds: eventId ? [eventId] : [],
              marketTypeCodes: wantedTypes,
              inPlayOnly: true,
            },
            marketProjection: [
              "EVENT",
              "MARKET_DESCRIPTION",
              "RUNNER_DESCRIPTION",
              "MARKET_START_TIME",
            ],
            maxResults: 10,
          },
        )
      ).filter((m) => Array.isArray(m.runners));
    } catch (err) {
      await slog("error", `O/U catalogue fetch failed for ${eventName}`, {
        err: String(err),
      });
      continue;
    }

    const ouBooks = await getBooks(ouMarkets.map((m) => m.marketId));

    interface LineQuote {
      market: CatalogueMarket;
      line: number;
      selectionId: number;
      selectionName: string;
      odds: number;
      size: number;
      liquidity: number;
    }
    const quotes = new Map<number, LineQuote>();
    for (const m of ouMarkets) {
      const line = ouLineFromMarketType(m.description?.marketType);
      if (!line) continue;
      const b = ouBooks.get(m.marketId);
      if (!b || b.status !== "OPEN" || !b.inplay || !b.runners) continue;
      const underRunner = m.runners!.find((r) => /^under/i.test(r.runnerName));
      if (!underRunner) continue;
      const br = b.runners.find(
        (r) => r.selectionId === underRunner.selectionId,
      );
      const backOffer = br?.ex?.availableToBack?.[0];
      if (!br || br.status !== "ACTIVE" || !backOffer) continue;
      quotes.set(line, {
        market: m,
        line,
        selectionId: underRunner.selectionId,
        selectionName: underRunner.runnerName,
        odds: backOffer.price,
        size: backOffer.size,
        liquidity: b.totalMatched ?? 0,
      });
    }

    const tight = quotes.get(tightLine) ?? null;
    const insured = quotes.get(insuredLine) ?? null;
    // Legacy config names retained for API compatibility:
    // minOdds = tight-line minimum; maxOdds = insured-line minimum.
    const tightMinOdds = num(config.minOdds);
    const insuredMinOdds = num(config.maxOdds);
    const pick = chooseEntryLine(tight, insured, tightMinOdds, insuredMinOdds);

    const base = {
      eventName,
      competition,
      score: scoreStr,
      goalGap: gap,
      minute,
      tightLine: tight ? tight.line : null,
      tightOdds: tight ? tight.odds : null,
      bufferLine: insured ? insured.line : null,
      bufferOdds: insured ? insured.odds : null,
    };

    if (!pick) {
      snap.push({
        ...base,
        marketId: null,
        liquidity: null,
        verdict: "WATCHING",
        reason:
          `Waiting for insured line > ${insuredMinOdds.toFixed(2)} or tight line > ${tightMinOdds.toFixed(2)}` +
          (insured ? ` (insured U${insured.line} @ ${insured.odds})` : "") +
          (tight ? ` (U${tight.line} @ ${tight.odds})` : ""),
      });
      continue;
    }

    if (pick.liquidity < num(config.minLiquidity)) {
      snap.push({
        ...base,
        marketId: pick.market.marketId,
        liquidity: pick.liquidity,
        verdict: "SKIPPED",
        reason: `Liquidity £${Math.round(pick.liquidity)} < £${Math.round(num(config.minLiquidity))} — resting lay execution would be impractical`,
      });
      continue;
    }

    // ENTER (paper): record at the visible back price.
    const stake = FULL_MATCH_ENTRY_STAKE_GBP;
    if (!isStakeFullyMatched(stake, pick.size)) {
      snap.push({
        ...base,
        marketId: pick.market.marketId,
        liquidity: pick.liquidity,
        verdict: "WATCHING",
        reason:
          `Fixed £${stake.toFixed(2)} back stake cannot be matched at ${pick.odds.toFixed(2)} ` +
          `(only £${pick.size.toFixed(2)} available)`,
      });
      continue;
    }
    const isInsured = pick.line === insuredLine;
    let layPrice: number;
    try {
      layPrice = layLockPrice(pick.odds, LAY_LOCK_TARGET_PCT);
    } catch {
      snap.push({
        ...base,
        marketId: pick.market.marketId,
        liquidity: pick.liquidity,
        verdict: "SKIPPED",
        reason: `Entry odds ${pick.odds.toFixed(2)} cannot lock £20 net with a valid equal-stake lay price`,
      });
      continue;
    }
    const baseTrade = {
      eventId,
      eventName,
      competition,
      marketId: pick.market.marketId,
      marketName: pick.market.marketName,
      selectionId: pick.selectionId,
      selectionName: pick.selectionName,
      line: pick.line.toFixed(1),
      bufferLine: isInsured,
      entryScore: scoreStr,
      entryTotalGoals: total,
      entryMinute: minute,
      entryOdds: pick.odds.toFixed(2),
      stake: stake.toFixed(2),
      status: "OPEN",
      paper: true,
    };
    // Immediately create the strategy's one and only equal-stake resting lay.
    // Flooring to a valid tick guarantees at least 40% of the original stake
    // net after commission when the Under wins.
    let layEvidence: Awaited<ReturnType<typeof getRestingLayEvidence>>;
    try {
      layEvidence = await getRestingLayEvidence(
        pick.market.marketId,
        pick.selectionId,
        layPrice,
        stake,
      );
    } catch (err) {
      await slog(
        "warn",
        `SKIPPED ${eventName} — could not establish resting-lay fill baseline`,
        { err: err instanceof Error ? err.message : String(err) },
      );
      continue;
    }
    const immediatelyHedged = isStakeFullyMatched(
      stake,
      layEvidence.immediateMatchedStake,
    );
    const immediateAveragePrice =
      layEvidence.immediateMatchedStake > 0
        ? layEvidence.immediatePriceStake / layEvidence.immediateMatchedStake
        : null;
    const storedLayPrice = immediateAveragePrice ?? layPrice;
    const enteredAt = new Date();

    await db.insert(soccerTradesTable).values({
      ...baseTrade,
      strategy: "LAY_LOCK",
      status: immediatelyHedged ? "HEDGED" : "OPEN",
      layPrice: storedLayPrice.toFixed(2),
      targetLayPrice: layPrice.toFixed(2),
      layMatchedStake: layEvidence.immediateMatchedStake.toFixed(2),
      layMatchedPriceStake: layEvidence.immediatePriceStake.toFixed(2),
      layTradedVolumeBaseline: layEvidence.tradedVolumeBaseline.toFixed(2),
      layQueueAhead: layEvidence.queueAhead.toFixed(2),
      layImmediateMatchedStake: layEvidence.immediateMatchedStake.toFixed(2),
      layImmediatePriceStake: layEvidence.immediatePriceStake.toFixed(2),
      layMatchedAt: immediatelyHedged ? new Date() : null,
      fallbackNextCheckAt: null,
      fallbackAttemptCount: 0,
      fallbackAttemptedAt: null,
      fallbackPrice: null,
      fallbackProjectedPnl: null,
      fallbackDecision: null,
      placedAt: enteredAt,
      exitOdds: immediatelyHedged ? storedLayPrice.toFixed(2) : null,
      exitReason: immediatelyHedged
        ? `Resting lay immediately matched @ average ${storedLayPrice.toFixed(2)} — locked`
        : null,
    });
    slots--;
    if (eventId) openEventIds.add(eventId);
    await slog(
      "info",
      `ENTERED ${eventName} ${scoreStr} ${minute}' — BACK ${pick.selectionName} @ ${pick.odds} £${stake} ` +
        `(${isInsured ? "INSURED line, one-goal cover" : "tight line"}, liq £${Math.round(pick.liquidity)}, score via ${scoreSource === "feed" ? "live-score feed" : "odds inference"}) ` +
        `[fixed £${stake.toFixed(2)} stake; 40% net-profit target lay @ ${layPrice.toFixed(2)}; ` +
        `immediate evidence £${layEvidence.immediateMatchedStake.toFixed(2)} matched / £${stake.toFixed(2)}, ` +
        `price-stake £${layEvidence.immediatePriceStake.toFixed(2)}, queue £${layEvidence.queueAhead.toFixed(2)}]`,
    );
    if (immediatelyHedged) {
      await slog(
        "info",
        `LAY MATCHED ${eventName} immediately — ${pick.selectionName} layed £${stake} @ average ${storedLayPrice.toFixed(2)}; outcome locked to +£${layLockWinProfit(stake, pick.odds, storedLayPrice).toFixed(2)} or £0`,
      );
    }
    snap.push({
      ...base,
      marketId: pick.market.marketId,
      liquidity: pick.liquidity,
      verdict: "ENTERED",
      reason: `BACK ${pick.selectionName} @ ${pick.odds} (${isInsured ? "insured" : "tight"} line)`,
    });
  }

  candidates = snap;
}

function openSnapshot(t: SoccerTrade): SoccerCandidateSnapshot {
  const matched = num(t.layMatchedStake);
  const reason =
    t.status === "HEDGED"
      ? `Lay matched @ ${num(t.layPrice)} — waiting for full-time settlement`
      : `BACK ${t.selectionName} @ ${num(t.entryOdds)} — £${matched.toFixed(2)} lay matched, target @ ${num(t.targetLayPrice).toFixed(2)}`;

  return {
    eventName: t.eventName,
    competition: t.competition,
    marketId: t.marketId,
    score: t.entryScore,
    goalGap: 0,
    minute: t.entryMinute,
    tightLine: null,
    tightOdds: null,
    bufferLine: num(t.line),
    bufferOdds: num(t.entryOdds),
    liquidity: null,
    verdict: "OPEN",
    reason,
  };
}

// ── Resting lay monitor ──────────────────────────────────────────────────────
async function monitorRestingLays(generation: number): Promise<void> {
  if (!running || generation !== runGeneration || !getSession()) {
    return;
  }

  const open = await db
    .select()
    .from(soccerTradesTable)
    .where(
      and(
        eq(soccerTradesTable.status, "OPEN"),
        eq(soccerTradesTable.strategy, "LAY_LOCK"),
      ),
    );
  if (open.length === 0) return;
  const books = await getBooksWithTradedVolume(
    open.map((trade) => trade.marketId),
  );
  if (!running || generation !== runGeneration) return;

  for (const trade of open) {
    const book = books.get(trade.marketId);
    if (!book || book.status !== "OPEN") continue;

    const runner = book.runners?.find(
      (item) => item.selectionId === trade.selectionId,
    );
    if (!runner) continue;

    const stake = num(trade.stake);
    const entryOdds = num(trade.entryOdds);
    const targetPrice = num(trade.targetLayPrice ?? trade.layPrice);
    const initialImmediateStake = num(trade.layImmediateMatchedStake);
    const compatibleAggregate = compatibleLayAggregate(
      trade.status, stake, num(trade.layPrice),
      num(trade.layMatchedStake), num(trade.layMatchedPriceStake),
      initialImmediateStake, num(trade.layImmediatePriceStake),
    );
    let matchedStake = compatibleAggregate.matchedStake;
    let matchedPriceStake = compatibleAggregate.priceStake;
    const matchedBeforeTargetEvidence = matchedStake;
    // Attribute only volume at our exact target after clearing the captured
    // queue. Comparing cumulative target evidence with the durable aggregate
    // prevents the one-second monitor from counting the same fill twice.
    const restingTargetStake = Math.min(
      stake - initialImmediateStake,
      Math.max(
        0,
        tradedVolumeAtPrice(runner.ex?.tradedVolume ?? [], targetPrice) -
          num(trade.layTradedVolumeBaseline) -
          num(trade.layQueueAhead),
      ),
    );
    const evidencedTargetStake = initialImmediateStake + restingTargetStake;
    if (evidencedTargetStake > matchedStake + 0.005) {
      const targetFill = addEqualLayFill(
        stake,
        matchedStake,
        matchedPriceStake,
        evidencedTargetStake - matchedStake,
        targetPrice,
      );
      matchedStake = targetFill.matchedStake;
      matchedPriceStake = targetFill.priceStake;
      await slog(
        "info",
        `TARGET LAY EVIDENCE ${trade.eventName} — newly proved £${(matchedStake - matchedBeforeTargetEvidence).toFixed(2)} ` +
          `@ ${targetPrice.toFixed(2)}; aggregate £${matchedStake.toFixed(2)} of £${stake.toFixed(2)} ` +
          `(traded £${tradedVolumeAtPrice(runner.ex?.tradedVolume ?? [], targetPrice).toFixed(2)}, ` +
          `baseline £${num(trade.layTradedVolumeBaseline).toFixed(2)}, queue £${num(trade.layQueueAhead).toFixed(2)})`,
        {
          tradeId: trade.id,
          targetPrice,
          evidencedTargetStake,
          durableMatchedBefore: matchedBeforeTargetEvidence,
          durableMatchedAfter: matchedStake,
          durablePriceStakeAfter: matchedPriceStake,
        },
      );
    }

    const now = new Date();
    const fullyHedged = isStakeFullyMatched(stake, matchedStake);
    const averageLayPrice =
      matchedStake > 0 ? matchedPriceStake / matchedStake : targetPrice;
    if (!running || generation !== runGeneration) return;
    const updated = await db
      .update(soccerTradesTable)
      .set({
        status: fullyHedged ? "HEDGED" : "OPEN",
        layMatchedStake: matchedStake.toFixed(2),
        layMatchedPriceStake: matchedPriceStake.toFixed(2),
        layMatchedAt: fullyHedged ? now : null,
        layPrice: averageLayPrice.toFixed(2),
        exitOdds: fullyHedged ? averageLayPrice.toFixed(2) : null,
        exitReason: fullyHedged
          ? `Equal-stake lay fully matched @ weighted average ${averageLayPrice.toFixed(2)}`
          : `Partial lay evidence: £${matchedStake.toFixed(2)} of £${stake.toFixed(2)} matched`,
      })
      .where(
        and(
          eq(soccerTradesTable.id, trade.id),
          eq(soccerTradesTable.status, "OPEN"),
        ),
      )
      .returning({ id: soccerTradesTable.id });

    if (updated.length > 0 && fullyHedged) {
      await slog(
        "info",
        `LAY MATCHED ${trade.eventName} — aggregate £${matchedStake.toFixed(2)} @ weighted average ${averageLayPrice.toFixed(2)} ` +
          `(target price-stake £${matchedPriceStake.toFixed(2)}); ` +
          `no-more-goals P&L +£${layLockWinProfit(stake, entryOdds, averageLayPrice).toFixed(2)}, line-broken P&L £0.00`,
      );
    }
  }
}

async function runRestingLayMonitor(generation: number): Promise<void> {
  if (layMonitorPromise) {
    const existingGeneration = layMonitorPromiseGeneration;
    await layMonitorPromise;
    if (existingGeneration === generation) return;
  }
  if (!running || generation !== runGeneration) return;
  if (layMonitorPromise) return layMonitorPromise;

  const promise = monitorRestingLays(generation).finally(() => {
    if (layMonitorPromise === promise) {
      layMonitorPromise = null;
      layMonitorPromiseGeneration = null;
    }
  });
  layMonitorPromise = promise;
  layMonitorPromiseGeneration = generation;
  await promise;
}

// ── Open-trade management: goal handling ────────────────────────────────────
async function manageOpenTrades(): Promise<void> {
  const open = await db
    .select()
    .from(soccerTradesTable)
    .where(
      and(
        eq(soccerTradesTable.status, "OPEN"),
        eq(soccerTradesTable.strategy, "LAY_LOCK"),
      ),
    );
  if (open.length === 0) return;

  const books = await getBooks(open.map((t) => t.marketId));

  // Goal detection, primary source: the real live-score feed (matched by
  // event name). Secondary: re-read the CORRECT_SCORE market and compare the
  // inferred total goals with entryTotalGoals. Last resort: price spike.
  const currentTotals = new Map<string, number>(); // eventId -> total goals
  const openEventIds = [
    ...new Set(open.map((t) => t.eventId).filter((x): x is string => !!x)),
  ];
  try {
    const feedGames = await fetchLiveScores();
    for (const t of open) {
      if (!t.eventId) continue;
      const feed = matchFeedScore(feedGames, t.eventName);
      if (feed) currentTotals.set(t.eventId, feed.home + feed.away);
    }
  } catch {
    /* feed is best-effort */
  }
  if (openEventIds.length > 0) {
    try {
      const csMarkets = await apiBetfairRequest<CatalogueMarket[]>(
        "SportsAPING/v1.0/listMarketCatalogue",
        {
          filter: {
            eventIds: openEventIds,
            marketTypeCodes: ["CORRECT_SCORE"],
          },
          marketProjection: ["EVENT", "RUNNER_DESCRIPTION"],
          maxResults: openEventIds.length * 2,
        },
      );
      if (Array.isArray(csMarkets) && csMarkets.length > 0) {
        const csBooks = await getBooks(csMarkets.map((m) => m.marketId));
        for (const cs of csMarkets) {
          const b = csBooks.get(cs.marketId);
          if (!b || !cs.event?.id) continue;
          const { score } = inferScore(cs, b);
          // Feed score (if matched) wins; CS inference only fills gaps.
          if (score && !currentTotals.has(cs.event.id)) {
            currentTotals.set(cs.event.id, score.home + score.away);
          }
        }
      }
    } catch {
      /* score refresh is best-effort; fall back to price heuristic below */
    }
  }

  for (const trade of open) {
    const book = books.get(trade.marketId);
    if (!book) continue;
    if (book.status === "CLOSED") continue; // settlement pass handles it

    const entryOdds = num(trade.entryOdds);
    const runner = book.runners?.find(
      (r) => r.selectionId === trade.selectionId,
    );
    const layOffer = runner?.ex?.availableToLay?.[0];

    // Goal-after-entry: primary signal is the refreshed correct-score total;
    // the last-resort signal is a violent price spike on our Under selection.
    let goalAfterEntry = trade.goalAfterEntry;
    if (!goalAfterEntry) {
      const currentTotal = trade.eventId
        ? currentTotals.get(trade.eventId)
        : undefined;
      const scoreSaysGoal =
        currentTotal !== undefined &&
        trade.entryTotalGoals !== null &&
        currentTotal > trade.entryTotalGoals;
      const priceSaysGoal = !!layOffer && layOffer.price >= entryOdds * 1.4;
      if (scoreSaysGoal || (currentTotal === undefined && priceSaysGoal)) {
        goalAfterEntry = true;
        const updated = await db
          .update(soccerTradesTable)
          .set({ goalAfterEntry: true })
          .where(
            and(
              eq(soccerTradesTable.id, trade.id),
              eq(soccerTradesTable.status, "OPEN"),
            ),
          )
          .returning({ id: soccerTradesTable.id });
        if (updated.length > 0) {
          await slog(
            "warn",
            `GOAL against us in ${trade.eventName} (${scoreSaysGoal ? `score now totals ${currentTotal}` : `${trade.selectionName} spiked to ${layOffer?.price}`}) — resting lay was not yet confirmed matched`,
          );
        }
      }
    }
  }
}

// ── Settlement ──────────────────────────────────────────────────────────────
async function settleTrades(): Promise<void> {
  const open = await db
    .select()
    .from(soccerTradesTable)
    .where(
      and(
        inArray(soccerTradesTable.status, ["OPEN", "HEDGED"]),
        eq(soccerTradesTable.strategy, "LAY_LOCK"),
      ),
    );
  if (open.length === 0) return;

  interface SettleBook {
    marketId: string;
    status: string;
    runners?: Array<{
      selectionId: number;
      status: string;
      ex?: { tradedVolume?: Array<{ price: number; size: number }> };
    }>;
  }
  const ids = open.map((t) => t.marketId);
  let books: SettleBook[] = [];
  try {
    books = await apiBetfairRequest<SettleBook[]>(
      "SportsAPING/v1.0/listMarketBook",
      {
        marketIds: ids,
        priceProjection: { priceData: ["EX_TRADED"] },
      },
    );
  } catch {
    return;
  }
  const byId = new Map(books.map((b) => [b.marketId, b]));

  for (const trade of open) {
    const book = byId.get(trade.marketId);
    if (!book || book.status !== "CLOSED" || !book.runners) continue;
    const runner = book.runners.find(
      (r) => r.selectionId === trade.selectionId,
    );
    if (!runner) continue;

    const stake = num(trade.stake);
    const entryOdds = num(trade.entryOdds);
    if (runner.status === "REMOVED") {
      await db
        .update(soccerTradesTable)
        .set({
          status: "VOID",
          exitReason: "Market voided/removed",
          profit: "0.00",
          closedAt: new Date(),
        })
        .where(
          and(
            eq(soccerTradesTable.id, trade.id),
            inArray(soccerTradesTable.status, ["OPEN", "HEDGED"]),
          ),
        );
      continue;
    }
    if (runner.status !== "WINNER" && runner.status !== "LOSER") continue;

    // Reconcile final exact-target volume in case closure happened between
    // monitor ticks, then settle from the durable target-fill aggregate.
    const targetPrice = num(trade.targetLayPrice ?? trade.layPrice);
    const immediateStake = num(trade.layImmediateMatchedStake);
    const finalRestingStake = Math.min(
      stake - immediateStake,
      Math.max(
        0,
        tradedVolumeAtPrice(runner.ex?.tradedVolume ?? [], targetPrice) -
          num(trade.layTradedVolumeBaseline) -
          num(trade.layQueueAhead),
      ),
    );
    const compatibleAggregate = compatibleLayAggregate(
      trade.status, stake, num(trade.layPrice),
      num(trade.layMatchedStake), num(trade.layMatchedPriceStake),
      immediateStake, num(trade.layImmediatePriceStake),
    );
    let matchedStake = compatibleAggregate.matchedStake;
    let matchedPriceStake = compatibleAggregate.priceStake;
    const evidencedTargetStake = immediateStake + finalRestingStake;
    if (evidencedTargetStake > matchedStake + 0.005) {
      const reconciled = addEqualLayFill(
        stake,
        matchedStake,
        matchedPriceStake,
        evidencedTargetStake - matchedStake,
        targetPrice,
      );
      matchedStake = reconciled.matchedStake;
      matchedPriceStake = reconciled.priceStake;
    }
    const averageLayPrice =
      matchedStake > 0 ? matchedPriceStake / matchedStake : targetPrice;
    const underWon = runner.status === "WINNER";
    const net = equalStakeCombinedProfit(
      stake,
      entryOdds,
      underWon,
      matchedStake,
      averageLayPrice,
    );
    const cents = Math.round(net * 100);
    const settledStatus =
      cents > 0
        ? "SETTLED_WON"
        : cents < 0
          ? "SETTLED_LOST"
          : "SETTLED_BREAK_EVEN";
    const settled = await db
      .update(soccerTradesTable)
      .set({
        status: settledStatus,
        layMatchedStake: matchedStake.toFixed(2),
        layMatchedPriceStake: matchedPriceStake.toFixed(2),
        layPrice:
          matchedStake > 0 ? averageLayPrice.toFixed(2) : trade.layPrice,
        profit: net.toFixed(2),
        closedAt: new Date(),
        goalAfterEntry: !underWon,
        exitReason:
          `${underWon ? "Under won" : "Line broken"} — settled back plus ` +
          `£${matchedStake.toFixed(2)} of £${stake.toFixed(2)} resting target lay fills ` +
          `@ ${matchedStake > 0 ? averageLayPrice.toFixed(2) : "n/a"}`,
      })
      .where(
        and(
          eq(soccerTradesTable.id, trade.id),
          inArray(soccerTradesTable.status, ["OPEN", "HEDGED"]),
        ),
      )
      .returning({ id: soccerTradesTable.id });
    if (settled.length > 0) {
      await slog(
        net < 0 ? "warn" : "info",
        `SETTLED ${settledStatus} ${trade.eventName} ${net >= 0 ? "+" : ""}£${net.toFixed(2)} ` +
          `(lay £${matchedStake.toFixed(2)} @ weighted ${matchedStake > 0 ? averageLayPrice.toFixed(2) : "n/a"})`,
      );
    }
  }
}

/**
 * One-time, idempotent correction for the confirmed Johor paper-simulation
 * miss. The operator's real £50 lay at 1.23 matched before the goal, so the
 * backed-line loss was a £0 overall result rather than -£50.
 */
async function repairConfirmedJohorLayFill(): Promise<void> {
  const [trade] = await db
    .select()
    .from(soccerTradesTable)
    .where(
      and(
        eq(soccerTradesTable.eventId, "35962946"),
        eq(soccerTradesTable.marketId, "1.261344329"),
        eq(soccerTradesTable.status, "SETTLED_LOST"),
        eq(soccerTradesTable.profit, "-50.00"),
      ),
    )
    .limit(1);
  if (!trade || trade.layMatchedAt) return;

  const updated = await db
    .update(soccerTradesTable)
    .set({
      layMatchedAt: trade.placedAt,
      exitOdds: "1.23",
      exitReason:
        "Corrected — confirmed real resting lay matched @ 1.23 before the goal; overall result breakeven",
      profit: "0.00",
    })
    .where(
      and(
        eq(soccerTradesTable.id, trade.id),
        eq(soccerTradesTable.status, "SETTLED_LOST"),
        eq(soccerTradesTable.profit, "-50.00"),
      ),
    )
    .returning({ id: soccerTradesTable.id });

  if (updated.length > 0) {
    await slog(
      "info",
      "CORRECTED Johor Darul Ta'zim v Kuching FA paper result from -£50 to £0 after confirmed resting-lay match",
    );
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
async function loop(generation: number): Promise<void> {
  if (!running || generation !== runGeneration) return;
  if (!processing) {
    processing = true;
    try {
      await runCycle(generation);
    } catch (err) {
      logger.error({ err }, "[SOCCER] cycle error");
    } finally {
      processing = false;
    }
  }
  const config = await getSoccerConfig().catch(() => null);
  const interval = (config?.checkIntervalSeconds ?? 20) * 1000;
  if (running && generation === runGeneration) {
    cycleTimer = setTimeout(() => void loop(generation), interval);
  }
}

async function layMonitorLoop(generation: number): Promise<void> {
  if (!running || generation !== runGeneration) return;
  if (!processing && !layMonitorProcessing) {
    layMonitorProcessing = true;
    try {
      await runRestingLayMonitor(generation);
    } catch (err) {
      logger.error({ err }, "[SOCCER] resting lay monitor error");
    } finally {
      layMonitorProcessing = false;
    }
  }
  if (running && generation === runGeneration) {
    layMonitorTimer = setTimeout(
      () => void layMonitorLoop(generation),
      RESTING_LAY_MONITOR_MS,
    );
  }
}

export async function startSoccerBot(): Promise<void> {
  if (running) return;
  const config = await getSoccerConfig();
  running = true;
  const generation = ++runGeneration;
  startedAt = new Date();
  await db
    .update(soccerConfigTable)
    .set({ isRunning: true, paperMode: true })
    .where(eq(soccerConfigTable.id, config.id));
  await slog(
    "info",
    "Soccer in-play bot STARTED (paper only; no exchange orders)",
  );
  void loop(generation);
  void layMonitorLoop(generation);
}

export async function stopSoccerBot(): Promise<void> {
  if (!running) return;
  running = false;
  runGeneration++;
  startedAt = null;
  if (cycleTimer) clearTimeout(cycleTimer);
  cycleTimer = null;
  if (layMonitorTimer) clearTimeout(layMonitorTimer);
  layMonitorTimer = null;
  candidates = [];
  watchedGames = 0;
  await db.update(soccerConfigTable).set({ isRunning: false });
  await slog("info", "Soccer in-play bot STOPPED");
}

/** Resume after process restart if the persisted flag says running. */
export async function autoResumeSoccerBot(): Promise<void> {
  try {
    await repairConfirmedJohorLayFill();
    const config = await getSoccerConfig();
    if (config.isRunning) {
      if (running) return;
      await slog("info", "Auto-resuming soccer bot after restart");
      running = true;
      const generation = ++runGeneration;
      startedAt = new Date();
      void loop(generation);
      void layMonitorLoop(generation);
    }
  } catch (err) {
    logger.error({ err }, "[SOCCER] auto-resume failed");
  }
}
