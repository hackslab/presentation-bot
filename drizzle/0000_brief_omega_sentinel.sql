CREATE TABLE "telegram_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_id" varchar(32) NOT NULL,
	"first_name" varchar(255),
	"phone_number" varchar(255),
	"username" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_users_telegram_id_unique" UNIQUE("telegram_id")
);
