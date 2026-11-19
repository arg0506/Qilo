import { type CanActivate, type ExecutionContext, Injectable, SetMetadata, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { AppError } from "../common/errors.ts";
import { TokenVerifier } from "./token-verifier.ts";
import { UsersService } from "../users/users.service.ts";
import type { AuthUser } from "./auth-user.ts";

// none: no token read. optional: token used if present. user: guest or
// account. account: signed-in (non-guest) only. admin: moderators.
export type AuthMode = "none" | "optional" | "user" | "account" | "admin";
const AUTH_MODE = "qilo:auth-mode";
export const Auth = (mode: AuthMode) => SetMetadata(AUTH_MODE, mode);

export type AuthedRequest = Request & { user?: AuthUser };

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const mode =
      this.reflector.getAllAndOverride<AuthMode | undefined>(AUTH_MODE, [ctx.getHandler(), ctx.getClass()]) ?? "user";
    if (mode === "none") return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      if (mode === "optional") return true;
      throw new AppError("UNAUTHORIZED");
    }
    req.user = await this.usersService.resolve(await this.verifier.verify(token));

    if (mode === "account" && req.user.isGuest) {
      throw new AppError("FORBIDDEN", "Create an account to use this feature.");
    }
    if (mode === "admin" && req.user.role !== "admin") throw new AppError("FORBIDDEN");
    return true;
  }
}
