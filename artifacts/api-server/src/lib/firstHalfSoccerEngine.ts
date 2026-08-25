/**
 * FIRST-HALF "NO MORE GOALS" PAPER ENGINE
 *
 * From 35' until the first-half goals market closes, a two-goal lead can enter
 * the tight first-half Under line. The same-stake lay is rested immediately:
 * no further goal locks the configured return; the next goal loses the Under
 * and returns the stake through the matched lay. This module never submits
 * Betfair orders — all rows are explicitly paper trades.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  firstHalfSoccerConfigTable,
  soccerTradesTable,
  botLogsTable,
  type FirstHalfSoccerConfig,
  type SoccerTrade,
} from "@workspace/db/schema";
import { getSession, loginWithEnvCredentials, apiBetfairRequest } from "./betfair";
import { logger } from "./logger";
import {
  addEqualLayFill,
  compatibleLayAggregate,
  entryStakeForOdds,
  equalStakeCombinedProfit,
  estimateMinute,
  fixedOffsetLayTarget,
  firstHalfGoalLineFromMarketType,
  inferScore,
  immediateLayFill,
  isFallbackLayEligible,
  isEligibleFirstHalfEntry,
  remainingEqualLayStake,
  tradedVolumeAtPrice,
} from "./soccerHelpers";
import { fetchLiveScores, matchFeedScore } from "./scoreFeed";

const SOCCER_EVENT_TYPE = "1";
const STRATEGY = "FIRST_HALF_LAY_LOCK";
const MONITOR_MS = 1_000;
const PRICE_EPSILON = 0.0001;

interface CatalogueMarket {
  marketId: string;
  marketName: string;
  event?: { id?: string; name?: string };
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

export interface FirstHalfCandidateSnapshot {
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

let running = false;
let startedAt: Date | null = null;
let lastCycleAt: Date | null = null;
let candidates: FirstHalfCandidateSnapshot[] = [];
let watchedGames = 0;
let cycleTimer: ReturnType<typeof setTimeout> | null = null;
let monitorTimer: ReturnType<typeof setTimeout> | null = null;
let processing = false;
let monitorProcessing = false;
let generation = 0;

const num = (value: string | number | null | undefined) => Number(value ?? 0);
export function isFirstHalfSoccerBotRunning() { return running; }
export function getFirstHalfSoccerBotStartedAt() { return startedAt; }
export function getFirstHalfLastCycleAt() { return lastCycleAt; }
export function getFirstHalfCandidatesSnapshot() { return candidates; }
export function getFirstHalfWatchedGameCount() { return watchedGames; }

export async function getFirstHalfSoccerConfig(): Promise<FirstHalfSoccerConfig> {
  const [config] = await db.select().from(firstHalfSoccerConfigTable).limit(1);
  if (config) return config;
  const [created] = await db.insert(firstHalfSoccerConfigTable).values({ paperMode: true }).returning();
  return created!;
}

async function log(level: string, message: string, metadata?: unknown) {
  const line = `[FIRST HALF] ${message}`;
  if (level === "error") logger.error({ metadata }, line);
  else logger.info({ metadata }, line);
  try {
    await db.insert(botLogsTable).values({
      level,
      message: line,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });
  } catch { /* Logs must not stop trade monitoring. */ }
}

async function catalogue(filter: Record<string, unknown>, types: string[], maxResults: number) {
  return apiBetfairRequest<CatalogueMarket[]>("SportsAPING/v1.0/listMarketCatalogue", {
    filter: { eventTypeIds: [SOCCER_EVENT_TYPE], inPlayOnly: true, marketTypeCodes: types, ...filter },
    marketProjection: ["EVENT", "COMPETITION", "MARKET_START_TIME", "MARKET_DESCRIPTION", "RUNNER_DESCRIPTION"],
    maxResults,
    sort: "FIRST_TO_START",
  });
}

async function books(marketIds: string[], traded = false, allOffers = false): Promise<Map<string, Book>> {
  const result = new Map<string, Book>();
  for (let index = 0; index < marketIds.length; index += 40) {
    const response = await apiBetfairRequest<Book[]>("SportsAPING/v1.0/listMarketBook", {
      marketIds: marketIds.slice(index, index + 40),
      priceProjection: {
        priceData: allOffers ? ["EX_ALL_OFFERS", "EX_TRADED"] : traded ? ["EX_TRADED"] : ["EX_BEST_OFFERS"],
        ...(allOffers ? { virtualise: true } : {}),
        ...(!traded && !allOffers ? { exBestOffersOverrides: { bestPricesDepth: 1 } } : {}),
      },
    });
    for (const book of response ?? []) result.set(book.marketId, book);
  }
  return result;
}

