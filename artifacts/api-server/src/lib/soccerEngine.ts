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
 *  - Immediately rest a lay for the same stake. If it matches, the position
 *    locks the configured return when the Under wins and £0 when it loses.
 *
 * Score inference: the Betfair betting API exposes no scoreline, so the
 * engine reads the CORRECT_SCORE market — at the 85th minute the true score
 * trades at ~1.0x. Games whose score cannot be read unambiguously (e.g. 4-3
 * territory covered only by "Any Other Home Win") are skipped and logged.
 * Match minute is estimated from kick-off time (+15 min half-time break).
 */
import { eq, desc, inArray } from "drizzle-orm";
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
  COMMISSION,
  parseScoreName,
  inferScore,
  estimateMinute,
  chooseEntryLine,
  layLockPrice,
  layLockWinProfit,
  ouLineFromMarketType,
} from "./soccerHelpers";
import { fetchLiveScores, matchFeedScore } from "./scoreFeed";

const SOCCER_EVENT_TYPE = "1";

// ── In-memory state ─────────────────────────────────────────────────────────
let running = false;
let startedAt: Date | null = null;
let lastCycleAt: Date | null = null;
let cycleTimer: ReturnType<typeof setTimeout> | null = null;
let processing = false;

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
  if (rows.length > 0) return rows[0]!;
  const inserted = await db.insert(soccerConfigTable).values({}).returning();
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
const num = (v: string | number | null | undefined) => Number(v ?? 0);

// ── Main cycle ──────────────────────────────────────────────────────────────
async function runCycle(): Promise<void> {
  const config = await getSoccerConfig();

  // Session
  if (!getSession()) {
    const login = await loginWithEnvCredentials();
    if (!login.success) {
      await slog("warn", `Betfair not connected: ${login.error}`);
      return;
    }
    await slog("info", "Connected to Betfair");
  }

  // 1) Manage open trades first
  await manageOpenTrades(config);

  // 2) Settle closed markets
  await settleTrades(config);

  // 3) Scan for new entries. There is deliberately no daily stop-loss.
  await scanForEntries(config);

  lastCycleAt = new Date();
}

