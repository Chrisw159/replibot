/**
 * SOCCER IN-PLAY "NO MORE GOALS" ENGINE
 *
 * Strategy (frozen with the user, 17 Aug 2026 — paper mode until proven):
 *  - From `entryMinute` (default 85') onward, find live soccer games with a
 *    goal gap >= `minGoalGap` (default 2) — dead games where nobody chases.
 *  - Back "Under X.5" in the Over/Under goals market at odds 1.25–1.50.
 *    Line priority: if the BUFFER line (current total goals + 2, e.g. 2-0 →
 *    Under 4.5) is already inside the odds band, take it (a late goal does
 *    not kill the bet). Otherwise take the TIGHT line (total + 0.5, e.g.
 *    2-0 → Under 2.5).
 *  - Trade out (hedge with a lay) as soon as +`profitTargetPct`% of stake is
 *    available. Otherwise let the bet settle at full time.
 *  - If a goal is scored after entry: green/scratch out the moment breakeven
 *    or better is available, else ride to full time.
 *
 * Score inference: the Betfair betting API exposes no scoreline, so the
 * engine reads the CORRECT_SCORE market — at the 85th minute the true score
 * trades at ~1.0x. Games whose score cannot be read unambiguously (e.g. 4-3
 * territory covered only by "Any Other Home Win") are skipped and logged.
 * Match minute is estimated from kick-off time (+15 min half-time break).
 */
import { eq, desc, sql, inArray } from "drizzle-orm";
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
  ouLineFromMarketType,
  hedgeProfit,
} from "./soccerHelpers";
import { fetchLiveScores, matchFeedScore } from "./scoreFeed";

const SOCCER_EVENT_TYPE = "1";

// ── In-memory state ─────────────────────────────────────────────────────────
let running = false;
let startedAt: Date | null = null;
let lastCycleAt: Date | null = null;
let cycleTimer: ReturnType<typeof setTimeout> | null = null;
let processing = false;
let dailyStopHit = false;
let dailyStopDate = "";

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
export function isDailyStopHit(): boolean {
  return dailyStopHit;
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
async function todayPnl(): Promise<{ pnl: number; trades: number }> {
  const rows = await db
    .select({
      pnl: sql<string>`coalesce(sum(${soccerTradesTable.profit}), 0)`,
      trades: sql<number>`count(*)`,
    })
    .from(soccerTradesTable)
    .where(sql`${soccerTradesTable.closedAt} >= date_trunc('day', now())`);
  return { pnl: num(rows[0]?.pnl), trades: Number(rows[0]?.trades ?? 0) };
}

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

  // Daily stop-loss latch (resets at midnight)
  const today = new Date().toISOString().slice(0, 10);
  if (dailyStopDate !== today) {
    dailyStopDate = today;
    dailyStopHit = false;
  }

  // 1) Manage open trades first (exits are always allowed)
  await manageOpenTrades(config);

  // 2) Settle closed markets
  await settleTrades(config);

  // 3) Re-check the daily stop AFTER exits/settlements so a loss realized
  //    this cycle blocks entries in this same cycle.
  const day = await todayPnl();
  const stopLoss = num(config.dailyStopLoss);
  if (!dailyStopHit && stopLoss > 0 && day.pnl <= -stopLoss) {
    dailyStopHit = true;
    await slog(
      "warn",
      `DAILY STOP-LOSS HIT (£${day.pnl.toFixed(2)}) — no new entries today`,
    );
  }

  // 4) Scan for new entries
  if (!dailyStopHit) await scanForEntries(config);

  lastCycleAt = new Date();
}

