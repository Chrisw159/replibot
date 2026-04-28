import {
  pgTable,
  text,
  serial,
  boolean,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const strategiesTable = pgTable("strategies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  eventTypeId: text("event_type_id").notNull().default("1"),
  minOdds: numeric("min_odds", { precision: 10, scale: 2 }).notNull().default("1.5"),
  maxOdds: numeric("max_odds", { precision: 10, scale: 2 }).notNull().default("10.0"),
  stakeAmount: numeric("stake_amount", { precision: 10, scale: 2 }).notNull().default("5.00"),
  maxStakeAmount: numeric("max_stake_amount", { precision: 10, scale: 2 }).notNull().default("50.00"),
  betType: text("bet_type").notNull().default("BACK"),
  isActive: boolean("is_active").notNull().default(true),
  aiPrompt: text("ai_prompt"),
  aiModel: text("ai_model").notNull().default("gpt-5-mini"),
  marketFilter: text("market_filter"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertStrategySchema = createInsertSchema(strategiesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertStrategy = z.infer<typeof insertStrategySchema>;
export type Strategy = typeof strategiesTable.$inferSelect;
