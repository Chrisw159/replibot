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
 * back Under X.5 at odds within [minOdds, maxOdds]. Prefer the buffer line
 * (current total goals + 2) when its odds are already in range; otherwise
 * take the tight line (total + 0.5 above score). Trade out at
 * profitTargetPct; on a goal after entry, exit at breakeven-or-better or
 * ride to full time.
 */
export const soccerConfigTable = pgTable("soccer_config", {
  id: serial("id").primaryKey(),
  isRunning: boolean("is_running").notNull().default(false),
  stake: numeric("stake", { precision: 10, scale: 2 }).notNull().default("50.00"),
  minOdds: numeric("min_odds", { precision: 6, scale: 2 }).notNull().default("1.25"),
  maxOdds: numeric("max_odds", { precision: 6, scale: 2 }).notNull().default("1.50"),
  profitTargetPct: numeric("profit_target_pct", { precision: 6, scale: 2 }).notNull().default("15.00"),
  entryMinute: integer("entry_minute").notNull().default(85),
  minGoalGap: integer("min_goal_gap").notNull().default(2),
  preferBufferLine: boolean("prefer_buffer_line").notNull().default(true),
  maxConcurrent: integer("max_concurrent").notNull().default(2),
  // 0 = disabled (no daily stop-loss)
  dailyStopLoss: numeric("daily_stop_loss", { precision: 10, scale: 2 }).notNull().default("0.00"),
  minLiquidity: numeric("min_liquidity", { precision: 12, scale: 2 }).notNull().default("5000.00"),
  checkIntervalSeconds: integer("check_interval_seconds").notNull().default(20),
  paperMode: boolean("paper_mode").notNull().default(true),
  // When true (default), any event with a TRADED_OUT or EXITED_AFTER_GOAL trade
  // placed today is blocked from re-entry — prevents doubling exposure to one
  // late goal in the same game after profit has already been banked.
  blockReEntryAfterProfit: boolean("block_re_entry_after_profit").notNull().default(true),
  // Strategy toggles: TRADE_OUT = original (+15% net trade-out, breakeven after
  // goal). LAY_LOCK = immediately rest a lay at entry sized so a match locks
  // layTargetPct net profit if the bet wins and breakeven if it loses.
  strategyTradeOutEnabled: boolean("strategy_trade_out_enabled").notNull().default(true),
  strategyLayLockEnabled: boolean("strategy_lay_lock_enabled").notNull().default(true),
  layTargetPct: numeric("lay_target_pct", { precision: 6, scale: 2 }).notNull().default("30.00"),
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
  bufferLine: boolean("buffer_line").notNull().default(false), // true = score+2 line taken
  entryScore: text("entry_score").notNull(), // "2-0"
  entryTotalGoals: integer("entry_total_goals").notNull(),
  entryMinute: integer("entry_minute").notNull(), // estimated match minute
  entryOdds: numeric("entry_odds", { precision: 6, scale: 2 }).notNull(),
  stake: numeric("stake", { precision: 10, scale: 2 }).notNull(),
  // TRADE_OUT (original) | LAY_LOCK (resting lay at entry)
  strategy: text("strategy").notNull().default("TRADE_OUT"),
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
