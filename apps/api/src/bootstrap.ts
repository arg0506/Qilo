import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AppConfig } from "./config/config.ts";
import { AppModule } from "./app.module.ts";
import { requestId } from "./common/http.ts";
import { RedisIoAdapter } from "./realtime/redis-io.adapter.ts";

const LOG_LEVELS = {
  debug: ["error", "warn", "log", "debug"],
  info: ["error", "warn", "log"],
  warn: ["error", "warn"],
  error: ["error"],
} as const satisfies Record<AppConfig["LOG_LEVEL"], readonly ("error" | "warn" | "log" | "debug")[]>;

export async function createApp(config: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    logger: config.NODE_ENV === "test" ? ["error"] : [...LOG_LEVELS[config.LOG_LEVEL]],
    bodyParser: false,
  });
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  app.use(requestId);
  app.useBodyParser("json", { limit: "200kb" });
  app.enableCors({ origin: config.corsOrigins === "*" ? true : config.corsOrigins, credentials: true });
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] });
  app.useWebSocketAdapter(new RedisIoAdapter(app, config.REDIS_URL, config.corsOrigins));
  app.enableShutdownHooks();
  return app;
}
