import { Router, type IRouter } from "express";
import {
  ListMarketsQueryParams,
  GetMarketParams,
  ListMarketsResponse,
  GetMarketResponse,
} from "@workspace/api-zod";
import { getSession, listMarkets, getMarketDetail, loginWithEnvCredentials } from "../lib/betfair";

const router: IRouter = Router();

router.get("/markets", async (req, res): Promise<void> => {
  const parsed = ListMarketsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const session = getSession();
  if (!session) {
    await loginWithEnvCredentials();
  }

  let markets;
  try {
    markets = await listMarkets({
      eventTypeId: parsed.data.eventTypeId ?? undefined,
      countryCode: parsed.data.countryCode ?? undefined,
      marketType: parsed.data.marketType ?? undefined,
      limit: parsed.data.limit ?? 20,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  res.json(ListMarketsResponse.parse(markets));
});

router.get("/markets/:marketId", async (req, res): Promise<void> => {
  const params = GetMarketParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const session = getSession();
  if (!session) {
    await loginWithEnvCredentials();
  }

  const market = await getMarketDetail(params.data.marketId);

  if (!market) {
    res.status(404).json({ error: "Market not found" });
    return;
  }

  res.json(GetMarketResponse.parse(market));
});

export default router;
