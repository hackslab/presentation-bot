import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { and, count, eq, gte, ne, sql } from "drizzle-orm";
import { DatabaseService } from "../database/database.service";
import { presentations, telegramUsers } from "../database/schema";
import type { PresentationLanguage } from "./presentation.service";

type TelegramProfile = {
  id: number;
  username?: string;
  first_name: string;
};

type PresentationMetadata = {
  prompt?: string;
  language?: PresentationLanguage;
  templateId?: number;
  pageCount?: number;
  fileName?: string;
};

type GenerationQuota = {
  allowed: boolean;
  usedToday: number;
  remainingToday: number;
  dailyLimit: number;
  nextAvailableAt: Date | null;
};

type GenerationReservation = GenerationQuota & {
  reservationId: number | null;
};

@Injectable()
export class TelegramService implements OnModuleInit {
  private static readonly DAILY_GENERATION_LIMIT = 3;
  private static readonly RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
  private readonly logger = new Logger(TelegramService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    try {
      const recoveredReservations =
        await this.recoverPendingGenerationsAfterProcessFailure();

      if (recoveredReservations > 0) {
        this.logger.warn(
          `${recoveredReservations} ta pending generatsiya process uzilishi sabab failed holatga o'tkazildi.`,
        );
      }
    } catch (error) {
      this.logger.error(
        "Processdan keyingi pending generatsiyalarni tiklashda xatolik yuz berdi.",
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

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

  async isRegistrationCompleted(telegramId: number): Promise<boolean> {
    const user = await this.getUserByTelegramId(telegramId);
    return Boolean(user?.phoneNumber);
  }

  async completeRegistration(
    telegramId: number,
    phoneNumber: string,
  ): Promise<void> {
    await this.databaseService.db
      .update(telegramUsers)
      .set({ phoneNumber })
      .where(eq(telegramUsers.telegramId, String(telegramId)));
  }

  async consumeGeneration(
    telegramId: number,
    metadata: PresentationMetadata = {},
  ): Promise<GenerationReservation> {
    const now = new Date();
    const windowStart = this.getWindowStart(now);

    return this.databaseService.db.transaction(async (tx) => {
      const lockedUserResult = await tx.execute(
        sql<{ id: number; phoneNumber: string | null }>`
          select id, phone_number as "phoneNumber"
          from telegram_users
          where telegram_id = ${String(telegramId)}
          for update
        `,
      );

      const lockedUser = lockedUserResult.rows[0];

      if (!lockedUser) {
        throw new Error("Foydalanuvchi ro'yxatdan o'tmagan.");
      }

      if (!lockedUser.phoneNumber) {
        throw new Error("Foydalanuvchi ro'yxatdan o'tishi yakunlanmagan.");
      }

      const usageRows = await tx
        .select({
          usedCount: count(presentations.id),
          oldestCreatedAt: sql<Date | null>`min(${presentations.createdAt})`,
        })
        .from(presentations)
        .where(
          and(
            eq(presentations.userId, lockedUser.id),
            gte(presentations.createdAt, windowStart),
            ne(presentations.status, "failed"),
          ),
        );

      const usage = usageRows[0];
      const usedCount = usage?.usedCount ?? 0;
      const oldestCreatedAt = usage?.oldestCreatedAt
        ? new Date(usage.oldestCreatedAt)
        : null;

      if (usedCount >= TelegramService.DAILY_GENERATION_LIMIT) {
        return {
          ...this.buildBlockedQuota(usedCount, oldestCreatedAt, now),
          reservationId: null,
        };
      }

      const [reservation] = await tx
        .insert(presentations)
        .values({
          userId: lockedUser.id,
          status: "pending",
          metadata,
        })
        .returning({ id: presentations.id });

      const usedToday = usedCount + 1;

      return {
        allowed: true,
        usedToday,
        remainingToday: Math.max(
          TelegramService.DAILY_GENERATION_LIMIT - usedToday,
          0,
        ),
        dailyLimit: TelegramService.DAILY_GENERATION_LIMIT,
        nextAvailableAt: null,
        reservationId: reservation.id,
      };
    });
  }

  async updateGenerationStatus(
    presentationId: number,
    status: "completed" | "failed",
  ): Promise<void> {
    await this.databaseService.db
      .update(presentations)
      .set({ status })
      .where(eq(presentations.id, presentationId));
  }

  async markGenerationAsFailedIfPending(presentationId: number): Promise<void> {
    await this.databaseService.db
      .update(presentations)
      .set({ status: "failed" })
      .where(
        and(
          eq(presentations.id, presentationId),
          eq(presentations.status, "pending"),
        ),
      );
  }

  async recoverPendingGenerationsAfterProcessFailure(): Promise<number> {
    const recovered = await this.databaseService.db
      .update(presentations)
      .set({ status: "failed" })
      .where(eq(presentations.status, "pending"))
      .returning({ id: presentations.id });

    return recovered.length;
  }

  async getGenerationAvailability(
    telegramId: number,
  ): Promise<GenerationQuota> {
    const user = await this.getUserByTelegramId(telegramId);

    if (!user) {
      throw new Error("Foydalanuvchi ro'yxatdan o'tmagan.");
    }

    if (!user.phoneNumber) {
      throw new Error("Foydalanuvchi ro'yxatdan o'tishi yakunlanmagan.");
    }

    const now = new Date();
    const windowStart = this.getWindowStart(now);
    const usageRows = await this.databaseService.db
      .select({
        usedCount: count(presentations.id),
        oldestCreatedAt: sql<Date | null>`min(${presentations.createdAt})`,
      })
      .from(presentations)
      .where(
        and(
          eq(presentations.userId, user.id),
          gte(presentations.createdAt, windowStart),
          ne(presentations.status, "failed"),
        ),
      );

    const usage = usageRows[0];
    const usedToday = usage?.usedCount ?? 0;
    const oldestCreatedAt = usage?.oldestCreatedAt
      ? new Date(usage.oldestCreatedAt)
      : null;

    if (usedToday >= TelegramService.DAILY_GENERATION_LIMIT) {
      return this.buildBlockedQuota(usedToday, oldestCreatedAt, now);
    }

    return {
      allowed: true,
      usedToday,
      remainingToday: Math.max(
        TelegramService.DAILY_GENERATION_LIMIT - usedToday,
        0,
      ),
      dailyLimit: TelegramService.DAILY_GENERATION_LIMIT,
      nextAvailableAt: null,
    };
  }

  async getProfileStatus(telegramId: number): Promise<{
    username: string | null;
    firstName: string | null;
    phoneNumber: string | null;
    usedToday: number;
    remainingToday: number;
    dailyLimit: number;
    nextAvailableAt: Date | null;
  }> {
    const user = await this.getUserByTelegramId(telegramId);

    if (!user) {
      throw new Error("Foydalanuvchi ro'yxatdan o'tmagan.");
    }

    if (!user.phoneNumber) {
      throw new Error("Foydalanuvchi ro'yxatdan o'tishi yakunlanmagan.");
    }

    const availability = await this.getGenerationAvailability(telegramId);

    return {
      username: user.username,
      firstName: user.firstName,
      phoneNumber: user.phoneNumber,
      usedToday: availability.usedToday,
      remainingToday: availability.remainingToday,
      dailyLimit: availability.dailyLimit,
      nextAvailableAt: availability.nextAvailableAt,
    };
  }

  private buildBlockedQuota(
    usedCount: number,
    oldestCreatedAt: Date | null,
    referenceDate: Date,
  ): GenerationQuota {
    const nextAvailableAt = oldestCreatedAt
      ? new Date(
          oldestCreatedAt.getTime() + TelegramService.RATE_LIMIT_WINDOW_MS,
        )
      : new Date(
          referenceDate.getTime() + TelegramService.RATE_LIMIT_WINDOW_MS,
        );

    return {
      allowed: false,
      usedToday: usedCount,
      remainingToday: 0,
      dailyLimit: TelegramService.DAILY_GENERATION_LIMIT,
      nextAvailableAt,
    };
  }

  private getWindowStart(referenceDate: Date): Date {
    return new Date(
      referenceDate.getTime() - TelegramService.RATE_LIMIT_WINDOW_MS,
    );
  }

  async getPresentationStatus(
    presentationId: number,
  ): Promise<string | undefined> {
    const presentation =
      await this.databaseService.db.query.presentations.findFirst({
        where: eq(presentations.id, presentationId),
        columns: {
          status: true,
        },
      });

    return presentation?.status;
  }

  private async getUserByTelegramId(telegramId: number) {
    return this.databaseService.db.query.telegramUsers.findFirst({
      where: eq(telegramUsers.telegramId, String(telegramId)),
    });
  }
}