async function restingLayEvidence(marketId: string, selectionId: number, layPrice: number, stake: number) {
  const [book] = await apiBetfairRequest<Book[]>("SportsAPING/v1.0/listMarketBook", {
    marketIds: [marketId],
    priceProjection: { priceData: ["EX_ALL_OFFERS", "EX_TRADED"], virtualise: true },
  });
  const runner = book?.runners?.find((entry) => entry.selectionId === selectionId);
  if (!book || book.status !== "OPEN" || !runner) throw new Error("first-half market unavailable");
  const immediate = immediateLayFill(runner.ex?.availableToLay ?? [], layPrice, stake);
  return {
    baseline: tradedVolumeAtPrice(runner.ex?.tradedVolume ?? [], layPrice),
    queueAhead: runner.ex?.availableToBack?.find((entry) => Math.abs(entry.price - layPrice) < 0.0001)?.size ?? 0,
    immediate,
  };
}

function openSnapshot(trade: SoccerTrade): FirstHalfCandidateSnapshot {
  const target = num(trade.targetLayPrice ?? trade.layPrice);
  const matched = num(trade.layMatchedStake);
  return {
    eventName: trade.eventName, competition: trade.competition, marketId: trade.marketId,
    score: trade.entryScore, goalGap: 0, minute: trade.entryMinute,
    tightLine: num(trade.line), tightOdds: num(trade.entryOdds),
    bufferLine: null, bufferOdds: null, liquidity: null, verdict: "OPEN",
    reason: trade.status === "HEDGED"
      ? `Lay matched £${matched.toFixed(2)} @ ${num(trade.layPrice).toFixed(2)} — waiting for first-half settlement`
      : `BACK ${trade.selectionName} @ ${num(trade.entryOdds).toFixed(2)} — £${matched.toFixed(2)} lay matched; target @ ${target.toFixed(2)}`,
  };
}

