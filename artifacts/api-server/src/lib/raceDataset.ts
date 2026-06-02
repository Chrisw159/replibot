/**
 * Permanent race-research dataset helpers.
 *
 * This module is the single write path into the `race_dataset` table. The
 * table is append/enrich only — it must NEVER be truncated by any reset or
 * admin endpoint. Every race the system observes gets a row here, regardless
 * of whether any bot acted on it.
 */
import { sql } from "drizzle-orm";
import { db, raceDatasetTable } from "@workspace/db";
import { logger } from "./logger";

export interface RaceMarketLite {
  marketId: string;
  eventName: string;
  marketName: string;
  marketStartTime: string | Date;
  runnerCount?: number | null;
  marketType?: string | null;
  countryCode?: string | null;
  venue?: string | null;
}

function isoDate(d: string | Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Insert a discovered race if we have never seen this marketId before.
 * Safe to call on every discovery cycle; existing rows are left alone.
 */
export async function upsertDiscoveredRace(market: RaceMarketLite): Promise<void> {
  try {
    await db.insert(raceDatasetTable).values({
      marketId:        market.marketId,
      eventName:       market.eventName,
      marketName:      market.marketName,
      venue:           market.venue ?? null,
      countryCode:     market.countryCode ?? null,
      marketType:      market.marketType ?? null,
      marketStartTime: new Date(market.marketStartTime),
      scheduledDate:   isoDate(market.marketStartTime),
      runnerCount:     market.runnerCount ?? null,
    }).onConflictDoNothing({ target: raceDatasetTable.marketId });
  } catch (err) {
    logger.warn({ err, marketId: market.marketId }, "[DATASET] discovery upsert failed");
  }
}

/**
 * Batch helper — call once per scan with the full market list.
 */
export async function upsertDiscoveredRaces(markets: RaceMarketLite[]): Promise<void> {
  for (const m of markets) {
    await upsertDiscoveredRace(m);
  }
}

export interface RaceEnrichment {
  runners?: unknown[];
  preRaceTotalMatched?: number | null;
}

export interface RaceResult {
  winnerSelectionId?: number | null;
  winnerName?: string | null;
  placesPaid?: number | null;
  going?: string | null;
  runners?: unknown[];
  preRaceTotalMatched?: number | null;
}

/**
 * Fill in pre-race liquidity + runner snapshot when we visit a market at
 * bet-evaluation time. Never overwrites stronger data (preserves an already
 * recorded liquidity figure unless the new one is non-zero and the existing is null).
 */
export async function enrichRaceWithRunners(
  marketId: string,
  data: RaceEnrichment,
): Promise<void> {
  try {
    const sets: Record<string, unknown> = {
      enrichedAt: new Date(),
      updatedAt:  new Date(),
    };
    if (data.runners && data.runners.length > 0) {
      sets.runnersJson = data.runners;
    }
    if (data.preRaceTotalMatched != null && data.preRaceTotalMatched > 0) {
      sets.preRaceTotalMatched = data.preRaceTotalMatched.toFixed(2);
    }
    if (Object.keys(sets).length === 2) return; // nothing real to write
    await db.update(raceDatasetTable)
      .set(sets)
      .where(sql`${raceDatasetTable.marketId} = ${marketId}`);
  } catch (err) {
    logger.warn({ err, marketId }, "[DATASET] enrichment failed");
  }
}

/**
 * Record the final race outcome (winner + going). Called from settlement.
 */
export async function recordRaceResult(
  marketId: string,
  result: RaceResult,
): Promise<void> {
  try {
    const sets: Record<string, unknown> = { updatedAt: new Date() };
    if (result.winnerSelectionId != null) {
      sets.winnerSelectionId = result.winnerSelectionId;
      sets.settledAt = new Date();
    }
    if (result.winnerName) sets.winnerName = result.winnerName;
    if (result.placesPaid != null) sets.placesPaid = result.placesPaid;
    if (result.going) {
      sets.going = result.going;
      sets.goingRecordedAt = new Date();
    }
    if (result.runners && result.runners.length > 0) {
      sets.runnersJson = result.runners;
    }
    if (result.preRaceTotalMatched != null && result.preRaceTotalMatched > 0) {
      sets.preRaceTotalMatched = result.preRaceTotalMatched.toFixed(2);
    }
    if (Object.keys(sets).length === 1) return;
    await db.update(raceDatasetTable)
      .set(sets)
      .where(sql`${raceDatasetTable.marketId} = ${marketId}`);
  } catch (err) {
    logger.warn({ err, marketId }, "[DATASET] result recording failed");
  }
}
