import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import Handlebars from "handlebars";
import puppeteer from "puppeteer";
import type { Page } from "puppeteer";

export type PresentationTemplateId = 1 | 2 | 3 | 4;
export type PresentationPageCount = 4 | 6 | 8;
export type PresentationLanguage = "uz" | "ru" | "en";
export type PresentationBriefAnswerKey =
  | "targetAudience"
  | "presenterRole"
  | "presentationGoal"
  | "toneStyle";
export type PresentationBriefAnswers = Record<
  PresentationBriefAnswerKey,
  string
>;

type PresentationFlowStep =
  | "awaiting_language"
  | "awaiting_topic"
  | "awaiting_brief_answer"
  | "awaiting_template"
  | "awaiting_page_count"
  | "awaiting_image_preference"
  | "generating";

type PresentationFlowState = {
  step: PresentationFlowStep;
  language?: PresentationLanguage;
  topic?: string;
  templateId?: PresentationTemplateId;
  pageCount?: PresentationPageCount;
  useImages?: boolean;
  askTopicMessageId?: number;
  briefAnswers?: Partial<PresentationBriefAnswers>;
};

type PresentationSlide = {
  pageNumber: number;
  title: string;
  summary: string;
  bullets: string[];
  content: string;
  imageUrl?: string;
};