async function scan(config: FirstHalfSoccerConfig, currentGeneration: number) {
  const open = await db.select().from(soccerTradesTable).where(and(
    inArray(soccerTradesTable.status, ["OPEN", "HEDGED"]),
    eq(soccerTradesTable.strategy, STRATEGY),
  ));
  const snapshots = open.map(openSnapshot);
  const openEvents = new Set(open.map((trade) => trade.eventId).filter((id): id is string => !!id));
  if (openEvents.size >= config.maxConcurrent) { candidates = snapshots; return; }

  const prior = await db.select({ eventId: soccerTradesTable.eventId }).from(soccerTradesTable)
    .where(eq(soccerTradesTable.strategy, STRATEGY));
  const entered = new Set(prior.map((row) => row.eventId).filter((id): id is string => !!id));
  const correctScores = await catalogue({}, ["CORRECT_SCORE"], 200);
  watchedGames = correctScores.length;
  const eligible = correctScores.filter((market) => {
    const minute = estimateMinute(market.marketStartTime);
    return minute >= config.entryMinute && minute <= 45;
  });
  if (!eligible.length) { candidates = snapshots; return; }
  const scoreBooks = await books(eligible.map((market) => market.marketId));
  const feedGames = await fetchLiveScores();
  let slots = config.maxConcurrent - openEvents.size;

  for (const scoreMarket of eligible) {
    if (slots <= 0) break;
    const eventName = scoreMarket.event?.name ?? "Unknown fixture";
    const eventId = scoreMarket.event?.id ?? null;
    const competition = scoreMarket.competition?.name ?? null;
    const estimatedMinute = estimateMinute(scoreMarket.marketStartTime);
    if (!eventId || openEvents.has(eventId)) continue;
    if (entered.has(eventId)) {
      snapshots.push({ eventName, competition, marketId: null, score: "?", goalGap: 0, minute: estimatedMinute, tightLine: null, tightOdds: null, bufferLine: null, bufferOdds: null, liquidity: null, verdict: "SKIPPED", reason: "Already entered this first-half match — repeat entry blocked" });
      continue;
    }
    const inferred = inferScore(scoreMarket, scoreBooks.get(scoreMarket.marketId) ?? {});
    const feed = matchFeedScore(feedGames, eventName);
    const minute = feed?.minute ?? estimatedMinute;
    if (
      feed &&
      inferred.score &&
      (feed.home !== inferred.score.home || feed.away !== inferred.score.away)
    ) {
      snapshots.push({ eventName, competition, marketId: null, score: `${feed.home}-${feed.away}?`, goalGap: 0, minute, tightLine: null, tightOdds: null, bufferLine: null, bufferOdds: null, liquidity: null, verdict: "SKIPPED", reason: `Live feed and Correct Score market disagree — possible goal in flight` });
      continue;
    }
    const score = feed
      ? { home: feed.home, away: feed.away }
      : inferred.score;
    if (!score) {
      snapshots.push({ eventName, competition, marketId: null, score: "?", goalGap: 0, minute, tightLine: null, tightOdds: null, bufferLine: null, bufferOdds: null, liquidity: null, verdict: "SKIPPED", reason: `No live-score feed match and score not yet readable (${inferred.detail})` });
      continue;
    }
    const total = score.home + score.away;
    const gap = Math.abs(score.home - score.away);
    const scoreText = `${score.home}-${score.away}`;
    if (!isEligibleFirstHalfEntry(minute, gap, config.entryMinute, config.minGoalGap)) {
      snapshots.push({ eventName, competition, marketId: null, score: scoreText, goalGap: gap, minute, tightLine: null, tightOdds: null, bufferLine: null, bufferOdds: null, liquidity: null, verdict: "SKIPPED", reason: `Goal gap ${gap} < ${config.minGoalGap}` });
      continue;
    }
    // Tight line only: the next goal must make the Under lose so the same-stake
    // lay returns the stake (rather than a one-goal insured position winning).
    const line = total + 0.5;
    const type = `FIRST_HALF_GOALS_${Math.floor(line)}5`;
    const markets = await catalogue({ eventIds: [eventId] }, [type], 5);
    const market = markets.find((entry) => firstHalfGoalLineFromMarketType(entry.description?.marketType) === line);
    if (!market?.runners) {
      snapshots.push({ eventName, competition, marketId: null, score: scoreText, goalGap: gap, minute, tightLine: line, tightOdds: null, bufferLine: null, bufferOdds: null, liquidity: null, verdict: "WATCHING", reason: "First-half Under market is unavailable" });
      continue;
    }
    const [marketBook] = await books([market.marketId]).then((result) => [result.get(market.marketId)]);
    const under = market.runners.find((runner) => /^under/i.test(runner.runnerName));
    const runner = under && marketBook?.runners?.find((entry) => entry.selectionId === under.selectionId);
    const offer = runner?.ex?.availableToBack?.[0];
    const liquidity = marketBook?.totalMatched ?? 0;
    const base = { eventName, competition, score: scoreText, goalGap: gap, minute, tightLine: line, bufferLine: null, bufferOdds: null };
    if (!under || !runner || runner.status !== "ACTIVE" || !offer) {
      snapshots.push({ ...base, marketId: market.marketId, tightOdds: null, liquidity, verdict: "WATCHING", reason: "Waiting for a live first-half Under price" });
      continue;
    }
    if (offer.price <= num(config.minOdds)) {
      snapshots.push({ ...base, marketId: market.marketId, tightOdds: offer.price, liquidity, verdict: "WATCHING", reason: `Waiting for Under ${line.toFixed(1)} above ${num(config.minOdds).toFixed(2)}` });
      continue;
    }
    if (liquidity < num(config.minLiquidity)) {
      snapshots.push({ ...base, marketId: market.marketId, tightOdds: offer.price, liquidity, verdict: "SKIPPED", reason: `Liquidity £${Math.round(liquidity)} below £${Math.round(num(config.minLiquidity))}` });
      continue;
    }
    const stake = entryStakeForOdds(offer.price);
    if (offer.size + 0.01 < stake) {
      snapshots.push({
        ...base,
        marketId: market.marketId,
        tightOdds: offer.price,
        liquidity,
        verdict: "WATCHING",
        reason: `Only £${offer.size.toFixed(2)} available to back; £${stake.toFixed(2)} required for the odds-based stake`,
      });
      continue;
    }
    const layPrice = fixedOffsetLayTarget(offer.price, num(config.layOffset));
    let evidence: Awaited<ReturnType<typeof restingLayEvidence>>;
    try { evidence = await restingLayEvidence(market.marketId, under.selectionId, layPrice, stake); }
    catch (error) {
      await log("warn", `SKIPPED ${eventName} — cannot establish resting-lay evidence`, { error: String(error) });
      continue;
    }
    const fullyMatched = evidence.immediate.matchedStake + 0.01 >= stake;
    const average = evidence.immediate.matchedStake > 0
      ? evidence.immediate.priceStake / evidence.immediate.matchedStake
      : layPrice;
    const enteredAt = new Date();
    const fallbackNextCheckAt = new Date(
      enteredAt.getTime() + config.fallbackIntervalSeconds * 1_000,
    );
    // Network requests above can straddle Stop or the half-time suspension.
    // Recheck both lifecycle and the live first-half market immediately before
    // recording an entry.
    if (!running || currentGeneration !== generation) return;
    const finalBook = (await books([market.marketId])).get(market.marketId);
    if (!finalBook || finalBook.status !== "OPEN" || !finalBook.inplay) {
      await log("info", `SKIPPED ${eventName} — first-half market closed or suspended before entry`);
      continue;
    }
    if (!running || currentGeneration !== generation) return;
    const [inserted] = await db.insert(soccerTradesTable).values({
      eventId, eventName, competition, marketId: market.marketId, marketName: market.marketName,
      selectionId: under.selectionId, selectionName: under.runnerName, line: line.toFixed(1),
      bufferLine: false, entryScore: scoreText, entryTotalGoals: total, entryMinute: minute,
      entryOdds: offer.price.toFixed(2), stake: stake.toFixed(2), strategy: STRATEGY,
      targetLayPrice: layPrice.toFixed(2), layPrice: average.toFixed(2),
      layTradedVolumeBaseline: evidence.baseline.toFixed(2),
      layQueueAhead: evidence.queueAhead.toFixed(2), layImmediateMatchedStake: evidence.immediate.matchedStake.toFixed(2),
      layImmediatePriceStake: evidence.immediate.priceStake.toFixed(2),
      layMatchedStake: evidence.immediate.matchedStake.toFixed(2),
      layMatchedPriceStake: evidence.immediate.priceStake.toFixed(2),
      layMatchedAt: fullyMatched ? enteredAt : null,
      fallbackNextCheckAt: fullyMatched ? null : fallbackNextCheckAt,
      fallbackAttemptCount: 0,
      fallbackDecision: fullyMatched
        ? "NOT_REQUIRED_TARGET_FILLED"
        : "WAITING_FOR_FALLBACK_INTERVAL",
      status: fullyMatched ? "HEDGED" : "OPEN", exitOdds: fullyMatched ? average.toFixed(2) : null,
      exitReason: fullyMatched ? `First-half lay immediately matched @ ${average.toFixed(2)} — £0 if next goal, target return if no goal` : null,
      paper: true, placedAt: enteredAt,
    }).returning({ id: soccerTradesTable.id });
    if (!running || currentGeneration !== generation) {
      if (inserted) {
        await db.delete(soccerTradesTable).where(eq(soccerTradesTable.id, inserted.id));
      }
      await log("info", `CANCELLED ${eventName} entry because the first-half bot was stopped`);
      return;
    }
    slots--; openEvents.add(eventId);
    snapshots.push({ ...base, marketId: market.marketId, tightOdds: offer.price, liquidity, verdict: "ENTERED", reason: `BACK ${under.runnerName} @ ${offer.price.toFixed(2)}; same-stake lay @ ${layPrice.toFixed(2)}` });
    await log("info", `ENTERED ${eventName} ${scoreText} ${minute}' — BACK ${under.runnerName} @ ${offer.price.toFixed(2)} £${stake}, resting lay @ ${layPrice.toFixed(2)}`, {
      paper: true,
      targetLayPrice: layPrice,
      immediateMatchedStake: evidence.immediate.matchedStake,
      immediatePriceStake: evidence.immediate.priceStake,
      fallbackNextCheckAt: fullyMatched ? null : fallbackNextCheckAt.toISOString(),
    });
  }
  candidates = snapshots;
}

