import {
  Action,
  Ctx,
  Hears,
  Help,
  Message,
  On,
  Start,
  Update,
} from "nestjs-telegraf";
import { Context, Input, Markup } from "telegraf";
import {
  GeneratedPresentation,
  PresentationPageCount,
  PresentationService,
  PresentationTemplateId,
} from "./presentation.service";
import { TelegramService } from "./telegram.service";

const REGISTRATION_BUTTON_TEXT = "📲 Telefon raqamni yuborish";

const MAIN_MENU_BUTTONS = {
  generate: "📄 Yangi prezentatsiya",
  profile: "👤 Profil",
} as const;

const PROFILE_TRIGGERS = [
  MAIN_MENU_BUTTONS.profile,
  "Profil",
  "profile",
  "/profil",
  "/profile",
] as const;

const PROFILE_COMMAND_REGEX = /^\/(profile|profil)(@\w+)?$/i;
const PROFILE_TRIGGER_SET = new Set(
  PROFILE_TRIGGERS.map((trigger) => trigger.toLowerCase()),
);

const PAGE_COUNT_OPTIONS: PresentationPageCount[] = [4, 6, 8];

const templateSelectionKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback("1", "template:1"),
    Markup.button.callback("2", "template:2"),
  ],
  [
    Markup.button.callback("3", "template:3"),
    Markup.button.callback("4", "template:4"),
  ],
]);

const pageCountKeyboard = Markup.inlineKeyboard([
  PAGE_COUNT_OPTIONS.map((count) =>
    Markup.button.callback(String(count), `pages:${count}`),
  ),
]);

type SharedContact = {
  phone_number: string;
  user_id?: number;
};

