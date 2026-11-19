import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { Auth, CurrentUser, type AuthedRequest } from "../auth/auth.guard.ts";
import type { AuthUser } from "../auth/auth-user.ts";
import { RoomsService } from "./rooms.service.ts";

@Controller("rooms")
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Post()
  @Auth("user")
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.rooms.create(user, body);
  }

  @Post("join")
  @HttpCode(200)
  @Auth("user")
  join(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.rooms.join(user, body, `ip:${req.ip ?? "unknown"}`);
  }

  @Get(":id")
  @Auth("user")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.rooms.get(user, id);
  }

  @Post(":id/rematch")
  @Auth("user")
  rematch(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.rooms.rematch(user, id, body);
  }

  @Post(":id/display-tokens")
  @Auth("user")
  createDisplayToken(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.rooms.createDisplayToken(user, id);
  }

  @Delete(":id/display-tokens/:tokenId")
  @Auth("user")
  revokeDisplayToken(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("tokenId") tokenId: string) {
    return this.rooms.revokeDisplayToken(user, id, tokenId);
  }
}