type PresentationTemplateData = {
  topic: string;
  generatedAt: string;
  slides: PresentationSlide[];
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

type SerperImageSearchResponse = {
  images?: Array<{
    imageUrl?: string;
    link?: string;
  }>;
};

type ImageSearchParams = {
  query: string;
  gl: string;
  hl: string;
};

class GeminiApiError extends Error {
  constructor(
    readonly status: number,
    readonly details: string,
  ) {
    super(`Gemini API xatosi: ${status} ${details}`);
    this.name = "GeminiApiError";
  }
}

class SerperApiError extends Error {
  constructor(
    readonly status: number,
    readonly details: string,
  ) {
    super(`Serper API xatosi: ${status} ${details}`);
    this.name = "SerperApiError";
  }
}

export type GeneratedPresentation = {
  pdfPath: string;
  tempDir: string;
  fileName: string;
};

@Injectable()
export class PresentationService {
  private static readonly NAMED_TEMPLATE_FILES = [
    "presentation-template.hbs",
    "template-classic.hbs",
    "template-creative.hbs",
    "template-minimal.hbs",
  ] as const;

  private static readonly LEGACY_TEMPLATE_FILES = [
    "template-1.hbs",
    "template-2.hbs",
    "template-3.hbs",
    "template-4.hbs",
  ] as const;

  private readonly logger = new Logger(PresentationService.name);
  private readonly flows = new Map<number, PresentationFlowState>();

  constructor(private readonly configService: ConfigService) {
    Handlebars.registerHelper("addOne", (value: number) => Number(value) + 1);
  }

  startFlow(telegramId: number): void {
    this.flows.set(telegramId, { step: "awaiting_language" });
  }

  setLanguage(telegramId: number, language: PresentationLanguage): boolean {
    const state = this.flows.get(telegramId);
    if (!state || state.step !== "awaiting_language") {
      return false;
    }

    this.flows.set(telegramId, {
      step: "awaiting_topic",
      language,
    });
    return true;
  }

  setAskTopicMessageId(telegramId: number, messageId: number): boolean {
    const state = this.flows.get(telegramId);
    if (!state || state.step !== "awaiting_topic") {
      return false;
    }

    this.flows.set(telegramId, {
      ...state,
      askTopicMessageId: messageId,
    });
    return true;
  }

  getFlow(telegramId: number): PresentationFlowState | undefined {
    return this.flows.get(telegramId);
  }

  setTopic(telegramId: number, topic: string): boolean {
    const state = this.flows.get(telegramId);
    if (!state || state.step !== "awaiting_topic" || !state.language) {
      return false;
    }

    this.flows.set(telegramId, {
      step: "awaiting_brief_answer",
      language: state.language,
      topic,
      askTopicMessageId: state.askTopicMessageId,
      briefAnswers: {},
    });
    return true;
  }

  setBriefAnswer(
    telegramId: number,
    key: PresentationBriefAnswerKey,
    answer: string,
  ): PresentationFlowState | undefined {
    const state = this.flows.get(telegramId);
    if (
      !state ||
      state.step !== "awaiting_brief_answer" ||
      !state.language ||
      !state.topic
    ) {
      return undefined;
    }

    const normalizedAnswer = answer.trim();
    if (!normalizedAnswer) {
      return undefined;
    }

    const updatedState: PresentationFlowState = {
      ...state,
      step: "awaiting_brief_answer",
      briefAnswers: {
        ...(state.briefAnswers ?? {}),
        [key]: normalizedAnswer,
      },
    };

    this.flows.set(telegramId, updatedState);
    return updatedState;
  }

  completeBriefAnswers(
    telegramId: number,
    requiredKeys: readonly PresentationBriefAnswerKey[],
  ): PresentationFlowState | undefined {
    const state = this.flows.get(telegramId);
    if (
      !state ||
      state.step !== "awaiting_brief_answer" ||
      !state.language ||
      !state.topic ||
      !this.hasAllBriefAnswers(state.briefAnswers, requiredKeys)
    ) {
      return undefined;
    }

    const updatedState: PresentationFlowState = {
      step: "awaiting_template",
      language: state.language,
      topic: state.topic,
      briefAnswers: state.briefAnswers,
    };

    this.flows.set(telegramId, updatedState);
    return updatedState;
  }

  backToTopic(telegramId: number): PresentationFlowState | undefined {
    const state = this.flows.get(telegramId);
    if (!state || !state.language || state.step === "awaiting_language") {
      return undefined;
    }

    const updatedState: PresentationFlowState = {
      step: "awaiting_topic",
      language: state.language,
    };

    this.flows.set(telegramId, updatedState);
    return updatedState;
  }

  setTemplate(telegramId: number, templateId: PresentationTemplateId): boolean {
    const state = this.flows.get(telegramId);
    if (
      !state ||
      state.step !== "awaiting_template" ||
      !state.topic ||
      !state.language ||
      !this.hasAllBriefAnswers(state.briefAnswers, [
        "targetAudience",
        "presenterRole",
        "presentationGoal",
        "toneStyle",
      ])
    ) {
      return false;
    }

    this.flows.set(telegramId, {
      step: "awaiting_page_count",
      language: state.language,
      topic: state.topic,
      templateId,
      briefAnswers: state.briefAnswers,
    });
    return true;
  }

  backToTemplate(telegramId: number): boolean {
    const state = this.flows.get(telegramId);
    if (
      !state ||
      state.step !== "awaiting_page_count" ||
      !state.language ||
      !state.topic
    ) {
      return false;
    }

    this.flows.set(telegramId, {
      step: "awaiting_template",
      language: state.language,
      topic: state.topic,
      briefAnswers: state.briefAnswers,
    });
    return true;
  }

  setPageCount(telegramId: number, pageCount: PresentationPageCount): boolean {
    const state = this.flows.get(telegramId);
    if (
      !state ||
      state.step !== "awaiting_page_count" ||
      !state.language ||
      !state.topic ||
      !state.templateId
    ) {
      return false;
    }

    this.flows.set(telegramId, {
      step: "awaiting_image_preference",
      language: state.language,
      topic: state.topic,
      templateId: state.templateId,
      pageCount,
      briefAnswers: state.briefAnswers,
    });
    return true;
  }

  backToPageCount(telegramId: number): boolean {
    const state = this.flows.get(telegramId);
    if (
      !state ||
      state.step !== "awaiting_image_preference" ||
      !state.language ||
      !state.topic ||
      !state.templateId
    ) {
      return false;
    }

    this.flows.set(telegramId, {
      step: "awaiting_page_count",
      language: state.language,
      topic: state.topic,
      templateId: state.templateId,
      briefAnswers: state.briefAnswers,
    });
    return true;
  }

  setGenerating(
    telegramId: number,
    useImages: boolean,
  ): PresentationFlowState | undefined {
    const state = this.flows.get(telegramId);
    if (
      !state ||
      state.step !== "awaiting_image_preference" ||
      !state.language ||
      !state.topic ||
      !state.templateId ||
      !state.pageCount
    ) {
      return undefined;
    }

    const updatedState: PresentationFlowState = {
      step: "generating",
      language: state.language,
      topic: state.topic,
      templateId: state.templateId,
      pageCount: state.pageCount,
      useImages,
      briefAnswers: state.briefAnswers,
    };

    this.flows.set(telegramId, updatedState);
    return updatedState;
  }

  clearFlow(telegramId: number): void {
    this.flows.delete(telegramId);
  }

  getTemplatePreviewPath(): string {
    return join(this.resolveTemplatesDir(), "templates.jpg");
  }

  async hasTemplatePreview(): Promise<boolean> {
    try {
      await access(this.getTemplatePreviewPath());
      return true;
    } catch {
      return false;
    }
  }

  async generatePresentationPdf(options: {
    topic: string;
    language: PresentationLanguage;
    templateId: PresentationTemplateId;
    pageCount: PresentationPageCount;
    useImages?: boolean;
    briefAnswers?: Partial<PresentationBriefAnswers>;
  }): Promise<GeneratedPresentation> {
    const normalizedTopic = await this.normalizeTopicForLanguage(
      options.topic,
      options.language,
    );
    let slides = await this.generateSlides(
      normalizedTopic,
      options.pageCount,
      options.language,
      options.briefAnswers,
    );

    if (options.useImages) {
      slides = await this.attachImagesToSlides(
        normalizedTopic,
        slides,
        options.language,
      );
      const slidesWithImages = slides.filter((slide) =>
        Boolean(slide.imageUrl),
      ).length;

      this.logger.log(
        `Rasmlar biriktirildi: ${slidesWithImages}/${slides.length} ta slayd.`,
      );

      if (slidesWithImages === 0) {
        this.logger.warn(
          "Rasm rejimi yoqilgan bo'lsa-da, hech bir slaydga rasm topilmadi.",
        );
      }
    }

    const html = await this.renderTemplate(options.templateId, {
      topic: normalizedTopic,
      generatedAt: this.formatDate(new Date()),
      slides,
    });

    const tempDir = await mkdtemp(join(tmpdir(), "tg-presentation-"));
    const htmlPath = join(tempDir, "presentation.html");
    const pdfPath = join(tempDir, "presentation.pdf");

    try {
      await writeFile(htmlPath, html, "utf-8");
      await this.convertHtmlToPdf(html, pdfPath);

      return {
        pdfPath,
        tempDir,
        fileName: this.buildPdfName(normalizedTopic),
      };
    } catch (error) {
      await this.cleanupTemporaryFiles(tempDir);
      throw error;
    }
  }

  private readTrimmedConfig(key: string): string | undefined {
    const value = this.configService.get<string>(key);
    if (typeof value !== "string") {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private readTrimmedConfigList(key: string): string[] {
    const value = this.readTrimmedConfig(key);
    if (!value) {
      return [];
    }

    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  private getGeminiApiKeys(): string[] {
    const candidates = [
      ...this.readTrimmedConfigList("GEMINI_API_KEY"),
      ...this.readTrimmedConfigList("GOOGLE_API_KEY"),
    ];

    return [...new Set(candidates)];
  }

  private getSerperApiKeys(): string[] {
    const candidates = [
      ...this.readTrimmedConfigList("SERPER_API_KEY"),
      ...this.readTrimmedConfigList("SERPER_API"),
    ];

    return [...new Set(candidates)];
  }

  private getGeminiModel(): string {
    return (
      this.readTrimmedConfig("GEMINI_MODEL") ??
      this.readTrimmedConfig("AI_MODEL") ??
      "gemini-2.5-flash"
    );
  }

  private shouldTryNextGeminiApiKey(error: unknown): boolean {
    if (!(error instanceof GeminiApiError)) {
      return false;
    }

    if (error.status === 400 && /API_KEY_INVALID/i.test(error.details)) {
      return true;
    }

    if (
      error.status === 403 &&
      /(API_KEY_SERVICE_BLOCKED|PERMISSION_DENIED|SERVICE_DISABLED|forbidden)/i.test(
        error.details,
      )
    ) {
      return true;
    }

    return false;
  }

  private isSerperPermissionError(error: unknown): boolean {
    if (!(error instanceof SerperApiError)) {
      return false;
    }

    return (
      error.status === 401 ||
      error.status === 403 ||
      error.status === 429 ||
      /unauthorized|forbidden|invalid api key|quota|rate limit/i.test(
        error.details,
      )
    );
  }

  private async normalizeTopicForLanguage(
    topic: string,
    language: PresentationLanguage,
  ): Promise<string> {
    const fallbackTopic = topic.trim();
    if (!fallbackTopic) {
      return topic;
    }

    const openAiApiKey = this.readTrimmedConfig("OPENAI_API_KEY");
    const geminiApiKeys = this.getGeminiApiKeys();

    if (openAiApiKey) {
      try {
        return await this.normalizeTopicWithOpenAi(
          fallbackTopic,
          language,
          openAiApiKey,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Noma'lum xatolik";
        this.logger.warn(`OpenAI topic normalizatsiyasida xatolik: ${message}`);
      }
    }

    for (let index = 0; index < geminiApiKeys.length; index += 1) {
      const geminiApiKey = geminiApiKeys[index];

      try {
        return await this.normalizeTopicWithGemini(
          fallbackTopic,
          language,
          geminiApiKey,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Noma'lum xatolik";
        this.logger.warn(`Gemini topic normalizatsiyasida xatolik: ${message}`);

        const hasNextKey = index < geminiApiKeys.length - 1;
        if (!hasNextKey || !this.shouldTryNextGeminiApiKey(error)) {
          break;
        }

        this.logger.warn(
          "Gemini API kaliti yaroqsiz yoki cheklangan, keyingi kalit bilan qayta urinish qilinadi.",
        );
      }
    }

    return fallbackTopic;
  }

  async cleanupTemporaryFiles(tempDir: string): Promise<void> {
    await rm(tempDir, { recursive: true, force: true });
  }

  private async renderTemplate(
    templateId: PresentationTemplateId,
    data: PresentationTemplateData,
  ): Promise<string> {
    const templatePath = await this.resolveTemplatePath(templateId);
    const source = await readFile(templatePath, "utf-8");
    const template = Handlebars.compile<PresentationTemplateData>(source);
    return template(data);
  }

  private detectSystemChromium(): string | undefined {
    try {
      // Try to find chromium using which/whereis commands (works for Nixpacks/Linux)
      const path = execSync(
        "which chromium || which chromium-browser || which google-chrome || which google-chrome-stable",
      )
        .toString()
        .trim();

      if (path && existsSync(path)) {
        return path;
      }
    } catch {
      // Ignore errors if commands fail
    }

    // Common fallback paths on various Linux distros
    const commonPaths = [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/snap/bin/chromium",
    ];

    for (const p of commonPaths) {
      if (existsSync(p)) return p;
    }

    return undefined;
  }

  private async convertHtmlToPdf(
    html: string,
    outputPath: string,
  ): Promise<void> {
    let browser;

    try {
      // First attempt: try with default settings (respects env vars if valid)
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    } catch (error) {
      this.logger.warn(
        `Standard Puppeteer launch failed: ${error instanceof Error ? error.message : String(error)}. Attempting to auto-detect browser executable...`,
      );

      // Second attempt: try to auto-detect system chromium
      const executablePath = this.detectSystemChromium();

      if (!executablePath) {
        this.logger.error(
          "Could not detect any Chromium executable on the system.",
        );
        throw error;
      }

      this.logger.log(
        `Retrying Puppeteer with detected path: ${executablePath}`,
      );

      browser = await puppeteer.launch({
        headless: true,
        executablePath,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    }

    try {
      const page = await browser.newPage();
      await page.setContent(html, {
        waitUntil: "load",
        timeout: 60000,
      });
      await this.waitForPageVisualAssets(page);
      await page.pdf({
        path: outputPath,
        format: "A4",
        landscape: true,
        preferCSSPageSize: true,
        printBackground: true,
        margin: {
          top: "0mm",
          right: "0mm",
          bottom: "0mm",
          left: "0mm",
        },
      });
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  private async waitForPageVisualAssets(page: Page): Promise<void> {
    await page.evaluate(async () => {
      if (document.fonts) {
        try {
          await document.fonts.ready;
        } catch {}
      }

      const images = Array.from(document.images);

      await Promise.all(
        images.map(async (img) => {
          if (!img.complete) {
            await new Promise<void>((resolve) => {
              const onDone = () => resolve();
              img.addEventListener("load", onDone, { once: true });
              img.addEventListener("error", onDone, { once: true });
            });
          }

          if (typeof img.decode === "function") {
            try {
              await img.decode();
            } catch {}
          }
        }),
      );

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });
    });
  }

  private async generateSlides(
    topic: string,
    pageCount: PresentationPageCount,
    language: PresentationLanguage,
    briefAnswers?: Partial<PresentationBriefAnswers>,
  ): Promise<PresentationSlide[]> {
    const openAiApiKey = this.readTrimmedConfig("OPENAI_API_KEY");
    const geminiApiKeys = this.getGeminiApiKeys();

    if (!openAiApiKey && geminiApiKeys.length === 0) {
      this.logger.warn(
        "OPENAI_API_KEY yoki GEMINI_API_KEY/GOOGLE_API_KEY topilmadi, fallback kontent ishlatiladi.",
      );
      return this.buildFallbackSlides(topic, pageCount, language);
    }

    if (openAiApiKey) {
      try {
        return await this.generateSlidesWithOpenAi(
          topic,
          pageCount,
          language,
          briefAnswers,
          openAiApiKey,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Noma'lum xatolik";
        this.logger.warn(`OpenAI'dan kontent olishda xatolik: ${message}`);

        if (geminiApiKeys.length === 0) {
          return this.buildFallbackSlides(topic, pageCount, language);
        }

        this.logger.warn(
          "Gemini API mavjud, Gemini orqali qayta urinish qilinadi.",
        );
      }
    }

    for (let index = 0; index < geminiApiKeys.length; index += 1) {
      const geminiApiKey = geminiApiKeys[index];

      try {
        return await this.generateSlidesWithGemini(
          topic,
          pageCount,
          language,
          briefAnswers,
          geminiApiKey,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Noma'lum xatolik";
        this.logger.warn(`Gemini'dan kontent olishda xatolik: ${message}`);

        const hasNextKey = index < geminiApiKeys.length - 1;
        if (!hasNextKey || !this.shouldTryNextGeminiApiKey(error)) {
          break;
        }

        this.logger.warn(
          "Gemini API kaliti yaroqsiz yoki cheklangan, keyingi kalit bilan qayta urinish qilinadi.",
        );
      }
    }

    return this.buildFallbackSlides(topic, pageCount, language);
  }

  private async attachImagesToSlides(
    topic: string,
    slides: PresentationSlide[],
    language: PresentationLanguage,
  ): Promise<PresentationSlide[]> {
    const serperApiKeys = this.getSerperApiKeys();

    if (serperApiKeys.length === 0) {
      this.logger.warn(
        "SERPER_API_KEY(,SERPER_API) topilmadi, slaydlar rasmsiz yaratiladi.",
      );
      return slides;
    }

    const updatedSlides: PresentationSlide[] = [];
    let shouldStopImageSearch = false;

    for (const slide of slides) {
      if (shouldStopImageSearch) {
        updatedSlides.push(slide);
        continue;
      }

      try {
        const imageUrl = await this.fetchSerperImageForSlide(
          topic,
          slide,
          serperApiKeys,
          language,
        );
        updatedSlides.push(imageUrl ? { ...slide, imageUrl } : slide);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Noma'lum xatolik";
        this.logger.warn(
          `Serper orqali rasm olishda xatolik (slide ${slide.pageNumber}): ${message}`,
        );

        if (this.isSerperPermissionError(error)) {
          shouldStopImageSearch = true;
          this.logger.warn(
            "Serper API ruxsat yoki limit xatosi sabab qolgan slaydlar uchun rasm qidiruvi to'xtatildi.",
          );
        }

        updatedSlides.push(slide);
      }
    }

    return updatedSlides;
  }

  private async fetchSerperImageForSlide(
    topic: string,
    slide: PresentationSlide,
    apiKeys: string[],
    language: PresentationLanguage,
  ): Promise<string | undefined> {
    const correctedParams = await this.buildImageSearchParams(
      topic,
      slide,
      language,
    );
    const queryCandidates = [
      correctedParams.query,
      this.buildImageSearchQuery(topic, slide),
      slide.title,
      topic,
    ];
    const uniqueQueryCandidates = [...new Set(queryCandidates)];

    let imageUrl: string | undefined;
    for (const candidate of uniqueQueryCandidates) {
      const query = candidate.replace(/\s+/g, " ").trim().slice(0, 120);
      if (!query) {
        continue;
      }

      for (let index = 0; index < apiKeys.length; index += 1) {
        const apiKey = apiKeys[index];

        try {
          imageUrl = await this.searchSerperImage(
            query,
            apiKey,
            correctedParams.gl,
            correctedParams.hl,
          );
          if (imageUrl) {
            break;
          }
        } catch (error) {
          if (!this.isSerperPermissionError(error)) {
            const message =
              error instanceof Error ? error.message : "Noma'lum xatolik";
            const maskedKey = apiKey.slice(-4);
            this.logger.warn(
              `Serper image search error (query: "${query}", gl: "${correctedParams.gl}", hl: "${correctedParams.hl}", key: ...${maskedKey}): ${message}`,
            );
            continue;
          }

          const hasNextKey = index < apiKeys.length - 1;
          if (hasNextKey) {
            this.logger.warn(
              "Serper API kaliti cheklangan yoki bloklangan, keyingi kalit bilan qayta urinish qilinadi.",
            );
            continue;
          }

          throw error;
        }
      }

      if (imageUrl) {
        break;
      }
    }

    if (!imageUrl) {
      return undefined;
    }

    try {
      return await this.fetchImageAsDataUrl(imageUrl);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Noma'lum xatolik";
      this.logger.warn(
        `Rasmni data URL ga aylantirishda xatolik (slide ${slide.pageNumber}): ${message}`,
      );
      return imageUrl;
    }
  }

  private async buildImageSearchParams(
    topic: string,
    slide: PresentationSlide,
    language: PresentationLanguage,
  ): Promise<ImageSearchParams> {
    const fallback: ImageSearchParams = {
      query: this.buildImageSearchQuery(topic, slide),
      ...this.getDefaultSerperLocale(language),
    };

    const openAiApiKey = this.readTrimmedConfig("OPENAI_API_KEY");
    const geminiApiKeys = this.getGeminiApiKeys();

    if (openAiApiKey) {
      try {
        return await this.normalizeImageSearchParamsWithOpenAi(
          topic,
          slide,
          language,
          openAiApiKey,
          fallback,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Noma'lum xatolik";
        this.logger.warn(
          `OpenAI image qidiruv parametrlarini tuzatishda xatolik: ${message}`,
        );
      }
    }

    for (let index = 0; index < geminiApiKeys.length; index += 1) {
      const geminiApiKey = geminiApiKeys[index];

      try {
        return await this.normalizeImageSearchParamsWithGemini(
          topic,
          slide,
          language,
          geminiApiKey,
          fallback,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Noma'lum xatolik";
        this.logger.warn(
          `Gemini image qidiruv parametrlarini tuzatishda xatolik: ${message}`,
        );

        const hasNextKey = index < geminiApiKeys.length - 1;
        if (!hasNextKey || !this.shouldTryNextGeminiApiKey(error)) {
          break;
        }

        this.logger.warn(
          "Gemini API kaliti yaroqsiz yoki cheklangan, keyingi kalit bilan qayta urinish qilinadi.",
        );
      }
    }

    return fallback;
  }

  private async normalizeImageSearchParamsWithOpenAi(
    topic: string,
    slide: PresentationSlide,
    language: PresentationLanguage,
    apiKey: string,
    fallback: ImageSearchParams,
  ): Promise<ImageSearchParams> {
    const model =
      this.configService.get<string>("OPENAI_MODEL") ?? "gpt-4o-mini";

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'You optimize image search parameters for Serper API. Correct spelling and intent, output concise image-friendly query, and choose best gl (country code) and hl (language code). Return only JSON with shape {"query":string,"gl":string,"hl":string}.',
          },
          {
            role: "user",
            content: this.buildImageSearchNormalizationPrompt(
              topic,
              slide,
              language,
            ),
          },
        ],
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`OpenAI API xatosi: ${response.status} ${details}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("OpenAI image qidiruv parametrlari bo'sh qaytdi.");
    }

    return this.parseImageSearchParams(content, "OpenAI", fallback);
  }

  private async normalizeImageSearchParamsWithGemini(
    topic: string,
    slide: PresentationSlide,
    language: PresentationLanguage,
    apiKey: string,
    fallback: ImageSearchParams,
  ): Promise<ImageSearchParams> {
    const model = this.getGeminiModel();
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: this.buildImageSearchNormalizationPrompt(
                  topic,
                  slide,
                  language,
                ),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              query: { type: "STRING" },
              gl: { type: "STRING" },
              hl: { type: "STRING" },
            },
            required: ["query", "gl", "hl"],
          },
        },
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new GeminiApiError(response.status, details);
    }

    const payload = (await response.json()) as GeminiGenerateContentResponse;
    const content = payload.candidates?.[0]?.content?.parts?.find(
      (part) => typeof part.text === "string" && part.text.trim().length > 0,
    )?.text;

    if (!content) {
      throw new Error("Gemini image qidiruv parametrlari bo'sh qaytdi.");
    }

    return this.parseImageSearchParams(content, "Gemini", fallback);
  }

  private parseImageSearchParams(
    content: string,
    provider: "OpenAI" | "Gemini",
    fallback: ImageSearchParams,
  ): ImageSearchParams {
    const parsed = JSON.parse(content) as {
      query?: unknown;
      gl?: unknown;
      hl?: unknown;
    };

    const query =
      typeof parsed.query === "string"
        ? parsed.query.replace(/\s+/g, " ").trim().slice(0, 120)
        : "";
    const normalizedQuery = query || fallback.query;
    const gl = this.normalizeSerperCountryCode(parsed.gl, fallback.gl);
    const hl = this.normalizeSerperLanguageCode(parsed.hl, fallback.hl);

    if (!normalizedQuery) {
      throw new Error(`${provider} image qidiruv natijasi yaroqsiz qaytdi.`);
    }

    return {
      query: normalizedQuery,
      gl,
      hl,
    };
  }

  private getDefaultSerperLocale(
    language: PresentationLanguage,
  ): Omit<ImageSearchParams, "query"> {
    switch (language) {
      case "ru":
        return { gl: "ru", hl: "ru" };
      case "en":
        return { gl: "us", hl: "en" };
      case "uz":
      default:
        return { gl: "uz", hl: "uz" };
    }
  }

  private normalizeSerperCountryCode(value: unknown, fallback: string): string {
    if (typeof value !== "string") {
      return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (/^[a-z]{2}$/.test(normalized)) {
      return normalized;
    }

    const parts = normalized.split(/[-_]/).filter((part) => part.length > 0);
    const region = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    return region && /^[a-z]{2}$/.test(region) ? region : fallback;
  }

  private normalizeSerperLanguageCode(
    value: unknown,
    fallback: string,
  ): string {
    if (typeof value !== "string") {
      return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (/^[a-z]{2}$/.test(normalized)) {
      return normalized;
    }

    const languagePart = normalized.split(/[-_]/)[0];
    return /^[a-z]{2}$/.test(languagePart) ? languagePart : fallback;
  }

  private buildImageSearchNormalizationPrompt(
    topic: string,
    slide: PresentationSlide,
    language: PresentationLanguage,
  ): string {
    const languageName = this.getPromptLanguageName(language);
    const defaultLocale = this.getDefaultSerperLocale(language);

    return [
      "Optimize Serper image search fields for this slide.",
      `Topic: "${topic}"`,
      `Slide title: "${slide.title}"`,
      `Slide summary: "${slide.summary}"`,
      `Target language: ${languageName}.`,
      "Requirements:",
      "- Correct spelling and grammar in the query.",
      "- Translate query to the target language when needed.",
      "- Query must be concise and suitable for image search.",
      "- Query length must be <= 120 characters.",
      "- gl must be a 2-letter lowercase country code.",
      "- hl must be a 2-letter lowercase language code.",
      `- If uncertain, prefer gl=${defaultLocale.gl} and hl=${defaultLocale.hl}.`,
      'Return only JSON: {"query":"...","gl":"..","hl":".."}',
    ].join("\n");
  }

  private async searchSerperImage(
    query: string,
    apiKey: string,
    gl: string,
    hl: string,
  ): Promise<string | undefined> {
    const response = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({
        q: query,
        gl,
        hl,
        num: 1,
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new SerperApiError(response.status, details);
    }

    const payload = (await response.json()) as SerperImageSearchResponse;
    return this.extractSerperImageUrl(payload);
  }

  private extractSerperImageUrl(
    payload: SerperImageSearchResponse,
  ): string | undefined {
    const image = payload.images?.find(
      (item) =>
        typeof item.imageUrl === "string" || typeof item.link === "string",
    );

    const rawUrl = image?.imageUrl ?? image?.link;
    return typeof rawUrl === "string" && rawUrl.trim().length > 0
      ? rawUrl.trim()
      : undefined;
  }

  private async fetchImageAsDataUrl(imageUrl: string): Promise<string> {
    const response = await fetch(imageUrl);

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `Rasmni yuklab olish xatosi: ${response.status} ${details}`,
      );
    }

    const contentTypeHeader = response.headers.get("content-type")?.trim();
    const mediaType =
      contentTypeHeader && contentTypeHeader.startsWith("image/")
        ? contentTypeHeader.split(";")[0]
        : "image/jpeg";
    const imageBuffer = Buffer.from(await response.arrayBuffer());

    return `data:${mediaType};base64,${imageBuffer.toString("base64")}`;
  }

  private buildImageSearchQuery(
    topic: string,
    slide: PresentationSlide,
  ): string {
    return `${topic} ${slide.title}`.replace(/\s+/g, " ").trim().slice(0, 120);
  }

  private async generateSlidesWithOpenAi(
    topic: string,
    pageCount: PresentationPageCount,
    language: PresentationLanguage,
    briefAnswers: Partial<PresentationBriefAnswers> | undefined,
    apiKey: string,
  ): Promise<PresentationSlide[]> {
    const model =
      this.configService.get<string>("OPENAI_MODEL") ?? "gpt-4o-mini";

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'You are an expert presentation writer. Normalize the topic intent by fixing spelling and translating to the requested target language when needed. Write every output field strictly in the target language and never mix languages except unavoidable proper nouns. Return only JSON with shape {"slides":[{"title":string,"summary":string,"bullets":string[]}]}.',
          },
          {
            role: "user",
            content: this.buildSlideRequestPrompt(
              topic,
              pageCount,
              language,
              briefAnswers,
            ),
          },
        ],
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`OpenAI API xatosi: ${response.status} ${details}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI javobi bo'sh qaytdi.");
    }

    return this.parseAiSlides(content, pageCount, "OpenAI", language);
  }

  private async generateSlidesWithGemini(
    topic: string,
    pageCount: PresentationPageCount,
    language: PresentationLanguage,
    briefAnswers: Partial<PresentationBriefAnswers> | undefined,
    apiKey: string,
  ): Promise<PresentationSlide[]> {
    const model = this.getGeminiModel();
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: this.buildSlideRequestPrompt(
                  topic,
                  pageCount,
                  language,
                  briefAnswers,
                ),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              slides: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    title: { type: "STRING" },
                    summary: { type: "STRING" },
                    bullets: {
                      type: "ARRAY",
                      items: { type: "STRING" },
                    },
                  },
                  required: ["title", "summary", "bullets"],
                },
              },
            },
            required: ["slides"],
          },
        },
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new GeminiApiError(response.status, details);
    }

    const payload = (await response.json()) as GeminiGenerateContentResponse;
    const content = payload.candidates?.[0]?.content?.parts?.find(
      (part) => typeof part.text === "string" && part.text.trim().length > 0,
    )?.text;

    if (!content) {
      throw new Error("Gemini javobi bo'sh qaytdi.");
    }

    return this.parseAiSlides(content, pageCount, "Gemini", language);
  }

  private async normalizeTopicWithOpenAi(
    topic: string,
    language: PresentationLanguage,
    apiKey: string,
  ): Promise<string> {
    const model =
      this.configService.get<string>("OPENAI_MODEL") ?? "gpt-4o-mini";

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'You normalize presentation topics. Fix spelling and grammar, infer intended meaning from noisy text, and translate fully into the requested language when needed. Return only JSON with shape {"normalizedTopic":string}. The normalizedTopic must be written strictly in the requested language and must not mix with the source language, except unavoidable proper nouns.',
          },
          {
            role: "user",
            content: this.buildTopicNormalizationPrompt(topic, language),
          },
        ],
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`OpenAI API xatosi: ${response.status} ${details}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI topic normalizatsiyasi bo'sh qaytdi.");
    }

    return this.parseNormalizedTopic(content, "OpenAI");
  }

  private async normalizeTopicWithGemini(
    topic: string,
    language: PresentationLanguage,
    apiKey: string,
  ): Promise<string> {
    const model = this.getGeminiModel();
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: this.buildTopicNormalizationPrompt(topic, language),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              normalizedTopic: { type: "STRING" },
            },
            required: ["normalizedTopic"],
          },
        },
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new GeminiApiError(response.status, details);
    }

    const payload = (await response.json()) as GeminiGenerateContentResponse;
    const content = payload.candidates?.[0]?.content?.parts?.find(
      (part) => typeof part.text === "string" && part.text.trim().length > 0,
    )?.text;

    if (!content) {
      throw new Error("Gemini topic normalizatsiyasi bo'sh qaytdi.");
    }

    return this.parseNormalizedTopic(content, "Gemini");
  }

  private buildSlideRequestPrompt(
    topic: string,
    pageCount: PresentationPageCount,
    language: PresentationLanguage,
    briefAnswers?: Partial<PresentationBriefAnswers>,
  ): string {
    const languageName = this.getPromptLanguageName(language);
    const briefContext = this.buildBriefContextPrompt(briefAnswers);

    return [
      `Create ${pageCount} slide pages for the topic: "${topic}".`,
      `Target language: ${languageName}.`,
      ...(briefContext.length > 0
        ? [
            "Audience and presentation context:",
            ...briefContext,
            "Use this context to tune tone, examples, and level of detail.",
          ]
        : []),
      "Rules:",
      `- Write all slide text strictly in ${languageName}.`,
      "- Do not use words from other languages except unavoidable proper nouns.",
      "- If the topic appears misspelled or written in another language, internally correct and adapt it to the target language before writing slides.",
      "- Keep each summary to 1-2 sentences.",
      "- Provide exactly 4 concise bullets per slide.",
      "- Return only valid JSON matching the required schema.",
    ].join("\n");
  }

  private buildBriefContextPrompt(
    briefAnswers?: Partial<PresentationBriefAnswers>,
  ): string[] {
    if (!briefAnswers) {
      return [];
    }

    const lines = [
      ["- Target audience", briefAnswers.targetAudience],
      ["- Presented by", briefAnswers.presenterRole],
      ["- Primary goal", briefAnswers.presentationGoal],
      ["- Tone/style", briefAnswers.toneStyle],
    ]
      .filter((entry): entry is [string, string] => {
        const value = entry[1];
        return typeof value === "string" && value.trim().length > 0;
      })
      .map(([label, value]) => `${label}: ${value.trim()}`);

    return lines;
  }

  private hasAllBriefAnswers(
    briefAnswers: Partial<PresentationBriefAnswers> | undefined,
    requiredKeys: readonly PresentationBriefAnswerKey[],
  ): briefAnswers is PresentationBriefAnswers {
    if (!briefAnswers) {
      return false;
    }

    return requiredKeys.every((key) => {
      const value = briefAnswers[key];
      return typeof value === "string" && value.trim().length > 0;
    });
  }

  private buildTopicNormalizationPrompt(
    topic: string,
    language: PresentationLanguage,
  ): string {
    const languageName = this.getPromptLanguageName(language);

    return [
      `Normalize this presentation topic into ${languageName}: "${topic}"`,
      "Requirements:",
      "- Fix spelling and grammar mistakes.",
      "- Infer the intended meaning even if words are noisy/transliterated.",
      "- If input language is different, translate fully to the target language.",
      "- Keep it concise and natural as a presentation theme.",
      "- Output must contain only the target language, except unavoidable proper nouns.",
      'Return only JSON: {"normalizedTopic":"..."}',
    ].join("\n");
  }

  private parseNormalizedTopic(
    content: string,
    provider: "OpenAI" | "Gemini",
  ): string {
    const parsed = JSON.parse(content) as { normalizedTopic?: unknown };
    const normalizedTopic =
      typeof parsed.normalizedTopic === "string"
        ? parsed.normalizedTopic.trim()
        : "";

    if (!normalizedTopic) {
      throw new Error(`${provider} normalizatsiya natijasi yaroqsiz qaytdi.`);
    }

    return normalizedTopic;
  }

  private parseAiSlides(
    content: string,
    pageCount: PresentationPageCount,
    provider: "OpenAI" | "Gemini",
    language: PresentationLanguage,
  ): PresentationSlide[] {
    const parsed = JSON.parse(content) as { slides?: unknown };
    const aiSlides = this.normalizeSlides(parsed.slides, pageCount, language);
    if (aiSlides.length === pageCount) {
      return aiSlides;
    }

    throw new Error(`${provider} qaytargan slaydlar soni noto'g'ri.`);
  }

  private normalizeSlides(
    slides: unknown,
    pageCount: number,
    language: PresentationLanguage,
  ): PresentationSlide[] {
    if (!Array.isArray(slides)) {
      return [];
    }

    const locale = this.getSlideLocale(language);

    return slides.slice(0, pageCount).map((item, index) => {
      const safeItem =
        typeof item === "object" && item !== null
          ? (item as {
              title?: unknown;
              summary?: unknown;
              bullets?: unknown;
            })
          : {};

      const title =
        typeof safeItem.title === "string" && safeItem.title.trim().length > 0
          ? safeItem.title.trim()
          : `${locale.sectionLabel} ${index + 1}`;
      const summary =
        typeof safeItem.summary === "string" &&
        safeItem.summary.trim().length > 0
          ? safeItem.summary.trim()
          : locale.defaultSummary;
      const bullets = Array.isArray(safeItem.bullets)
        ? safeItem.bullets
            .filter(
              (bullet): bullet is string =>
                typeof bullet === "string" && bullet.trim().length > 0,
            )
            .slice(0, 5)
        : [];

      const filledBullets =
        bullets.length > 0 ? bullets : locale.defaultBullets;

      return {
        pageNumber: index + 1,
        title,
        summary,
        bullets: filledBullets,
        content: this.buildSlideHtmlContent(summary, filledBullets),
      };
    });
  }

  private buildFallbackSlides(
    topic: string,
    pageCount: number,
    language: PresentationLanguage,
  ): PresentationSlide[] {
    const locale = this.getSlideLocale(language);

    return Array.from({ length: pageCount }).map((_, index) => {
      const summary = this.buildFallbackSummary(
        topic,
        locale.sections[index],
        language,
      );
      const bullets = locale.fallbackBullets(topic);

      return {
        pageNumber: index + 1,
        title: locale.sections[index] ?? `${locale.sectionLabel} ${index + 1}`,
        summary,
        bullets,
        content: this.buildSlideHtmlContent(summary, bullets),
      };
    });
  }

  private buildFallbackSummary(
    topic: string,
    section: string | undefined,
    language: PresentationLanguage,
  ): string {
    const sectionText = section?.toLowerCase();

    switch (language) {
      case "ru":
        return `По теме "${topic}" раскрывается раздел ${sectionText ? `«${sectionText}»` : "с ключевыми аспектами"}. Эта страница структурированно показывает основные идеи презентации.`;
      case "en":
        return `For the topic "${topic}", this slide covers ${sectionText ?? "the key section"}. It presents the most important points in a clear and structured way.`;
      case "uz":
      default:
        return `"${topic}" mavzusi bo'yicha ${sectionText ?? "asosiy bo'lim"} yoritiladi. Ushbu sahifa taqdimotning muhim nuqtalarini tartibli ko'rsatadi.`;
    }
  }

  private getSlideLocale(language: PresentationLanguage): {
    sectionLabel: string;
    defaultSummary: string;
    defaultBullets: string[];
    sections: string[];
    fallbackBullets: (topic: string) => string[];
  } {
    switch (language) {
      case "ru":
        return {
          sectionLabel: "Раздел",
          defaultSummary: "Этот раздел раскрывает ключевые аспекты темы.",
          defaultBullets: [
            "Объясняются основные понятия",
            "Показываются практические примеры",
            "Сравниваются проблемы и решения",
            "Подводятся краткие итоги",
          ],
          sections: [
            "Введение и контекст",
            "Ключевые понятия",
            "Анализ и проблемы",
            "Стратегия",
            "Практические примеры",
            "Результаты",
            "Рекомендации",
            "Выводы и следующие шаги",
          ],
          fallbackBullets: (topic: string) => [
            `Ключевая идея по теме ${topic}`,
            "Анализ проблем и возможностей",
            "Краткий практический подход",
            "Предложение для достижения результата",
          ],
        };
      case "en":
        return {
          sectionLabel: "Section",
          defaultSummary:
            "This section highlights the core aspects of the topic.",
          defaultBullets: [
            "Core concepts are explained",
            "Practical examples are shown",
            "Problems and solutions are compared",
            "Key takeaways are summarized",
          ],
          sections: [
            "Introduction and context",
            "Core concepts",
            "Analysis and challenges",
            "Strategy",
            "Practical examples",
            "Results",
            "Recommendations",
            "Conclusion and next steps",
          ],
          fallbackBullets: (topic: string) => [
            `Core idea related to ${topic}`,
            "Analysis of challenges and opportunities",
            "Short practical approach",
            "Proposal to drive measurable outcomes",
          ],
        };
      case "uz":
      default:
        return {
          sectionLabel: "Bo'lim",
          defaultSummary:
            "Mazkur bo'lim mavzuning asosiy jihatlarini yoritadi.",
          defaultBullets: [
            "Asosiy tushunchalar izohlanadi",
            "Amaliy qo'llash misollari beriladi",
            "Muammolar va yechimlar solishtiriladi",
            "Natijalar qisqacha yakunlanadi",
          ],
          sections: [
            "Kirish va kontekst",
            "Asosiy tushunchalar",
            "Tahlil va muammolar",
            "Strategiya",
            "Amaliy misollar",
            "Natijalar",
            "Tavsiyalar",
            "Xulosa va keyingi qadamlar",
          ],
          fallbackBullets: (topic: string) => [
            `${topic} bo'yicha asosiy g'oya`,
            "Muammo va imkoniyatlar tahlili",
            "Qisqa amaliy yondashuv",
            "Natijaga olib boruvchi taklif",
          ],
        };
    }
  }

  private getPromptLanguageName(language: PresentationLanguage): string {
    switch (language) {
      case "ru":
        return "Russian";
      case "en":
        return "English";
      case "uz":
      default:
        return "Uzbek";
    }
  }

  private async resolveTemplatePath(
    templateId: PresentationTemplateId,
  ): Promise<string> {
    const templatesDir = this.resolveTemplatesDir();
    const templateIndex = templateId - 1;
    const preferredTemplate =
      PresentationService.NAMED_TEMPLATE_FILES[templateIndex];

    if (preferredTemplate) {
      const preferredPath = join(templatesDir, preferredTemplate);
      if (await this.fileExists(preferredPath)) {
        return preferredPath;
      }
    }

    const legacyTemplate =
      PresentationService.LEGACY_TEMPLATE_FILES[templateIndex];
    if (legacyTemplate) {
      const legacyPath = join(templatesDir, legacyTemplate);
      if (await this.fileExists(legacyPath)) {
        return legacyPath;
      }
    }

    const dynamicTemplates = (await readdir(templatesDir))
      .filter((fileName) => fileName.toLowerCase().endsWith(".hbs"))
      .sort((left, right) => left.localeCompare(right));

    const dynamicTemplate = dynamicTemplates[templateIndex];
    if (dynamicTemplate) {
      return join(templatesDir, dynamicTemplate);
    }

    throw new Error(`Template topilmadi (id: ${templateId}).`);
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private buildSlideHtmlContent(summary: string, bullets: string[]): string {
    const escapedSummary = this.escapeHtml(summary);
    const bulletItems = bullets
      .map((bullet) => `<li>${this.escapeHtml(bullet)}</li>`)
      .join("");

    return `<p>${escapedSummary}</p><ul>${bulletItems}</ul>`;
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  private resolveTemplatesDir(): string {
    const distPath = resolve(__dirname, "..", "..", "templates");
    const srcRuntimePath = resolve(__dirname, "..", "templates");
    const srcPath = resolve(process.cwd(), "src", "templates");

    if (existsSync(distPath)) {
      return distPath;
    }

    if (existsSync(srcRuntimePath)) {
      return srcRuntimePath;
    }

    return srcPath;
  }

  private formatDate(date: Date): string {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tashkent",
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(date);
  }

  private buildPdfName(topic: string): string {
    const slug = topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);

    const dateSuffix = this.formatDateForFileName(new Date());
    return `${slug || "presentation"}-${dateSuffix}.pdf`;
  }

  private formatDateForFileName(date: Date): string {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tashkent",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);

    const day = parts.find((part) => part.type === "day")?.value ?? "01";
    const month = parts.find((part) => part.type === "month")?.value ?? "01";
    const year = parts.find((part) => part.type === "year")?.value ?? "1970";

    return `${year}-${month}-${day}`;
  }
}