type CallbackActionContext = Context & {
  match: RegExpExecArray;
  answerCbQuery: (text?: string) => Promise<unknown>;
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
  constructor(
    private readonly telegramService: TelegramService,
    private readonly presentationService: PresentationService,
  ) {}

  @Start()
  async handleStart(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from) {
      await ctx.reply("⚠️ Telegram akkauntingizni aniqlab bo'lmadi.");
      return;
    }

    this.presentationService.clearFlow(ctx.from.id);
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
      this.presentationService.clearFlow(ctx.from.id);
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
      "ℹ️ Asosiy menyuni ochish uchun /start buyrug'ini yuboring. Oxirgi 24 soatda 3 tagacha prezentatsiya yaratishingiz mumkin.",
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
    this.presentationService.clearFlow(ctx.from.id);

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

    const generation = await this.telegramService.getGenerationAvailability(
      ctx.from.id,
    );

    if (!generation.allowed) {
      await ctx.reply(
        this.buildLimitReachedMessage(generation),
        mainMenuKeyboard,
      );
      return;
    }

    this.presentationService.startFlow(ctx.from.id);

    await ctx.reply(
      "📝 Prezentatsiya uchun asosiy mavzuni yuboring.",
      Markup.removeKeyboard(),
    );
  }

  @On("text")
  async handleTopicMessage(
    @Ctx() ctx: Context,
    @Message("text") topicMessage: string,
  ): Promise<void> {
    if (!ctx.from) {
      return;
    }

    const normalizedMessage = topicMessage.trim();
    const state = this.presentationService.getFlow(ctx.from.id);
    if (!state || state.step !== "awaiting_topic") {
      if (this.isProfileTrigger(normalizedMessage)) {
        await this.handleProfileStatus(ctx);
      }
      return;
    }

    const topic = normalizedMessage;
    if (!topic || topic.startsWith("/")) {
      await ctx.reply("📝 Iltimos, mavzuni oddiy matn ko'rinishida yuboring.");
      return;
    }

    this.presentationService.setTopic(ctx.from.id, topic);
    await this.replyWithTemplateOptions(ctx);
  }

  @Action(/^template:(1|2|3|4)$/)
  async handleTemplateSelection(
    @Ctx() ctx: CallbackActionContext,
  ): Promise<void> {
    await ctx.answerCbQuery();

    if (!ctx.from) {
      return;
    }

    const templateId = Number(ctx.match[1]) as PresentationTemplateId;
    const updated = this.presentationService.setTemplate(
      ctx.from.id,
      templateId,
    );

    if (!updated) {
      await ctx.reply(
        "⚠️ Avval mavzuni yuboring. So'ng shablon tanlash bosqichiga o'tamiz.",
        mainMenuKeyboard,
      );
      return;
    }

    await ctx.reply("📄 Sahifalar sonini tanlang:", pageCountKeyboard);
  }

  @Action(/^pages:(4|6|8)$/)
  async handlePageCountSelection(
    @Ctx() ctx: CallbackActionContext,
  ): Promise<void> {
    await ctx.answerCbQuery();

    if (!ctx.from) {
      return;
    }

    const pageCount = Number(ctx.match[1]) as PresentationPageCount;
    const state = this.presentationService.setGenerating(ctx.from.id);

    if (!state?.topic || !state.templateId) {
      await ctx.reply(
        "⚠️ Jarayon topilmadi. Iltimos, qaytadan `📄 Yangi prezentatsiya` tugmasini bosing.",
        mainMenuKeyboard,
      );
      return;
    }

    const generation = await this.telegramService.consumeGeneration(
      ctx.from.id,
      {
        prompt: state.topic,
        templateId: state.templateId,
        pageCount,
      },
    );
    if (!generation.allowed || !generation.reservationId) {
      this.presentationService.clearFlow(ctx.from.id);
      await ctx.reply(
        this.buildLimitReachedMessage(generation),
        mainMenuKeyboard,
      );
      return;
    }

    const reservationId = generation.reservationId;

    await ctx.reply(
      `⏳ Prezentatsiya tayyorlanmoqda (${pageCount} bet). Bir oz kuting...`,
    );

    let generatedPresentation: GeneratedPresentation | undefined;

    try {
      generatedPresentation =
        await this.presentationService.generatePresentationPdf({
          topic: state.topic,
          templateId: state.templateId,
          pageCount,
        });

      await this.telegramService.updateGenerationStatus(
        reservationId,
        "completed",
      );

      await ctx.replyWithDocument(
        Input.fromLocalFile(
          generatedPresentation.pdfPath,
          generatedPresentation.fileName,
        ),
        {
          caption: `✅ Tayyor! Oxirgi 24 soatdagi limit holati: ${generation.usedToday}/${generation.dailyLimit}.`,
        },
      );

      await ctx.reply(
        "📌 Yana prezentatsiya yaratish uchun menyudan foydalaning.",
        mainMenuKeyboard,
      );
    } catch {
      try {
        await this.telegramService.updateGenerationStatus(
          reservationId,
          "failed",
        );
      } catch {}
      await ctx.reply(
        "⚠️ Prezentatsiya yaratishda xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring.",
        mainMenuKeyboard,
      );
    } finally {
      if (generatedPresentation) {
        await this.presentationService.cleanupTemporaryFiles(
          generatedPresentation.tempDir,
        );
      }
      this.presentationService.clearFlow(ctx.from.id);
    }
  }

  @Hears([...PROFILE_TRIGGERS, PROFILE_COMMAND_REGEX])
  async handleProfileStatus(@Ctx() ctx: Context): Promise<void> {
    try {
      const canUseBot = await this.ensureRegisteredOrPrompt(ctx);
      if (!canUseBot || !ctx.from) {
        return;
      }

      const status = await this.telegramService.getProfileStatus(ctx.from.id);
      const username = status.username ? `@${status.username}` : "kiritilmagan";
      const firstName = status.firstName ?? "kiritilmagan";
      const profileLines = [
        `👤 Profil: ${firstName} (${username})`,
        `📞 Telefon: ${status.phoneNumber ?? "kiritilmagan"}`,
        `📊 Oxirgi 24 soatdagi yaratishlar: ${status.usedToday}/${status.dailyLimit}`,
        `🧮 Qolgan limit: ${status.remainingToday}`,
        status.nextAvailableAt
          ? `⏰ Keyingi yaratish vaqti (UTC): ${this.formatUtcDate(status.nextAvailableAt)}`
          : null,
      ].filter((line): line is string => Boolean(line));

      await ctx.reply(profileLines.join("\n"), mainMenuKeyboard);
    } catch (error) {
      console.error("Error handling profile status:", error);
      await ctx.reply(
        "⚠️ Profil ma'lumotlarini olishda xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring.",
        mainMenuKeyboard,
      );
    }
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

  private async replyWithTemplateOptions(ctx: Context): Promise<void> {
    const hasTemplatePreview =
      await this.presentationService.hasTemplatePreview();

    if (hasTemplatePreview) {
      await ctx.replyWithPhoto(
        Input.fromLocalFile(this.presentationService.getTemplatePreviewPath()),
        {
          caption: "🎨 Quyidagi shablonlardan birini tanlang (1-4).",
          reply_markup: templateSelectionKeyboard.reply_markup,
        },
      );
      return;
    }

    await ctx.reply(
      "🎨 `./src/templates/templates.png` topilmadi. Baribir shablonni tanlashingiz mumkin (1-4).",
      {
        parse_mode: "Markdown",
        reply_markup: templateSelectionKeyboard.reply_markup,
      },
    );
  }

  private isProfileTrigger(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return (
      PROFILE_TRIGGER_SET.has(normalized) ||
      PROFILE_COMMAND_REGEX.test(normalized)
    );
  }

  private buildLimitReachedMessage(generation: {
    usedToday: number;
    dailyLimit: number;
    nextAvailableAt: Date | null;
  }): string {
    const nextAvailable = generation.nextAvailableAt
      ? `${this.formatUtcDate(generation.nextAvailableAt)} UTC`
      : "24 soatdan keyin";

    return `⛔ Limit tugadi. Oxirgi 24 soatda ${generation.usedToday}/${generation.dailyLimit} ta yaratdingiz. Keyingi yaratish: ${nextAvailable}.`;
  }

  private formatUtcDate(value: Date): string {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(value);
  }
}
