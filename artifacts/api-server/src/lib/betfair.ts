import { logger } from "./logger";
import { db } from "@workspace/db";
import { botConfigTable } from "@workspace/db/schema";

const BETFAIR_LOGIN_URL = "https://identitysso.betfair.com/api/login";
const BETFAIR_API_URL = "https://api.betfair.com/exchange/betting/json-rpc/v1";
const BETFAIR_ACCOUNTS_URL = "https://api.betfair.com/exchange/account/json-rpc/v1";

interface BetfairSession {
  token: string;
  appKey: string;
  username: string;
  connectedAt: Date;
}

let currentSession: BetfairSession | null = null;

export function getSession(): BetfairSession | null {
  return currentSession;
}

export function setSession(session: BetfairSession | null): void {
  currentSession = session;
}

export async function loginWithCredentials(
  username: string,
  password: string,
  appKey: string
): Promise<{ success: boolean; token?: string; error?: string }> {
  try {
    const params = new URLSearchParams({ username, password });
    const response = await fetch(BETFAIR_LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Application": appKey,
        Accept: "application/json",
      },
      body: params.toString(),
    });

    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("application/json")) {
      const text = await response.text();
      if (text.includes("Restricted") || text.includes("country that Betfair does not")) {
        logger.warn({ username }, "Betfair geo-restricted: server IP blocked");
        return {
          success: false,
          error:
            "Betfair is geo-restricted from this server's IP address (US region). To use live Betfair connectivity, deploy the app to a UK/EU server. Paper trading mode still works fully.",
        };
      }
      logger.warn({ text: text.slice(0, 200) }, "Unexpected non-JSON response from Betfair");
      return { success: false, error: "Unexpected response from Betfair login server" };
    }

    const data = (await response.json()) as {
      token?: string;
      status?: string;
      error?: string;
    };

    if (data.status === "SUCCESS" && data.token) {
      currentSession = {
        token: data.token,
        appKey,
        username,
        connectedAt: new Date(),
      };
      logger.info({ username }, "Betfair login successful");
      return { success: true, token: data.token };
    } else {
      logger.warn({ status: data.status, error: data.error }, "Betfair login failed");
      return { success: false, error: data.error ?? "Login failed" };
    }
  } catch (err) {
    logger.error({ err }, "Betfair login request failed");
    return { success: false, error: "Network error connecting to Betfair. Please check your credentials and try again." };
  }
}

export async function loginWithEnvCredentials(): Promise<{
  success: boolean;
  error?: string;
}> {
  // 1. Try environment variables first
  let username = process.env.BETFAIR_USERNAME;
  let password = process.env.BETFAIR_PASSWORD;
  let appKey = process.env.BETFAIR_APP_KEY;

  // 2. Fall back to credentials stored in the database (via Settings page)
  if (!username || !password || !appKey) {
    try {
      const [cfg] = await db.select().from(botConfigTable).limit(1);
      if (cfg) {
        username = username || cfg.betfairUsername || undefined;
        password = password || cfg.betfairPassword || undefined;
        appKey   = appKey   || cfg.betfairAppKey   || undefined;
      }
    } catch {
      // DB not ready yet — fall through to the error below
    }
  }

  if (!username || !password || !appKey) {
    return {
      success: false,
      error: "Betfair credentials not configured. Enter them in Settings and click Save.",
    };
  }

  const result = await loginWithCredentials(username, password, appKey);
  return result;
}

async function apiRequest<T>(
  url: string,
  method: string,
  params: Record<string, unknown>
): Promise<T> {
  if (!currentSession) {
    throw new Error("Not connected to Betfair. Please authenticate first.");
  }

  const body = JSON.stringify([{ jsonrpc: "2.0", method, params, id: 1 }]);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Application": currentSession.appKey,
      "X-Authentication": currentSession.token,
      Accept: "application/json",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Betfair API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as Array<{
    result?: T;
    error?: { code: string; message: string };
  }>;

  if (data[0]?.error) {
    const errMsg = data[0].error.message ?? String(data[0].error.code);
    // DSC-0018 = session token expired — clear so auto-connect triggers next cycle
    if (errMsg.includes("DSC-0018")) {
      logger.warn("Betfair session expired (DSC-0018) — clearing session for re-auth");
      currentSession = null;
    }
    throw new Error(`Betfair API error: ${errMsg}`);
  }

  return data[0]?.result as T;
}

