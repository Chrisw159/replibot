import { logger } from "./logger";
import { db, strategiesTable, betsTable, botConfigTable, botLogsTable } from "@workspace/db";
import { eq, gte, sql } from "drizzle-orm";
import {
  getSession,
  listMarkets,
  getMarketDetail,
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
let botRunning = false;
let startedAt: Date | null = null;

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
}

function parseDutchConfig(marketFilter: string | null): DutchConfig {
  const defaults: DutchConfig = {
    maxRunners: 12,
    minLiquidity: 1000,
    minutesBeforeStart: 5,
    countryCode: "GB",
    countryCodes: ["GB", "IE"],
    excludeRaceTypes: [],
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
      limit: 30,
      hoursAhead: 4,
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

  // Only races starting within the timing window
  const candidateMarkets = markets.filter(m => {
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

    const marketDetail = await getMarketDetail(market.marketId);
    if (!marketDetail) continue;

    const activeRunners = marketDetail.runners.filter(r => r.status === "ACTIVE" && r.bestBackPrice != null);
    if (activeRunners.length === 0) continue;

    // ── Runner count filter ──
    if (activeRunners.length > dc.maxRunners) {
      await logBotActivity("info", `[DUTCH] Skipping ${market.eventName} — ${activeRunners.length} runners > max ${dc.maxRunners}`);
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

    // ── AI: validate race AND calculate per-runner stakes ──
    const budget = totalStake; // max £40 per race

    const runnerList = qualifying
      .map(r => `  • selectionId ${r.selectionId} — ${r.runnerName}: ${r.bestBackPrice}`)
      .join("\n");

    const marketContext = `
Dutch Bet Opportunity — Horse Racing
Race: ${marketDetail.eventName} — ${marketDetail.marketName}
Country: ${market.countryCode ?? "Unknown"}  |  Total Runners: ${activeRunners.length}
Liquidity: £${marketDetail.totalMatched.toFixed(0)}  |  Starts in: ${((new Date(market.marketStartTime).getTime() - now) / 60_000).toFixed(1)} min
Favourite odds: ${favouriteOdds} (${sortedByOdds[0].runnerName})

Qualifying runners (odds ${strategy.minOdds}–${maxSelOdds}):
${runnerList}

Total budget: £${budget.toFixed(2)} (must not be exceeded)
    `.trim();

    const systemPrompt = strategy.aiPrompt ??
      "You are a UK horse racing dutching specialist. Approve only solid opportunities on reputable UK tracks.";

    const userMessage = `
You have been given a potential dutch betting opportunity. Your job is to:

1. Validate the race (UK track, not Novice/Maiden/Bumper/NH Flat, sensible opportunity).
2. If approved: calculate the stake for EACH qualifying runner so that if ANY of them wins, the total return exceeds the total amount staked. Profit per winner can vary — it does NOT need to be equal. The sum of all stakes must not exceed £${budget.toFixed(2)}.
3. Use the standard dutching formula as a starting point: stake_i = (budget / bookPct) / odds_i, where bookPct = sum(1/odds). You may adjust stakes slightly but must ensure every winner returns a profit.

Reply with JSON ONLY — no prose outside the JSON block:
{
  "approved": boolean,
  "reasoning": string,
  "stakes": [
    { "selectionId": number, "runnerName": string, "stake": number, "odds": number, "expectedProfit": number }
  ]
}
If not approved, return an empty stakes array.

Market data:
${marketContext}
    `.trim();

    interface AiStake { selectionId: number; runnerName: string; stake: number; odds: number; expectedProfit: number; }
    interface AiDutchResponse { approved: boolean; reasoning: string; stakes: AiStake[]; }

    let aiResponse: AiDutchResponse = { approved: false, reasoning: "AI not called", stakes: [] };
    try {
      const aiClient = await getAIClient(strategy.aiModel);
      const response = await aiClient.chat.completions.create({
        model: strategy.aiModel,
        max_completion_tokens: 600,
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

    if (!aiResponse.approved || aiResponse.stakes.length === 0) {
      await logBotActivity("info", `[DUTCH] AI rejected ${market.eventName}: ${aiResponse.reasoning}`);
      continue;
    }

    // ── Sanity-check the AI's stakes ──
    // Each winner must return more than the total staked
    const totalStaked = aiResponse.stakes.reduce((s, r) => s + r.stake, 0);

    if (totalStaked > budget * 1.01) { // allow 1p rounding
      await logBotActivity("warn", `[DUTCH] AI over-budget (£${totalStaked.toFixed(2)} > £${budget}). Skipping.`);
      continue;
    }

    const failingRunner = aiResponse.stakes.find(r => r.stake * r.odds <= totalStaked);
    if (failingRunner) {
      await logBotActivity("warn",
        `[DUTCH] AI stake for ${failingRunner.runnerName} (£${failingRunner.stake} @ ${failingRunner.odds}) would not profit. Skipping.`
      );
      continue;
    }

    // ── Place bets ──
    const dutchGroupId = `DUTCH-${market.marketId}-${Date.now()}`;
    const profitRange = `£${Math.min(...aiResponse.stakes.map(r => r.expectedProfit)).toFixed(2)}–£${Math.max(...aiResponse.stakes.map(r => r.expectedProfit)).toFixed(2)}`;

    if (config.paperTradingMode) {
      for (const r of aiResponse.stakes) {
        const runner = qualifying.find(q => q.selectionId === r.selectionId);
        if (!runner) continue;
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
          status: "MATCHED",
          aiReasoning: `[DUTCH] ${aiResponse.reasoning} | Group: ${dutchGroupId}`,
          betId: `${dutchGroupId}-${runner.selectionId}`,
        });
      }
      await logBotActivity("info",
        `[DUTCH][PAPER] ${aiResponse.stakes.length} bets on ${marketDetail.eventName} — total £${totalStaked.toFixed(2)}, profit range ${profitRange}`,
        { race: market.eventName, selections: aiResponse.stakes.length, totalStaked, profitRange, reasoning: aiResponse.reasoning }
      );
    } else {
      for (const r of aiResponse.stakes) {
        const runner = qualifying.find(q => q.selectionId === r.selectionId);
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
        `[DUTCH] ${aiResponse.stakes.length} live bets on ${marketDetail.eventName} — total £${totalStaked.toFixed(2)}, profit range ${profitRange}`,
        { race: market.eventName, selections: aiResponse.stakes.length, totalStaked, profitRange }
      );
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

    const [todayBets] = await db
      .select({ count: sql<number>`count(*)`, totalLoss: sql<number>`coalesce(sum(case when actual_profit < 0 then abs(actual_profit) else 0 end), 0)` })
      .from(betsTable)
      .where(gte(betsTable.placedAt, todayStart));

    const todayLoss = Number(todayBets?.totalLoss ?? 0);
    const dailyLossLimit = Number(config.dailyLossLimit);

    if (todayLoss >= dailyLossLimit) {
      await logBotActivity("warn", `Daily loss limit reached: £${todayLoss.toFixed(2)} / £${dailyLossLimit.toFixed(2)}. Bot paused.`);
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

export async function startBot(): Promise<void> {
  if (botRunning) return;
  const config = await getBotConfig();
  await db.update(botConfigTable).set({ isRunning: true }).where(eq(botConfigTable.id, config.id));
  botRunning = true;
  startedAt = new Date();
  await logBotActivity("info", "Bot started");
  botInterval = setInterval(() => void runBotCycle(), config.checkIntervalSeconds * 1000);
  void runBotCycle();
}

export async function stopBot(): Promise<void> {
  if (botInterval) { clearInterval(botInterval); botInterval = null; }
  botRunning = false;
  startedAt = null;
  const [config] = await db.select().from(botConfigTable).limit(1);
  if (config) {
    await db.update(botConfigTable).set({ isRunning: false }).where(eq(botConfigTable.id, config.id));
  }
  await logBotActivity("info", "Bot stopped");
}
