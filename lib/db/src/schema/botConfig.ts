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
  // When true: place NO bets (paper or real). The engines only observe markets
  // and record the permanent research dataset (race_dataset). Used for pure
  // data-collection runs (e.g. 1-2 months of races) ahead of going live.
  dataCollectionMode: boolean("data_collection_mode").notNull().default(false),
  xaiApiKey: text("xai_api_key"),
  betfairUsername: text("betfair_username"),
  betfairPassword: text("betfair_password"),
  betfairAppKey: text("betfair_app_key"),
  bookieIsRunning: boolean("bookie_is_running").notNull().default(false),
  bookieConfigJson: json("bookie_config_json").$type<Record<string, unknown>>(),
  dutchIsRunning: boolean("dutch_is_running").notNull().default(false),
  dutchConfigJson: json("dutch_config_json").$type<Record<string, unknown>>(),
  paperBackFavIsRunning: boolean("paper_back_fav_is_running").notNull().default(false),
  paperBackFavConfigJson: json("paper_back_fav_config_json").$type<Record<string, unknown>>(),
  paperLayShortFavIsRunning: boolean("paper_lay_short_fav_is_running").notNull().default(false),
  paperLayShortFavConfigJson: json("paper_lay_short_fav_config_json").$type<Record<string, unknown>>(),
  martingaleIsRunning: boolean("martingale_is_running").notNull().default(false),
  martingaleConfigJson: json("martingale_config_json").$type<Record<string, unknown>>(),
  martingaleStateJson: json("martingale_state_json").$type<Record<string, unknown>>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBotConfigSchema = createInsertSchema(botConfigTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type BotConfig = typeof botConfigTable.$inferSelect;
