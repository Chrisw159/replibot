import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const dutchScheduleTable = pgTable("dutch_schedule", {
  id:               serial("id").primaryKey(),
  marketId:         text("market_id").notNull(),
  eventName:        text("event_name").notNull(),
  marketName:       text("market_name").notNull(),
  marketStartTime:  timestamp("market_start_time", { withTimezone: true }).notNull(),
  runnerCount:      integer("runner_count"),
  status:           text("status").notNull().default("SCHEDULED"),
  skipReason:       text("skip_reason"),
  scheduledDate:    text("scheduled_date").notNull(),
  runnersJson:      jsonb("runners_json"),
  createdAt:        timestamp("created_at",  { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at",  { withTimezone: true }).notNull().defaultNow(),
});

export type DutchScheduleEntry = typeof dutchScheduleTable.$inferSelect;
