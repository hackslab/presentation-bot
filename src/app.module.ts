import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TelegrafModule } from "nestjs-telegraf";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { DatabaseModule } from "./database/database.module";
import { TelegramBotModule } from "./telegram/telegram.module";
import { resolveTelegramWebhookConfig } from "./telegram/telegram-webhook.config";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const isTest = configService.get("NODE_ENV") === "test";
        const token = configService.get<string>("TELEGRAM_BOT_TOKEN");

        if (!token && !isTest) {
          throw new Error("TELEGRAM_BOT_TOKEN talab qilinadi");
        }

        const resolvedToken = token ?? "000000:TEST_TOKEN";

        if (isTest) {
          return {
            token: resolvedToken,
            launchOptions: false,
          };
        }

        const webhook = resolveTelegramWebhookConfig(configService);

        return {
          token: resolvedToken,
          launchOptions: {
            dropPendingUpdates: true,
            webhook: {
              domain: webhook.domain,
              path: webhook.path,
              secretToken: webhook.secretToken,
            },
          },
        };
      },
    }),
    TelegramBotModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
