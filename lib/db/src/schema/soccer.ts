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
  // Legacy config column; full-match entries are unconditionally £50.
  stake: numeric("stake", { precision: 10, scale: 2 }).notNull().default("50.00"),
  minOdds: numeric("min_odds", { precision: 6, scale: 2 }).notNull().default("1.50"),
  maxOdds: numeric("max_odds", { precision: 6, scale: 2 }).notNull().default("1.60"),
  // Legacy full-match trade-out setting, retained but unused.
  profitTargetPct: numeric("profit_target_pct", { precision: 6, scale: 2 }).notNull().default("0.00"),
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
  // Legacy full-match target/exit columns retained for database compatibility.
  // Runtime uses a fixed 40% lock target and never reads these values.
  layTargetPct: numeric("lay_target_pct", { precision: 6, scale: 2 }).notNull().default("0.00"),
  layOffset: numeric("lay_offset", { precision: 6, scale: 2 }).notNull().default("0.00"),
  fallbackIntervalSeconds: integer("fallback_interval_seconds").notNull().default(0),
  maxFallbackLossPct: numeric("max_fallback_loss_pct", { precision: 6, scale: 2 }).notNull().default("0.00"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Separate singleton configuration for the first-half paper strategy. Keeping
 * this apart from soccer_config means either bot may run or be configured
 * without changing the other's risk controls.
 */
export const firstHalfSoccerConfigTable = pgTable("first_half_soccer_config", {
  id: serial("id").primaryKey(),
  isRunning: boolean("is_running").notNull().default(false),
  stake: numeric("stake", { precision: 10, scale: 2 }).notNull().default("50.00"),
  minOdds: numeric("min_odds", { precision: 6, scale: 2 }).notNull().default("1.50"),
  entryMinute: integer("entry_minute").notNull().default(35),
  minGoalGap: integer("min_goal_gap").notNull().default(2),
  maxConcurrent: integer("max_concurrent").notNull().default(2),
  minLiquidity: numeric("min_liquidity", { precision: 12, scale: 2 }).notNull().default("5000.00"),
  checkIntervalSeconds: integer("check_interval_seconds").notNull().default(10),
  // This strategy is deliberately never allowed to place real-money orders.
  paperMode: boolean("paper_mode").notNull().default(true),
  layTargetPct: numeric("lay_target_pct", { precision: 6, scale: 2 }).notNull().default("40.00"),
  layOffset: numeric("lay_offset", { precision: 6, scale: 2 }).notNull().default("0.45"),
  fallbackIntervalSeconds: integer("fallback_interval_seconds").notNull().default(300),
  maxFallbackLossPct: numeric("max_fallback_loss_pct", { precision: 6, scale: 2 }).notNull().default("20.00"),
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
  // Paper fill evidence captured when the resting lay is created. The monitor
  // later requires enough traded volume to clear the queue plus the full stake.
  layTradedVolumeBaseline: numeric("lay_traded_volume_baseline", { precision: 14, scale: 2 })
    .notNull()
    .default("0.00"),
  layQueueAhead: numeric("lay_queue_ahead", { precision: 14, scale: 2 })
    .notNull()
    .default("0.00"),
  layImmediateMatchedStake: numeric("lay_immediate_matched_stake", { precision: 10, scale: 2 })
    .notNull()
    .default("0.00"),
  layImmediatePriceStake: numeric("lay_immediate_price_stake", { precision: 14, scale: 2 })
    .notNull()
    .default("0.00"),
  targetLayPrice: numeric("target_lay_price", { precision: 6, scale: 2 }),
  layMatchedStake: numeric("lay_matched_stake", { precision: 10, scale: 2 }).notNull().default("0.00"),
  layMatchedPriceStake: numeric("lay_matched_price_stake", { precision: 14, scale: 2 }).notNull().default("0.00"),
  fallbackNextCheckAt: timestamp("fallback_next_check_at", { withTimezone: true }),
  fallbackAttemptCount: integer("fallback_attempt_count").notNull().default(0),
  fallbackAttemptedAt: timestamp("fallback_attempted_at", { withTimezone: true }),
  fallbackPrice: numeric("fallback_price", { precision: 6, scale: 2 }),
  fallbackProjectedPnl: numeric("fallback_projected_pnl", { precision: 10, scale: 2 }),
  fallbackDecision: text("fallback_decision"),
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

export const insertFirstHalfSoccerConfigSchema = createInsertSchema(firstHalfSoccerConfigTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertFirstHalfSoccerConfig = z.infer<typeof insertFirstHalfSoccerConfigSchema>;
export type FirstHalfSoccerConfig = typeof firstHalfSoccerConfigTable.$inferSelect;

export const insertSoccerTradeSchema = createInsertSchema(soccerTradesTable).omit({
  id: true,
  placedAt: true,
});
export type InsertSoccerTrade = z.infer<typeof insertSoccerTradeSchema>;
export type SoccerTrade = typeof soccerTradesTable.$inferSelect;