function targetMatchedStake(trade: SoccerTrade, runner: BookRunner): number {
  const stake = num(trade.stake);
  const immediate = Math.min(stake, num(trade.layImmediateMatchedStake));
  const targetPrice = num(trade.targetLayPrice ?? trade.layPrice);
  const postEntryVolume = tradedVolumeAtPrice(
    runner.ex?.tradedVolume ?? [],
    targetPrice,
  ) - num(trade.layTradedVolumeBaseline);
  const resting = Math.max(
    0,
    Math.min(stake - immediate, postEntryVolume - num(trade.layQueueAhead)),
  );
  return immediate + resting;
}

function fallbackMaximumPrice(
  stake: number,
  entryOdds: number,
  matchedStake: number,
  matchedPriceStake: number,
  maxLossPct: number,
): number {
  const remaining = remainingEqualLayStake(stake, matchedStake);
  if (remaining <= 0) return 1.01;
  const maximumLoss = stake * Math.max(0, maxLossPct) / 100;
  const existingLiability = matchedPriceStake - matchedStake;
  return 1 + (
    stake * (entryOdds - 1) + maximumLoss - existingLiability
  ) / remaining;
}

async function monitorLays(currentGeneration: number) {
  if (currentGeneration !== generation || !getSession()) return;
  const config = await getFirstHalfSoccerConfig();
  const open = await db.select().from(soccerTradesTable).where(and(
    eq(soccerTradesTable.strategy, STRATEGY), eq(soccerTradesTable.status, "OPEN"),
  ));
  if (!open.length) return;
  const marketBooks = await books(open.map((trade) => trade.marketId), false, true);
  for (const trade of open) {
    if (currentGeneration !== generation) return;
    const book = marketBooks.get(trade.marketId);
    const runner = book?.runners?.find((entry) => entry.selectionId === trade.selectionId);
    if (!runner) continue;
    const stake = num(trade.stake);
    const targetPrice = num(trade.targetLayPrice ?? trade.layPrice);
    const compatibleAggregate = compatibleLayAggregate(
      trade.status, stake, num(trade.layPrice),
      num(trade.layMatchedStake), num(trade.layMatchedPriceStake),
      num(trade.layImmediateMatchedStake), num(trade.layImmediatePriceStake),
    );
    let matchedStake = compatibleAggregate.matchedStake;
    let priceStake = compatibleAggregate.priceStake;
    const fallbackAccepted = trade.fallbackDecision?.startsWith("ACCEPTED") ?? false;

    // Once a fallback is accepted, the simulated target is cancelled. Before
    // then, persist only the newly evidenced target volume so repeated monitor
    // passes cannot count the same exchange volume twice.
    if (!fallbackAccepted) {
      const evidencedTargetStake = targetMatchedStake(trade, runner);
      const targetFill = Math.max(
        0,
        evidencedTargetStake - matchedStake,
      );
      if (targetFill > PRICE_EPSILON) {
        const aggregate = addEqualLayFill(
          stake,
          matchedStake,
          priceStake,
          targetFill,
          targetPrice,
        );
        matchedStake = aggregate.matchedStake;
        priceStake = aggregate.priceStake;
        await db.update(soccerTradesTable).set({
          layMatchedStake: matchedStake.toFixed(2),
          layMatchedPriceStake: priceStake.toFixed(2),
          layPrice: aggregate.averageOdds.toFixed(2),
        }).where(and(
          eq(soccerTradesTable.id, trade.id),
          eq(soccerTradesTable.status, "OPEN"),
        ));
        await log("info", `TARGET PARTIAL ${trade.eventName} — £${targetFill.toFixed(2)} @ ${targetPrice.toFixed(2)}`, {
          targetLayPrice: targetPrice,
          aggregateMatchedStake: matchedStake,
          remainingStake: remainingEqualLayStake(stake, matchedStake),
        });
      }
    }

    let remaining = remainingEqualLayStake(stake, matchedStake);
    if (remaining <= PRICE_EPSILON) {
      const average = priceStake / matchedStake;
      const updated = await db.update(soccerTradesTable).set({
        status: "HEDGED", layMatchedAt: new Date(), layPrice: average.toFixed(2),
        exitOdds: average.toFixed(2), fallbackNextCheckAt: null,
        exitReason: `First-half target lay fully matched @ ${average.toFixed(2)} average`,
      }).where(and(
        eq(soccerTradesTable.id, trade.id),
        eq(soccerTradesTable.status, "OPEN"),
      )).returning({ id: soccerTradesTable.id });
      if (updated.length) {
        const projectedPnl = equalStakeCombinedProfit(
          stake, num(trade.entryOdds), true, matchedStake, average,
        );
        await log("info", `TARGET MATCHED ${trade.eventName} @ ${average.toFixed(2)}`, {
          matchedStake,
          matchedPriceStake: priceStake,
          projectedPnl,
        });
      }
      continue;
    }

    const now = new Date();
    const nextCheckAt = trade.fallbackNextCheckAt ??
      new Date(trade.placedAt.getTime() + config.fallbackIntervalSeconds * 1_000);
    if (now < nextCheckAt || book?.status !== "OPEN") continue;

    const bestLay = [...(runner.ex?.availableToLay ?? [])]
      .filter((level) => level.size > 0)
      .sort((a, b) => a.price - b.price)[0];
    const attemptCount = (trade.fallbackAttemptCount ?? 0) + 1;
    const elapsedSeconds = Math.max(
      0,
      Math.round((now.getTime() - trade.placedAt.getTime()) / 1_000),
    );
    const followingCheck = new Date(
      now.getTime() + config.fallbackIntervalSeconds * 1_000,
    );
    if (!bestLay) {
      const decision = fallbackAccepted
        ? "ACCEPTED_PARTIAL_THEN_DEFERRED_NO_LIQUIDITY"
        : "DEFERRED_NO_LIQUIDITY";
      await db.update(soccerTradesTable).set({
        fallbackAttemptedAt: now, fallbackAttemptCount: attemptCount,
        fallbackNextCheckAt: followingCheck, fallbackPrice: null,
        fallbackProjectedPnl: null, fallbackDecision: decision,
      }).where(and(
        eq(soccerTradesTable.id, trade.id),
        eq(soccerTradesTable.status, "OPEN"),
      ));
      await log("warn", `FALLBACK DEFERRED ${trade.eventName} — no executable lay liquidity`, {
        attemptCount, elapsedSeconds, remainingStake: remaining,
        nextCheckAt: followingCheck.toISOString(),
      });
      continue;
    }

    const fillStake = Math.min(remaining, bestLay.size);
    const proposed = addEqualLayFill(
      stake, matchedStake, priceStake, fillStake, bestLay.price,
    );
    const projectedFullPriceStake = priceStake + remaining * bestLay.price;
    const projectedPnl = equalStakeCombinedProfit(
      stake,
      num(trade.entryOdds),
      true,
      stake,
      projectedFullPriceStake / stake,
    );
    const maximumPrice = fallbackMaximumPrice(
      stake,
      num(trade.entryOdds),
      matchedStake,
      priceStake,
      num(config.maxFallbackLossPct),
    );
    const eligible = isFallbackLayEligible(
      trade.placedAt.getTime(),
      now.getTime(),
      config.fallbackIntervalSeconds * 1_000,
      stake,
      matchedStake,
      bestLay.price,
      maximumPrice,
    );
    if (!eligible) {
      const decision = fallbackAccepted
        ? "ACCEPTED_PARTIAL_THEN_DEFERRED_LOSS_CAP"
        : "DEFERRED_LOSS_CAP";
      await db.update(soccerTradesTable).set({
        fallbackAttemptedAt: now, fallbackAttemptCount: attemptCount,
        fallbackNextCheckAt: followingCheck,
        fallbackPrice: bestLay.price.toFixed(2),
        fallbackProjectedPnl: projectedPnl.toFixed(2),
        fallbackDecision: decision,
      }).where(and(
        eq(soccerTradesTable.id, trade.id),
        eq(soccerTradesTable.status, "OPEN"),
      ));
      await log("warn", `FALLBACK DEFERRED ${trade.eventName} @ ${bestLay.price.toFixed(2)} — projected ${projectedPnl >= 0 ? "+" : ""}£${projectedPnl.toFixed(2)}`, {
        attemptCount, elapsedSeconds, availableStake: bestLay.size,
        remainingStake: remaining, maximumPrice,
        maxLoss: stake * num(config.maxFallbackLossPct) / 100,
        nextCheckAt: followingCheck.toISOString(),
      });
      continue;
    }

    matchedStake = proposed.matchedStake;
    priceStake = proposed.priceStake;
    remaining = remainingEqualLayStake(stake, matchedStake);
    const fullyMatched = remaining <= PRICE_EPSILON;
    const decision = fullyMatched ? "ACCEPTED_FULL" : "ACCEPTED_PARTIAL";
    const updated = await db.update(soccerTradesTable).set({
      layMatchedStake: matchedStake.toFixed(2),
      layMatchedPriceStake: priceStake.toFixed(2),
      layPrice: proposed.averageOdds.toFixed(2),
      fallbackAttemptedAt: now, fallbackAttemptCount: attemptCount,
      fallbackNextCheckAt: fullyMatched ? null : followingCheck,
      fallbackPrice: bestLay.price.toFixed(2),
      fallbackProjectedPnl: projectedPnl.toFixed(2),
      fallbackDecision: decision,
      status: fullyMatched ? "HEDGED" : "OPEN",
      layMatchedAt: fullyMatched ? now : null,
      exitOdds: fullyMatched ? proposed.averageOdds.toFixed(2) : null,
      exitReason: fullyMatched
        ? `Fallback completed lay @ ${bestLay.price.toFixed(2)}; £${matchedStake.toFixed(2)} matched @ ${proposed.averageOdds.toFixed(2)} average`
        : `Fallback partially filled £${fillStake.toFixed(2)} @ ${bestLay.price.toFixed(2)}; £${remaining.toFixed(2)} remains`,
    }).where(and(
      eq(soccerTradesTable.id, trade.id),
      eq(soccerTradesTable.status, "OPEN"),
    )).returning({ id: soccerTradesTable.id });
    if (updated.length) {
      await log("info", `FALLBACK ${decision} ${trade.eventName} — £${fillStake.toFixed(2)} @ ${bestLay.price.toFixed(2)}`, {
        attemptCount, elapsedSeconds, availableStake: bestLay.size,
        matchedStake, remainingStake: remaining,
        averageLayOdds: proposed.averageOdds, projectedPnl,
      });
    }
  }
}

