import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../config/config.ts";

export const REDIS = Symbol("REDIS");

export function createRedis(url: string): Redis {
  // BullMQ requires maxRetriesPerRequest: null on connections it uses.
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
}

@Global()
@Module({
  providers: [
    { provide: REDIS, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createRedis(c.REDIS_URL) },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
