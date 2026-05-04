import { logger } from "./logger";
import { db, strategiesTable, betsTable, botConfigTable, botLogsTable, raceRunnersTable, aiInsightsTable } from "@workspace/db";
import { eq, gte, sql, desc } from "drizzle-orm";
import {
  getSession,
  listMarkets,
  getMarketDetail,
  getMarketSettlement,
  placeBet,
  loginWithEnvCredentials,
} from "./betfair";
import type { BetfairMarketDetail, BetfairRunner } from "./betfair";
import OpenAI from "openai";

async function getAIClient(model: string): Promise<OpenAI> {
  if (model.startsWith("grok-")) {
    let apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      const [config] = await db.select({ xaiApiKey: botConfigTable.xaiApiKey }).from(botConfigTable).limit(1);
      apiKey = config?.xaiApiKey ?? undefined;
    }
    if (!apiKey) throw new Error("xAI API key is not set. Add it in Settings → AI Provider.");
    return new OpenAI({ apiKey, baseURL: "https://api.x.ai/v1" });
  }
  if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) throw new Error("AI_INTEGRATIONS_OPENAI_API_KEY is not set.");
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  });
}

let botInterval: NodeJS.Timeout | null = null;
let settlementInterval: NodeJS.Timeout | null = null;
let botRunning = false;
let startedAt: Date | null = null;

// In-memory lock: markets currently being processed this cycle.
// Prevents two overlapping cycles from placing bets on the same market
// before the first cycle's DB inserts have completed.
const processingMarkets = new Set<string>();

export function isBotRunning(): boolean { return botRunning; }
export function getStartedAt(): Date | null { return startedAt; }

async function logBotActivity(level: string, message: string, metadata?: Record<string, unknown>): Promise<void> {
  await db.insert(botLogsTable).values({ level, message, metadata: metadata ? JSON.stringify(metadata) : null });
  logger.info({ level, message, metadata }, "Bot activity");
}

async function getBotConfig() {
  const [config] = await db.select().from(botConfigTable).limit(1);
  if (!config) {
    const [newConfig] = await db.insert(botConfigTable).values({}).returning();
    return newConfig;
  }
  return config;
}

// ─── Dutch Betting ──────────────────────────────────────────────────────────

interface DutchConfig {
  maxRunners: number;
  minLiquidity: number;
  minutesBeforeStart: number;
  countryCode: string;
  countryCodes: string[];
  excludeRaceTypes: string[];
  stakingMode: "equal" | "weighted";
}

function parseDutchConfig(marketFilter: string | null): DutchConfig {
  const defaults: DutchConfig = {
    maxRunners: 12,
    minLiquidity: 1000,
    minutesBeforeStart: 5,
    countryCode: "GB",
    countryCodes: ["GB", "IE"],
    excludeRaceTypes: [],
    stakingMode: "equal",
  };
  try {
    return { ...defaults, ...(JSON.parse(marketFilter ?? "{}") as Partial<DutchConfig>) };
  } catch {
    return defaults;
  }
}


