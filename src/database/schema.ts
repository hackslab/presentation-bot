import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const presentationStatusEnum = pgEnum("presentation_status", [
  "pending",
  "completed",
  "failed",
]);

export const telegramUsers = pgTable("telegram_users", {
  id: serial("id").primaryKey(),
  telegramId: varchar("telegram_id", { length: 32 }).notNull().unique(),
  firstName: varchar("first_name", { length: 255 }),
  phoneNumber: varchar("phone_number", { length: 255 }),
  username: varchar("username", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const presentations = pgTable("presentations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => telegramUsers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  status: presentationStatusEnum("status").notNull().default("pending"),
  metadata: jsonb("metadata")
    .$type<{
      prompt?: string;
      templateId?: number;
      pageCount?: number;
      fileName?: string;
    }>()
    .notNull()
    .default({}),
});

export const schema = {
  telegramUsers,
  presentations,
};
