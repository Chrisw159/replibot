import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const betsTable = pgTable("bets", {
  id: serial("id").primaryKey(),
  betId: text("bet_id"),
  strategyId: integer("strategy_id"),
  strategyName: text("strategy_name"),
  marketId: text("market_id").notNull(),
  marketName: text("market_name").notNull(),
  eventName: text("event_name").notNull(),
  selectionId: integer("selection_id").notNull(),
  selectionName: text("selection_name").notNull(),
  betType: text("bet_type").notNull().default("BACK"),
  requestedOdds: numeric("requested_odds", { precision: 10, scale: 2 }).notNull(),
  matchedOdds: numeric("matched_odds", { precision: 10, scale: 2 }),
  stakeAmount: numeric("stake_amount", { precision: 10, scale: 2 }).notNull(),
  potentialProfit: numeric("potential_profit", { precision: 10, scale: 2 }).notNull(),
  actualProfit: numeric("actual_profit", { precision: 10, scale: 2 }),
  status: text("status").notNull().default("PLACED"),
  aiReasoning: text("ai_reasoning"),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
});

export const insertBetSchema = createInsertSchema(betsTable).omit({
  id: true,
  placedAt: true,
});
export type InsertBet = z.infer<typeof insertBetSchema>;
export type Bet = typeof betsTable.$inferSelect;