// ── Entry scan ──────────────────────────────────────────────────────────────
async function scanForEntries(config: SoccerConfig): Promise<void> {
  const openRows = await db
    .select()
    .from(soccerTradesTable)
    .where(inArray(soccerTradesTable.status, ["OPEN", "HEDGED"]));
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
      .from(soccerTradesTable);
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
        eventName, competition, marketId: null, score: "?", goalGap: 0, minute,
        tightLine: null, tightOdds: null, bufferLine: null, bufferOdds: null,
        liquidity: null, verdict: "SKIPPED",
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
          eventName, competition, marketId: null,
          score: `${feed.home}-${feed.away}?`, goalGap: 0, minute,
          tightLine: null, tightOdds: null, bufferLine: null, bufferOdds: null,
          liquidity: null, verdict: "SKIPPED",
          reason: `Feed (${feed.home}-${feed.away}) and market (${score.home}-${score.away}) disagree — possible goal in flight, waiting for both to agree`,
        });
        continue;
      }
      score = { home: feed.home, away: feed.away };
      scoreSource = "feed";
    }
    if (!score) {
      snap.push({
        eventName, competition, marketId: null, score: "?", goalGap: 0, minute,
        tightLine: null, tightOdds: null, bufferLine: null, bufferOdds: null,
        liquidity: null, verdict: "SKIPPED",
        reason: `No live-score feed match and score not readable from Correct Score market (${inferred.detail})`,
      });
      continue;
    }

    const scoreStr = `${score.home}-${score.away}`;
    const gap = Math.abs(score.home - score.away);
    const total = score.home + score.away;

    if (gap < config.minGoalGap) {
      snap.push({
        eventName, competition, marketId: null, score: scoreStr, goalGap: gap, minute,
        tightLine: null, tightOdds: null, bufferLine: null, bufferOdds: null,
        liquidity: null, verdict: "SKIPPED",
        reason: `Goal gap ${gap} < ${config.minGoalGap} — game not dead, a team can still chase`,
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
            filter: { eventIds: eventId ? [eventId] : [], marketTypeCodes: wantedTypes, inPlayOnly: true },
            marketProjection: ["EVENT", "MARKET_DESCRIPTION", "RUNNER_DESCRIPTION", "MARKET_START_TIME"],
            maxResults: 10,
          },
        )
      ).filter((m) => Array.isArray(m.runners));
    } catch (err) {
      await slog("error", `O/U catalogue fetch failed for ${eventName}`, { err: String(err) });
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
      const br = b.runners.find((r) => r.selectionId === underRunner.selectionId);
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
    const pick = chooseEntryLine(
      tight,
      insured,
      tightMinOdds,
      insuredMinOdds,
    );

    const base = {
      eventName, competition, score: scoreStr, goalGap: gap, minute,
      tightLine: tight ? tight.line : null,
      tightOdds: tight ? tight.odds : null,
      bufferLine: insured ? insured.line : null,
      bufferOdds: insured ? insured.odds : null,
    };

    if (!pick) {
      snap.push({
        ...base, marketId: null, liquidity: null, verdict: "WATCHING",
        reason: `Waiting for insured line > ${insuredMinOdds.toFixed(2)} or tight line > ${tightMinOdds.toFixed(2)}` +
          (insured ? ` (insured U${insured.line} @ ${insured.odds})` : "") +
          (tight ? ` (U${tight.line} @ ${tight.odds})` : ""),
      });
      continue;
    }

    if (pick.liquidity < num(config.minLiquidity)) {
      snap.push({
        ...base, marketId: pick.market.marketId, liquidity: pick.liquidity, verdict: "SKIPPED",
        reason: `Liquidity £${Math.round(pick.liquidity)} < £${Math.round(num(config.minLiquidity))} — trade-out would be impossible`,
      });
      continue;
    }

    // ENTER (paper): record at the visible back price — one trade per enabled strategy
    const stake = num(config.stake);
    const isInsured = pick.line === insuredLine;
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
      paper: config.paperMode,
    };
    // Immediately rest the same-stake lay. A match locks layTargetPct net if
    // the Under wins and £0 if it loses.
    const targetFrac = num(config.layTargetPct) / 100;
    const ideal = pick.odds - targetFrac / (1 - COMMISSION);
    const layPrice = layLockPrice(pick.odds, num(config.layTargetPct));
    await db.insert(soccerTradesTable).values({
      ...baseTrade,
      strategy: "LAY_LOCK",
      layPrice: layPrice.toFixed(2),
    });
    slots--;
    if (eventId) openEventIds.add(eventId);
    await slog(
      "info",
      `ENTERED ${eventName} ${scoreStr} ${minute}' — BACK ${pick.selectionName} @ ${pick.odds} £${stake} ` +
        `(${isInsured ? "INSURED line, one-goal cover" : "tight line"}, liq £${Math.round(pick.liquidity)}, score via ${scoreSource === "feed" ? "live-score feed" : "odds inference"}) ` +
        `[resting same-stake lay @ ${layPrice.toFixed(2)}${ideal < 1.01 ? ", target capped at 1.01" : ""}]`,
    );
    snap.push({
      ...base, marketId: pick.market.marketId, liquidity: pick.liquidity, verdict: "ENTERED",
      reason: `BACK ${pick.selectionName} @ ${pick.odds} (${isInsured ? "insured" : "tight"} line)`,
    });
  }

  candidates = snap;
}