export interface BetfairMarket {
  marketId: string;
  marketName: string;
  eventName: string;
  eventTypeId: string;
  eventTypeName: string;
  countryCode?: string;
  marketStartTime: string;
  totalMatched: number;
  status: string;
  inPlay: boolean;
}

export interface BetfairRunner {
  selectionId: number;
  runnerName: string;
  status: string;
  lastPriceTraded?: number;
  totalMatched?: number;
  bestBackPrice?: number;
  bestLayPrice?: number;
}

export interface BetfairMarketDetail extends BetfairMarket {
  runners: BetfairRunner[];
}

export async function debugListEventTypes(): Promise<unknown> {
  const body = JSON.stringify([{
    jsonrpc: "2.0",
    method: "SportsAPING/v1.0/listEventTypes",
    params: { filter: {} },
    id: 1,
  }]);

  if (!currentSession) throw new Error("Not connected");

  const response = await fetch(BETFAIR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Application": currentSession.appKey,
      "X-Authentication": currentSession.token,
      Accept: "application/json",
    },
    body,
  });

  const raw = await response.text();
  return { status: response.status, body: raw.substring(0, 2000) };
}

export async function listMarkets(params: {
  eventTypeId?: string;
  countryCode?: string;
  countryCodes?: string[];
  marketType?: string;
  limit?: number;
  hoursAhead?: number;
}): Promise<BetfairMarket[]> {
  interface MarketCatalogueResult {
    marketId: string;
    marketName: string;
    event?: { name?: string };
    eventType?: { id?: string; name?: string };
    country?: string;
    marketStartTime?: string;
    totalMatched?: number;
    marketCatalogueDescription?: { marketStatus?: string };
  }

  const filter: Record<string, unknown> = {};
  if (params.eventTypeId) filter["eventTypeIds"] = [params.eventTypeId];

  // Support array of country codes (e.g. ["GB","IE"]) or single code
  const countries = params.countryCodes ?? (params.countryCode ? [params.countryCode] : null);
  if (countries && countries.length > 0) filter["marketCountries"] = countries;

  if (params.marketType) filter["marketTypes"] = [params.marketType];

  // Only apply time range when explicitly requested
  if (params.hoursAhead) {
    const now = new Date();
    const future = new Date(now.getTime() + params.hoursAhead * 60 * 60 * 1000);
    filter["marketStartTime"] = {
      from: new Date(now.getTime() - 60_000).toISOString(), // 1 min grace for clock drift
      to: future.toISOString(),
    };
  }

  const maxResults = params.limit ?? 30;

  // Let errors propagate — caller (botEngine) handles and logs them
  const results = await apiRequest<MarketCatalogueResult[]>(
    BETFAIR_API_URL,
    "SportsAPING/v1.0/listMarketCatalogue",
    {
      filter,
      marketProjection: [
        "EVENT",
        "EVENT_TYPE",
        "MARKET_START_TIME",
        "MARKET_DESCRIPTION",
      ],
      maxResults,
      sort: "FIRST_TO_START",
    }
  );

  if (!Array.isArray(results)) {
    const msg = `Betfair listMarketCatalogue returned unexpected response: ${JSON.stringify(results)}`;
    logger.error({ results }, msg);
    throw new Error(msg);
  }

  logger.info({ count: results.length, filter }, "listMarketCatalogue raw response");

  return results.map((m) => ({
    marketId: m.marketId,
    marketName: m.marketName,
    eventName: m.event?.name ?? m.marketName,
    eventTypeId: m.eventType?.id ?? "1",
    eventTypeName: m.eventType?.name ?? "Horse Racing",
    countryCode: m.country,
    marketStartTime: m.marketStartTime ?? new Date().toISOString(),
    totalMatched: m.totalMatched ?? 0,
    status: m.marketCatalogueDescription?.marketStatus ?? "OPEN",
    inPlay: false,
  }));
}

