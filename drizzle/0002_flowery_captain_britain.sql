CREATE TYPE "public"."presentation_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "presentations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "presentation_status" DEFAULT 'pending' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "presentations" ADD CONSTRAINT "presentations_user_id_telegram_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."telegram_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_users" DROP COLUMN "generation_count";--> statement-breakpoint
ALTER TABLE "telegram_users" DROP COLUMN "generation_count_date";