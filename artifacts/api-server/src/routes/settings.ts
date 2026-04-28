import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, botConfigTable } from "@workspace/db";
import { z } from "zod";

const router: IRouter = Router();

async function getOrCreateConfig() {
  const [config] = await db.select().from(botConfigTable).limit(1);
  if (!config) {
    const [newConfig] = await db.insert(botConfigTable).values({}).returning();
    return newConfig;
  }
  return config;
}

router.get("/settings", async (_req, res): Promise<void> => {
  const config = await getOrCreateConfig();
  const key = config.xaiApiKey;
  res.json({
    hasXaiApiKey: !!key,
    xaiApiKeyHint: key ? `${key.slice(0, 6)}...${key.slice(-4)}` : null,
  });
});

router.post("/settings/xai-api-key", async (req, res): Promise<void> => {
  const parsed = z.object({ apiKey: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "apiKey is required" });
    return;
  }
  const config = await getOrCreateConfig();
  await db
    .update(botConfigTable)
    .set({ xaiApiKey: parsed.data.apiKey })
    .where(eq(botConfigTable.id, config.id));
  process.env.XAI_API_KEY = parsed.data.apiKey;
  res.json({ success: true });
});

router.delete("/settings/xai-api-key", async (_req, res): Promise<void> => {
  const config = await getOrCreateConfig();
  await db
    .update(botConfigTable)
    .set({ xaiApiKey: null })
    .where(eq(botConfigTable.id, config.id));
  delete process.env.XAI_API_KEY;
  res.json({ success: true });
});

export default router;
