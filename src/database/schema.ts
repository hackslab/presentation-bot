import {
  date,
  integer,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const telegramUsers = pgTable("telegram_users", {
  id: serial("id").primaryKey(),
  telegramId: varchar("telegram_id", { length: 32 }).notNull().unique(),
  firstName: varchar("first_name", { length: 255 }),
  phoneNumber: varchar("phone_number", { length: 255 }),
  username: varchar("username", { length: 255 }),
  generationCount: integer("generation_count").default(0).notNull(),
  generationCountDate: date("generation_count_date"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const schema = {
  telegramUsers,
};
