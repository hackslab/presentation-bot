import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getBotToken } from "nestjs-telegraf";
import { Telegraf } from "telegraf";
import { AppModule } from "./app.module";
import { resolveTelegramWebhookPath } from "./telegram/telegram-webhook.config";

async function bootstrap() {
  const logger = new Logger("Bootstrap");

  process.on("unhandledRejection", (reason) => {
    logger.error(
      "Unhandled promise rejection aniqlandi.",
      reason instanceof Error ? reason.stack : String(reason),
    );
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception aniqlandi.", error.stack);
  });

  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const webhookPath = resolveTelegramWebhookPath(
    configService.get<string>("TELEGRAM_WEBHOOK_PATH"),
  );
  const webhookSecretToken =
    configService.get<string>("TELEGRAM_WEBHOOK_SECRET_TOKEN")?.trim() ||
    undefined;

  const bot = app.get<Telegraf>(getBotToken());
  app.use(
    bot.webhookCallback(webhookPath, {
      secretToken: webhookSecretToken,
    }),
  );

  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();