import { Logger } from "@nestjs/common";
import { loadConfig } from "./config/config.ts";
import { createApp } from "./bootstrap.ts";
import { createDb, createPool, runMigrations } from "./db/db.ts";
import { seedStarterQuizzes } from "./db/seed.ts";

const config = loadConfig();
// Migrations and starter content are idempotent, so every instance can run
// them at boot; set MIGRATE_ON_BOOT=false to run them as a release step instead.
if (process.env.MIGRATE_ON_BOOT !== "false") {
  const pool = createPool(config.DATABASE_URL);
  const db = createDb(pool);
  await runMigrations(db);
  await seedStarterQuizzes(db);
  await pool.end();
}
const app = await createApp(config);
await app.listen(config.PORT, "0.0.0.0");
new Logger("Qilo").log(`API listening on :${config.PORT} (REST /api/v1, realtime /game)`);
