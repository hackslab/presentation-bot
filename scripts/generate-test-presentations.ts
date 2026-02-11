import "dotenv/config";
import { createReadStream } from "node:fs";
import { ConfigService } from "@nestjs/config";
import { Telegraf } from "telegraf";
import {
  type GeneratedPresentation,
  type PresentationLanguage,
  type PresentationPageCount,
  type PresentationTemplateId,
  PresentationService,
} from "../src/telegram/presentation.service";

const TEMPLATE_IDS: PresentationTemplateId[] = [1, 2, 3, 4];
const PAGE_COUNT: PresentationPageCount = 4;
const LANGUAGE: PresentationLanguage = "en";

async function main(): Promise<void> {
  const configService = new ConfigService();
  const botToken = configService.get<string>("TELEGRAM_BOT_TOKEN")?.trim();
  const adminIdRaw = configService.get<string>("ADMIN_ID")?.trim();

  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN topilmadi. .env faylni tekshiring.");
  }

  if (!adminIdRaw) {
    throw new Error("ADMIN_ID topilmadi. .env faylni tekshiring.");
  }

  const adminId = Number(adminIdRaw);
  if (!Number.isFinite(adminId)) {
    throw new Error("ADMIN_ID raqam bo'lishi kerak.");
  }

  const telegram = new Telegraf(botToken).telegram;
  const presentationService = new PresentationService(configService);
  const generatedPresentations: GeneratedPresentation[] = [];

  try {
    for (const templateId of TEMPLATE_IDS) {
      const topic = `Template ${templateId} QA preview`;
      console.log(
        `Generating template ${templateId} with ${PAGE_COUNT} pages...`,
      );

      const generated = await presentationService.generatePresentationPdf({
        topic,
        language: LANGUAGE,
        templateId,
        pageCount: PAGE_COUNT,
      });

      generatedPresentations.push(generated);

      await telegram.sendDocument(
        adminId,
        {
          source: createReadStream(generated.pdfPath),
          filename: generated.fileName,
        },
        {
          caption: `Template ${templateId} test presentation (${PAGE_COUNT} pages)`,
        },
      );

      console.log(`Sent template ${templateId}: ${generated.fileName}`);
    }

    console.log("Done. All template test presentations were sent to ADMIN_ID.");
  } finally {
    for (const generated of generatedPresentations) {
      try {
        await presentationService.cleanupTemporaryFiles(generated.tempDir);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Temp cleanup failed (${generated.tempDir}): ${message}`);
      }
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Script failed: ${message}`);
  process.exit(1);
});
