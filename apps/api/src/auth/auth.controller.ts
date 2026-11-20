import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { z } from "zod";
import { Auth, CurrentUser } from "./auth.guard.ts";
import type { AuthUser } from "./auth-user.ts";
import { AppError } from "../common/errors.ts";
import { parseInput } from "../common/validation.ts";
import { UsersService } from "../users/users.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { serializeMe } from "../users/me.serializer.ts";

// Identity is issued by Supabase Auth. A guest is a Supabase anonymous user
// (supabase.auth.signInAnonymously()); an upgrade links an email or OAuth
// identity to that same user, so the subject and all history carry over.
@Controller("auth")
export class AuthController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Post("guest")
  @HttpCode(200)
  @Auth("user")
  async guest(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const { displayName } = parseInput(z.object({ displayName: z.string().max(60).optional() }), body ?? {});
    const row = displayName ? await this.users.updateProfile(user.id, { displayName }) : await this.users.getById(user.id);
    return serializeMe(row);
  }

  @Post("upgrade")
  @HttpCode(200)
  @Auth("user")
  async upgrade(@CurrentUser() user: AuthUser) {
    // resolve() already flips is_guest when the token is no longer anonymous.
    if (user.isGuest) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Link an email or sign-in method in Supabase first, then call this with the refreshed access token.",
      );
    }
    await this.audit.record("user.upgraded", "user", user.id, user.id);
    return serializeMe(await this.users.getById(user.id));
  }
}
