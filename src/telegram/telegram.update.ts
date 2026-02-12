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
import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { Context, Input, Markup } from "telegraf";
import {
  GeneratedPresentation,
  PresentationLanguage,
  PresentationPageCount,
  PresentationService,
  PresentationTemplateId,
} from "./presentation.service";
import { TelegramService } from "./telegram.service";

const REGISTRATION_BUTTON_TEXT = "📲 Telefon raqamni yuborish";
const SUBSCRIPTION_REQUIRED_TEXT =
  "Botdan foydalanish uchun ushbu kanallarga obuna bo'lishingiz kerak";
const SUBSCRIPTION_CHECK_CALLBACK = "subscription:check";

const MAIN_MENU_BUTTONS = {
  generate: "📄 Yangi prezentatsiya",
  profile: "👤 Profil",
} as const;

const BACK_BUTTON_TEXT = "⬅️ Ortga";

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
const PRESENTATION_LANGUAGES: Array<{
  code: PresentationLanguage;
  label: string;
}> = [
  { code: "uz", label: "🇺🇿 O'zbek" },
  { code: "ru", label: "🇷🇺 Русский" },
  { code: "en", label: "🇬🇧 English" },
];

const languageSelectionKeyboard = Markup.inlineKeyboard([
  PRESENTATION_LANGUAGES.map((language) =>
    Markup.button.callback(language.label, `language:${language.code}`),
  ),
]);

const templateSelectionKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback("1", "template:1"),
    Markup.button.callback("2", "template:2"),
  ],
  [
    Markup.button.callback("3", "template:3"),
    Markup.button.callback("4", "template:4"),
  ],
  [Markup.button.callback(BACK_BUTTON_TEXT, "back:topic")],
]);

const pageCountKeyboard = Markup.inlineKeyboard([
  [
    ...PAGE_COUNT_OPTIONS.map((count) =>
      Markup.button.callback(String(count), `pages:${count}`),
    ),
  ],
  [Markup.button.callback(BACK_BUTTON_TEXT, "back:template")],
]);

const imagePreferenceKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback("🖼️ Ha", "images:on"),
    Markup.button.callback("🚫 Yo'q", "images:off"),
  ],
  [Markup.button.callback(BACK_BUTTON_TEXT, "back:page_count")],
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
  private readonly logger = new Logger(TelegramUpdate.name);
  private readonly channelId: string | null;
  private readonly channelLink: string | null;
  private readonly isSubscriptionCheckEnabled: boolean;
  private readonly isSubscriptionCheckConfigured: boolean;

  constructor(
    private readonly telegramService: TelegramService,
    private readonly presentationService: PresentationService,
    private readonly configService: ConfigService,
  ) {
    this.channelId =
      this.configService.get<string>("CHANNEL_ID")?.trim() ?? null;
    this.channelLink =
      this.configService.get<string>("CHANNEL_LINK")?.trim() ?? null;
    this.isSubscriptionCheckEnabled = this.parseBooleanEnv(
      this.configService.get<string>("SUBSCRIPTION_TOGGLE"),
      true,
    );
    this.isSubscriptionCheckConfigured = Boolean(
      this.isSubscriptionCheckEnabled && this.channelId && this.channelLink,
    );

    if (!this.isSubscriptionCheckEnabled) {
      this.logger.log(
        "SUBSCRIPTION_TOGGLE=false, kanal obunasi tekshiruvi o'chirildi.",
      );
    } else if (!this.isSubscriptionCheckConfigured) {
      this.logger.warn(
        "CHANNEL_ID yoki CHANNEL_LINK topilmadi, kanal obunasi tekshiruvi o'chirildi.",
      );
    }
  }

  @Start()
  async handleStart(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from) {
      await ctx.reply("⚠️ Telegram akkauntingizni aniqlab bo'lmadi.");
      return;
    }

    this.presentationService.clearFlow(ctx.from.id);
    const canUseBot = await this.ensureRegisteredAndSubscribedOrPrompt(ctx);
    if (!canUseBot) {
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
      const canUseBot = await this.ensureRegisteredAndSubscribedOrPrompt(ctx);
      if (!canUseBot) {
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

    const isSubscribed = await this.isSubscribedToRequiredChannel(ctx);
    if (!isSubscribed) {
      await this.replyWithSubscriptionPrompt(ctx);
      return;
    }

    await ctx.reply(
      "✅ Ro'yxatdan o'tish muvaffaqiyatli yakunlandi. Endi botdan foydalanishingiz mumkin.",
      mainMenuKeyboard,
    );
  }

  @Hears(MAIN_MENU_BUTTONS.generate)
  async handleGenerateRequest(@Ctx() ctx: Context): Promise<void> {
    const canUseBot = await this.ensureRegisteredAndSubscribedOrPrompt(ctx);
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
      this.getLocalizedGenerationText("uz", "choose_language_first"),
      languageSelectionKeyboard,
    );
  }

  @Action(/^language:(uz|ru|en)$/)
  async handleLanguageSelection(
    @Ctx() ctx: CallbackActionContext,
  ): Promise<void> {
    try {
      await ctx.answerCbQuery();
    } catch (e) {
      // Ignore error if query is too old
    }

    if (!ctx.from) {
      return;
    }

    const canUseBot = await this.ensureRegisteredAndSubscribedOrPrompt(ctx);
    if (!canUseBot) {
      this.presentationService.clearFlow(ctx.from.id);
      return;
    }

    const language = ctx.match[1] as PresentationLanguage;
    const updated = this.presentationService.setLanguage(ctx.from.id, language);
    if (!updated) {
      await ctx.reply(
        this.getLocalizedGenerationText("uz", "flow_not_found"),
        mainMenuKeyboard,
      );
      return;
    }

    const sentMessage = await ctx.reply(
      this.getLocalizedGenerationText(language, "ask_topic"),
      Markup.keyboard([[BACK_BUTTON_TEXT]]).resize(),
    );

    this.presentationService.setAskTopicMessageId(
      ctx.from.id,
      sentMessage.message_id,
    );

    try {
      await ctx.deleteMessage();
    } catch (e) {
      // Ignore
    }
  }

  @Action("back:topic")
  async handleBackToTopic(@Ctx() ctx: CallbackActionContext): Promise<void> {
    try {
      await ctx.answerCbQuery();
    } catch (e) {
      // Ignore
    }

    if (!ctx.from) {
      return;
    }

    const state = this.presentationService.getFlow(ctx.from.id);
    if (!state) {
      await ctx.reply(
        this.getLocalizedGenerationText("uz", "flow_not_found"),
        mainMenuKeyboard,
      );
      return;
    }

    const language = state.language ?? "uz";
    this.presentationService.setLanguage(ctx.from.id, language);

    const sentMessage = await ctx.reply(
      this.getLocalizedGenerationText(language, "ask_topic"),
      Markup.keyboard([[BACK_BUTTON_TEXT]]).resize(),
    );

    this.presentationService.setAskTopicMessageId(
      ctx.from.id,
      sentMessage.message_id,
    );

    try {
      await ctx.deleteMessage();
    } catch (e) {
      // Ignore
    }
  }

  @Action("back:template")
  async handleBackToTemplate(@Ctx() ctx: CallbackActionContext): Promise<void> {
    try {
      await ctx.answerCbQuery();
    } catch (e) {
      // Ignore
    }

    if (!ctx.from) {
      return;
    }

    const state = this.presentationService.getFlow(ctx.from.id);
    if (!state || !state.topic) {
      await ctx.reply(
        this.getLocalizedGenerationText("uz", "flow_not_found"),
        mainMenuKeyboard,
      );
      return;
    }

    // Set topic again essentially resets to template selection state
    this.presentationService.setTopic(ctx.from.id, state.topic);
    await this.replyWithTemplateOptions(ctx, state.language ?? "uz");

    try {
      await ctx.deleteMessage();
    } catch (e) {
      // Ignore
    }
  }

  @On("text")
  async handleTopicMessage(
    @Ctx() ctx: Context,
    @Message("text") topicMessage: string,
  ): Promise<void> {
    if (!ctx.from) {
      return;
    }

    const canUseBot = await this.ensureRegisteredAndSubscribedOrPrompt(ctx);
    if (!canUseBot) {
      this.presentationService.clearFlow(ctx.from.id);
      return;
    }

    const normalizedMessage = topicMessage.trim();
    const state = this.presentationService.getFlow(ctx.from.id);
    if (!state || state.step !== "awaiting_topic") {
      if (state?.step === "awaiting_language") {
        await ctx.reply(
          this.getLocalizedGenerationText("uz", "choose_language_first"),
          languageSelectionKeyboard,
        );
        return;
      }

      if (this.isProfileTrigger(normalizedMessage)) {
        await this.handleProfileStatus(ctx);
      }
      return;
    }

    if (normalizedMessage === BACK_BUTTON_TEXT) {
      this.presentationService.startFlow(ctx.from.id);
      await ctx.reply(
        this.getLocalizedGenerationText("uz", "choose_language_first"),
        languageSelectionKeyboard,
      );
      try {
        if (state.askTopicMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            state.askTopicMessageId,
          );
        }
      } catch (e) {
        // Ignore
      }
      return;
    }

    const language = state.language ?? "uz";

    const topic = normalizedMessage;
    if (!topic || topic.startsWith("/")) {
      await ctx.reply(
        this.getLocalizedGenerationText(language, "topic_as_text"),
      );
      return;
    }

    const topicSaved = this.presentationService.setTopic(ctx.from.id, topic);
    if (!topicSaved) {
      await ctx.reply(
        this.getLocalizedGenerationText(language, "flow_not_found"),
        mainMenuKeyboard,
      );
      return;
    }

    await this.replyWithTemplateOptions(ctx, language);

    try {
      if (state.askTopicMessageId) {
        await ctx.telegram.deleteMessage(ctx.chat!.id, state.askTopicMessageId);
      }
    } catch (e) {
      // Ignore
    }
  }

  @Action(/^template:(1|2|3|4)$/)
  async handleTemplateSelection(
    @Ctx() ctx: CallbackActionContext,
  ): Promise<void> {
    try {
      await ctx.answerCbQuery();
    } catch (e) {
      // Ignore error if query is too old
    }

    if (!ctx.from) {
      return;
    }

    const canUseBot = await this.ensureRegisteredAndSubscribedOrPrompt(ctx);
    if (!canUseBot) {
      this.presentationService.clearFlow(ctx.from.id);
      return;
    }

    const templateId = Number(ctx.match[1]) as PresentationTemplateId;
    const currentFlow = this.presentationService.getFlow(ctx.from.id);
    const language = currentFlow?.language ?? "uz";
    const updated = this.presentationService.setTemplate(
      ctx.from.id,
      templateId,
    );

    if (!updated) {
      await ctx.reply(
        this.getLocalizedGenerationText(language, "send_topic_first"),
        mainMenuKeyboard,
      );
      return;
    }

    await ctx.reply(
      this.getLocalizedGenerationText(language, "ask_page_count"),
      pageCountKeyboard,
    );

    try {
      await ctx.deleteMessage();
    } catch (e) {
      // Ignore
    }
  }

  @Action(/^pages:(4|6|8)$/)
  async handlePageCountSelection(
    @Ctx() ctx: CallbackActionContext,
  ): Promise<void> {
    try {
      await ctx.answerCbQuery();
    } catch (e) {
      // Ignore error if query is too old
    }

    if (!ctx.from) {
      return;
    }

    const canUseBot = await this.ensureRegisteredAndSubscribedOrPrompt(ctx);
    if (!canUseBot) {
      this.presentationService.clearFlow(ctx.from.id);
      return;
    }

    const pageCount = Number(ctx.match[1]) as PresentationPageCount;
    const updated = this.presentationService.setPageCount(
      ctx.from.id,
      pageCount,
    );
    const state = this.presentationService.getFlow(ctx.from.id);
    const language = state?.language ?? "uz";

    if (!updated) {
      await ctx.reply(
        this.getLocalizedGenerationText(language, "flow_not_found"),
        mainMenuKeyboard,
      );
      return;
    }

    await ctx.reply(
      this.getLocalizedGenerationText(language, "ask_image_mode"),
      imagePreferenceKeyboard,
    );

    try {
      await ctx.deleteMessage();
    } catch (e) {
      // Ignore
    }
  }

  @Action("back:page_count")
  async handleBackToPageCount(
    @Ctx() ctx: CallbackActionContext,
  ): Promise<void> {
    try {
      await ctx.answerCbQuery();
    } catch (e) {
      // Ignore
    }

    if (!ctx.from) {
      return;
    }

    const state = this.presentationService.getFlow(ctx.from.id);
    const language = state?.language ?? "uz";
    const updated = this.presentationService.backToPageCount(ctx.from.id);

    if (!updated) {
      await ctx.reply(
        this.getLocalizedGenerationText(language, "flow_not_found"),
        mainMenuKeyboard,
      );
      return;
    }

    await ctx.reply(
      this.getLocalizedGenerationText(language, "ask_page_count"),
      pageCountKeyboard,
    );

    try {
      await ctx.deleteMessage();
    } catch (e) {
      // Ignore
    }
  }

  @Action(/^images:(on|off)$/)
  async handleImagePreferenceSelection(
    @Ctx() ctx: CallbackActionContext,
  ): Promise<void> {
    try {
      await ctx.answerCbQuery();
    } catch (e) {
      // Ignore error if query is too old
    }

    if (!ctx.from) {
      return;
    }

    const canUseBot = await this.ensureRegisteredAndSubscribedOrPrompt(ctx);
    if (!canUseBot) {
      this.presentationService.clearFlow(ctx.from.id);
      return;
    }

    const useImages = ctx.match[1] === "on";
    const state = this.presentationService.setGenerating(
      ctx.from.id,
      useImages,
    );
    const language = state?.language ?? "uz";

    if (
      !state?.topic ||
      !state.templateId ||
      !state.language ||
      !state.pageCount
    ) {
      await ctx.reply(
        this.getLocalizedGenerationText(language, "flow_not_found"),
        mainMenuKeyboard,
      );
      return;
    }

    const generation = await this.telegramService.consumeGeneration(
      ctx.from.id,
      {
        prompt: state.topic,
        language: state.language,
        templateId: state.templateId,
        pageCount: state.pageCount,
        useImages,
      },
    );
    if (!generation.allowed || !generation.reservationId) {
      this.presentationService.clearFlow(ctx.from.id);
      await ctx.reply(
        this.buildLimitReachedMessage(generation, language),
        mainMenuKeyboard,
      );
      return;
    }

    const reservationId = generation.reservationId;
    let generatedPresentation: GeneratedPresentation | undefined;

    let progressMsg;
    try {
      progressMsg = await ctx.reply(
        this.buildGenerationProgressMessage(
          language,
          state.pageCount,
          useImages,
        ),
      );
      await ctx.deleteMessage();
    } catch (e) {
      // Ignore
    }

    try {
      generatedPresentation =
        await this.presentationService.generatePresentationPdf({
          topic: state.topic,
          language: state.language,
          templateId: state.templateId,
          pageCount: state.pageCount,
          useImages,
        });

      await this.telegramService.updateGenerationStatus(
        reservationId,
        "completed",
      );

      const status =
        await this.telegramService.getPresentationStatus(reservationId);

      if (status === "failed") {
        if (progressMsg) {
          try {
            await ctx.telegram.deleteMessage(
              ctx.chat!.id,
              progressMsg.message_id,
            );
          } catch (e) {}
        }
        return;
      }

      await ctx.replyWithDocument(
        Input.fromLocalFile(
          generatedPresentation.pdfPath,
          generatedPresentation.fileName,
        ),
        {
          caption: this.buildGenerationCompleteMessage(language, generation),
        },
      );

      if (progressMsg) {
        try {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            progressMsg.message_id,
          );
        } catch (e) {}
      }

      await ctx.reply(
        this.getLocalizedGenerationText(language, "use_menu_for_next"),
        mainMenuKeyboard,
      );
    } catch (error) {
      try {
        await this.telegramService.markGenerationAsFailedIfPending(
          reservationId,
        );
      } catch (statusError) {
        this.logger.error(
          "Xatolikdan so'ng rezervatsiya holatini failed ga o'tkazishda xatolik yuz berdi.",
          statusError instanceof Error ? statusError.stack : undefined,
        );
      }

      this.logger.error(
        "Prezentatsiya yaratish jarayonida xatolik yuz berdi.",
        error instanceof Error ? error.stack : undefined,
      );

      try {
        if (progressMsg) {
          try {
            await ctx.telegram.deleteMessage(
              ctx.chat!.id,
              progressMsg.message_id,
            );
          } catch (e) {}
        }
        await ctx.reply(
          this.getLocalizedGenerationText(language, "generation_error"),
          mainMenuKeyboard,
        );
      } catch (replyError) {
        this.logger.error(
          "Foydalanuvchiga xatolik xabarini yuborishda xatolik yuz berdi.",
          replyError instanceof Error ? replyError.stack : undefined,
        );
      }
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
      const canUseBot = await this.ensureRegisteredAndSubscribedOrPrompt(ctx);
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
          ? `⏰ Keyingi yaratish vaqti: ${this.formatUzbekistanDate(status.nextAvailableAt)}`
          : null,
      ].filter((line): line is string => Boolean(line));

      await ctx.reply(profileLines.join("\n"), mainMenuKeyboard);
    } catch (error) {
      this.logger.error(
        "Profil holatini qayta ishlashda xatolik yuz berdi.",
        error instanceof Error ? error.stack : undefined,
      );
      await ctx.reply(
        "⚠️ Profil ma'lumotlarini olishda xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring.",
        mainMenuKeyboard,
      );
    }
  }

  @Action(SUBSCRIPTION_CHECK_CALLBACK)
  async handleSubscriptionCheck(
    @Ctx() ctx: CallbackActionContext,
  ): Promise<void> {
    try {
      await ctx.answerCbQuery();
    } catch (e) {
      // Ignore error if query is too old
    }

    const canUseBot = await this.ensureRegisteredAndSubscribedOrPrompt(ctx);
    if (!canUseBot) {
      return;
    }

    await ctx.reply(
      "✅ Obuna tasdiqlandi. Endi botdan foydalanishingiz mumkin.",
      mainMenuKeyboard,
    );
  }

  private async ensureRegisteredAndSubscribedOrPrompt(
    ctx: Context,
  ): Promise<boolean> {
    if (!ctx.from) {
      await ctx.reply("⚠️ Telegram akkauntingizni aniqlab bo'lmadi.");
      return false;
    }

    await this.telegramService.registerUser(ctx.from);
    const isRegistered = await this.telegramService.isRegistrationCompleted(
      ctx.from.id,
    );

    if (isRegistered) {
      const isSubscribed = await this.isSubscribedToRequiredChannel(ctx);
      if (isSubscribed) {
        return true;
      }

      await this.replyWithSubscriptionPrompt(ctx);
      return false;
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

  private async replyWithSubscriptionPrompt(ctx: Context): Promise<void> {
    if (!this.channelLink) {
      await ctx.reply(SUBSCRIPTION_REQUIRED_TEXT);
      return;
    }

    await ctx.reply(
      SUBSCRIPTION_REQUIRED_TEXT,
      Markup.inlineKeyboard([
        [Markup.button.url("📢 Kanalga o'tish", this.channelLink)],
        [
          Markup.button.callback(
            "✅ Obunani tekshirish",
            SUBSCRIPTION_CHECK_CALLBACK,
          ),
        ],
      ]),
    );
  }

  private async isSubscribedToRequiredChannel(ctx: Context): Promise<boolean> {
    if (!this.isSubscriptionCheckConfigured || !this.channelId || !ctx.from) {
      return true;
    }

    try {
      const member = await ctx.telegram.getChatMember(
        this.channelId,
        ctx.from.id,
      );
      return member.status !== "left" && member.status !== "kicked";
    } catch (error) {
      this.logger.error(
        "Kanal obunasini tekshirishda xatolik yuz berdi.",
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }
  }

  private async replyWithTemplateOptions(
    ctx: Context,
    language: PresentationLanguage,
  ): Promise<void> {
    const hasTemplatePreview =
      await this.presentationService.hasTemplatePreview();

    if (hasTemplatePreview) {
      await ctx.replyWithPhoto(
        Input.fromLocalFile(this.presentationService.getTemplatePreviewPath()),
        {
          caption: this.getLocalizedGenerationText(language, "choose_template"),
          reply_markup: templateSelectionKeyboard.reply_markup,
        },
      );
      return;
    }

    await ctx.reply(
      this.getLocalizedGenerationText(language, "template_preview_missing"),
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

  private getLocalizedGenerationText(
    language: PresentationLanguage,
    key:
      | "ask_topic"
      | "choose_language_first"
      | "topic_as_text"
      | "flow_not_found"
      | "send_topic_first"
      | "ask_page_count"
      | "ask_image_mode"
      | "choose_template"
      | "template_preview_missing"
      | "use_menu_for_next"
      | "generation_error",
  ): string {
    const uz: Record<typeof key, string> = {
      ask_topic: "📝 Prezentatsiya uchun asosiy mavzuni yuboring.",
      choose_language_first: "🌐 Avval prezentatsiya tilini tanlang:",
      topic_as_text: "📝 Iltimos, mavzuni oddiy matn ko'rinishida yuboring.",
      flow_not_found:
        "⚠️ Jarayon topilmadi. Iltimos, qaytadan `📄 Yangi prezentatsiya` tugmasini bosing.",
      send_topic_first:
        "⚠️ Avval mavzuni yuboring. So'ng shablon tanlash bosqichiga o'tamiz.",
      ask_page_count: "📄 Sahifalar sonini tanlang:",
      ask_image_mode: "🖼️ Slaydlarga rasmlar qo'shilsinmi?",
      choose_template: "🎨 Quyidagi shablonlardan birini tanlang (1-4).",
      template_preview_missing:
        "🎨 `./src/templates/templates.jpg` topilmadi. Baribir shablonni tanlashingiz mumkin (1-4).",
      use_menu_for_next:
        "📌 Yana prezentatsiya yaratish uchun menyudan foydalaning.",
      generation_error:
        "⚠️ Prezentatsiya yaratishda xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring.",
    };

    return uz[key];
  }

  private buildGenerationProgressMessage(
    language: PresentationLanguage,
    pageCount: PresentationPageCount,
    useImages: boolean,
  ): string {
    return `⏳ Prezentatsiya tayyorlanmoqda (${pageCount} bet, rasmlar: ${useImages ? "yoqilgan" : "o'chirilgan"}). Bir oz kuting...`;
  }

  private buildGenerationCompleteMessage(
    language: PresentationLanguage,
    generation: {
      usedToday: number;
      dailyLimit: number;
    },
  ): string {
    return `✅ Tayyor! Oxirgi 24 soatdagi limit holati: ${generation.usedToday}/${generation.dailyLimit}.`;
  }

  private buildLimitReachedMessage(
    generation: {
      usedToday: number;
      dailyLimit: number;
      nextAvailableAt: Date | null;
    },
    language: PresentationLanguage = "uz",
  ): string {
    const nextAvailableFallback = "24 soatdan keyin";
    const nextAvailable = generation.nextAvailableAt
      ? `${this.formatUzbekistanDate(generation.nextAvailableAt)} (O'zbekiston vaqti)`
      : nextAvailableFallback;
    return `⛔ Limit tugadi. Oxirgi 24 soatda ${generation.usedToday}/${generation.dailyLimit} ta yaratdingiz. Keyingi yaratish: ${nextAvailable}.`;
  }

  private formatUzbekistanDate(value: Date): string {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tashkent",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(value);
  }

  private parseBooleanEnv(
    value: string | undefined,
    defaultValue: boolean,
  ): boolean {
    if (!value) {
      return defaultValue;
    }

    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }

    this.logger.warn(
      `SUBSCRIPTION_TOGGLE noto'g'ri qiymat oldi: "${value}". Default qiymat ishlatiladi: ${defaultValue}.`,
    );
    return defaultValue;
  }
}
