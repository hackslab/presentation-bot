import { Ctx, Hears, Help, Message, On, Start, Update } from "nestjs-telegraf";
import { Context, Markup } from "telegraf";
import { TelegramService } from "./telegram.service";

const REGISTRATION_BUTTON_TEXT = "📲 Telefon raqamni yuborish";

const MAIN_MENU_BUTTONS = {
  generate: "📄 Yangi prezentatsiya",
  profile: "👤 Profil va holat",
} as const;

type SharedContact = {
  phone_number: string;
  user_id?: number;
};

const registrationKeyboard = Markup.keyboard([
  [Markup.button.contactRequest(REGISTRATION_BUTTON_TEXT)],
])
  .resize()
  .oneTime();

const mainMenuKeyboard = Markup.keyboard([
  [MAIN_MENU_BUTTONS.generate, MAIN_MENU_BUTTONS.profile],
]).resize();

@Update()
export class TelegramUpdate {
  constructor(private readonly telegramService: TelegramService) {}

  @Start()
  async handleStart(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from) {
      await ctx.reply("⚠️ Telegram akkauntingizni aniqlab bo'lmadi.");
      return;
    }

    await this.telegramService.registerUser(ctx.from);
    const isRegistered = await this.telegramService.isRegistrationCompleted(
      ctx.from.id,
    );

    if (!isRegistered) {
      await this.replyWithRegistrationPrompt(ctx);
      return;
    }

    await ctx.reply(
      "👋 Xush kelibsiz! Quyidagi menyudan prezentatsiya yaratishingiz yoki profil va holatingizni ko'rishingiz mumkin.",
      mainMenuKeyboard,
    );
  }

  @Help()
  async handleHelp(@Ctx() ctx: Context): Promise<void> {
    if (ctx.from) {
      await this.telegramService.registerUser(ctx.from);
      const isRegistered = await this.telegramService.isRegistrationCompleted(
        ctx.from.id,
      );

      if (!isRegistered) {
        await this.replyWithRegistrationPrompt(ctx);
        return;
      }
    }

    await ctx.reply(
      "ℹ️ Asosiy menyuni ochish uchun /start buyrug'ini yuboring. Bir kunda 3 tagacha prezentatsiya yaratishingiz mumkin.",
      mainMenuKeyboard,
    );
  }

  @On("contact")
  async handleContactShare(
    @Ctx() ctx: Context,
    @Message("contact") contact: SharedContact,
  ): Promise<void> {
    if (!ctx.from) {
      await ctx.reply("⚠️ Telegram akkauntingizni aniqlab bo'lmadi.");
      return;
    }

    if (!contact?.phone_number) {
      await this.replyWithRegistrationPrompt(ctx);
      return;
    }

    await this.telegramService.registerUser(ctx.from);

    if (contact.user_id !== ctx.from.id) {
      await ctx.reply(
        "📱 Iltimos, ro'yxatdan o'tish tugmasini bosib o'zingizning telefon raqamingizni ulashing.",
        registrationKeyboard,
      );
      return;
    }

    await this.telegramService.completeRegistration(
      ctx.from.id,
      contact.phone_number,
    );

    await ctx.reply(
      "✅ Ro'yxatdan o'tish muvaffaqiyatli yakunlandi. Endi botdan foydalanishingiz mumkin.",
      mainMenuKeyboard,
    );
  }

  @Hears(MAIN_MENU_BUTTONS.generate)
  async handleGenerateRequest(@Ctx() ctx: Context): Promise<void> {
    const canUseBot = await this.ensureRegisteredOrPrompt(ctx);
    if (!canUseBot || !ctx.from) {
      return;
    }

    const generation = await this.telegramService.consumeGeneration(
      ctx.from.id,
    );

    if (!generation.allowed) {
      await ctx.reply(
        `⛔ Kunlik limit tugadi. Bugun ${generation.usedToday}/${generation.dailyLimit} ta yaratishdan foydalandingiz.`,
        mainMenuKeyboard,
      );
      return;
    }

    await ctx.reply(
      `🚀 Prezentatsiya yaratish boshlandi. Bugun qolgan limit: ${generation.remainingToday}/${generation.dailyLimit}.`,
      mainMenuKeyboard,
    );
  }

  @Hears(MAIN_MENU_BUTTONS.profile)
  async handleProfileStatus(@Ctx() ctx: Context): Promise<void> {
    const canUseBot = await this.ensureRegisteredOrPrompt(ctx);
    if (!canUseBot || !ctx.from) {
      return;
    }

    const status = await this.telegramService.getProfileStatus(ctx.from.id);
    const username = status.username ? `@${status.username}` : "kiritilmagan";
    const firstName = status.firstName ?? "kiritilmagan";

    await ctx.reply(
      [
        `👤 Profil: ${firstName} (${username})`,
        `📞 Telefon: ${status.phoneNumber ?? "kiritilmagan"}`,
        `📊 Kunlik yaratishlar: ${status.usedToday}/${status.dailyLimit}`,
        `🧮 Bugun qolgan: ${status.remainingToday}`,
      ].join("\n"),
      mainMenuKeyboard,
    );
  }

  private async ensureRegisteredOrPrompt(ctx: Context): Promise<boolean> {
    if (!ctx.from) {
      await ctx.reply("⚠️ Telegram akkauntingizni aniqlab bo'lmadi.");
      return false;
    }

    await this.telegramService.registerUser(ctx.from);
    const isRegistered = await this.telegramService.isRegistrationCompleted(
      ctx.from.id,
    );

    if (isRegistered) {
      return true;
    }

    await this.replyWithRegistrationPrompt(ctx);
    return false;
  }

  private async replyWithRegistrationPrompt(ctx: Context): Promise<void> {
    await ctx.reply(
      "📝 Botdan foydalanish uchun avval ro'yxatdan o'ting va telefon raqamingizni ulashing.",
      registrationKeyboard,
    );
  }
}
