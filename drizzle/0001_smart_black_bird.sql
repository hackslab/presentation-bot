ALTER TABLE "telegram_users" ADD COLUMN "generation_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_users" ADD COLUMN "generation_count_date" date;