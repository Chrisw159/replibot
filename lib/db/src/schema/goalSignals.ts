import {
  pgTable,
  text,
  serial,
  timestamp,
  real,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const goalSignalsTable = pgTable("goal_signals", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull(),
  eventName: text("event_name").notNull(),
  marketId: text("market_id").notNull(),
  marketName: text("market_name").notNull(),
  signalType: text("signal_type").notNull(), // "GOAL_DETECTED" | "WATCHING" | "ODDS_SPIKE"
  homeTeam: text("home_team"),
  awayTeam: text("away_team"),
  triggerDescription: text("trigger_description").notNull(),
  oddsMovePct: real("odds_move_pct"),
  affectedSelection: text("affected_selection"),
  oddsBeforeMove: real("odds_before_move"),
  oddsAfterMove: real("odds_after_move"),
  confirmed: boolean("confirmed").notNull().default(false),
  marketSuspended: boolean("market_suspended").notNull().default(false),
  totalMatched: real("total_matched"),
  secondsIntoMatch: integer("seconds_into_match"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertGoalSignalSchema = createInsertSchema(goalSignalsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertGoalSignal = z.infer<typeof insertGoalSignalSchema>;
export type GoalSignal = typeof goalSignalsTable.$inferSelect;
