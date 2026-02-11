# Telegram Bot (NestJS + Telegraf + Drizzle + Postgres)

This project is initialized with:

- `nestjs-telegraf` for Telegram bot updates (`/start`, `/help`)
- `drizzle-orm` + `pg` for PostgreSQL access
- `drizzle-kit` for schema generation/migrations

## Required environment variables

Create a `.env` file with:

```env
DATABASE_URL=postgresql://user:password@host:5432/database
TELEGRAM_BOT_TOKEN=123456:ABCDEF...
```

## Install and run

```bash
npm install
npm run start:dev
```

## Drizzle commands

```bash
npm run db:generate
npm run db:migrate
npm run db:studio
```

## Project structure

- `src/database/schema.ts` - Drizzle tables/schema
- `src/database/database.service.ts` - shared Drizzle database client
- `src/telegram/telegram.update.ts` - Telegram command handlers
- `drizzle.config.ts` - Drizzle Kit config

## Bot behavior

- `/start` stores or updates the Telegram user in `telegram_users`
- `/help` shows a quick usage message