async function settle() {
  const open = await db.select().from(soccerTradesTable).where(and(
    eq(soccerTradesTable.strategy, STRATEGY), inArray(soccerTradesTable.status, ["OPEN", "HEDGED"]),
  ));
  if (!open.length) return;
  const byMarket = await books(open.map((trade) => trade.marketId), true);
  for (const trade of open) {
    const book = byMarket.get(trade.marketId);
    const runner = book?.runners?.find((entry) => entry.selectionId === trade.selectionId);
    if (book?.status !== "CLOSED" || !runner) continue;
    const stake = num(trade.stake);
    const won = runner.status === "WINNER";
    const compatibleAggregate = compatibleLayAggregate(
      trade.status, stake, num(trade.layPrice),
      num(trade.layMatchedStake), num(trade.layMatchedPriceStake),
      num(trade.layImmediateMatchedStake), num(trade.layImmediatePriceStake),
    );
    let matchedLayStake = compatibleAggregate.matchedStake;
    let matchedPriceStake = compatibleAggregate.priceStake;
    const fallbackAccepted = trade.fallbackDecision?.startsWith("ACCEPTED") ?? false;
    if (trade.status !== "HEDGED" && !fallbackAccepted) {
      const finalTargetStake = targetMatchedStake(trade, runner);
      const finalTargetFill = Math.max(0, finalTargetStake - matchedLayStake);
      const aggregate = addEqualLayFill(
        stake,
        matchedLayStake,
        matchedPriceStake,
        finalTargetFill,
        num(trade.targetLayPrice ?? trade.layPrice),
      );
      matchedLayStake = aggregate.matchedStake;
      matchedPriceStake = aggregate.priceStake;
    }
    const averageLayOdds = matchedLayStake > 0
      ? matchedPriceStake / matchedLayStake
      : num(trade.targetLayPrice ?? trade.layPrice);
    const profit = equalStakeCombinedProfit(
      stake,
      num(trade.entryOdds),
      won,
      matchedLayStake,
      averageLayOdds,
    );
    const profitCents = Math.round(profit * 100);
    const status = profitCents > 0
      ? "SETTLED_WON"
      : profitCents < 0
        ? "SETTLED_LOST"
        : "SETTLED_BREAK_EVEN";
    await db.update(soccerTradesTable).set({
      status, profit: profit.toFixed(2), closedAt: new Date(),
      layMatchedStake: matchedLayStake.toFixed(2),
      layMatchedPriceStake: matchedPriceStake.toFixed(2),
      layPrice: averageLayOdds.toFixed(2),
      goalAfterEntry: !won,
      exitReason: won
        ? `First half ended with no further goal — £${matchedLayStake.toFixed(2)} lay stake matched`
        : matchedLayStake + 0.01 >= stake
          ? "Goal broke the Under — matched lay returned the stake (breakeven)"
          : `Goal broke the Under — £${matchedLayStake.toFixed(2)} of £${stake.toFixed(2)} lay stake matched`,
    }).where(and(eq(soccerTradesTable.id, trade.id), inArray(soccerTradesTable.status, ["OPEN", "HEDGED"])));
    await log(won ? "info" : "warn", `${won ? "SETTLED WON" : "SETTLED"} ${trade.eventName} ${profit >= 0 ? "+" : ""}£${profit.toFixed(2)}`, {
      matchedLayStake,
      matchedLayPriceStake: matchedPriceStake,
      averageLayOdds,
      fallbackDecision: trade.fallbackDecision,
    });
  }
}

