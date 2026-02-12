import { ConfigService } from "@nestjs/config";

export const DEFAULT_TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";

export type TelegramWebhookConfig = {
  domain: string;
  path: string;
  secretToken?: string;
};

export function resolveTelegramWebhookPath(value: string | undefined): string {
  const normalized = value?.trim();

  if (!normalized) {
    return DEFAULT_TELEGRAM_WEBHOOK_PATH;
  }

  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function resolveTelegramWebhookConfig(
  configService: ConfigService,
): TelegramWebhookConfig {
  const domain = configService.get<string>("TELEGRAM_WEBHOOK_DOMAIN")?.trim();

  if (!domain) {
    throw new Error("TELEGRAM_WEBHOOK_DOMAIN talab qilinadi");
  }

  const path = resolveTelegramWebhookPath(
    configService.get<string>("TELEGRAM_WEBHOOK_PATH"),
  );
  const secretToken =
    configService.get<string>("TELEGRAM_WEBHOOK_SECRET_TOKEN")?.trim() ||
    undefined;

  return {
    domain,
    path,
    secretToken,
  };
}
