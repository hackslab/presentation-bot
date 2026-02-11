import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { telegramUsers } from "../database/schema";

type TelegramProfile = {
  id: number;
  username?: string;
  first_name: string;
};

@Injectable()
export class TelegramService {
  constructor(private readonly databaseService: DatabaseService) {}

  async registerUser(profile: TelegramProfile): Promise<void> {
    await this.databaseService.db
      .insert(telegramUsers)
      .values({
        telegramId: String(profile.id),
        username: profile.username,
        firstName: profile.first_name,
        phoneNumber: null,
      })
      .onConflictDoUpdate({
        target: telegramUsers.telegramId,
        set: {
          username: profile.username,
          firstName: profile.first_name,
        },
      });
  }
}
