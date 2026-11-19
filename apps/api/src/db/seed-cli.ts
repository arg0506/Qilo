import { loadConfig } from "../config/config.ts";
import { createDb, createPool } from "./db.ts";
import { seedStarterQuizzes } from "./seed.ts";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const created = await seedStarterQuizzes(createDb(pool));
await pool.end();
console.log(`Starter quizzes created: ${created}`);
