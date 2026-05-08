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
const MAX_ODDS = 50;
const MIN_BET_SIZE = 2.0;

const NON_WIN_PATTERN =
  /each.?way|forecast|\(f\/c\)|\bFC\b|\bRFC\b|reverse\s|straight\s+f|combination\s+f|to be placed|\bTBP\b|match bet|daily win dist|without\s+\w|to win by|trained\s+winner|named\s+fav|jockey.*champion|specials|scorecast|wincast/i;

// Skip National Hunt chase races — too many variables (falls, unseated, errors)
const CHASE_PATTERN = /\bChs\b|Chase/i;

// Known UK/IE all-weather venues — 7f handicaps here tend to be wide-open and hit by longshots
const AW_VENUE_PATTERN = /chelmsford|kempton|lingfield|southwell|wolverhampton|dundalk/i;
const SEVEN_FURLONG_PATTERN = /\b7f\b/i;

interface DutchConfig {
  totalOutlay: number;
  topPct: number;
  minFavPrice: number;
  minLiquidity: number;
  countryCodes: string[];
  minRunners: number;
  maxRunners: number;
  skipChases: boolean;
  skipAwSevenFurlong: boolean;
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
  minFavPrice: 4.0,
  minLiquidity: 3000,
  countryCodes: ["GB", "IE"],
  minRunners: 4,
  maxRunners: 12,
  skipChases: true,
  skipAwSevenFurlong: true,
};

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
      if (typeof saved.minLiquidity      === "number")  dutchConfig.minLiquidity      = saved.minLiquidity;
      if (Array.isArray(saved.countryCodes))             dutchConfig.countryCodes      = saved.countryCodes;
      if (typeof saved.minRunners        === "number")  dutchConfig.minRunners        = saved.minRunners;
      if (typeof saved.maxRunners        === "number")  dutchConfig.maxRunners        = saved.maxRunners;
      if (typeof saved.skipChases        === "boolean") dutchConfig.skipChases        = saved.skipChases;
      if (typeof saved.skipAwSevenFurlong === "boolean") dutchConfig.skipAwSevenFurlong = saved.skipAwSevenFurlong;
      logger.info({ dutchConfig }, "[DUTCH] Loaded config from DB");
    }
  } catch (err) {
    logger.error({ err }, "[DUTCH] Failed to load config from DB — using defaults");
  }
}

