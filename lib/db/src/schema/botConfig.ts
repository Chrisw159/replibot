import {
  pgTable,
  text,
  serial,
  boolean,
  integer,
  numeric,
  timestamp,
  json,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botConfigTable = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  isRunning: boolean("is_running").notNull().default(false),
  checkIntervalSeconds: integer("check_interval_seconds").notNull().default(30),
  maxConcurrentBets: integer("max_concurrent_bets").notNull().default(5),
  dailyLossLimit: numeric("daily_loss_limit", { precision: 10, scale: 2 }).notNull().default("100.00"),
  dailyProfitTarget: numeric("daily_profit_target", { precision: 10, scale: 2 }),
  enabledEventTypes: text("enabled_event_types").notNull().default("1,2,4"),
  paperTradingMode: boolean("paper_trading_mode").notNull().default(true),
  xaiApiKey: text("xai_api_key"),
  betfairUsername: text("betfair_username"),
  betfairPassword: text("betfair_password"),
  betfairAppKey: text("betfair_app_key"),
  bookieIsRunning: boolean("bookie_is_running").notNull().default(false),
  bookieConfigJson: json("bookie_config_json").$type<Record<string, unknown>>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBotConfigSchema = createInsertSchema(botConfigTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type BotConfig = typeof botConfigTable.$inferSelect;
