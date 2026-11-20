import { loadConfig } from "../config/config.ts";
import { createDb, createPool, runMigrations } from "./db.ts";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
await runMigrations(createDb(pool));
await pool.end();
console.log("Migrations applied");