async function updateScheduleEntry(
  marketId: string,
  status: string,
  opts?: { skipReason?: string; runnerCount?: number },
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    await db.update(dutchScheduleTable)
      .set({
        status,
        skipReason:  opts?.skipReason  ?? null,
        ...(opts?.runnerCount != null ? { runnerCount: opts.runnerCount } : {}),
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
        log("info", `Skipping ${m.eventName} — National Hunt chase (${m.marketName})`);
        return false;
      }
      if (dutchConfig.skipAwSevenFurlong && SEVEN_FURLONG_PATTERN.test(m.marketName) && AW_VENUE_PATTERN.test(m.eventName)) {
        log("info", `Skipping ${m.eventName} — 7f all-weather flat (${m.marketName})`);
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

async function runDutchMarket(
  marketId: string,
  eventName: string,
  marketName: string,
): Promise<void> {
  const [config] = await db.select({ paperTradingMode: botConfigTable.paperTradingMode })
    .from(botConfigTable).limit(1);
  const paperTrading = config?.paperTradingMode ?? true;

  const marketDetail = await getMarketDetail(marketId);
  if (!marketDetail) return;

  if (marketDetail.totalMatched < dutchConfig.minLiquidity) {
    log("info",
      `Skipping ${eventName} — liquidity £${marketDetail.totalMatched.toFixed(0)} < £${dutchConfig.minLiquidity}`,
    );
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: `Low liquidity — £${marketDetail.totalMatched.toFixed(0)} matched (min £${dutchConfig.minLiquidity})`,
    });
    return;
  }

  // Only ACTIVE runners with a valid back price within our odds cap
  const eligible = marketDetail.runners.filter(r =>
    r.status === "ACTIVE" &&
    r.bestBackPrice != null &&
    r.bestBackPrice >= 1.01 &&
    r.bestBackPrice <= MAX_ODDS,
  );

  if (eligible.length < dutchConfig.minRunners) {
    log("info",
      `Skipping ${eventName} — only ${eligible.length} eligible runners, need ${dutchConfig.minRunners}`,
    );
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: `Only ${eligible.length} runners — need at least ${dutchConfig.minRunners}`,
      runnerCount: eligible.length,
    });
    return;
  }

  if (eligible.length > dutchConfig.maxRunners) {
    log("info",
      `Skipping ${eventName} — ${eligible.length} runners exceeds max ${dutchConfig.maxRunners}`,
    );
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: `${eligible.length} runners — exceeds max of ${dutchConfig.maxRunners}`,
      runnerCount: eligible.length,
    });
    return;
  }

  // Favourite check — skip if shortest price is under minFavPrice (e.g. 4.0 = 3/1)
  const shortestPrice = Math.min(...eligible.map(r => r.bestBackPrice!));
  if (shortestPrice < dutchConfig.minFavPrice) {
    log("info",
      `Skipping ${eventName} — favourite at ${shortestPrice} is under ${dutchConfig.minFavPrice} (${dutchConfig.minFavPrice - 1}/1)`,
    );
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: `Favourite at ${shortestPrice} — minimum is ${dutchConfig.minFavPrice}`,
      runnerCount: eligible.length,
    });
    return;
  }

  // Rank by implied probability (1/backPrice) descending — best proxy for market volume
  const impliedSum = eligible.reduce((s, r) => s + 1 / r.bestBackPrice!, 0);
  const ranked = eligible
    .map(r => ({
      runner: r,
      backPrice: r.bestBackPrice!,
      volPct: (1 / r.bestBackPrice!) / impliedSum,
    }))
    .sort((a, b) => b.volPct - a.volPct);

  const cutoff = Math.max(1, Math.ceil(ranked.length * dutchConfig.topPct));
  const backed = ranked.slice(0, cutoff);

  // Dutch stake formula:
  //   S = sum(1/backPrice_i) for backed horses
  //   stake_i = totalOutlay / (S × backPrice_i)
  //   targetProfit = totalOutlay × (1-S) / S
  const S = backed.reduce((s, r) => s + 1 / r.backPrice, 0);
  const targetProfit = dutchConfig.totalOutlay * (1 - S) / S;

  if (targetProfit <= 0) {
    log("info",
      `Skipping ${eventName} — market overround too tight, target profit £${targetProfit.toFixed(2)} ≤ 0`,
    );
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: "Market overround too tight — no profit margin",
      runnerCount: eligible.length,
    });
    return;
  }

  const withStakes = backed.map(r => ({
    ...r,
    stake: Math.round((dutchConfig.totalOutlay / (S * r.backPrice)) * 100) / 100,
  }));

  // Betfair minimum bet check
  const belowMin = withStakes.filter(r => r.stake < MIN_BET_SIZE);
  if (belowMin.length > 0) {
    log("info",
      `Skipping ${eventName} — ${belowMin.length} runner(s) below £${MIN_BET_SIZE} minimum: ${belowMin.map(r => `${r.runner.runnerName} £${r.stake.toFixed(2)}`).join(", ")}`,
    );
    void updateScheduleEntry(marketId, "SKIPPED", {
      skipReason: `${belowMin.length} runner(s) below Betfair's £${MIN_BET_SIZE} minimum stake`,
      runnerCount: eligible.length,
    });
    return;
  }

  const totalOutlay = dutchConfig.totalOutlay;
  const summary = withStakes
    .map(r => `${r.runner.runnerName} £${r.stake.toFixed(2)} @ ${r.backPrice}`)
    .join(" | ");

  log("info",
    `BACKING (DUTCH) ${withStakes.length}/${ranked.length} runners in ${eventName} — outlay £${totalOutlay.toFixed(2)} · target profit +£${targetProfit.toFixed(2)}${paperTrading ? " [PAPER]" : ""}`,
    { marketId, totalOutlay, cutoff, targetProfit: Math.round(targetProfit * 100) / 100, summary },
  );

  // Snapshot the full field (all active runners) so settled races can still show it
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

  for (const r of withStakes) {
    const reasoning =
      `[DUTCH] BACK £${r.stake.toFixed(2)} @ ${r.backPrice} · vol share ${(r.volPct * 100).toFixed(1)}% · target profit +£${targetProfit.toFixed(2)}||FIELD:${fullFieldJson}`;

    const potentialProfit = Math.round((r.stake * (r.backPrice - 1)) * 100) / 100;

    if (paperTrading) {
      await db.insert(betsTable).values({
        strategyId: null,
        strategyName: DUTCH_STRATEGY_NAME,
        marketId,
        marketName,
        eventName,
        selectionId: r.runner.selectionId,
        selectionName: r.runner.runnerName,
        betType: "BACK",
        requestedOdds: r.backPrice.toFixed(2),
        matchedOdds: r.backPrice.toFixed(2),
        stakeAmount: r.stake.toFixed(2),
        potentialProfit: potentialProfit.toFixed(2),
        status: "MATCHED",
        aiReasoning: reasoning,
        betId: `DUTCH-PAPER-${Date.now()}-${r.runner.selectionId}`,
      });
    } else {
      const result = await placeBet({
        marketId,
        selectionId: r.runner.selectionId,
        betType: "BACK",
        price: r.backPrice,
        size: r.stake,
      });
      await db.insert(betsTable).values({
        strategyId: null,
        strategyName: DUTCH_STRATEGY_NAME,
        marketId,
        marketName,
        eventName,
        selectionId: r.runner.selectionId,
        selectionName: r.runner.runnerName,
        betType: "BACK",
        requestedOdds: r.backPrice.toFixed(2),
        stakeAmount: r.stake.toFixed(2),
        potentialProfit: potentialProfit.toFixed(2),
        status: result.status === "PLACED" ? "PLACED" : "CANCELLED",
        aiReasoning: reasoning,
        betId: result.betId ?? `DUTCH-${Date.now()}-${r.runner.selectionId}`,
      });
    }
  }
  // Mark race as bet-placed in the schedule
  void updateScheduleEntry(marketId, "BET_PLACED", { runnerCount: withStakes.length });
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

    // Apply same static filters as the betting cycle (name-based only — runner counts
    // are filled in later when the bot processes each race within its 5-min window)
    const filtered = markets.filter(m => {
      if (NON_WIN_PATTERN.test(m.marketName)) return false;
      if (dutchConfig.skipChases && CHASE_PATTERN.test(m.marketName)) return false;
      if (dutchConfig.skipAwSevenFurlong && SEVEN_FURLONG_PATTERN.test(m.marketName) && AW_VENUE_PATTERN.test(m.eventName)) return false;
      // Only today's races (UTC date)
      const raceDate = new Date(m.marketStartTime).toISOString().slice(0, 10);
      return raceDate === today;
    });

    const filteredIds = new Set(filtered.map(m => m.marketId));

    // Delete any SCHEDULED rows for today that are no longer in the valid filtered set
    // (e.g. filter pattern was updated, or Betfair reclassified the market)
    await db.delete(dutchScheduleTable)
      .where(
        sql`${dutchScheduleTable.scheduledDate} = ${today}
          AND ${dutchScheduleTable.status} = 'SCHEDULED'
          AND ${dutchScheduleTable.marketId} NOT IN (${sql.join(
            filtered.length ? filtered.map(m => sql`${m.marketId}`) : [sql`''`],
            sql`, `
          )})`
      );

    // Fetch remaining entries to avoid re-inserting already-processed races
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
  log("info", "Dutch Bot started");
  void scheduleNextCycle();
  dutchSettlementInterval = setInterval(() => { void runDutchSettlement(); }, 2 * 60_000);
  // Run an immediate schedule scan then refresh every hour
  void runScheduleScan();
  dutchScanInterval = setInterval(() => { void runScheduleScan(); }, 60 * 60_000);
}

export async function stopDutchBot(): Promise<void> {
  if (!dutchBotRunning) return;
  dutchBotRunning = false;
  dutchStartedAt = null;
  if (dutchBotInterval)     { clearTimeout(dutchBotInterval);      dutchBotInterval     = null; }
  if (dutchSettlementInterval) { clearInterval(dutchSettlementInterval); dutchSettlementInterval = null; }
  if (dutchScanInterval)    { clearInterval(dutchScanInterval);    dutchScanInterval    = null; }
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

    for (const [marketId, bets] of byMarket) {
      const { getMarketSettlement } = await import("./betfair");
      const settlement = await getMarketSettlement(marketId);
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
        // Fallback: check if it's one of our backed runners
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

        const actualProfit = selectionWon
          ?   stake * (odds - 1)
          : -(stake);

        raceNet += actualProfit;

        // Append winner tag so the race detail page can always show who won
        const winnerTag = winnerName ? `||WINNER:${winnerName}` : "";
        const baseReasoning = (bet.aiReasoning ?? "").replace(/\|\|WINNER:[^|]*$/, "");

        await db.update(betsTable).set({
          status: selectionWon ? "WON" : "LOST",
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
