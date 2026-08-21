import {
  pgTable,
  text,
  serial,
  boolean,
  integer,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Soccer in-play "no more goals" bot — singleton config row.
 * Strategy: after `entryMinute`, in games with a goal gap >= minGoalGap,
 * prefer the one-goal-insured Under line (current total + 1.5) when its odds
 * exceed maxOdds; otherwise take the tight line (current total + 0.5) only
 * when its odds exceed minOdds. The legacy column names are retained for
 * compatibility: minOdds is the tight minimum and maxOdds is the insured
 * minimum.
 */
export const soccerConfigTable = pgTable("soccer_config", {
  id: serial("id").primaryKey(),
  isRunning: boolean("is_running").notNull().default(false),
  stake: numeric("stake", { precision: 10, scale: 2 }).notNull().default("50.00"),
  minOdds: numeric("min_odds", { precision: 6, scale: 2 }).notNull().default("1.50"),
  maxOdds: numeric("max_odds", { precision: 6, scale: 2 }).notNull().default("1.60"),
  profitTargetPct: numeric("profit_target_pct", { precision: 6, scale: 2 }).notNull().default("15.00"),
  entryMinute: integer("entry_minute").notNull().default(80),
  minGoalGap: integer("min_goal_gap").notNull().default(2),
  // Legacy column retained for database compatibility; insured-first is now fixed.
  preferBufferLine: boolean("prefer_buffer_line").notNull().default(true),
  maxConcurrent: integer("max_concurrent").notNull().default(2),
  // 0 = disabled (no daily stop-loss)
  dailyStopLoss: numeric("daily_stop_loss", { precision: 10, scale: 2 }).notNull().default("0.00"),
  minLiquidity: numeric("min_liquidity", { precision: 12, scale: 2 }).notNull().default("5000.00"),
  checkIntervalSeconds: integer("check_interval_seconds").notNull().default(20),
  paperMode: boolean("paper_mode").notNull().default(true),
  // Legacy configuration retained for database compatibility. The engine now
  // always blocks repeat entry on any event it has traded.
  blockReEntryAfterProfit: boolean("block_re_entry_after_profit").notNull().default(true),
  // Legacy comparison flags retained for database compatibility. The engine
  // now runs only the same-stake LAY_LOCK strategy.
  strategyTradeOutEnabled: boolean("strategy_trade_out_enabled").notNull().default(false),
  strategyLayLockEnabled: boolean("strategy_lay_lock_enabled").notNull().default(true),
  layTargetPct: numeric("lay_target_pct", { precision: 6, scale: 2 }).notNull().default("40.00"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const soccerTradesTable = pgTable("soccer_trades", {
  id: serial("id").primaryKey(),
  eventId: text("event_id"),
  eventName: text("event_name").notNull(),
  competition: text("competition"),
  marketId: text("market_id").notNull(),
  marketName: text("market_name").notNull(), // e.g. "Over/Under 4.5 Goals"
  selectionId: integer("selection_id").notNull(),
  selectionName: text("selection_name").notNull(), // e.g. "Under 4.5 Goals"
  line: numeric("line", { precision: 4, scale: 1 }).notNull(), // 4.5
  bufferLine: boolean("buffer_line").notNull().default(false), // true = one-goal-insured line taken
  entryScore: text("entry_score").notNull(), // "2-0"
  entryTotalGoals: integer("entry_total_goals").notNull(),
  entryMinute: integer("entry_minute").notNull(), // estimated match minute
  entryOdds: numeric("entry_odds", { precision: 6, scale: 2 }).notNull(),
  stake: numeric("stake", { precision: 10, scale: 2 }).notNull(),
  // LAY_LOCK (same-stake resting lay at entry)
  strategy: text("strategy").notNull().default("LAY_LOCK"),
  // LAY_LOCK: the resting lay order (same stake as the back)
  layPrice: numeric("lay_price", { precision: 6, scale: 2 }),
  layMatchedAt: timestamp("lay_matched_at", { withTimezone: true }),
  // OPEN | HEDGED (lay matched, awaiting FT) | TRADED_OUT | EXITED_AFTER_GOAL
  // | SETTLED_WON | SETTLED_LOST | VOID
  status: text("status").notNull().default("OPEN"),
  exitOdds: numeric("exit_odds", { precision: 6, scale: 2 }),
  exitReason: text("exit_reason"),
  profit: numeric("profit", { precision: 10, scale: 2 }),
  goalAfterEntry: boolean("goal_after_entry").notNull().default(false),
  paper: boolean("paper").notNull().default(true),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const insertSoccerConfigSchema = createInsertSchema(soccerConfigTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertSoccerConfig = z.infer<typeof insertSoccerConfigSchema>;
export type SoccerConfig = typeof soccerConfigTable.$inferSelect;

export const insertSoccerTradeSchema = createInsertSchema(soccerTradesTable).omit({
  id: true,
  placedAt: true,
});
export type InsertSoccerTrade = z.infer<typeof insertSoccerTradeSchema>;
export type SoccerTrade = typeof soccerTradesTable.$inferSelect;