async function cycle(currentGeneration: number) {
  const config = await getFirstHalfSoccerConfig();
  if (!config.paperMode) {
    await db.update(firstHalfSoccerConfigTable).set({ paperMode: true }).where(eq(firstHalfSoccerConfigTable.id, config.id));
    throw new Error("First-half bot is paper-only");
  }
  if (!getSession()) {
    const login = await loginWithEnvCredentials();
    if (!login.success) { await log("warn", `Betfair not connected: ${login.error}`); return; }
  }
  await monitorLays(currentGeneration);
  await settle();
  if (running && currentGeneration === generation) await scan(config, currentGeneration);
  lastCycleAt = new Date();
}

async function loop(currentGeneration: number) {
  if (!running || currentGeneration !== generation) return;
  if (!processing) {
    processing = true;
    try { await cycle(currentGeneration); } catch (error) { logger.error({ error }, "[FIRST HALF] cycle error"); }
    finally { processing = false; }
  }
  const interval = (await getFirstHalfSoccerConfig()).checkIntervalSeconds * 1_000;
  if (running && currentGeneration === generation) cycleTimer = setTimeout(() => void loop(currentGeneration), interval);
}

async function monitorLoop(currentGeneration: number) {
  if (currentGeneration !== generation) return;
  if (!processing && !monitorProcessing) {
    monitorProcessing = true;
    try {
      if (!getSession()) await loginWithEnvCredentials();
      await monitorLays(currentGeneration);
      await settle();
    } catch (error) { logger.error({ error }, "[FIRST HALF] lay monitor error"); }
    finally { monitorProcessing = false; }
  }
  const [outstanding] = await db.select({ id: soccerTradesTable.id }).from(soccerTradesTable)
    .where(and(eq(soccerTradesTable.strategy, STRATEGY), inArray(soccerTradesTable.status, ["OPEN", "HEDGED"])))
    .limit(1);
  if ((running || outstanding) && currentGeneration === generation) {
    monitorTimer = setTimeout(() => void monitorLoop(currentGeneration), MONITOR_MS);
  }
}

