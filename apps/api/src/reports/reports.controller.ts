import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Auth, CurrentUser } from "../auth/auth.guard.ts";
import type { AuthUser } from "../auth/auth-user.ts";
import { ReportsService } from "./reports.service.ts";

@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post("reports")
  @Auth("user")
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.reports.create(user, body);
  }

  @Get("admin/reports")
  @Auth("admin")
  queue(@Query() query: unknown) {
    return this.reports.queue(query);
  }

  @Post("admin/reports/:id/resolve")
  @HttpCode(200)
  @Auth("admin")
  resolve(@CurrentUser() admin: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.reports.resolve(admin, id, body);
  }

  @Get("admin/audit")
  @Auth("admin")
  audit(@Query() query: unknown) {
    return this.reports.auditLog(query);
  }
}
