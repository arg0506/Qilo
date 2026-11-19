import { z } from "zod";

// All runtime configuration comes from the environment and is validated once
// at boot. Durations are in milliseconds unless the name says otherwise.
const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  CORS_ORIGINS: z.string().default("*"),
  // Public URL of this API, used for development upload links.
  PUBLIC_BASE_URL: z.string().url().optional(),

  // Supabase. Access tokens are verified with the JWT secret (HS256 projects)
  // or the project's JWKS (asymmetric signing keys).
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default("qilo-media"),
  SUPABASE_JWT_AUDIENCE: z.string().default("authenticated"),

  // Game timing (spec Appendix A).
  COUNTDOWN_MS: z.coerce.number().int().min(0).default(3_000),
  PLAYER_GRACE_MS: z.coerce.number().int().min(0).default(60_000),
  HOST_GRACE_MS: z.coerce.number().int().min(0).default(60_000),
  HOST_PAUSE_MAX_MS: z.coerce.number().int().min(0).default(300_000),
  LOBBY_EXPIRY_MS: z.coerce.number().int().min(0).default(1_800_000),
  // Multiplies question, reveal and scoreboard durations. 1 in production;
  // tests use a small value so a full match runs in seconds.
  TIME_SCALE: z.coerce.number().positive().max(1).default(1),

  // Scales throughput limits (not the join lockout). 1 in production; load
  // tests and the e2e suite, where every client shares one IP, raise it.
  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
  ROOM_MAX_PLAYERS_CAP: z.coerce.number().int().min(2).default(50),
  RUN_WORKERS: bool.default(true),
  RUN_MAINTENANCE: bool.default(true),
  ADMIN_SUBJECTS: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = z.infer<typeof schema> & {
  corsOrigins: string[] | "*";
  adminSubjects: Set<string>;
};

export const APP_CONFIG = Symbol("APP_CONFIG");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  if (!c.SUPABASE_JWT_SECRET && !c.SUPABASE_URL) {
    throw new Error(
      "Invalid configuration: set SUPABASE_JWT_SECRET or SUPABASE_URL so access tokens can be verified",
    );
  }
  return {
    ...c,
    corsOrigins:
      c.CORS_ORIGINS.trim() === "*"
        ? "*"
        : c.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    adminSubjects: new Set(
      c.ADMIN_SUBJECTS.split(",").map((s) => s.trim()).filter(Boolean),
    ),
  };
}
