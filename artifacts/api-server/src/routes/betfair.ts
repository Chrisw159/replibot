import { Router, type IRouter } from "express";
import {
  ConnectBetfairBody,
  GetBetfairStatusResponse,
  ConnectBetfairResponse,
  GetBetfairAccountResponse,
} from "@workspace/api-zod";
import {
  getSession,
  loginWithCredentials,
  loginWithEnvCredentials,
  getAccountFunds,
} from "../lib/betfair";
import { db } from "@workspace/db";
import { botConfigTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/betfair/status", async (_req, res): Promise<void> => {
  const session = getSession();
  res.json(
    GetBetfairStatusResponse.parse({
      connected: !!session,
      sessionToken: session?.token ? "[hidden]" : null,
      username: session?.username ?? null,
      lastConnectedAt: session?.connectedAt?.toISOString() ?? null,
      error: null,
    })
  );
});

router.post("/betfair/connect", async (req, res): Promise<void> => {
  const parsed = ConnectBetfairBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { username, password, appKey } = parsed.data;
  const result = await loginWithCredentials(username, password, appKey);

  if (!result.success) {
    res.status(401).json({ error: result.error ?? "Authentication failed" });
    return;
  }

  // Persist credentials in DB so auto-connect survives container restarts
  try {
    const [existing] = await db.select().from(botConfigTable).limit(1);
    if (existing) {
      await db.update(botConfigTable)
        .set({ betfairUsername: username, betfairPassword: password, betfairAppKey: appKey })
        .where(eq(botConfigTable.id, existing.id));
    } else {
      await db.insert(botConfigTable).values({ betfairUsername: username, betfairPassword: password, betfairAppKey: appKey });
    }
  } catch (e) {
    // Non-fatal — session is already live even if we can't save to DB
  }

  const session = getSession();
  res.json(
    ConnectBetfairResponse.parse({
      connected: true,
      sessionToken: "[hidden]",
      username: session?.username ?? username,
      lastConnectedAt: session?.connectedAt?.toISOString() ?? new Date().toISOString(),
      error: null,
    })
  );
});

router.get("/betfair/account", async (_req, res): Promise<void> => {
  const session = getSession();

  if (!session) {
    await loginWithEnvCredentials();
  }

  const funds = await getAccountFunds();
  res.json(GetBetfairAccountResponse.parse(funds));
});

export default router;