function openSnapshot(t: SoccerTrade): SoccerCandidateSnapshot {
  const reason =
    t.status === "HEDGED"
      ? `Lay matched @ ${num(t.layPrice)} — waiting for full-time settlement`
      : `BACK ${t.selectionName} @ ${num(t.entryOdds)} — resting lay @ ${num(t.layPrice)} waiting to match`;

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

// ── Open-trade management: trade-out, goal handling ─────────────────────────
async function manageOpenTrades(config: SoccerConfig): Promise<void> {
  const open = await db
    .select()
    .from(soccerTradesTable)
    .where(eq(soccerTradesTable.status, "OPEN"));
  if (open.length === 0) return;

  const books = await getBooks(open.map((t) => t.marketId));

  // Goal detection, primary source: the real live-score feed (matched by
  // event name). Secondary: re-read the CORRECT_SCORE market and compare the
  // inferred total goals with entryTotalGoals. Last resort: price spike.
  const currentTotals = new Map<string, number>(); // eventId -> total goals
  const openEventIds = [...new Set(open.map((t) => t.eventId).filter((x): x is string => !!x))];
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
          filter: { eventIds: openEventIds, marketTypeCodes: ["CORRECT_SCORE"] },
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

    const stake = num(trade.stake);
    const entryOdds = num(trade.entryOdds);
    const runner = book.runners?.find((r) => r.selectionId === trade.selectionId);
    const layOffer = runner?.ex?.availableToLay?.[0];

    // Goal-after-entry: primary signal is the refreshed correct-score total;
    // fallback is a violent price spike on our Under selection.
    let goalAfterEntry = trade.goalAfterEntry;
    if (!goalAfterEntry) {
      const currentTotal = trade.eventId ? currentTotals.get(trade.eventId) : undefined;
      const scoreSaysGoal =
        currentTotal !== undefined &&
        trade.entryTotalGoals !== null &&
        currentTotal > trade.entryTotalGoals;
      const priceSaysGoal = !!layOffer && layOffer.price >= entryOdds * 1.4;
      if (scoreSaysGoal || (currentTotal === undefined && priceSaysGoal)) {
        goalAfterEntry = true;
        await db
          .update(soccerTradesTable)
          .set({ goalAfterEntry: true })
          .where(eq(soccerTradesTable.id, trade.id));
        await slog(
          "warn",
          `GOAL against us in ${trade.eventName} (${scoreSaysGoal ? `score now totals ${currentTotal}` : `${trade.selectionName} spiked to ${layOffer?.price}`}) — switching to breakeven-exit mode`,
        );
      }
    }

    // LAY_LOCK strategy: the only management is watching the resting lay.
    // It matches (paper) when the market's best back offer trades down to
    // our price with enough size to absorb the stake.
    if (trade.strategy === "LAY_LOCK") {
      if (book.status !== "OPEN" || !trade.layPrice) continue;
      // Paper fill heuristic (threshold-cross): our resting lay at L sits in
      // the availableToBack queue. Once the best OTHER back offer is strictly
      // below L, our price is the best in the book and incoming back flow
      // takes it. Strict `<` keeps the simulation conservative — touching L
      // exactly doesn't count (we'd be behind the existing queue at L).
      const backOffer = runner?.ex?.availableToBack?.[0];
      const layPrice = num(trade.layPrice);
      if (backOffer && backOffer.price < layPrice) {
        await db
          .update(soccerTradesTable)
          .set({
            status: "HEDGED",
            layMatchedAt: new Date(),
            exitOdds: layPrice.toFixed(2),
            exitReason: `Resting lay matched @ ${layPrice.toFixed(2)} — locked: win = target %, lose = breakeven`,
          })
          .where(eq(soccerTradesTable.id, trade.id));
        await slog(
          "info",
          `LAY MATCHED ${trade.eventName} — ${trade.selectionName} layed £${stake} @ ${layPrice.toFixed(2)} (backed @ ${entryOdds}); outcome locked to +£${layLockWinProfit(stake, entryOdds, layPrice).toFixed(2)} or £0`,
        );
      }
      continue;
    }

  }
}