async function runDutchStrategy(
  strategy: typeof strategiesTable.$inferSelect,
  config: typeof botConfigTable.$inferSelect
): Promise<void> {
  const dc = parseDutchConfig(strategy.marketFilter);
  const minFavOdds = Number(strategy.minOdds);   // 2/1 = 3.0
  const maxSelOdds = Number(strategy.maxOdds);    // 30/1 = 31.0
  const totalStake = Number(strategy.stakeAmount);

  const countries = dc.countryCodes?.length ? dc.countryCodes : [dc.countryCode];
  await logBotActivity("info", `[DUTCH] Cycle start — scanning horse racing (countries: ${countries.join(",")}), window: ±${dc.minutesBeforeStart} min`);

  let markets: Awaited<ReturnType<typeof listMarkets>> = [];
  try {
    markets = await listMarkets({
      eventTypeId: strategy.eventTypeId,
      countryCodes: countries,
      marketType: "WIN",
      limit: 30,
    });
  } catch (err) {
    await logBotActivity("error", `[DUTCH] Betfair API error fetching markets: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  await logBotActivity("info", `[DUTCH] Betfair returned ${markets.length} markets (next 4h, countries: ${countries.join(",")})`);

  if (markets.length === 0) {
    await logBotActivity("info", `[DUTCH] No horse racing markets found — check Betfair connection and that races are scheduled`);
    return;
  }

  const now = Date.now();

  // Only races starting within the timing window. Betfair sometimes returns
  // specialty markets (Forecast, TBP, Each Way, Match Bet, etc.) with
  // marketType WIN — exclude them all so we only bet on the main win market.
  // We check BOTH eventName and marketName since Betfair puts the descriptor
  // in different fields depending on the market type.
  const NON_WIN_PATTERN = /each.?way|forecast|\(f\/c\)|to be placed|\bTBP\b|match bet|daily win dist|without\s+\w|to win by|jockey.*champion|specials/i;
  const candidateMarkets = markets.filter(m => {
    const fullName = `${m.eventName} ${m.marketName}`;
    if (NON_WIN_PATTERN.test(fullName)) return false;
    const startMs = new Date(m.marketStartTime).getTime();
    const minsToStart = (startMs - now) / 60_000;
    return minsToStart >= 0 && minsToStart <= dc.minutesBeforeStart;
  });

  // Log all markets and whether they're in the window
  for (const m of markets) {
    const minsToStart = (new Date(m.marketStartTime).getTime() - now) / 60_000;
    const inWindow = minsToStart >= 0 && minsToStart <= dc.minutesBeforeStart;
    await logBotActivity("info",
      `[DUTCH] Market: ${m.eventName} — ${m.marketName} | Starts in ${minsToStart.toFixed(1)} min | ${inWindow ? "IN WINDOW ✓" : `outside ${dc.minutesBeforeStart}-min window`}`
    );
  }

  if (candidateMarkets.length === 0) {
    await logBotActivity("info", `[DUTCH] No races within the ${dc.minutesBeforeStart}-min window — waiting for next cycle`);
    return;
  }

  for (const market of candidateMarkets) {
    // ── In-memory lock: skip if another cycle is currently placing bets on this market ──
    if (processingMarkets.has(market.marketId)) {
      await logBotActivity("info", `[DUTCH] Skipping ${market.eventName} — already being processed by another cycle`);
      continue;
    }

    // ── DB check: skip if bets already exist for this market ──
    const [existing] = await db
      .select({ id: betsTable.id })
      .from(betsTable)
      .where(eq(betsTable.marketId, market.marketId))
      .limit(1);
    if (existing) {
      await logBotActivity("info", `[DUTCH] Skipping ${market.eventName} — already bet on this market`);
      continue;
    }

    // Claim the lock for this market — released in the finally block below
    processingMarkets.add(market.marketId);
    try {

    // ── Liquidity filter ──
    if (market.totalMatched < dc.minLiquidity) {
      await logBotActivity("info", `[DUTCH] Skipping ${market.eventName} — liquidity £${market.totalMatched.toFixed(0)} < £${dc.minLiquidity}`);
      continue;
    }

    // ── Race type filter (Novice / Maiden) ──
    const raceName = `${market.marketName} ${market.eventName}`.toUpperCase();
    const excluded = dc.excludeRaceTypes.find(t => raceName.includes(t.toUpperCase()));
    if (excluded) {
      await logBotActivity("info", `[DUTCH] Skipping ${market.eventName} — excluded race type "${excluded}"`);
      continue;
    }

    // Fetch market detail with up to 5 attempts (3s apart) to handle brief
    // Betfair API glitches where runners temporarily have no available price.
    let marketDetail = await getMarketDetail(market.marketId);
    if (!marketDetail) continue;

    let activeRunners = marketDetail.runners.filter(r => r.status === "ACTIVE" && r.bestBackPrice != null);
    const totalActiveInField = marketDetail.runners.filter(r => r.status === "ACTIVE").length;

    for (let attempt = 1; attempt < 5 && activeRunners.length < totalActiveInField; attempt++) {
      const missingPrices = totalActiveInField - activeRunners.length;
      await logBotActivity("info",
        `[DUTCH] ${market.eventName} — ${missingPrices} runner(s) have no price, retrying in 3s (attempt ${attempt}/4)...`
      );
      await new Promise(r => setTimeout(r, 3000));
      marketDetail = (await getMarketDetail(market.marketId)) ?? marketDetail;
      activeRunners = marketDetail.runners.filter(r => r.status === "ACTIVE" && r.bestBackPrice != null);
    }

    if (activeRunners.length === 0) continue;

    // ── Warn if we still have runners with no price after all retries ──
    if (activeRunners.length < totalActiveInField) {
      const missing = totalActiveInField - activeRunners.length;
      await logBotActivity("info",
        `[DUTCH] ⚠️ WARNING: ${market.eventName} — ${missing} runner(s) still have no back price after 4 retries. ` +
        `Proceeding with ${activeRunners.length}/${totalActiveInField} runners — missed runner(s) could win.`
      );
    }

    // ── Runner count filter ──
    if (activeRunners.length > dc.maxRunners) {
      await logBotActivity("info", `[DUTCH] Skipping ${market.eventName} — ${activeRunners.length} runners > max ${dc.maxRunners}`);
      continue;
    }

    // ── Too many big outsiders filter ──
    // If more than 3 runners are priced above 40/1 (41.0 decimal), skip the race
    const outsiders = activeRunners.filter(r => (r.bestBackPrice ?? 0) > 41.0);
    if (outsiders.length > 3) {
      await logBotActivity("info", `[DUTCH] Skipping ${market.eventName} — ${outsiders.length} runners over 40/1 (max 3 allowed)`);
      continue;
    }

    // ── Minimum favourite odds filter ──
    const sortedByOdds = [...activeRunners].sort((a, b) => (a.bestBackPrice ?? 999) - (b.bestBackPrice ?? 999));
    const favouriteOdds = sortedByOdds[0].bestBackPrice ?? 0;

    if (favouriteOdds < minFavOdds) {
      await logBotActivity("info", `[DUTCH] Skipping ${market.eventName} — favourite ${favouriteOdds} < min ${minFavOdds} (2/1)`);
      continue;
    }

    // ── Build qualifying selection list (odds within range) ──
    const qualifying: BetfairRunner[] = activeRunners.filter(
      r => (r.bestBackPrice ?? 0) >= Number(strategy.minOdds) && (r.bestBackPrice ?? 0) <= maxSelOdds
    );
    if (qualifying.length === 0) continue;

    // ── Runner selection ──────────────────────────────────────────────────────
    // weighted: back every qualifying runner — the formula naturally assigns
    //           tiny stakes to outsiders, so no overround trimming is needed.
    // equal:    greedy exclusion — drop longest-priced runners until book < 100%
    //           so the equal-return target is profitable on every winner.
    let selected: BetfairRunner[];
    let bookPct: number;
    const dropped: string[] = [];

    if (dc.stakingMode === "weighted") {
      // Cover ALL qualifying runners — never drop any.
      // Sort shortest → longest price.
      selected = [...qualifying].sort((a, b) => (a.bestBackPrice ?? 0) - (b.bestBackPrice ?? 0));
      bookPct = selected.reduce((s, r) => s + 1 / (r.bestBackPrice ?? 999), 0);
    } else {
      // Equal-return mode: trim outsiders until book is sub-100%
      const minCoverageCount = Math.ceil(activeRunners.length * 0.8);
      selected = [...qualifying].sort((a, b) => (b.bestBackPrice ?? 0) - (a.bestBackPrice ?? 0));
      bookPct = selected.reduce((s, r) => s + 1 / (r.bestBackPrice ?? 999), 0);
      while (bookPct >= 1.0 && selected.length > minCoverageCount) {
        const removed = selected.shift()!;
        dropped.push(`${removed.runnerName} (${removed.bestBackPrice})`);
        bookPct = selected.reduce((s, r) => s + 1 / (r.bestBackPrice ?? 999), 0);
      }
      if (bookPct >= 1.0) {
        await logBotActivity("info",
          `[DUTCH] Skipping ${market.eventName} — cannot get below 100% book while covering ≥80% of field ` +
          `(${selected.length}/${activeRunners.length} runners, book ${(bookPct * 100).toFixed(1)}%)`
        );
        continue;
      }
      if (dropped.length > 0) {
        await logBotActivity("info",
          `[DUTCH] ${market.eventName} — dropped ${dropped.length} outsider(s) to reach book ${(bookPct * 100).toFixed(1)}% ` +
          `(covering ${selected.length}/${activeRunners.length} = ${((selected.length / activeRunners.length) * 100).toFixed(0)}% of field): ${dropped.join(", ")}`
        );
      }
      // Sort selected shortest → longest for consistent downstream ordering
      selected.sort((a, b) => (a.bestBackPrice ?? 0) - (b.bestBackPrice ?? 0));
    }

    // ── Calculate stakes ──────────────────────────────────────────────────────
    // equal:    standard Dutch — every runner returns the same amount
    //           stake_i = (budget / bookPct) / odds_i
    // weighted: "profit-on-favourite" Dutch
    //   Step 1 — Allocate enough stake on the favourite to return (budget + FAV_PROFIT_PCT × budget)
    //            if it wins. This guarantees a profit whenever the shortest-priced runner wins.
    //   Step 2 — Distribute the remaining budget across all other runners proportional to 1/odds.
    //            This is equal-return Dutch for the outsiders, so every non-favourite winner
    //            produces the same known loss (predictable, symmetric downside).
    //   Result — No runners ever dropped. Overround markets are handled naturally: the favourite
    //            winning always profits; outsiders winning produce a small, fixed, equal loss.
    const FAV_PROFIT_PCT = 0.08; // target 8 % profit on total budget when favourite wins

    const fullCover = selected.length === activeRunners.length;
    const budget = fullCover ? totalStake * 2 : totalStake;

    interface ComputedStake { selectionId: number; runnerName: string; stake: number; odds: number; expectedProfit: number; }
    let computedStakes: ComputedStake[];

    if (dc.stakingMode === "weighted") {
      const oddsArr = selected.map(r => r.bestBackPrice ?? 1);
      const favOdds  = Math.min(...oddsArr);           // shortest price = favourite
      const favIndex = oddsArr.indexOf(favOdds);

      // Stake on favourite sized to return budget × (1 + FAV_PROFIT_PCT)
      const favStake = (budget * (1 + FAV_PROFIT_PCT)) / favOdds;

      // Remaining budget split equal-return across all other runners
      const remainingBudget = budget - favStake;
      const outsiderInvSum  = oddsArr.reduce((s, o, i) => i === favIndex ? s : s + 1 / o, 0);

      computedStakes = selected.map((r, i) => {
        const odds = oddsArr[i]!;
        const stake = i === favIndex
          ? parseFloat(favStake.toFixed(2))
          : parseFloat((remainingBudget * (1 / odds) / outsiderInvSum).toFixed(2));
        return {
          selectionId: r.selectionId,
          runnerName: r.runnerName,
          stake,
          odds,
          // Positive = profit when this runner wins; negative = loss
          expectedProfit: parseFloat((stake * odds - budget).toFixed(2)),
        };
      });
    } else {
      // equal-return (standard Dutch)
      const targetReturn = budget / bookPct;
      computedStakes = selected.map(r => {
        const odds = r.bestBackPrice ?? 1;
        const stake = parseFloat((targetReturn / odds).toFixed(2));
        return {
          selectionId: r.selectionId,
          runnerName: r.runnerName,
          stake,
          odds,
          expectedProfit: parseFloat((stake * odds - budget).toFixed(2)),
        };
      });
    }

    const totalStaked = computedStakes.reduce((s, r) => s + r.stake, 0);
    const minReturn = Math.min(...computedStakes.map(r => r.stake * r.odds));
    const maxReturn = Math.max(...computedStakes.map(r => r.stake * r.odds));

    const returnDesc = dc.stakingMode === "weighted"
      ? `returns £${minReturn.toFixed(2)}–£${maxReturn.toFixed(2)} (profit £${(minReturn - totalStaked).toFixed(2)} to £${(maxReturn - totalStaked).toFixed(2)})`
      : `guaranteed return £${minReturn.toFixed(2)} (profit £${(minReturn - totalStaked).toFixed(2)})`;

    await logBotActivity("info",
      `[DUTCH${dc.stakingMode === "weighted" ? "/WEIGHTED" : ""}] ${market.eventName} — ${selected.length} runners backed, book ${(bookPct * 100).toFixed(1)}%, ` +
      `total stake £${totalStaked.toFixed(2)}, ${returnDesc}`
    );

    // ── Record all runners (included + excluded) for race history ──
    const selectedIds = new Set(selected.map(r => r.selectionId));
    const droppedIds = new Set(dropped.map(name => {
      const match = qualifying.find(r => name.startsWith(r.runnerName));
      return match?.selectionId;
    }).filter(Boolean));
    const allRunners = marketDetail.runners.map(r => ({
      marketId: market.marketId,
      marketName: market.marketName,
      eventName: market.eventName,
      selectionId: r.selectionId,
      runnerName: r.runnerName,
      bestBackPrice: r.bestBackPrice != null ? String(r.bestBackPrice) : null,
      status: r.status ?? "ACTIVE",
      included: selectedIds.has(r.selectionId),
      excludeReason: r.status !== "ACTIVE"
        ? "Non-runner / withdrawn"
        : r.bestBackPrice == null
          ? "No price available"
          : (r.bestBackPrice ?? 0) < Number(strategy.minOdds)
            ? `Odds too short (${r.bestBackPrice} < ${strategy.minOdds})`
            : (r.bestBackPrice ?? 0) > maxSelOdds
              ? `Odds too big (${r.bestBackPrice} > ${maxSelOdds})`
              : droppedIds.has(r.selectionId)
                ? `Dropped to achieve sub-100% book (${r.bestBackPrice})`
                : null,
    }));
    try {
      await db.insert(raceRunnersTable).values(allRunners).onConflictDoNothing();
    } catch { /* non-fatal */ }

    // ── AI: validate the race only (approve / reject) ──
    const runnerList = selected
      .map(r => `  • ${r.runnerName}: ${r.bestBackPrice} (stake £${computedStakes.find(s => s.selectionId === r.selectionId)?.stake.toFixed(2)})`)
      .join("\n");

    const marketContext = `
Dutch Bet Opportunity — Horse Racing
Race: ${marketDetail.eventName} — ${marketDetail.marketName}
Country: ${market.countryCode ?? "Unknown"}  |  Total Runners: ${activeRunners.length}  |  Backed: ${selected.length}
Liquidity: £${marketDetail.totalMatched.toFixed(0)}  |  Starts in: ${((new Date(market.marketStartTime).getTime() - now) / 60_000).toFixed(1)} min
Favourite odds: ${favouriteOdds} (${sortedByOdds[0].runnerName})
Book: ${(bookPct * 100).toFixed(1)}%  |  Staking: ${dc.stakingMode === "weighted" ? `weighted (£${minReturn.toFixed(2)}–£${maxReturn.toFixed(2)} return range)` : `equal return £${minReturn.toFixed(2)}`} on £${totalStaked.toFixed(2)} staked
${dropped.length > 0 ? `Dropped (overround): ${dropped.join(", ")}` : "Full field covered"}

Runners being backed:
${runnerList}
    `.trim();

    const countryList = countries.join(", ");
    const systemPrompt = strategy.aiPrompt ??
      `You are a horse racing dutching specialist covering ${countryList} racing. Approve solid opportunities on reputable tracks in any of these countries.`;

    const userMessage = `
You have been given a potential dutch betting opportunity. The stakes have already been calculated — your ONLY job is to validate the race itself.

Approve if: reputable track in ${countryList}${countries.some(c => ["GB","IE"].includes(c)) && countries.every(c => ["GB","IE"].includes(c)) ? ", NOT a Novice/Maiden/Bumper/NH Flat race" : countries.some(c => ["GB","IE"].includes(c)) ? ". For GB/IE races reject Novice/Bumper/NH Flat types only" : ". US, Australian and Irish tracks are all valid"}.

Reply with JSON ONLY:
{
  "approved": boolean,
  "reasoning": string
}

Market data:
${marketContext}
    `.trim();

    interface AiDutchResponse { approved: boolean; reasoning: string; }

    let aiResponse: AiDutchResponse = { approved: false, reasoning: "AI not called" };
    try {
      const aiClient = await getAIClient(strategy.aiModel);
      const response = await aiClient.chat.completions.create({
        model: strategy.aiModel,
        max_completion_tokens: 200,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      });
      const raw = response.choices[0]?.message?.content ?? "{}";
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) aiResponse = JSON.parse(match[0]);
    } catch (err) {
      aiResponse.reasoning = `AI error: ${err instanceof Error ? err.message : "Unknown"}`;
    }

    if (!aiResponse.approved) {
      await logBotActivity("info", `[DUTCH] AI rejected ${market.eventName}: ${aiResponse.reasoning}`);
      continue;
    }

    // ── Place bets ──
    const dutchGroupId = `DUTCH-${market.marketId}-${Date.now()}`;
    const profitPerWinner = dc.stakingMode === "weighted"
      ? `£${(minReturn - totalStaked).toFixed(2)}–£${(maxReturn - totalStaked).toFixed(2)}`
      : `£${(minReturn - totalStaked).toFixed(2)}`;

    if (config.paperTradingMode) {
      let unmatchedCount = 0;
      for (const r of computedStakes) {
        const runner = selected.find(q => q.selectionId === r.selectionId);
        if (!runner) continue;

        const availableSize = runner.bestBackSize ?? 0;
        const wouldMatch = availableSize >= r.stake;
        if (!wouldMatch) {
          unmatchedCount++;
          await logBotActivity("info",
            `[DUTCH][PAPER] ${runner.runnerName} — only £${availableSize.toFixed(2)} available at ${r.odds}, stake £${r.stake.toFixed(2)} would NOT fully match`
          );
        }

        await db.insert(betsTable).values({
          strategyId: strategy.id,
          strategyName: strategy.name,
          marketId: market.marketId,
          marketName: marketDetail.marketName,
          eventName: marketDetail.eventName,
          selectionId: runner.selectionId,
          selectionName: runner.runnerName,
          betType: "BACK",
          requestedOdds: r.odds.toString(),
          matchedOdds: r.odds.toString(),
          stakeAmount: r.stake.toString(),
          potentialProfit: r.expectedProfit.toFixed(2),
          status: wouldMatch ? "MATCHED" : "UNMATCHED",
          aiReasoning: `[DUTCH] ${aiResponse.reasoning} | Group: ${dutchGroupId}${!wouldMatch ? ` | UNMATCHED — only £${availableSize.toFixed(2)} available at ${r.odds}` : ""}`,
          betId: `${dutchGroupId}-${runner.selectionId}`,
        });
      }
      const matchNote = unmatchedCount > 0 ? ` (⚠️ ${unmatchedCount} unmatched — insufficient volume)` : "";
      await logBotActivity("info",
        `[DUTCH][PAPER] ${computedStakes.length} bets on ${marketDetail.eventName} — total £${totalStaked.toFixed(2)}, profit if any wins ${profitPerWinner}${matchNote}`,
        { race: market.eventName, selections: computedStakes.length, totalStaked, profitPerWinner, reasoning: aiResponse.reasoning }
      );
    } else {
      for (const r of computedStakes) {
        const runner = selected.find(q => q.selectionId === r.selectionId);
        if (!runner) continue;
        const result = await placeBet({
          marketId: market.marketId,
          selectionId: runner.selectionId,
          betType: "BACK",
          price: r.odds,
          size: r.stake,
        });
        await db.insert(betsTable).values({
          strategyId: strategy.id,
          strategyName: strategy.name,
          marketId: market.marketId,
          marketName: marketDetail.marketName,
          eventName: marketDetail.eventName,
          selectionId: runner.selectionId,
          selectionName: runner.runnerName,
          betType: "BACK",
          requestedOdds: r.odds.toString(),
          stakeAmount: r.stake.toString(),
          potentialProfit: r.expectedProfit.toFixed(2),
          status: result.status === "PLACED" ? "PLACED" : "CANCELLED",
          aiReasoning: `[DUTCH] ${aiResponse.reasoning} | Group: ${dutchGroupId}`,
          betId: result.betId ?? `${dutchGroupId}-${runner.selectionId}`,
        });
        if (result.status !== "PLACED") {
          await logBotActivity("error", `[DUTCH] Failed to place on ${runner.runnerName}: ${result.error}`);
        }
      }
      await logBotActivity("info",
        `[DUTCH] ${computedStakes.length} live bets on ${marketDetail.eventName} — total £${totalStaked.toFixed(2)}, profit if any wins ${profitPerWinner}`,
        { race: market.eventName, selections: computedStakes.length, totalStaked, profitPerWinner }
      );
    }

    } finally {
      // Always release the in-memory lock so future cycles don't get stuck
      processingMarkets.delete(market.marketId);
    }
  }
}

// ─── Standard Single-Bet Cycle ───────────────────────────────────────────────

async function runBotCycle(): Promise<void> {
  try {
    const config = await getBotConfig();

    if (!config.isRunning) { stopBot(); return; }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Daily loss check: use net P&L across all settled bets today.
    // Dutch betting naturally has many small losing bets — we care about the
    // overall net, not the sum of individual losing stakes.
    const [todayBets] = await db
      .select({ netProfit: sql<number>`coalesce(sum(actual_profit), 0)` })
      .from(betsTable)
      .where(gte(betsTable.placedAt, todayStart));

    const todayNetProfit = Number(todayBets?.netProfit ?? 0);
    const dailyLossLimit = Number(config.dailyLossLimit);

    if (todayNetProfit <= -dailyLossLimit) {
      await logBotActivity("warn", `Daily loss limit reached: net P&L £${todayNetProfit.toFixed(2)} / limit -£${dailyLossLimit.toFixed(2)}. Bot paused.`);
      await db.update(botConfigTable).set({ isRunning: false }).where(eq(botConfigTable.id, config.id));
      stopBot();
      return;
    }

    const pendingBets = await db.select().from(betsTable).where(eq(betsTable.status, "PLACED"));
    if (pendingBets.length >= config.maxConcurrentBets) {
      await logBotActivity("info", `Max concurrent bets reached (${pendingBets.length}/${config.maxConcurrentBets}). Waiting.`);
      return;
    }

    const strategies = await db.select().from(strategiesTable).where(eq(strategiesTable.isActive, true));
    if (strategies.length === 0) { await logBotActivity("info", "No active strategies found."); return; }

    const session = getSession();
    if (!session) {
      await logBotActivity("warn", "Not connected to Betfair. Attempting auto-connect.");
      const loginResult = await loginWithEnvCredentials();
      if (!loginResult.success) {
        await logBotActivity("error", `Auto-connect failed: ${loginResult.error}`);
        return;
      }
    }

    for (const strategy of strategies) {
      // ── Route DUTCH strategies to dedicated handler ──
      if (strategy.betType === "DUTCH") {
        await runDutchStrategy(strategy, config);
        continue;
      }

      // ── Standard single-bet logic ──
      const markets = await listMarkets({ eventTypeId: strategy.eventTypeId, limit: 5 });
      if (markets.length === 0) continue;

      const targetMarket = markets[0];
      const marketDetail = await getMarketDetail(targetMarket.marketId);
      if (!marketDetail || marketDetail.runners.length === 0) continue;

      const eligibleRunners = marketDetail.runners.filter(r => {
        const odds = r.bestBackPrice;
        if (!odds) return false;
        return odds >= Number(strategy.minOdds) && odds <= Number(strategy.maxOdds) && r.status === "ACTIVE";
      });
      if (eligibleRunners.length === 0) continue;

      const marketContext = `
Market: ${marketDetail.eventName} - ${marketDetail.marketName}
Start Time: ${marketDetail.marketStartTime}
Total Matched: £${marketDetail.totalMatched.toFixed(0)}
Runners:
${eligibleRunners.map(r => `  - ${r.runnerName}: Back ${r.bestBackPrice}, Lay ${r.bestLayPrice}`).join("\n")}
      `.trim();

      const systemPrompt = strategy.aiPrompt ??
        "You are an expert Betfair exchange bettor. Analyze the given market and decide whether to place a bet. Be selective — only bet when you have high confidence.";

      let aiDecision: { shouldBet: boolean; selectionName?: string; reasoning: string; confidence?: number } =
        { shouldBet: false, reasoning: "Not called" };

      try {
        const aiClient = await getAIClient(strategy.aiModel);
        const response = await aiClient.chat.completions.create({
          model: strategy.aiModel,
          max_completion_tokens: 500,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Analyze this Betfair market and decide whether to place a ${strategy.betType} bet.\n\n${marketContext}\n\nRespond with JSON: { "shouldBet": boolean, "selectionName": string | null, "reasoning": string, "confidence": number (0-1) }`,
            },
          ],
        });
        const raw = response.choices[0]?.message?.content ?? "{}";
        const match = raw.match(/\{[\s\S]*\}/);
        aiDecision = match ? JSON.parse(match[0]) : { shouldBet: false, reasoning: "Could not parse AI response" };
      } catch (err) {
        aiDecision = { shouldBet: false, reasoning: `AI error: ${err instanceof Error ? err.message : "Unknown"}` };
      }

      if (!aiDecision.shouldBet) {
        await logBotActivity("info", `AI decided not to bet on ${targetMarket.eventName}`, {
          reasoning: aiDecision.reasoning,
          strategy: strategy.name,
        });
        continue;
      }

      const targetRunner = eligibleRunners.find(r => r.runnerName === aiDecision.selectionName) ?? eligibleRunners[0];
      if (!targetRunner?.bestBackPrice) continue;

      const stakeAmount = Number(strategy.stakeAmount);
      const odds = targetRunner.bestBackPrice;
      const potentialProfit = stakeAmount * (odds - 1);

      if (config.paperTradingMode) {
        await db.insert(betsTable).values({
          strategyId: strategy.id,
          strategyName: strategy.name,
          marketId: targetMarket.marketId,
          marketName: marketDetail.marketName,
          eventName: marketDetail.eventName,
          selectionId: targetRunner.selectionId,
          selectionName: targetRunner.runnerName,
          betType: strategy.betType,
          requestedOdds: odds.toString(),
          matchedOdds: odds.toString(),
          stakeAmount: stakeAmount.toString(),
          potentialProfit: potentialProfit.toFixed(2),
          status: "MATCHED",
          aiReasoning: aiDecision.reasoning,
          betId: `PAPER-${Date.now()}`,
        });
        await logBotActivity("info", `[PAPER] ${strategy.betType}: ${targetRunner.runnerName} @ ${odds} (£${stakeAmount})`, {
          market: targetMarket.eventName,
          reasoning: aiDecision.reasoning,
        });
      } else {
        const betResult = await placeBet({
          marketId: targetMarket.marketId,
          selectionId: targetRunner.selectionId,
          betType: strategy.betType as "BACK" | "LAY",
          price: odds,
          size: stakeAmount,
        });
        await db.insert(betsTable).values({
          strategyId: strategy.id,
          strategyName: strategy.name,
          marketId: targetMarket.marketId,
          marketName: marketDetail.marketName,
          eventName: marketDetail.eventName,
          selectionId: targetRunner.selectionId,
          selectionName: targetRunner.runnerName,
          betType: strategy.betType,
          requestedOdds: odds.toString(),
          stakeAmount: stakeAmount.toString(),
          potentialProfit: potentialProfit.toFixed(2),
          status: betResult.status === "PLACED" ? "PLACED" : "CANCELLED",
          aiReasoning: aiDecision.reasoning,
          betId: betResult.betId,
        });
        if (betResult.status === "PLACED") {
          await logBotActivity("info", `${strategy.betType}: ${targetRunner.runnerName} @ ${odds} (£${stakeAmount})`, {
            betId: betResult.betId, market: targetMarket.eventName,
          });
        } else {
          await logBotActivity("error", `Bet failed: ${betResult.error}`, {
            market: targetMarket.eventName, selection: targetRunner.runnerName,
          });
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "Bot cycle error");
    await logBotActivity("error", `Bot cycle error: ${err instanceof Error ? err.message : "Unknown error"}`);
  }
}

