import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * PERMANENT research dataset of every horse race we observe, independent of
 * any betting strategy. This table is APPEND/ENRICH ONLY — it must never be
 * truncated by any reset endpoint, ever, by any bot, for any reason.
 *
 * Rows are inserted at market discovery time and enriched as data arrives:
 *   - discovery: marketId, names, start time, runner count, runners snapshot
 *   - bet-time:  pre-race liquidity (totalMatched), enriched runners with prices
 *   - settle:    winnerSelectionId, winnerName, going
 */
export const raceDatasetTable = pgTable("race_dataset", {
  id:                 serial("id").primaryKey(),
  marketId:           text("market_id").notNull().unique(),
  eventName:          text("event_name").notNull(),
  marketName:         text("market_name").notNull(),
  venue:              text("venue"),
  countryCode:        text("country_code"),
  marketType:         text("market_type"),
  marketStartTime:    timestamp("market_start_time", { withTimezone: true }).notNull(),
  scheduledDate:      text("scheduled_date").notNull(),
  runnerCount:        integer("runner_count"),
  runnersJson:        jsonb("runners_json"),
  preRaceTotalMatched: numeric("pre_race_total_matched", { precision: 14, scale: 2 }),
  winnerSelectionId:  integer("winner_selection_id"),
  winnerName:         text("winner_name"),
  going:              text("going"),
  discoveredAt:       timestamp("discovered_at",   { withTimezone: true }).notNull().defaultNow(),
  enrichedAt:         timestamp("enriched_at",     { withTimezone: true }),
  settledAt:          timestamp("settled_at",      { withTimezone: true }),
  goingRecordedAt:    timestamp("going_recorded_at", { withTimezone: true }),
  updatedAt:          timestamp("updated_at",      { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("race_dataset_scheduled_date_idx").on(t.scheduledDate),
  index("race_dataset_market_start_idx").on(t.marketStartTime),
]);

export type RaceDatasetEntry = typeof raceDatasetTable.$inferSelect;