export async function startFirstHalfSoccerBot() {
  if (running) return;
  const config = await getFirstHalfSoccerConfig();
  if (!config.paperMode) throw new Error("First-half bot is paper-only");
  running = true; startedAt = new Date(); const currentGeneration = ++generation;
  await db.update(firstHalfSoccerConfigTable).set({ isRunning: true, paperMode: true }).where(eq(firstHalfSoccerConfigTable.id, config.id));
  await log("info", "First-half bot STARTED (paper only)");
  void loop(currentGeneration); void monitorLoop(currentGeneration);
}

export async function stopFirstHalfSoccerBot() {
  if (!running) return;
  running = false; const currentGeneration = ++generation; startedAt = null; candidates = []; watchedGames = 0;
  if (cycleTimer) clearTimeout(cycleTimer);
  if (monitorTimer) clearTimeout(monitorTimer);
  cycleTimer = null; monitorTimer = null;
  const config = await getFirstHalfSoccerConfig();
  await db.update(firstHalfSoccerConfigTable).set({ isRunning: false }).where(eq(firstHalfSoccerConfigTable.id, config.id));
  await log("info", "First-half bot STOPPED");
  const [outstanding] = await db.select({ id: soccerTradesTable.id }).from(soccerTradesTable)
    .where(and(eq(soccerTradesTable.strategy, STRATEGY), inArray(soccerTradesTable.status, ["OPEN", "HEDGED"])))
    .limit(1);
  if (outstanding) void monitorLoop(currentGeneration);
}

export async function autoResumeFirstHalfSoccerBot() {
  try {
    const config = await getFirstHalfSoccerConfig();
    if (config.isRunning) {
      await startFirstHalfSoccerBot();
      return;
    }
    const [outstanding] = await db.select({ id: soccerTradesTable.id }).from(soccerTradesTable)
      .where(and(eq(soccerTradesTable.strategy, STRATEGY), inArray(soccerTradesTable.status, ["OPEN", "HEDGED"])))
      .limit(1);
    if (outstanding) {
      const currentGeneration = ++generation;
      void monitorLoop(currentGeneration);
    }
  } catch (error) {
    logger.error({ error }, "[FIRST HALF] auto-resume failed");
  }
}