async function runSettlementCheck(): Promise<void> {
  if (!getSession()) return;

  try {
    // Find all unsettled bets from the last 48 hours
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const unsettledBets = await db
      .select()
      .from(betsTable)
      .where(
        sql`${betsTable.status} IN ('MATCHED','PLACED','UNMATCHED') AND ${betsTable.placedAt} >= ${cutoff}`
      );

    if (unsettledBets.length === 0) return;

    // Group by marketId
    const byMarket = new Map<string, typeof unsettledBets>();
    for (const bet of unsettledBets) {
      const list = byMarket.get(bet.marketId) ?? [];
      list.push(bet);
      byMarket.set(bet.marketId, list);
    }

    for (const [marketId, bets] of byMarket) {
      const settlement = await getMarketSettlement(marketId);
      if (!settlement?.settled) continue;

      const winnerSelectionId = settlement.winnerSelectionId;
      const settledAt = new Date();

      for (const bet of bets) {
        // UNMATCHED bets were never placed — mark as VOID (no P&L impact)
        if (bet.status === "UNMATCHED") {
          await db
            .update(betsTable)
            .set({ status: "VOID", actualProfit: "0", settledAt })
            .where(eq(betsTable.id, bet.id));
          continue;
        }

        const won = bet.selectionId === winnerSelectionId;
        // For the winner: profit = stake * (odds - 1)  — the per-bet P&L
        // Summing across all bets gives the correct Dutch net: stake_w*odds_w - totalStaked
        const odds = Number(bet.matchedOdds ?? bet.requestedOdds);
        const actualProfit = won
          ? Number(bet.stakeAmount) * (odds - 1)
          : -Number(bet.stakeAmount);

        await db
          .update(betsTable)
          .set({
            status: won ? "WON" : "LOST",
            actualProfit: actualProfit.toFixed(2),
            settledAt,
          })
          .where(eq(betsTable.id, bet.id));
      }

      const winnerBet = bets.find(b => b.selectionId === winnerSelectionId);
      const totalStaked = bets.reduce((s, b) => s + Number(b.stakeAmount), 0);
      if (winnerBet) {
        const winOdds = Number(winnerBet.matchedOdds ?? winnerBet.requestedOdds);
        const winnerStake = Number(winnerBet.stakeAmount);
        const netProfit = winnerStake * (winOdds - 1) - (totalStaked - winnerStake);
        await logBotActivity("info",
          `[SETTLED] ${winnerBet.eventName} — WINNER: ${winnerBet.selectionName} @ ${winOdds} | Net: ${netProfit >= 0 ? "+" : ""}£${netProfit.toFixed(2)}`,
          { marketId, totalStaked: totalStaked.toFixed(2), netProfit: netProfit.toFixed(2) }
        );
      } else {
        await logBotActivity("info",
          `[SETTLED] ${bets[0]?.eventName} — no backed horse won, lost £${totalStaked.toFixed(2)}`,
          { marketId }
        );
      }

      // After each settlement, give the AI a chance to review and tweak the strategy
      const [activeStrategy] = await db
        .select()
        .from(strategiesTable)
        .where(eq(strategiesTable.isActive, true))
        .limit(1);
      if (activeStrategy) void runAIStrategyReview(activeStrategy);
    }
  } catch (err) {
    logger.error({ err }, "Settlement check error");
  }
}

