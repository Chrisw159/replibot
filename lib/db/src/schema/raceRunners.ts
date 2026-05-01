import { pgTable, text, serial, integer, numeric, boolean, timestamp } from "drizzle-orm/pg-core";

export const raceRunnersTable = pgTable("race_runners", {
  id: serial("id").primaryKey(),
  marketId: text("market_id").notNull(),
  marketName: text("market_name").notNull(),
  eventName: text("event_name").notNull(),
  selectionId: integer("selection_id").notNull(),
  runnerName: text("runner_name").notNull(),
  bestBackPrice: numeric("best_back_price", { precision: 10, scale: 2 }),
  status: text("status").notNull().default("ACTIVE"),
  included: boolean("included").notNull().default(false),
  excludeReason: text("exclude_reason"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RaceRunner = typeof raceRunnersTable.$inferSelect;
