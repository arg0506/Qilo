import { Body, Controller, Delete, Get, Patch, Query } from "@nestjs/common";
import { z } from "zod";
import { Auth, CurrentUser } from "../auth/auth.guard.ts";
import type { AuthUser } from "../auth/auth-user.ts";
import { AppError } from "../common/errors.ts";
import { parseInput } from "../common/validation.ts";
import { LIMITS, RateLimitService } from "../common/rate-limit.service.ts";
import { MediaService } from "../media/media.service.ts";
import { MatchesService } from "../matches/matches.service.ts";
import { UsersService } from "./users.service.ts";
import { AccountService } from "./account.service.ts";
import { serializeMe } from "./me.serializer.ts";

const patchSchema = z.object({
  displayName: z.string().max(60).optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

@Controller("me")
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly account: AccountService,
    private readonly matches: MatchesService,
    private readonly media: MediaService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  @Auth("user")
  async me(@CurrentUser() user: AuthUser) {
    return serializeMe(await this.users.getById(user.id));
  }

  @Patch()
  @Auth("user")
  async update(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parseInput(patchSchema, body);
    await this.rateLimit.hit("profile", user.id, LIMITS.profile.limit, LIMITS.profile.windowSec);
    if (input.avatarUrl) {
      const allowed = await this.media.allowedUrls(user.id, [input.avatarUrl]);
      if (!allowed.has(input.avatarUrl)) throw new AppError("VALIDATION_ERROR", "Upload the avatar through Qilo first.");
    }
    return serializeMe(await this.users.updateProfile(user.id, input));
  }

  @Get("matches")
  @Auth("account")
  history(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    return this.matches.history(user, query);
  }

  @Get("export")
  @Auth("account")
  export(@CurrentUser() user: AuthUser) {
    return this.account.export(user);
  }

  @Delete()
  @Auth("user")
  delete(@CurrentUser() user: AuthUser) {
    return this.account.delete(user);
  }
}
