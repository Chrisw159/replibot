import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, strategiesTable } from "@workspace/db";
import {
  CreateStrategyBody,
  UpdateStrategyBody,
  GetStrategyParams,
  UpdateStrategyParams,
  DeleteStrategyParams,
  ListStrategiesResponse,
  GetStrategyResponse,
  UpdateStrategyResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function mapStrategy(s: typeof strategiesTable.$inferSelect) {
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? null,
    eventTypeId: s.eventTypeId,
    minOdds: Number(s.minOdds),
    maxOdds: Number(s.maxOdds),
    stakeAmount: Number(s.stakeAmount),
    maxStakeAmount: Number(s.maxStakeAmount),
    betType: s.betType,
    isActive: s.isActive,
    aiPrompt: s.aiPrompt ?? null,
    aiModel: s.aiModel,
    marketFilter: s.marketFilter ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

router.get("/strategies", async (_req, res): Promise<void> => {
  const strategies = await db.select().from(strategiesTable).orderBy(strategiesTable.createdAt);
  res.json(ListStrategiesResponse.parse(strategies.map(mapStrategy)));
});

router.post("/strategies", async (req, res): Promise<void> => {
  const parsed = CreateStrategyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { minOdds, maxOdds, stakeAmount, maxStakeAmount, description, aiPrompt, marketFilter, ...rest } = parsed.data;

  const [strategy] = await db
    .insert(strategiesTable)
    .values({
      ...rest,
      description: description ?? null,
      aiPrompt: aiPrompt ?? null,
      marketFilter: marketFilter ?? null,
      minOdds: minOdds.toString(),
      maxOdds: maxOdds.toString(),
      stakeAmount: stakeAmount.toString(),
      maxStakeAmount: maxStakeAmount.toString(),
    })
    .returning();

  res.status(201).json(GetStrategyResponse.parse(mapStrategy(strategy)));
});

router.get("/strategies/:id", async (req, res): Promise<void> => {
  const params = GetStrategyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [strategy] = await db
    .select()
    .from(strategiesTable)
    .where(eq(strategiesTable.id, params.data.id));

  if (!strategy) {
    res.status(404).json({ error: "Strategy not found" });
    return;
  }

  res.json(GetStrategyResponse.parse(mapStrategy(strategy)));
});

router.patch("/strategies/:id", async (req, res): Promise<void> => {
  const params = UpdateStrategyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateStrategyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  const d = parsed.data;
  if (d.name != null) updates.name = d.name;
  if (d.description != null) updates.description = d.description;
  if (d.eventTypeId != null) updates.eventTypeId = d.eventTypeId;
  if (d.minOdds != null) updates.minOdds = d.minOdds.toString();
  if (d.maxOdds != null) updates.maxOdds = d.maxOdds.toString();
  if (d.stakeAmount != null) updates.stakeAmount = d.stakeAmount.toString();
  if (d.maxStakeAmount != null) updates.maxStakeAmount = d.maxStakeAmount.toString();
  if (d.betType != null) updates.betType = d.betType;
  if (d.isActive != null) updates.isActive = d.isActive;
  if (d.aiPrompt != null) updates.aiPrompt = d.aiPrompt;
  if (d.aiModel != null) updates.aiModel = d.aiModel;
  if (d.marketFilter != null) updates.marketFilter = d.marketFilter;

  const [strategy] = await db
    .update(strategiesTable)
    .set(updates)
    .where(eq(strategiesTable.id, params.data.id))
    .returning();

  if (!strategy) {
    res.status(404).json({ error: "Strategy not found" });
    return;
  }

  res.json(UpdateStrategyResponse.parse(mapStrategy(strategy)));
});

router.delete("/strategies/:id", async (req, res): Promise<void> => {
  const params = DeleteStrategyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [strategy] = await db
    .delete(strategiesTable)
    .where(eq(strategiesTable.id, params.data.id))
    .returning();

  if (!strategy) {
    res.status(404).json({ error: "Strategy not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
