import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import type pg from "pg";
import { APP_CONFIG, type AppConfig } from "../config/config.ts";
import { DB, PG_POOL, createDb, createPool } from "./db.ts";

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createPool(config.DATABASE_URL),
    },
    { provide: DB, inject: [PG_POOL], useFactory: (pool: pg.Pool) => createDb(pool) },
  ],
  exports: [DB, PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