// ── AI Knowledge Base Strategy Advisor ───────────────────────────────────────
// After each race settles, the AI writes an observation to ai_insights (stored
// permanently in the DB). On the next review it reads ALL previous observations
// plus full historical aggregates, building genuine cumulative knowledge.

let lastStrategyReviewAt: Date | null = null;
const STRATEGY_REVIEW_COOLDOWN_MS = 30 * 60 * 1000; // at most once per 30 min

async function runAIStrategyReview(
  strategy: typeof strategiesTable.$inferSelect
): Promise<void> {
  if (
    lastStrategyReviewAt &&
    Date.now() - lastStrategyReviewAt.getTime() < STRATEGY_REVIEW_COOLDOWN_MS
  ) return;

  // ── Pull ALL settled bets (full history, not just today) ──────────────────
  const allSettled = await db
    .select()
    .from(betsTable)
    .where(sql`${betsTable.status} IN ('WON','LOST')`)
    .orderBy(desc(betsTable.settledAt));

  const byMarket = new Map<string, typeof allSettled>();
  for (const bet of allSettled) {
    const list = byMarket.get(bet.marketId) ?? [];
    list.push(bet);
    byMarket.set(bet.marketId, list);
  }
  const allRaces = [...byMarket.values()];
  if (allRaces.length < 3) return;

  lastStrategyReviewAt = new Date();

  const dc = parseDutchConfig(strategy.marketFilter);

  // ── Aggregate stats across ALL races ─────────────────────────────────────
  let totalNetProfit = 0;
  let racesWon = 0;
  const oddsRangeBuckets: Record<string, { races: number; won: number; profit: number }> = {
    "3-7":   { races: 0, won: 0, profit: 0 },
    "7-15":  { races: 0, won: 0, profit: 0 },
    "15-30": { races: 0, won: 0, profit: 0 },
    "30+":   { races: 0, won: 0, profit: 0 },
  };
  const countryBuckets: Record<string, { races: number; profit: number }> = {};
  const runnerCountBuckets: Record<string, { races: number; profit: number }> = {};

  for (const bets of allRaces) {
    const winner = bets.find(b => b.status === "WON");
    const netProfit = bets.reduce((s, b) => s + Number(b.actualProfit ?? 0), 0);
    totalNetProfit += netProfit;

    const shortestOdds = Math.min(...bets.map(b => Number(b.requestedOdds)));
    const bucket = shortestOdds < 7 ? "3-7" : shortestOdds < 15 ? "7-15" : shortestOdds < 30 ? "15-30" : "30+";
    oddsRangeBuckets[bucket]!.races++;
    oddsRangeBuckets[bucket]!.profit += netProfit;

    if (winner) {
      racesWon++;
      const wo = Number(winner.matchedOdds ?? winner.requestedOdds);
      const wb = wo < 7 ? "3-7" : wo < 15 ? "7-15" : wo < 30 ? "15-30" : "30+";
      oddsRangeBuckets[wb]!.won++;
    }

    const eventName = bets[0]?.eventName ?? "";
    const country = /\(AUS\)/i.test(eventName) ? "AU"
      : /\(USA\)/i.test(eventName) ? "US"
      : /(curragh|leopardstown|naas|punchestown|galway|cork|fairyhouse|down royal)/i.test(eventName) ? "IE"
      : "GB";
    countryBuckets[country] = countryBuckets[country] ?? { races: 0, profit: 0 };
    countryBuckets[country]!.races++;
    countryBuckets[country]!.profit += netProfit;

    const rc = bets.length <= 6 ? "5-6" : bets.length <= 9 ? "7-9" : "10+";
    runnerCountBuckets[rc] = runnerCountBuckets[rc] ?? { races: 0, profit: 0 };
    runnerCountBuckets[rc]!.races++;
    runnerCountBuckets[rc]!.profit += netProfit;
  }

  const winRate = ((racesWon / allRaces.length) * 100).toFixed(1);
  const avgProfit = (totalNetProfit / allRaces.length).toFixed(2);

  const bucketLines = Object.entries(oddsRangeBuckets)
    .filter(([, v]) => v.races > 0)
    .map(([range, v]) =>
      `  fav odds ${range}: ${v.races} races, ${v.won} won (${((v.won/v.races)*100).toFixed(0)}%), P&L £${v.profit.toFixed(2)}`
    ).join("\n");

  const countryLines = Object.entries(countryBuckets)
    .filter(([, v]) => v.races > 0)
    .map(([c, v]) => `  ${c}: ${v.races} races, P&L £${v.profit.toFixed(2)}`)
    .join("\n");

  const runnerLines = Object.entries(runnerCountBuckets)
    .filter(([, v]) => v.races > 0)
    .map(([r, v]) => `  ${r} runners backed: ${v.races} races, P&L £${v.profit.toFixed(2)}`)
    .join("\n");

  const recentRaces = allRaces.slice(0, 5).map(bets => {
    const winner = bets.find(b => b.status === "WON");
    const netProfit = bets.reduce((s, b) => s + Number(b.actualProfit ?? 0), 0);
    const winnerOdds = winner ? Number(winner.matchedOdds ?? winner.requestedOdds) : null;
    return `  ${bets[0]?.eventName ?? "?"}: ${bets.length} runners, winner ${winner ? `backed @ ${winnerOdds}` : "NOT backed"}, P&L £${netProfit.toFixed(2)}`;
  }).join("\n");

  // ── Load all previous AI observations ────────────────────────────────────
  const existingInsights = await db
    .select()
    .from(aiInsightsTable)
    .orderBy(desc(aiInsightsTable.createdAt))
    .limit(30);

  const insightsText = existingInsights.length > 0
    ? existingInsights.map(i =>
        `[${new Date(i.createdAt).toLocaleDateString("en-GB")} after ${i.racesProcessed} races | P&L £${i.runningNetProfit ?? "?"}] ${i.content}`
      ).join("\n")
    : "No previous observations yet — this is the first review.";

  // ── Build prompt ──────────────────────────────────────────────────────────
  const prompt = `You are an adaptive horse racing Dutch betting strategy optimizer with persistent memory. You have access to your full history of observations. Study them carefully — your job is to build understanding over time, not react to single races.

═══ CURRENT PARAMETERS ═══
minOdds: ${strategy.minOdds}  |  maxOdds: ${strategy.maxOdds}  |  maxRunners: ${dc.maxRunners}  |  minLiquidity: £${dc.minLiquidity}

═══ ALL-TIME PERFORMANCE (${allRaces.length} races total) ═══
Win rate (we backed the winner): ${winRate}%
Average P&L per race: £${avgProfit}
Total net P&L: £${totalNetProfit.toFixed(2)}

By favourite odds range:
${bucketLines}

By country:
${countryLines}

By runners backed per race:
${runnerLines}

═══ 5 MOST RECENT RACES ═══
${recentRaces}

═══ YOUR KNOWLEDGE BASE (all previous observations, oldest last) ═══
${insightsText}

═══ INSTRUCTIONS ═══
1. Write ONE observation (2-4 sentences) summarising what you now believe about this strategy's performance. Reference specific patterns you see in the data. This will be added permanently to your knowledge base and shown to you in every future review.
2. If the aggregate data (not just recent races) shows a clear, consistent opportunity to improve, suggest ONE parameter adjustment. Otherwise leave parameters unchanged.

Guardrails:
- Max ±0.5 per review for minOdds/maxOdds | max ±2 for maxRunners | max ±100 for minLiquidity
- Bounds: minOdds 2.0-6.0 | maxOdds 15.0-51.0 | maxRunners 5-16 | minLiquidity 200-2000
- Positive overall P&L = strong signal NOT to change things

Respond ONLY with valid JSON:
{
  "observation": "<your 2-4 sentence knowledge base entry>",
  "minOdds": <number>,
  "maxOdds": <number>,
  "maxRunners": <integer>,
  "minLiquidity": <number>,
  "adjustmentReason": "<one sentence on what changed and why, or 'No adjustment — evidence does not support changes yet'>"
}`;

  try {
    const ai = await getAIClient("grok-3-mini");
    const response = await ai.chat.completions.create({
      model: "grok-3-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });

    const content = response.choices[0]?.message?.content ?? "";
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      await logBotActivity("warn", "[AI-KNOWLEDGE] Could not parse AI response — skipping");
      return;
    }

    const adj = JSON.parse(match[0]) as {
      observation: string;
      minOdds: number; maxOdds: number; maxRunners: number; minLiquidity: number;
      adjustmentReason: string;
    };

    // ── Store the new observation permanently ─────────────────────────────
    await db.insert(aiInsightsTable).values({
      category: "race_observation",
      content: adj.observation,
      racesProcessed: allRaces.length,
      runningNetProfit: totalNetProfit.toFixed(2),
      metadata: {
        winRate,
        avgProfit,
        paramsAtTime: {
          minOdds: Number(strategy.minOdds),
          maxOdds: Number(strategy.maxOdds),
          maxRunners: dc.maxRunners,
          minLiquidity: dc.minLiquidity,
        },
      },
    });

    // ── Apply parameter adjustments with guardrails ───────────────────────
    const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
    const capChange = (next: number, curr: number, maxDelta: number) =>
      Math.min(Math.max(next, curr - maxDelta), curr + maxDelta);

    const safeMinOdds      = parseFloat(capChange(clamp(Number(adj.minOdds),  2.0,   6.0), Number(strategy.minOdds), 0.5).toFixed(2));
    const safeMaxOdds      = parseFloat(capChange(clamp(Number(adj.maxOdds), 15.0,  51.0), Number(strategy.maxOdds), 0.5).toFixed(2));
    const safeMaxRunners   = Math.round(capChange(clamp(Number(adj.maxRunners),    5,   16), dc.maxRunners,   2));
    const safeMinLiquidity = Math.round(capChange(clamp(Number(adj.minLiquidity), 200, 2000), dc.minLiquidity, 100));

    const changes: string[] = [];
    if (safeMinOdds      !== Number(strategy.minOdds))  changes.push(`minOdds ${Number(strategy.minOdds).toFixed(2)}→${safeMinOdds}`);
    if (safeMaxOdds      !== Number(strategy.maxOdds))  changes.push(`maxOdds ${Number(strategy.maxOdds).toFixed(2)}→${safeMaxOdds}`);
    if (safeMaxRunners   !== dc.maxRunners)              changes.push(`maxRunners ${dc.maxRunners}→${safeMaxRunners}`);
    if (safeMinLiquidity !== dc.minLiquidity)            changes.push(`minLiquidity £${dc.minLiquidity}→£${safeMinLiquidity}`);

    if (changes.length > 0) {
      const newMarketFilter = JSON.stringify({
        ...JSON.parse(strategy.marketFilter ?? "{}"),
        maxRunners: safeMaxRunners,
        minLiquidity: safeMinLiquidity,
      });
      await db.update(strategiesTable).set({
        minOdds: safeMinOdds.toString(),
        maxOdds: safeMaxOdds.toString(),
        marketFilter: newMarketFilter,
        updatedAt: new Date(),
      }).where(eq(strategiesTable.id, strategy.id));

      await db.insert(aiInsightsTable).values({
        category: "adjustment",
        content: `Adjusted: ${changes.join(", ")}. ${adj.adjustmentReason}`,
        racesProcessed: allRaces.length,
        runningNetProfit: totalNetProfit.toFixed(2),
        metadata: { changes, newParams: { minOdds: safeMinOdds, maxOdds: safeMaxOdds, maxRunners: safeMaxRunners, minLiquidity: safeMinLiquidity } },
      });

      await logBotActivity("info",
        `[AI-KNOWLEDGE] ${allRaces.length} races in DB — adjusted: ${changes.join(", ")} | ${adj.adjustmentReason}`
      );
    } else {
      await logBotActivity("info",
        `[AI-KNOWLEDGE] ${allRaces.length} races in DB — no change. ${adj.adjustmentReason} | Insight: ${adj.observation}`
      );
    }
  } catch (err) {
    logger.error({ err }, "AI knowledge base review error");
    await logBotActivity("warn", `[AI-KNOWLEDGE] Review error: ${err instanceof Error ? err.message : "Unknown"}`);
  }
}

// ── Smart scheduler: sleep until 30 mins before the next unbet race ──────────
// Instead of polling every 30 s blindly, we look at today's remaining markets
// and wake up 30 minutes before the first race that hasn't been bet on yet.
// This avoids hammering the API during quiet periods (e.g. early morning).
async function computeNextSleepMs(strategy: typeof strategiesTable.$inferSelect): Promise<number> {
  const MIN_SLEEP_MS = 30_000;        // never faster than 30 s
  const WAKE_BEFORE_MS = 30 * 60_000; // wake up 30 min before first race

  try {
    const dc = parseDutchConfig(strategy.marketFilter);
    const countries = dc.countryCodes?.length ? dc.countryCodes : [dc.countryCode];

    // Look 36 hours ahead so we always catch tomorrow's card if today is done
    const markets = await listMarkets({
      eventTypeId: strategy.eventTypeId,
      countryCodes: countries,
      marketType: "WIN",
      limit: 100,
      hoursAhead: 36,
    });

    // Filter to markets not already bet on
    const betMarketIds = new Set(
      (await db.select({ marketId: betsTable.marketId }).from(betsTable)).map(b => b.marketId)
    );

    const now = Date.now();
    const futureUnbet = markets
      .filter(m => !betMarketIds.has(m.marketId) && !/each.?way/i.test(m.marketName))
      .map(m => new Date(m.marketStartTime).getTime())
      .filter(t => t > now)
      .sort((a, b) => a - b);

    if (futureUnbet.length === 0) {
      // No races visible yet — check again in 1 hour
      await logBotActivity("info", "[SCHEDULER] No upcoming unbet races in the next 36 h — sleeping 1 hour");
      return 60 * 60_000;
    }

    const firstRace = futureUnbet[0];
    const sleepUntil = firstRace - WAKE_BEFORE_MS;
    // Sleep until 30 min before the race, with a 30 s floor (race may already be close)
    const sleepMs = Math.max(MIN_SLEEP_MS, sleepUntil - now);

    const firstRaceDate = new Date(firstRace);
    const wakeDate = new Date(now + sleepMs);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isNextDay = firstRaceDate.getDate() !== new Date(now).getDate();

    const raceLabel = firstRaceDate.toLocaleString("en-GB", {
      weekday: "short", hour: "2-digit", minute: "2-digit",
      ...(isNextDay ? { day: "numeric", month: "short" } : {}),
    });
    const wakeLabel = wakeDate.toLocaleString("en-GB", {
      hour: "2-digit", minute: "2-digit",
      ...(isNextDay ? { weekday: "short", day: "numeric", month: "short" } : {}),
    });
    const sleepHours = sleepMs / 3_600_000;
    const sleepDesc = sleepHours >= 1
      ? `${sleepHours.toFixed(1)} h`
      : `${(sleepMs / 60_000).toFixed(1)} min`;

    // Only log scheduler sleep if it's meaningful (> 30 min) — short sleeps are just active polling
    if (sleepMs > 30 * 60_000) {
      await logBotActivity("info",
        `[SCHEDULER] Next unbet race at ${raceLabel} — sleeping ${sleepDesc}, waking at ${wakeLabel}`
      );
    }
    return sleepMs;
  } catch {
    return MIN_SLEEP_MS;
  }
}

async function scheduleBotCycle(strategy: typeof strategiesTable.$inferSelect): Promise<void> {
  if (!botRunning) return;
  try {
    await runBotCycle();
  } catch (err) {
    logger.error({ err }, "Bot cycle error");
  }
  if (!botRunning) return;
  let sleepMs = 30_000;
  try {
    sleepMs = await computeNextSleepMs(strategy);
  } catch (err) {
    logger.error({ err }, "[SCHEDULER] computeNextSleepMs threw unexpectedly — falling back to 30 s");
  }
  botInterval = setTimeout(() => void scheduleBotCycle(strategy), sleepMs) as unknown as NodeJS.Timeout;
}

export async function startBot(): Promise<void> {
  if (botRunning) return;
  const config = await getBotConfig();
  await db.update(botConfigTable).set({ isRunning: true }).where(eq(botConfigTable.id, config.id));
  botRunning = true;
  startedAt = new Date();
  await logBotActivity("info", "Bot started");

  // Load the first DUTCH strategy to drive the smart scheduler
  const [strategy] = await db.select().from(strategiesTable).where(eq(strategiesTable.isActive, true)).limit(1);

  // Settlement check runs every 2 minutes independently
  settlementInterval = setInterval(() => void runSettlementCheck(), 2 * 60 * 1000);

  if (strategy) {
    void scheduleBotCycle(strategy);
  } else {
    // Fallback to fixed interval if no strategy configured yet
    botInterval = setInterval(() => void runBotCycle(), config.checkIntervalSeconds * 1000) as unknown as NodeJS.Timeout;
  }
  void runSettlementCheck();
}

export async function stopBot(): Promise<void> {
  if (botInterval) { clearTimeout(botInterval); botInterval = null; }
  if (settlementInterval) { clearInterval(settlementInterval); settlementInterval = null; }
  botRunning = false;
  startedAt = null;
  const [config] = await db.select().from(botConfigTable).limit(1);
  if (config) {
    await db.update(botConfigTable).set({ isRunning: false }).where(eq(botConfigTable.id, config.id));
  }
  await logBotActivity("info", "Bot stopped");
}