// ── Settlement ──────────────────────────────────────────────────────────────
async function settleTrades(_config: SoccerConfig): Promise<void> {
  const open = await db
    .select()
    .from(soccerTradesTable)
    .where(inArray(soccerTradesTable.status, ["OPEN", "HEDGED"]));
  if (open.length === 0) return;

  interface SettleBook {
    marketId: string;
    status: string;
    runners?: Array<{ selectionId: number; status: string }>;
  }
  const ids = open.map((t) => t.marketId);
  let books: SettleBook[] = [];
  try {
    books = await apiBetfairRequest<SettleBook[]>("SportsAPING/v1.0/listMarketBook", {
      marketIds: ids,
    });
  } catch {
    return;
  }
  const byId = new Map(books.map((b) => [b.marketId, b]));

  for (const trade of open) {
    const book = byId.get(trade.marketId);
    if (!book || book.status !== "CLOSED" || !book.runners) continue;
    const runner = book.runners.find((r) => r.selectionId === trade.selectionId);
    if (!runner) continue;

    const stake = num(trade.stake);
    const entryOdds = num(trade.entryOdds);

    if (trade.status === "HEDGED") {
      // Lay was matched: outcome is locked either way.
      const layPrice = num(trade.layPrice);
      if (runner.status === "WINNER") {
        const net = layLockWinProfit(stake, entryOdds, layPrice);
        await db
          .update(soccerTradesTable)
          .set({
            status: "SETTLED_WON",
            exitReason: `Held to full time with lay locked @ ${layPrice.toFixed(2)}`,
            profit: net.toFixed(2),
            closedAt: new Date(),
          })
          .where(eq(soccerTradesTable.id, trade.id));
        await slog("info", `SETTLED WON (LAY_LOCK) ${trade.eventName} +£${net.toFixed(2)}`);
      } else if (runner.status === "LOSER") {
        await db
          .update(soccerTradesTable)
          .set({
            status: "SETTLED_LOST",
            exitReason: `Line broken — lay hedge @ ${layPrice.toFixed(2)} returned the stake (breakeven)`,
            profit: "0.00",
            closedAt: new Date(),
          })
          .where(eq(soccerTradesTable.id, trade.id));
        await slog("info", `SETTLED BREAKEVEN (LAY_LOCK) ${trade.eventName} £0.00 — hedge did its job`);
      } else if (runner.status === "REMOVED") {
        await db
          .update(soccerTradesTable)
          .set({ status: "VOID", exitReason: "Market voided/removed", profit: "0.00", closedAt: new Date() })
          .where(eq(soccerTradesTable.id, trade.id));
      }
      continue;
    }

    if (runner.status === "WINNER") {
      const net = stake * (entryOdds - 1) * (1 - COMMISSION);
      await db
        .update(soccerTradesTable)
        .set({
          status: "SETTLED_WON",
          exitReason: "Held to full time — no goals broke the line",
          profit: net.toFixed(2),
          closedAt: new Date(),
        })
        .where(eq(soccerTradesTable.id, trade.id));
      await slog("info", `SETTLED WON ${trade.eventName} ${trade.selectionName} +£${net.toFixed(2)}`);
    } else if (runner.status === "LOSER") {
      await db
        .update(soccerTradesTable)
        .set({
          status: "SETTLED_LOST",
          exitReason: "Line broken — goals exceeded the backed under line",
          profit: (-stake).toFixed(2),
          closedAt: new Date(),
        })
        .where(eq(soccerTradesTable.id, trade.id));
      await slog("warn", `SETTLED LOST ${trade.eventName} ${trade.selectionName} -£${stake.toFixed(2)}`);
    } else if (runner.status === "REMOVED") {
      await db
        .update(soccerTradesTable)
        .set({
          status: "VOID",
          exitReason: "Market voided/removed",
          profit: "0.00",
          closedAt: new Date(),
        })
        .where(eq(soccerTradesTable.id, trade.id));
    }
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
async function loop(): Promise<void> {
  if (!running) return;
  if (!processing) {
    processing = true;
    try {
      await runCycle();
    } catch (err) {
      logger.error({ err }, "[SOCCER] cycle error");
    } finally {
      processing = false;
    }
  }
  const config = await getSoccerConfig().catch(() => null);
  const interval = (config?.checkIntervalSeconds ?? 20) * 1000;
  if (running) cycleTimer = setTimeout(() => void loop(), interval);
}

export async function startSoccerBot(): Promise<void> {
  if (running) return;
  running = true;
  startedAt = new Date();
  await db.update(soccerConfigTable).set({ isRunning: true });
  await slog("info", "Soccer in-play bot STARTED (paper mode until proven)");
  void loop();
}

export async function stopSoccerBot(): Promise<void> {
  if (!running) return;
  running = false;
  startedAt = null;
  if (cycleTimer) clearTimeout(cycleTimer);
  cycleTimer = null;
  candidates = [];
  watchedGames = 0;
  await db.update(soccerConfigTable).set({ isRunning: false });
  await slog("info", "Soccer in-play bot STOPPED");
}

/** Resume after process restart if the persisted flag says running. */
export async function autoResumeSoccerBot(): Promise<void> {
  try {
    const config = await getSoccerConfig();
    if (config.isRunning) {
      await slog("info", "Auto-resuming soccer bot after restart");
      running = true;
      startedAt = new Date();
      void loop();
    }
  } catch (err) {
    logger.error({ err }, "[SOCCER] auto-resume failed");
  }
}
