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
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
GEMINI_API_KEY=your-gemini-key
GEMINI_MODEL=gemini-2.5-flash
PEXELS_API_KEY=your-pexels-key
```

AI provider configuration:

- OpenAI: set `OPENAI_API_KEY` (`OPENAI_MODEL` optional)
- Gemini: set `GEMINI_API_KEY` or `GOOGLE_API_KEY` (`GEMINI_MODEL` optional)
- Images: set `PEXELS_API_KEY` to enable automatic slide images when user chooses image mode
- If both providers are missing (or both fail), the bot falls back to local generated content.

## Install and run

```bash
npm install
npm run start:dev
```

`start`/`start:dev` runs pending Drizzle migrations automatically on app boot.

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
- Presentation usage is tracked in `presentations` (metadata only; no file blobs)
- `📄 Yangi prezentatsiya` flow:
  - asks for presentation language (`🇺🇿 O'zbek`, `🇷🇺 Русский`, `🇬🇧 English`) via inline buttons
  - asks for topic
  - asks 4 clarification questions with inline options (target audience, presenter role, goal, tone/style) and also accepts custom text answers
  - sends template preview image from `src/templates/templates.jpg` with buttons `1-4`
  - asks page count (`4`, `6`, `8`)
  - asks whether to include slide images (`🖼️ Ha` / `🚫 Yo'q`) for this generation only
  - reserves a slot as `pending` before generation (max 3 successful/pending generations per rolling 24h window)
  - `failed` generations do not consume quota
  - generates slide content, optionally fetches matching images from Pexels, renders matching `src/templates/template-<n>.hbs`, converts HTML to PDF, and sends the file
  - removes temporary files immediately after sending
