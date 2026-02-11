import { Ctx, Hears, Help, Start, Update } from "nestjs-telegraf";
import { Context, Markup } from "telegraf";
import { TelegramService } from "./telegram.service";

const MAIN_MENU_BUTTONS = {
  generate: "Generate new presentations",
  profile: "Profile and status",
} as const;

const mainMenuKeyboard = Markup.keyboard([
  [MAIN_MENU_BUTTONS.generate, MAIN_MENU_BUTTONS.profile],
]).resize();

@Update()
export class TelegramUpdate {
  constructor(private readonly telegramService: TelegramService) {}

  @Start()
  async handleStart(@Ctx() ctx: Context): Promise<void> {
    if (ctx.from) {
      await this.telegramService.registerUser(ctx.from);
    }

    await ctx.reply(
      "Welcome! Use the menu below to generate a presentation or view your profile and status.",
      mainMenuKeyboard,
    );
  }

  @Help()
  async handleHelp(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply(
      "Use /start to open the main menu. You can generate up to 3 presentations per day.",
      mainMenuKeyboard,
    );
  }

  @Hears(MAIN_MENU_BUTTONS.generate)
  async handleGenerateRequest(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from) {
      await ctx.reply("Could not detect your Telegram account.");
      return;
    }

    await this.telegramService.registerUser(ctx.from);
    const generation = await this.telegramService.consumeGeneration(
      ctx.from.id,
    );

    if (!generation.allowed) {
      await ctx.reply(
        `Daily limit reached. You have used ${generation.usedToday}/${generation.dailyLimit} generations today.`,
        mainMenuKeyboard,
      );
      return;
    }

    await ctx.reply(
      `Presentation generation started. Remaining today: ${generation.remainingToday}/${generation.dailyLimit}.`,
      mainMenuKeyboard,
    );
  }

  @Hears(MAIN_MENU_BUTTONS.profile)
  async handleProfileStatus(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from) {
      await ctx.reply("Could not detect your Telegram account.");
      return;
    }

    await this.telegramService.registerUser(ctx.from);
    const status = await this.telegramService.getProfileStatus(ctx.from.id);
    const username = status.username ? `@${status.username}` : "not set";
    const firstName = status.firstName ?? "not set";

    await ctx.reply(
      [
        `Profile: ${firstName} (${username})`,
        `Daily generations: ${status.usedToday}/${status.dailyLimit}`,
        `Remaining today: ${status.remainingToday}`,
      ].join("\n"),
      mainMenuKeyboard,
    );
  }
}
