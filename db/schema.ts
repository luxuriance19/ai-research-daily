import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const digests = sqliteTable("digests", {
  date: text("date").primaryKey(),
  generatedAt: text("generated_at").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
