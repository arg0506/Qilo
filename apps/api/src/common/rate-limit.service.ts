import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../redis/redis.module.ts";
import { APP_CONFIG, type AppConfig } from "../config/config.ts";
import { AppError } from "./errors.ts";

// Fixed-window counters in Redis, shared by every instance (spec 14.1).
export const LIMITS = {
  roomCreate: { limit: 10, windowSec: 600 },
  roomJoin: { limit: 30, windowSec: 60 },
  // Per identity. A shared IP (a classroom behind one NAT) gets a much higher
  // threshold so one guesser cannot lock out everyone else.
  joinFailure: { limit: 8, windowSec: 600, lockoutSec: 900 },
  joinFailureIp: { limit: 60, windowSec: 600, lockoutSec: 900 },
  answer: { limit: 30, windowSec: 10 },
  hostCommand: { limit: 60, windowSec: 60 },
  report: { limit: 10, windowSec: 3600 },
  profile: { limit: 20, windowSec: 600 },
  quizWrite: { limit: 300, windowSec: 600 },
  mediaUpload: { limit: 30, windowSec: 600 },
  socketConnect: { limit: 30, windowSec: 60 },
} as const;

@Injectable()
export class RateLimitService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async hit(bucket: string, key: string, baseLimit: number, windowSec: number): Promise<void> {
    const limit = Math.ceil(baseLimit * this.config.RATE_LIMIT_SCALE);
    const redisKey = `rl:${bucket}:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) await this.redis.expire(redisKey, windowSec);
    if (count > limit) {
      const ttl = await this.redis.ttl(redisKey);
      throw new AppError("RATE_LIMITED", undefined, { retryAfterSeconds: Math.max(ttl, 1) });
    }
  }

  // Join backoff: repeated invalid codes lock the caller out for a while,
  // which makes code guessing impractical.
  async assertNotLockedOut(key: string): Promise<void> {
    const ttl = await this.redis.ttl(`lockout:join:${key}`);
    if (ttl > 0) throw new AppError("RATE_LIMITED", undefined, { retryAfterSeconds: ttl });
  }

  async recordJoinFailure(key: string, scope: "identity" | "ip" = "identity"): Promise<void> {
    const { limit, windowSec, lockoutSec } = scope === "ip" ? LIMITS.joinFailureIp : LIMITS.joinFailure;
    const redisKey = `rl:joinfail:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) await this.redis.expire(redisKey, windowSec);
    if (count >= limit) {
      await this.redis.set(`lockout:join:${key}`, "1", "EX", lockoutSec);
      await this.redis.del(redisKey);
    }
  }
}
