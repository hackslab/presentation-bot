import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../database/database.service";
import { telegramUsers } from "../database/schema";

type TelegramProfile = {
  id: number;
  username?: string;
  first_name: string;
};

@Injectable()
export class TelegramService {
  private static readonly DAILY_GENERATION_LIMIT = 3;

  constructor(private readonly databaseService: DatabaseService) {}

  async registerUser(profile: TelegramProfile): Promise<void> {
    await this.databaseService.db
      .insert(telegramUsers)
      .values({
        telegramId: String(profile.id),
        username: profile.username,
        firstName: profile.first_name,
        phoneNumber: null,
        generationCount: 0,
        generationCountDate: null,
      })
      .onConflictDoUpdate({
        target: telegramUsers.telegramId,
        set: {
          username: profile.username,
          firstName: profile.first_name,
        },
      });
  }

  async consumeGeneration(telegramId: number): Promise<{
    allowed: boolean;
    usedToday: number;
    remainingToday: number;
    dailyLimit: number;
  }> {
    const user = await this.databaseService.db.query.telegramUsers.findFirst({
      where: eq(telegramUsers.telegramId, String(telegramId)),
    });

    if (!user) {
      throw new Error("User is not registered.");
    }

    const today = this.getTodayDate();
    const currentCount =
      user.generationCountDate === today ? user.generationCount : 0;

    if (currentCount >= TelegramService.DAILY_GENERATION_LIMIT) {
      return {
        allowed: false,
        usedToday: currentCount,
        remainingToday: 0,
        dailyLimit: TelegramService.DAILY_GENERATION_LIMIT,
      };
    }

    const nextCount = currentCount + 1;

    await this.databaseService.db
      .update(telegramUsers)
      .set({
        generationCount: nextCount,
        generationCountDate: today,
      })
      .where(eq(telegramUsers.telegramId, String(telegramId)));

    return {
      allowed: true,
      usedToday: nextCount,
      remainingToday: TelegramService.DAILY_GENERATION_LIMIT - nextCount,
      dailyLimit: TelegramService.DAILY_GENERATION_LIMIT,
    };
  }

  async getProfileStatus(telegramId: number): Promise<{
    username: string | null;
    firstName: string | null;
    usedToday: number;
    remainingToday: number;
    dailyLimit: number;
  }> {
    const user = await this.databaseService.db.query.telegramUsers.findFirst({
      where: eq(telegramUsers.telegramId, String(telegramId)),
    });

    if (!user) {
      throw new Error("User is not registered.");
    }

    const today = this.getTodayDate();
    const usedToday =
      user.generationCountDate === today ? user.generationCount : 0;

    return {
      username: user.username,
      firstName: user.firstName,
      usedToday,
      remainingToday: Math.max(
        TelegramService.DAILY_GENERATION_LIMIT - usedToday,
        0,
      ),
      dailyLimit: TelegramService.DAILY_GENERATION_LIMIT,
    };
  }

  private getTodayDate(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
