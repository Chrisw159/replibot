import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const dutchScheduleTable = pgTable("dutch_schedule", {
  id:                 serial("id").primaryKey(),
  marketId:           text("market_id").notNull(),
  eventName:          text("event_name").notNull(),
  marketName:         text("market_name").notNull(),
  marketStartTime:    timestamp("market_start_time", { withTimezone: true }).notNull(),
  runnerCount:        integer("runner_count"),
  status:             text("status").notNull().default("SCHEDULED"),
  skipReason:         text("skip_reason"),
  scheduledDate:      text("scheduled_date").notNull(),
  runnersJson:        jsonb("runners_json"),
  // Latest decision-time liquidity snapshot from listMarketBook.totalMatched
  totalMatched:       numeric("total_matched", { precision: 14, scale: 2 }),
  // Filled by runScheduleSettlement once the market closes
  winnerSelectionId:  integer("winner_selection_id"),
  winnerName:         text("winner_name"),
  // Number of placed runners from the Betfair "To Be Placed" market.
  placesPaid:         integer("places_paid"),
  // Track condition scraped from Racing Post once the race has been run.
  // Captured so future strategies can condition on going (e.g. soft/heavy).
  going:              text("going"),
  resultRecordedAt:   timestamp("result_recorded_at", { withTimezone: true }),
  createdAt:          timestamp("created_at",  { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp("updated_at",  { withTimezone: true }).notNull().defaultNow(),
});

export type DutchScheduleEntry = typeof dutchScheduleTable.$inferSelect;
