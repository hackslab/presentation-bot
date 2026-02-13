import {
  BadRequestException,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "drizzle-orm";
import { DatabaseService } from "../database/database.service";

type PresentationStatus = "pending" | "completed" | "failed";

type OverviewRow = {
  totalUsers: number;
  registeredUsers: number;
  activeUsers24h: number;
  generated24h: number;
  pendingJobs: number;
  completedJobs: number;
  failedJobs: number;
};

type UserRow = {
  id: number;
  telegramId: string;
  firstName: string | null;
  username: string | null;
  phoneNumber: string | null;
  createdAt: Date;
  totalGenerations: number;
  usedToday: number;
  lastGenerationAt: Date | null;
};

type PresentationRow = {
  id: number;
  status: PresentationStatus;
  createdAt: Date;
  telegramId: string;
  firstName: string | null;
  username: string | null;
  metadata: Record<string, unknown>;
};

@Injectable()
export class AdminService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
  ) {}

  async getOverview() {
    const result = await this.databaseService.db.execute(sql<OverviewRow>`
      select
        count(*)::int as "totalUsers",
        count(*) filter (where tu.phone_number is not null)::int as "registeredUsers",
        (
          select count(distinct p.user_id)::int
          from presentations p
          where p.created_at >= now() - interval '24 hours'
            and p.status <> 'failed'
        ) as "activeUsers24h",
        (
          select count(*)::int
          from presentations p
          where p.created_at >= now() - interval '24 hours'
            and p.status = 'completed'
        ) as "generated24h",
        (
          select count(*)::int
          from presentations p
          where p.status = 'pending'
        ) as "pendingJobs",
        (
          select count(*)::int
          from presentations p
          where p.status = 'completed'
        ) as "completedJobs",
        (
          select count(*)::int
          from presentations p
          where p.status = 'failed'
        ) as "failedJobs"
      from telegram_users tu
    `);

    return (
      result.rows[0] ?? {
        totalUsers: 0,
        registeredUsers: 0,
        activeUsers24h: 0,
        generated24h: 0,
        pendingJobs: 0,
        completedJobs: 0,
        failedJobs: 0,
      }
    );
  }

  async getUsers(search: string | undefined, limitRaw: string | undefined) {
    const limit = this.parseLimit(limitRaw, 50, 200);
    const term = search?.trim();
    const termLike = term ? `%${term}%` : null;

    const result = await this.databaseService.db.execute(sql<UserRow>`
      select
        tu.id,
        tu.telegram_id as "telegramId",
        tu.first_name as "firstName",
        tu.username,
        tu.phone_number as "phoneNumber",
        tu.created_at as "createdAt",
        count(p.id)::int as "totalGenerations",
        count(p.id) filter (
          where p.created_at >= now() - interval '24 hours'
            and p.status <> 'failed'
        )::int as "usedToday",
        max(p.created_at) as "lastGenerationAt"
      from telegram_users tu
      left join presentations p on p.user_id = tu.id
      where 1 = 1
      ${
        termLike
          ? sql`
            and (
              tu.telegram_id ilike ${termLike}
              or coalesce(tu.username, '') ilike ${termLike}
              or coalesce(tu.first_name, '') ilike ${termLike}
              or coalesce(tu.phone_number, '') ilike ${termLike}
            )`
          : sql``
      }
      group by tu.id
      order by tu.created_at desc
      limit ${limit}
    `);

    return result.rows;
  }

  async getPresentations(
    status: PresentationStatus | undefined,
    limitRaw: string | undefined,
  ) {
    const limit = this.parseLimit(limitRaw, 40, 200);

    const result = await this.databaseService.db.execute(sql<PresentationRow>`
      select
        p.id,
        p.status,
        p.created_at as "createdAt",
        p.metadata,
        tu.telegram_id as "telegramId",
        tu.first_name as "firstName",
        tu.username
      from presentations p
      inner join telegram_users tu on tu.id = p.user_id
      ${status ? sql`where p.status = ${status}` : sql``}
      order by p.created_at desc
      limit ${limit}
    `);

    return result.rows;
  }

  async failPendingPresentation(idRaw: string) {
    const presentationId = Number(idRaw);
    if (!Number.isInteger(presentationId) || presentationId <= 0) {
      throw new BadRequestException("Presentation id is invalid.");
    }

    const result = await this.databaseService.db.execute(sql<{ id: number }>`
      update presentations
      set status = 'failed'
      where id = ${presentationId}
        and status = 'pending'
      returning id
    `);

    return {
      updated: result.rows.length > 0,
      presentationId,
    };
  }

  async broadcastMessage(message: string) {
    const token = this.configService.get<string>("TELEGRAM_BOT_TOKEN")?.trim();
    if (!token) {
      throw new BadRequestException(
        "TELEGRAM_BOT_TOKEN is required for broadcast.",
      );
    }

    const usersResult = await this.databaseService.db.execute(
      sql<{ telegramId: string }>`
        select telegram_id as "telegramId"
        from telegram_users
        where phone_number is not null
        order by id asc
      `,
    );

    const users = usersResult.rows;
    let sent = 0;
    let failed = 0;

    for (const user of users) {
      try {
        const response = await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              chat_id: Number(user.telegramId),
              text: message,
            }),
          },
        );

        if (!response.ok) {
          failed += 1;
          continue;
        }

        sent += 1;
      } catch {
        failed += 1;
      }
    }

    return {
      recipients: users.length,
      sent,
      failed,
    };
  }

  private parseLimit(
    limitRaw: string | undefined,
    fallback: number,
    max: number,
  ): number {
    if (!limitRaw) {
      return fallback;
    }

    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return fallback;
    }

    return Math.min(parsed, max);
  }
}
