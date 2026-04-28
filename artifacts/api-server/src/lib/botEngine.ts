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
import OpenAI from "openai";

async function getAIClient(model: string): Promise<OpenAI> {
  if (model.startsWith("grok-")) {
    // Prefer env var, fall back to DB-stored key
    let apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      const [config] = await db.select({ xaiApiKey: botConfigTable.xaiApiKey }).from(botConfigTable).limit(1);
      apiKey = config?.xaiApiKey ?? undefined;
    }
    if (!apiKey) {
      throw new Error("xAI API key is not set. Add it in Settings → AI Provider.");
    }
    return new OpenAI({ apiKey, baseURL: "https://api.x.ai/v1" });
  }
  if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error("AI_INTEGRATIONS_OPENAI_API_KEY is not set.");
  }
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  });
}

let botInterval: NodeJS.Timeout | null = null;
let botRunning = false;
let startedAt: Date | null = null;

export function isBotRunning(): boolean {
  return botRunning;
}

export function getStartedAt(): Date | null {
  return startedAt;
}

async function logBotActivity(
  level: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await db.insert(botLogsTable).values({
    level,
    message,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
  logger.info({ level, message, metadata }, "Bot activity");
}

async function getBotConfig() {
  const [config] = await db.select().from(botConfigTable).limit(1);
  if (!config) {
    const [newConfig] = await db
      .insert(botConfigTable)
      .values({})
      .returning();
    return newConfig;
  }
  return config;
}

async function runBotCycle(): Promise<void> {
  try {
    const config = await getBotConfig();

    if (!config.isRunning) {
      stopBot();
      return;
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayBets = await db
      .select({ count: sql<number>`count(*)`, totalLoss: sql<number>`coalesce(sum(case when actual_profit < 0 then abs(actual_profit) else 0 end), 0)` })
      .from(betsTable)
      .where(gte(betsTable.placedAt, todayStart));

    const todayLoss = Number(todayBets[0]?.totalLoss ?? 0);
    const dailyLossLimit = Number(config.dailyLossLimit);

    if (todayLoss >= dailyLossLimit) {
      await logBotActivity("warn", `Daily loss limit reached: £${todayLoss.toFixed(2)} / £${dailyLossLimit.toFixed(2)}. Bot paused.`);
      await db.update(botConfigTable).set({ isRunning: false }).where(eq(botConfigTable.id, config.id));
      stopBot();
      return;
    }

    const pendingBets = await db
      .select()
      .from(betsTable)
      .where(eq(betsTable.status, "PLACED"));

    if (pendingBets.length >= config.maxConcurrentBets) {
      await logBotActivity("info", `Max concurrent bets reached (${pendingBets.length}/${config.maxConcurrentBets}). Waiting.`);
      return;
    }

    const strategies = await db
      .select()
      .from(strategiesTable)
      .where(eq(strategiesTable.isActive, true));

    if (strategies.length === 0) {
      await logBotActivity("info", "No active strategies found.");
      return;
    }

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
      const markets = await listMarkets({
        eventTypeId: strategy.eventTypeId,
        limit: 5,
      });

      if (markets.length === 0) continue;

      const targetMarket = markets[0];
      const marketDetail = await getMarketDetail(targetMarket.marketId);

      if (!marketDetail || marketDetail.runners.length === 0) continue;

      const eligibleRunners = marketDetail.runners.filter((r) => {
        const odds = r.bestBackPrice;
        if (!odds) return false;
        const minOdds = Number(strategy.minOdds);
        const maxOdds = Number(strategy.maxOdds);
        return odds >= minOdds && odds <= maxOdds && r.status === "ACTIVE";
      });

      if (eligibleRunners.length === 0) continue;

      const marketContext = `
Market: ${marketDetail.eventName} - ${marketDetail.marketName}
Start Time: ${marketDetail.marketStartTime}
Total Matched: £${marketDetail.totalMatched.toFixed(0)}
Runners:
${eligibleRunners.map((r) => `  - ${r.runnerName}: Best Back ${r.bestBackPrice}, Best Lay ${r.bestLayPrice}`).join("\n")}
      `.trim();

      const systemPrompt = strategy.aiPrompt ?? 
        "You are an expert Betfair exchange bettor. Analyze the given market and decide whether to place a bet. Consider odds value, market liquidity, and risk management. Be selective — only bet when you have high confidence.";

      let aiDecision: {
        shouldBet: boolean;
        selectionName?: string;
        reasoning: string;
        confidence?: number;
      };

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

        const content = response.choices[0]?.message?.content ?? "{}";
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        aiDecision = jsonMatch ? JSON.parse(jsonMatch[0]) : { shouldBet: false, reasoning: "Could not parse AI response" };
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

      const targetRunner = eligibleRunners.find(
        (r) => r.runnerName === aiDecision.selectionName
      ) ?? eligibleRunners[0];

      if (!targetRunner || !targetRunner.bestBackPrice) continue;

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

        await logBotActivity("info", `[PAPER] Placed ${strategy.betType} bet: ${targetRunner.runnerName} @ ${odds} (£${stakeAmount})`, {
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
          await logBotActivity("info", `Placed ${strategy.betType} bet: ${targetRunner.runnerName} @ ${odds} (£${stakeAmount})`, {
            betId: betResult.betId,
            market: targetMarket.eventName,
          });
        } else {
          await logBotActivity("error", `Bet failed: ${betResult.error}`, {
            market: targetMarket.eventName,
            selection: targetRunner.runnerName,
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

  botInterval = setInterval(
    () => void runBotCycle(),
    config.checkIntervalSeconds * 1000
  );

  void runBotCycle();
}

export async function stopBot(): Promise<void> {
  if (botInterval) {
    clearInterval(botInterval);
    botInterval = null;
  }

  botRunning = false;
  startedAt = null;

  const [config] = await db.select().from(botConfigTable).limit(1);
  if (config) {
    await db.update(botConfigTable).set({ isRunning: false }).where(eq(botConfigTable.id, config.id));
  }

  await logBotActivity("info", "Bot stopped");
}
