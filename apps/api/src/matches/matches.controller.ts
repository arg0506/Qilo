import { Controller, Get, Param } from "@nestjs/common";
import { Auth, CurrentUser } from "../auth/auth.guard.ts";
import type { AuthUser } from "../auth/auth-user.ts";
import { MatchesService } from "./matches.service.ts";

@Controller("matches")
export class MatchesController {
  constructor(private readonly matches: MatchesService) {}

  @Get(":id")
  @Auth("user")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.matches.get(user, id);
  }
}
