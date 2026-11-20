import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { Auth, CurrentUser } from "../auth/auth.guard.ts";
import type { AuthUser } from "../auth/auth-user.ts";
import { LIMITS, RateLimitService } from "../common/rate-limit.service.ts";
import { QuizzesService } from "./quizzes.service.ts";

@Controller()
export class QuizzesController {
  constructor(
    private readonly quizzes: QuizzesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private async writeLimit(user: AuthUser) {
    await this.rateLimit.hit("quizWrite", user.id, LIMITS.quizWrite.limit, LIMITS.quizWrite.windowSec);
  }

  @Get("quizzes")
  @Auth("optional")
  list(@CurrentUser() user: AuthUser | undefined, @Query() query: unknown) {
    return this.quizzes.list(user, query);
  }

  @Post("quizzes")
  @Auth("account")
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    await this.writeLimit(user);
    return this.quizzes.create(user, body);
  }

  @Get("quizzes/:id")
  @Auth("optional")
  get(@CurrentUser() user: AuthUser | undefined, @Param("id") id: string) {
    return this.quizzes.get(user, id);
  }

  @Patch("quizzes/:id")
  @Auth("account")
  async update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    await this.writeLimit(user);
    return this.quizzes.update(user, id, body);
  }

  @Post("quizzes/:id/archive")
  @HttpCode(200)
  @Auth("account")
  archive(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.quizzes.archive(user, id);
  }

  @Post("quizzes/:id/questions")
  @Auth("account")
  async addQuestion(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    await this.writeLimit(user);
    return this.quizzes.addQuestion(user, id, body);
  }

  @Post("quizzes/:id/questions/reorder")
  @HttpCode(200)
  @Auth("account")
  async reorder(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    await this.writeLimit(user);
    return this.quizzes.reorder(user, id, body);
  }

  @Patch("questions/:id")
  @Auth("account")
  async updateQuestion(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    await this.writeLimit(user);
    return this.quizzes.updateQuestion(user, id, body);
  }

  @Delete("questions/:id")
  @Auth("account")
  async deleteQuestion(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.writeLimit(user);
    return this.quizzes.deleteQuestion(user, id);
  }

  @Post("quizzes/:id/publish")
  @HttpCode(200)
  @Auth("account")
  publish(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.quizzes.publish(user, id);
  }

  @Post("quizzes/:id/preview")
  @HttpCode(200)
  @Auth("account")
  preview(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.quizzes.preview(user, id);
  }
}
