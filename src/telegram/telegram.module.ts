import { Module } from "@nestjs/common";
import { PresentationService } from "./presentation.service";
import { TelegramService } from "./telegram.service";
import { TelegramUpdate } from "./telegram.update";

@Module({
  providers: [TelegramService, PresentationService, TelegramUpdate],
})
export class TelegramBotModule {}
