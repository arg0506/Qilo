import { Controller, Get, Inject } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { Auth } from "../auth/auth.guard.ts";
import { DB, type Db } from "../db/db.ts";
import { REDIS } from "../redis/redis.module.ts";
import { AppError } from "../common/errors.ts";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  @Auth("none")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  @Auth("none")
  async ready() {
    const checks: Record<string, string> = {};
    try {
      await this.db.execute(sql`select 1`);
      checks.database = "ok";
    } catch {
      checks.database = "down";
    }
    try {
      checks.redis = (await this.redis.ping()) === "PONG" ? "ok" : "down";
    } catch {
      checks.redis = "down";
    }
    if (Object.values(checks).some((v) => v !== "ok")) throw new AppError("INTERNAL_ERROR", "Not ready", checks);
    return { status: "ready", checks };
  }
}
