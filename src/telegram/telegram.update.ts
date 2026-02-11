import { Ctx, Help, Start, Update } from "nestjs-telegraf";
import { Context } from "telegraf";
import { TelegramService } from "./telegram.service";

@Update()
export class TelegramUpdate {
  constructor(private readonly telegramService: TelegramService) {}

  @Start()
  async handleStart(@Ctx() ctx: Context): Promise<void> {
    if (ctx.from) {
      await this.telegramService.registerUser(ctx.from);
    }

    await ctx.reply("Bot is up and connected to PostgreSQL with Drizzle.");
  }

  @Help()
  async handleHelp(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply(
      "Use /start to register your Telegram profile in Postgres.",
    );
  }
}
