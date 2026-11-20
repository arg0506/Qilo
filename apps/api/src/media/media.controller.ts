import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { Auth, CurrentUser } from "../auth/auth.guard.ts";
import type { AuthUser } from "../auth/auth-user.ts";
import { AppError } from "../common/errors.ts";
import { parseInput } from "../common/validation.ts";
import { LIMITS, RateLimitService } from "../common/rate-limit.service.ts";
import { MEDIA_RULES, MediaService } from "./media.service.ts";
import { MediaStorage, MemoryMediaStorage } from "./storage.ts";

const requestSchema = z.object({
  purpose: z.enum(["question", "cover", "avatar"]),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
});

@Controller("media")
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly rateLimit: RateLimitService,
    @Inject(MediaStorage) private readonly storage: MediaStorage,
  ) {}

  @Post("uploads")
  @Auth("user")
  async request(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parseInput(requestSchema, body);
    if (input.purpose !== "avatar" && user.isGuest) {
      throw new AppError("FORBIDDEN", "Create an account to upload quiz images.");
    }
    await this.rateLimit.hit("mediaUpload", user.id, LIMITS.mediaUpload.limit, LIMITS.mediaUpload.windowSec);
    return this.media.requestUpload(user.id, input.purpose, input.mimeType, input.sizeBytes);
  }

  @Post("uploads/:id/complete")
  @HttpCode(200)
  @Auth("user")
  complete(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new AppError("NOT_FOUND", "Upload not found.");
    return this.media.complete(user.id, id);
  }

  // Local development stand-ins for Supabase Storage. Disabled whenever a real
  // storage backend is configured.
  @Put("dev-upload/:token")
  @Auth("none")
  async devUpload(@Param("token") token: string, @Req() req: Request) {
    if (!(this.storage instanceof MemoryMediaStorage)) throw new AppError("NOT_FOUND");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MEDIA_RULES.maxBytes.question + 1) break;
      chunks.push(chunk);
    }
    if (!this.storage.accept(token, Buffer.concat(chunks))) throw new AppError("NOT_FOUND");
    return { ok: true };
  }

  @Get("dev-object/:path")
  @Auth("none")
  devObject(@Param("path") path: string, @Res() res: Response) {
    if (!(this.storage instanceof MemoryMediaStorage)) throw new AppError("NOT_FOUND");
    const bytes = this.storage.get(decodeURIComponent(path));
    if (!bytes) throw new AppError("NOT_FOUND");
    res.type("application/octet-stream").send(bytes);
  }
}