// ── Entry scan ──────────────────────────────────────────────────────────────
async function scanForEntries(config: SoccerConfig): Promise<void> {
  const openRows = await db
    .select()
    .from(soccerTradesTable)
    .where(eq(soccerTradesTable.status, "OPEN"));
  if (openRows.length >= config.maxConcurrent) {
    candidates = openRows.map((t) => openSnapshot(t));
    return;
  }
  const openEventIds = new Set(openRows.map((t) => t.eventId).filter(Boolean));

  // Events where we already banked profit today — block re-entry when the
  // flag is set, to avoid doubling exposure on the same game.
  const profitedEventIds = new Set<string>();
  if (config.blockReEntryAfterProfit) {
    const profited = await db
      .select({ eventId: soccerTradesTable.eventId })
      .from(soccerTradesTable)
      .where(
        sql`${soccerTradesTable.status} IN ('TRADED_OUT', 'EXITED_AFTER_GOAL')
          AND ${soccerTradesTable.closedAt} >= date_trunc('day', now())`,
      );
    for (const r of profited) {
      if (r.eventId) profitedEventIds.add(r.eventId);
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
  let slots = config.maxConcurrent - openRows.length;

  for (const cs of lateGames) {
    if (slots <= 0) break;
    const eventName = cs.event?.name ?? "Unknown fixture";
    const eventId = cs.event?.id ?? null;
    const competition = cs.competition?.name ?? null;
    const minute = estimateMinute(cs.marketStartTime);
    if (eventId && openEventIds.has(eventId)) continue;

    if (eventId && profitedEventIds.has(eventId)) {
      snap.push({
        eventName, competition, marketId: null, score: "?", goalGap: 0, minute,
        tightLine: null, tightOdds: null, bufferLine: null, bufferOdds: null,
        liquidity: null, verdict: "SKIPPED",
        reason: "Already banked profit on this game today — re-entry blocked (blockReEntryAfterProfit)",
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
    const bufferLine = total + 2.5;
    const wantedTypes = [
      `OVER_UNDER_${Math.floor(tightLine)}5`,
      `OVER_UNDER_${Math.floor(bufferLine)}5`,
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
    const buffer = quotes.get(bufferLine) ?? null;
    const minOdds = num(config.minOdds);
    const maxOdds = num(config.maxOdds);
    const inBand = (q: LineQuote | null): q is LineQuote =>
      !!q && q.odds >= minOdds && q.odds <= maxOdds;

    // Priority: buffer line first (score+2), tight line second
    const pick =
      config.preferBufferLine && inBand(buffer) ? buffer : inBand(tight) ? tight : null;

    const base = {
      eventName, competition, score: scoreStr, goalGap: gap, minute,
      tightLine: tight ? tight.line : null,
      tightOdds: tight ? tight.odds : null,
      bufferLine: buffer ? buffer.line : null,
      bufferOdds: buffer ? buffer.odds : null,
    };

    if (!pick) {
      snap.push({
        ...base, marketId: null, liquidity: null, verdict: "WATCHING",
        reason: `No line in ${minOdds.toFixed(2)}–${maxOdds.toFixed(2)} band yet` +
          (buffer ? ` (U${buffer.line} @ ${buffer.odds})` : "") +
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

    // ENTER (paper): record at the visible back price
    const stake = num(config.stake);
    const isBuffer = pick.line === bufferLine;
    await db.insert(soccerTradesTable).values({
      eventId,
      eventName,
      competition,
      marketId: pick.market.marketId,
      marketName: pick.market.marketName,
      selectionId: pick.selectionId,
      selectionName: pick.selectionName,
      line: pick.line.toFixed(1),
      bufferLine: isBuffer,
      entryScore: scoreStr,
      entryTotalGoals: total,
      entryMinute: minute,
      entryOdds: pick.odds.toFixed(2),
      stake: stake.toFixed(2),
      status: "OPEN",
      paper: config.paperMode,
    });
    slots--;
    if (eventId) openEventIds.add(eventId);
    await slog(
      "info",
      `ENTERED ${eventName} ${scoreStr} ${minute}' — BACK ${pick.selectionName} @ ${pick.odds} £${stake} ` +
        `(${isBuffer ? "BUFFER line, 2-goal cover" : "tight line"}, liq £${Math.round(pick.liquidity)}, score via ${scoreSource === "feed" ? "live-score feed" : "odds inference"})`,
    );
    snap.push({
      ...base, marketId: pick.market.marketId, liquidity: pick.liquidity, verdict: "ENTERED",
      reason: `BACK ${pick.selectionName} @ ${pick.odds} (${isBuffer ? "buffer" : "tight"} line)`,
    });
  }

  candidates = snap;
}

function openSnapshot(t: SoccerTrade): SoccerCandidateSnapshot {
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
    reason: `Open: BACK ${t.selectionName} @ ${num(t.entryOdds)} — waiting for trade-out`,
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

    if (!layOffer || book.status !== "OPEN") continue;

    // Executable-hedge check: the equal-profit lay stake is S*B/O — the quoted
    // lay depth must cover it or the paper exit would be fiction.
    const layStakeNeeded = (stake * entryOdds) / layOffer.price;
    if (layOffer.size < layStakeNeeded) continue; // not enough depth this tick

    const grossIfHedge = hedgeProfit(stake, entryOdds, layOffer.price);
    // Target is +profitTargetPct% NET of commission ⇒ gross must clear target/(1-c)
    const target = ((num(config.profitTargetPct) / 100) * stake) / (1 - COMMISSION);

    if (!goalAfterEntry && grossIfHedge >= target) {
      // Normal green-out at +15%
      const net = grossIfHedge * (1 - COMMISSION);
      await db
        .update(soccerTradesTable)
        .set({
          status: "TRADED_OUT",
          exitOdds: layOffer.price.toFixed(2),
          exitReason: `Profit target hit: +£${grossIfHedge.toFixed(2)} (${((grossIfHedge / stake) * 100).toFixed(1)}% of stake)`,
          profit: net.toFixed(2),
          closedAt: new Date(),
        })
        .where(eq(soccerTradesTable.id, trade.id));
      await slog(
        "info",
        `TRADED OUT ${trade.eventName} — ${trade.selectionName} ${entryOdds} → ${layOffer.price}, net +£${net.toFixed(2)}`,
      );
    } else if (goalAfterEntry && grossIfHedge >= 0) {
      // After a goal: take breakeven or better the moment it exists
      const net = grossIfHedge > 0 ? grossIfHedge * (1 - COMMISSION) : grossIfHedge;
      await db
        .update(soccerTradesTable)
        .set({
          status: "EXITED_AFTER_GOAL",
          exitOdds: layOffer.price.toFixed(2),
          exitReason: `Goal after entry — scratched at ${grossIfHedge >= 0.01 ? `+£${grossIfHedge.toFixed(2)}` : "breakeven"}`,
          profit: net.toFixed(2),
          closedAt: new Date(),
        })
        .where(eq(soccerTradesTable.id, trade.id));
      await slog(
        "info",
        `SCRATCHED ${trade.eventName} after goal — ${entryOdds} → ${layOffer.price}, £${net.toFixed(2)}`,
      );
    }
    // else: ride to full time (settlement pass decides)
  }
}

// ── Settlement ──────────────────────────────────────────────────────────────
async function settleTrades(_config: SoccerConfig): Promise<void> {
  const open = await db
    .select()
    .from(soccerTradesTable)
    .where(inArray(soccerTradesTable.status, ["OPEN"]));
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
