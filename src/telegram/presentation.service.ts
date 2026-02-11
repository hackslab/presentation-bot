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
import Handlebars from "handlebars";
import puppeteer from "puppeteer";

export type PresentationTemplateId = 1 | 2 | 3 | 4;
export type PresentationPageCount = 4 | 6 | 8;
export type PresentationLanguage = "uz" | "ru" | "en";

type PresentationFlowStep =
  | "awaiting_language"
  | "awaiting_topic"
  | "awaiting_template"
  | "awaiting_page_count"
  | "generating";

type PresentationFlowState = {
  step: PresentationFlowStep;
  language?: PresentationLanguage;
  topic?: string;
  templateId?: PresentationTemplateId;
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

  getFlow(telegramId: number): PresentationFlowState | undefined {
    return this.flows.get(telegramId);
  }

  setTopic(telegramId: number, topic: string): boolean {
    const state = this.flows.get(telegramId);
    if (!state || state.step !== "awaiting_topic" || !state.language) {
      return false;
    }

    this.flows.set(telegramId, {
      step: "awaiting_template",
      language: state.language,
      topic,
    });
    return true;
  }

  setTemplate(telegramId: number, templateId: PresentationTemplateId): boolean {
    const state = this.flows.get(telegramId);
    if (
      !state ||
      state.step !== "awaiting_template" ||
      !state.topic ||
      !state.language
    ) {
      return false;
    }

    this.flows.set(telegramId, {
      step: "awaiting_page_count",
      language: state.language,
      topic: state.topic,
      templateId,
    });
    return true;
  }

  setGenerating(telegramId: number): PresentationFlowState | undefined {
    const state = this.flows.get(telegramId);
    if (
      !state ||
      state.step !== "awaiting_page_count" ||
      !state.language ||
      !state.topic ||
      !state.templateId
    ) {
      return undefined;
    }

    const updatedState: PresentationFlowState = {
      step: "generating",
      language: state.language,
      topic: state.topic,
      templateId: state.templateId,
    };

    this.flows.set(telegramId, updatedState);
    return updatedState;
  }

  clearFlow(telegramId: number): void {
    this.flows.delete(telegramId);
  }

  getTemplatePreviewPath(): string {
    return join(this.resolveTemplatesDir(), "templates.png");
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
  }): Promise<GeneratedPresentation> {
    const normalizedTopic = await this.normalizeTopicForLanguage(
      options.topic,
      options.language,
    );
    const slides = await this.generateSlides(
      normalizedTopic,
      options.pageCount,
      options.language,
    );
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

  private async normalizeTopicForLanguage(
    topic: string,
    language: PresentationLanguage,
  ): Promise<string> {
    const fallbackTopic = topic.trim();
    if (!fallbackTopic) {
      return topic;
    }

    const openAiApiKey = this.configService.get<string>("OPENAI_API_KEY");
    const geminiApiKey =
      this.configService.get<string>("GEMINI_API_KEY") ??
      this.configService.get<string>("GOOGLE_API_KEY");

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

    if (geminiApiKey) {
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

  private async convertHtmlToPdf(
    html: string,
    outputPath: string,
  ): Promise<void> {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      this.logger.debug(`HTML Length: ${html.length}`);
      this.logger.debug(`HTML Content Peak: ${html.substring(0, 500)}`);

      const page = await browser.newPage();
      await page.setContent(html, {
        waitUntil: "networkidle2",
        timeout: 60000,
      });
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
      await browser.close();
    }
  }

  private async generateSlides(
    topic: string,
    pageCount: PresentationPageCount,
    language: PresentationLanguage,
  ): Promise<PresentationSlide[]> {
    const openAiApiKey = this.configService.get<string>("OPENAI_API_KEY");
    const geminiApiKey =
      this.configService.get<string>("GEMINI_API_KEY") ??
      this.configService.get<string>("GOOGLE_API_KEY");

    if (!openAiApiKey && !geminiApiKey) {
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
          openAiApiKey,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Noma'lum xatolik";
        this.logger.warn(`OpenAI'dan kontent olishda xatolik: ${message}`);

        if (!geminiApiKey) {
          return this.buildFallbackSlides(topic, pageCount, language);
        }

        this.logger.warn(
          "Gemini API mavjud, Gemini orqali qayta urinish qilinadi.",
        );
      }
    }

    if (geminiApiKey) {
      try {
        return await this.generateSlidesWithGemini(
          topic,
          pageCount,
          language,
          geminiApiKey,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Noma'lum xatolik";
        this.logger.warn(`Gemini'dan kontent olishda xatolik: ${message}`);
      }
    }

    return this.buildFallbackSlides(topic, pageCount, language);
  }

  private async generateSlidesWithOpenAi(
    topic: string,
    pageCount: PresentationPageCount,
    language: PresentationLanguage,
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
            content: this.buildSlideRequestPrompt(topic, pageCount, language),
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
    apiKey: string,
  ): Promise<PresentationSlide[]> {
    const model =
      this.configService.get<string>("GEMINI_MODEL") ?? "gemini-2.5-flash";
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
                text: this.buildSlideRequestPrompt(topic, pageCount, language),
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
      throw new Error(`Gemini API xatosi: ${response.status} ${details}`);
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
    const model =
      this.configService.get<string>("GEMINI_MODEL") ?? "gemini-2.5-flash";
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
      throw new Error(`Gemini API xatosi: ${response.status} ${details}`);
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
  ): string {
    const languageName = this.getPromptLanguageName(language);

    return [
      `Create ${pageCount} slide pages for the topic: "${topic}".`,
      `Target language: ${languageName}.`,
      "Rules:",
      `- Write all slide text strictly in ${languageName}.`,
      "- Do not use words from other languages except unavoidable proper nouns.",
      "- If the topic appears misspelled or written in another language, internally correct and adapt it to the target language before writing slides.",
      "- Keep each summary to 1-2 sentences.",
      "- Provide exactly 4 concise bullets per slide.",
      "- Return only valid JSON matching the required schema.",
    ].join("\n");
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

    const dateSuffix = new Date().toISOString().slice(0, 10);
    return `${slug || "presentation"}-${dateSuffix}.pdf`;
  }
}
