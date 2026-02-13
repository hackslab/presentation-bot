import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { AdminService } from "./admin.service";

type PresentationStatus = "pending" | "completed" | "failed";

type BroadcastBody = {
  message?: string;
};

@Controller("admin")
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get("overview")
  async getOverview() {
    return this.adminService.getOverview();
  }

  @Get("users")
  async getUsers(
    @Query("search") search: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    return this.adminService.getUsers(search, limit);
  }

  @Get("presentations")
  async getPresentations(
    @Query("status") statusRaw: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    const status = this.normalizeStatus(statusRaw);
    return this.adminService.getPresentations(status, limit);
  }

  @Post("presentations/:id/fail")
  async failPendingPresentation(@Param("id") id: string) {
    return this.adminService.failPendingPresentation(id);
  }

  @Post("broadcast")
  async broadcast(@Body() body: BroadcastBody) {

    const message = body.message?.trim();
    if (!message) {
      throw new BadRequestException("Message is required.");
    }

    if (message.length > 4096) {
      throw new BadRequestException("Message is too long.");
    }

    return this.adminService.broadcastMessage(message);
  }

  private normalizeStatus(statusRaw: string | undefined) {
    if (!statusRaw) {
      return undefined;
    }

    const normalized = statusRaw.toLowerCase();
    if (
      normalized === "pending" ||
      normalized === "completed" ||
      normalized === "failed"
    ) {
      return normalized as PresentationStatus;
    }

    throw new BadRequestException("Status filter is invalid.");
  }
}
