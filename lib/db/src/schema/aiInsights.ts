import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const aiInsightsTable = pgTable("ai_insights", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  category: text("category").notNull(), // 'race_observation' | 'pattern' | 'adjustment'
  content: text("content").notNull(),   // AI's natural-language observation
  racesProcessed: integer("races_processed").notNull().default(0),
  runningNetProfit: numeric("running_net_profit", { precision: 10, scale: 2 }),
  metadata: jsonb("metadata"),          // structured snapshot at time of writing
});

export type AiInsight = typeof aiInsightsTable.$inferSelect;
