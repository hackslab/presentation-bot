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

type PresentationFlowStep =
  | "awaiting_topic"
  | "awaiting_template"
  | "awaiting_page_count"
  | "generating";

type PresentationFlowState = {
  step: PresentationFlowStep;
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
    this.flows.set(telegramId, { step: "awaiting_topic" });
  }

  getFlow(telegramId: number): PresentationFlowState | undefined {
    return this.flows.get(telegramId);
  }

  setTopic(telegramId: number, topic: string): boolean {
    const state = this.flows.get(telegramId);
    if (!state || state.step !== "awaiting_topic") {
      return false;
    }

    this.flows.set(telegramId, {
      step: "awaiting_template",
      topic,
    });
    return true;
  }

  setTemplate(telegramId: number, templateId: PresentationTemplateId): boolean {
    const state = this.flows.get(telegramId);
    if (!state || state.step !== "awaiting_template" || !state.topic) {
      return false;
    }

    this.flows.set(telegramId, {
      step: "awaiting_page_count",
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
      !state.topic ||
      !state.templateId
    ) {
      return undefined;
    }

    const updatedState: PresentationFlowState = {
      step: "generating",
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
    templateId: PresentationTemplateId;
    pageCount: PresentationPageCount;
  }): Promise<GeneratedPresentation> {
    const slides = await this.generateSlides(options.topic, options.pageCount);
    const html = await this.renderTemplate(options.templateId, {
      topic: options.topic,
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
        fileName: this.buildPdfName(options.topic),
      };
    } catch (error) {
      await this.cleanupTemporaryFiles(tempDir);
      throw error;
    }
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
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
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
  ): Promise<PresentationSlide[]> {
    const openAiApiKey = this.configService.get<string>("OPENAI_API_KEY");
    const geminiApiKey =
      this.configService.get<string>("GEMINI_API_KEY") ??
      this.configService.get<string>("GOOGLE_API_KEY");

    if (!openAiApiKey && !geminiApiKey) {
      this.logger.warn(
        "OPENAI_API_KEY yoki GEMINI_API_KEY/GOOGLE_API_KEY topilmadi, fallback kontent ishlatiladi.",
      );
      return this.buildFallbackSlides(topic, pageCount);
    }

    if (openAiApiKey) {
      try {
        return await this.generateSlidesWithOpenAi(
          topic,
          pageCount,
          openAiApiKey,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Noma'lum xatolik";
        this.logger.warn(`OpenAI'dan kontent olishda xatolik: ${message}`);

        if (!geminiApiKey) {
          return this.buildFallbackSlides(topic, pageCount);
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
          geminiApiKey,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Noma'lum xatolik";
        this.logger.warn(`Gemini'dan kontent olishda xatolik: ${message}`);
      }
    }

    return this.buildFallbackSlides(topic, pageCount);
  }

  private async generateSlidesWithOpenAi(
    topic: string,
    pageCount: PresentationPageCount,
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
              'You are a presentation writer. Return only JSON with shape {"slides":[{"title":string,"summary":string,"bullets":string[]}]}.',
          },
          {
            role: "user",
            content: this.buildSlideRequestPrompt(topic, pageCount),
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

    return this.parseAiSlides(content, pageCount, "OpenAI");
  }

  private async generateSlidesWithGemini(
    topic: string,
    pageCount: PresentationPageCount,
    apiKey: string,
  ): Promise<PresentationSlide[]> {
    const model =
      this.configService.get<string>("GEMINI_MODEL") ?? "gemini-1.5-flash";
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
                text: this.buildSlideRequestPrompt(topic, pageCount),
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

    return this.parseAiSlides(content, pageCount, "Gemini");
  }

  private buildSlideRequestPrompt(
    topic: string,
    pageCount: PresentationPageCount,
  ): string {
    return `Create ${pageCount} slide pages for the topic: "${topic}". Keep each summary to 1-2 sentences and provide 4 concise bullets per slide.`;
  }

  private parseAiSlides(
    content: string,
    pageCount: PresentationPageCount,
    provider: "OpenAI" | "Gemini",
  ): PresentationSlide[] {
    const parsed = JSON.parse(content) as { slides?: unknown };
    const aiSlides = this.normalizeSlides(parsed.slides, pageCount);
    if (aiSlides.length === pageCount) {
      return aiSlides;
    }

    throw new Error(`${provider} qaytargan slaydlar soni noto'g'ri.`);
  }

  private normalizeSlides(
    slides: unknown,
    pageCount: number,
  ): PresentationSlide[] {
    if (!Array.isArray(slides)) {
      return [];
    }

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
          : `Bo'lim ${index + 1}`;
      const summary =
        typeof safeItem.summary === "string" &&
        safeItem.summary.trim().length > 0
          ? safeItem.summary.trim()
          : "Mazkur bo'lim mavzuning asosiy jihatlarini yoritadi.";
      const bullets = Array.isArray(safeItem.bullets)
        ? safeItem.bullets
            .filter(
              (bullet): bullet is string =>
                typeof bullet === "string" && bullet.trim().length > 0,
            )
            .slice(0, 5)
        : [];

      const filledBullets =
        bullets.length > 0
          ? bullets
          : [
              "Asosiy tushunchalar izohlanadi",
              "Amaliy qo'llash misollari beriladi",
              "Muammolar va yechimlar solishtiriladi",
              "Natijalar qisqacha yakunlanadi",
            ];

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
  ): PresentationSlide[] {
    const sections = [
      "Kirish va kontekst",
      "Asosiy tushunchalar",
      "Tahlil va muammolar",
      "Strategiya",
      "Amaliy misollar",
      "Natijalar",
      "Tavsiyalar",
      "Xulosa va keyingi qadamlar",
    ];

    return Array.from({ length: pageCount }).map((_, index) => ({
      pageNumber: index + 1,
      title: sections[index] ?? `Bo'lim ${index + 1}`,
      summary: `"${topic}" mavzusi bo'yicha ${sections[index]?.toLowerCase() ?? "asosiy bo'lim"} yoritiladi. Ushbu sahifa taqdimotning muhim nuqtalarini tartibli ko'rsatadi.`,
      bullets: [
        `${topic} bo'yicha asosiy g'oya`,
        "Muammo va imkoniyatlar tahlili",
        "Qisqa amaliy yondashuv",
        "Natijaga olib boruvchi taklif",
      ],
      content: this.buildSlideHtmlContent(
        `"${topic}" mavzusi bo'yicha ${sections[index]?.toLowerCase() ?? "asosiy bo'lim"} yoritiladi. Ushbu sahifa taqdimotning muhim nuqtalarini tartibli ko'rsatadi.`,
        [
          `${topic} bo'yicha asosiy g'oya`,
          "Muammo va imkoniyatlar tahlili",
          "Qisqa amaliy yondashuv",
          "Natijaga olib boruvchi taklif",
        ],
      ),
    }));
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