export async function getMarketDetail(
  marketId: string
): Promise<BetfairMarketDetail | null> {
  interface BookResult {
    marketId?: string;
    status?: string;
    inplay?: boolean;
    totalMatched?: number;
    runners?: Array<{
      selectionId: number;
      status: string;
      lastPriceTraded?: number;
      totalMatched?: number;
      ex?: {
        availableToBack?: Array<{ price: number; size: number }>;
        availableToLay?: Array<{ price: number; size: number }>;
      };
    }>;
  }

  interface CatalogueResult {
    marketId?: string;
    marketName?: string;
    event?: { name?: string };
    marketStartTime?: string;
    runners?: Array<{ selectionId: number; runnerName: string }>;
  }

  try {
    const [bookResult, catalogResult] = await Promise.all([
      apiRequest<BookResult[]>(
        BETFAIR_API_URL,
        "SportsAPING/v1.0/listMarketBook",
        {
          marketIds: [marketId],
          priceProjection: {
            priceData: ["EX_BEST_OFFERS"],
            exBestOffersOverrides: { bestPricesDepth: 1 },
          },
        }
      ),
      apiRequest<CatalogueResult[]>(
        BETFAIR_API_URL,
        "SportsAPING/v1.0/listMarketCatalogue",
        {
          filter: { marketIds: [marketId] },
          marketProjection: ["EVENT", "RUNNER_METADATA", "MARKET_START_TIME"],
          maxResults: 1,
        }
      ),
    ]);

    const book = bookResult[0];
    const catalogue = catalogResult[0];

    if (!book || !catalogue) return null;

    const runnerNames = new Map(
      (catalogue.runners ?? []).map((r) => [r.selectionId, r.runnerName])
    );

    const runners: BetfairRunner[] = (book.runners ?? []).map((r) => ({
      selectionId: r.selectionId,
      runnerName: runnerNames.get(r.selectionId) ?? `Selection ${r.selectionId}`,
      status: r.status,
      lastPriceTraded: r.lastPriceTraded,
      totalMatched: r.totalMatched,
      bestBackPrice: r.ex?.availableToBack?.[0]?.price,
      bestLayPrice: r.ex?.availableToLay?.[0]?.price,
    }));

    return {
      marketId: book.marketId ?? marketId,
      marketName: catalogue.marketName ?? "Unknown",
      eventName: catalogue.event?.name ?? "Unknown",
      eventTypeId: "1",
      eventTypeName: "Horse Racing",
      marketStartTime: catalogue.marketStartTime ?? new Date().toISOString(),
      totalMatched: book.totalMatched ?? 0,
      status: book.status ?? "OPEN",
      inPlay: book.inplay ?? false,
      runners,
    };
  } catch (err) {
    logger.error({ err, marketId }, "Failed to get market detail");
    return null;
  }
}

export interface AccountFunds {
  availableToBetBalance: number;
  exposure: number;
  retainedCommission: number;
  exposureLimit: number;
  currency: string;
}

export async function getAccountFunds(): Promise<AccountFunds> {
  interface AccountResult {
    availableToBetBalance?: number;
    exposure?: number;
    retainedCommission?: number;
    exposureLimit?: number;
    wallet?: string;
  }

  try {
    const result = await apiRequest<AccountResult>(
      BETFAIR_ACCOUNTS_URL,
      "AccountAPING/v1.0/getAccountFunds",
      { wallet: "UK wallet" }
    );

    return {
      availableToBetBalance: result.availableToBetBalance ?? 0,
      exposure: result.exposure ?? 0,
      retainedCommission: result.retainedCommission ?? 0,
      exposureLimit: result.exposureLimit ?? 0,
      currency: "GBP",
    };
  } catch (err) {
    logger.warn({ err }, "Could not get account funds, returning zeros");
    return {
      availableToBetBalance: 0,
      exposure: 0,
      retainedCommission: 0,
      exposureLimit: 0,
      currency: "GBP",
    };
  }
}

export interface PlaceBetParams {
  marketId: string;
  selectionId: number;
  betType: "BACK" | "LAY";
  price: number;
  size: number;
}

export interface PlaceBetResult {
  betId?: string;
  status: string;
  error?: string;
}

export async function placeBet(params: PlaceBetParams): Promise<PlaceBetResult> {
  interface PlaceResult {
    status?: string;
    instructionReports?: Array<{
      status?: string;
      betId?: string;
      errorCode?: string;
    }>;
  }

  try {
    const side = params.betType === "BACK" ? "BACK" : "LAY";

    const result = await apiRequest<PlaceResult>(
      BETFAIR_API_URL,
      "SportsAPING/v1.0/placeOrders",
      {
        marketId: params.marketId,
        instructions: [
          {
            selectionId: params.selectionId,
            side,
            orderType: "LIMIT",
            limitOrder: {
              size: params.size,
              price: params.price,
              persistenceType: "LAPSE",
            },
          },
        ],
      }
    );

    const report = result.instructionReports?.[0];
    if (report?.status === "SUCCESS") {
      return { betId: report.betId, status: "PLACED" };
    } else {
      return {
        status: "FAILED",
        error: report?.errorCode ?? "Unknown error",
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { status: "FAILED", error: msg };
  }
}
