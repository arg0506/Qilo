// End-to-end test harness: boots the real app (REST + Socket.IO + BullMQ
// timers) against PostgreSQL and Redis, with Supabase-shaped HS256 tokens.

import { SignJWT } from "jose";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { io, type Socket } from "socket.io-client";
import { sql } from "drizzle-orm";
import { loadConfig, type AppConfig } from "../config/config.ts";
import { createApp } from "../bootstrap.ts";
import { createDb, createPool, runMigrations, type Db } from "../db/db.ts";
import { seedStarterQuizzes } from "../db/seed.ts";

export const JWT_SECRET = "test-secret-at-least-32-characters-long!!";

export interface TestApp {
  nest: Awaited<ReturnType<typeof createApp>>;
  baseUrl: string;
  config: AppConfig;
  db: Db;
  close: () => Promise<void>;
}

export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://qilo:qilo@127.0.0.1:5432/qilo_test",
    REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/1",
    SUPABASE_JWT_SECRET: JWT_SECRET,
    ADMIN_SUBJECTS: "admin-subject",
    COUNTDOWN_MS: "150",
    TIME_SCALE: "0.05",
    PLAYER_GRACE_MS: "400",
    HOST_GRACE_MS: "400",
    HOST_PAUSE_MAX_MS: "1200",
    RUN_MAINTENANCE: "false",
    RATE_LIMIT_SCALE: "50",
    ...env,
  });

  // Fresh schema and Redis database for each test file.
  const pool = createPool(config.DATABASE_URL);
  const db = createDb(pool);
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  await seedStarterQuizzes(db);
  const redis = new Redis(config.REDIS_URL);
  await redis.flushdb();
  await redis.quit();

  const app = await createApp(config);
  await app.listen(0, "127.0.0.1");
  const port = (app.getHttpServer().address() as AddressInfo).port;
  config.PORT = port;
  return {
    nest: app,
    baseUrl: `http://127.0.0.1:${port}`,
    config,
    db,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export async function tokenFor(subject: string, opts: { anonymous?: boolean; name?: string; expiresIn?: string } = {}) {
  return new SignJWT({
    role: "authenticated",
    is_anonymous: opts.anonymous ?? false,
    email: opts.anonymous ? undefined : `${subject}@example.test`,
    user_metadata: opts.name ? { display_name: opts.name } : {},
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export function client(baseUrl: string) {
  return async function api<T = any>(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
    const res = await fetch(`${baseUrl}${path.startsWith("/health") ? "" : "/api/v1"}${path}`, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

export interface Recorded {
  event: string;
  payload: any;
  at: number;
}

// A socket client that records every event, so tests can assert on what a
// player actually received (and did not receive).
export class Player {
  readonly socket: Socket;
  readonly events: Recorded[] = [];
  roomId = "";
  resumeToken = "";
  userId = "";

  constructor(baseUrl: string, auth: Record<string, string>) {
    this.socket = io(`${baseUrl}/game`, { auth, transports: ["websocket"], reconnection: false, forceNew: true });
    this.socket.onAny((event: string, payload: unknown) => this.events.push({ event, payload, at: Date.now() }));
  }

  async connected(): Promise<void> {
    if (this.socket.connected) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once("connect", () => resolve());
      this.socket.once("connect_error", (err) => reject(err));
    });
  }

  emit<T = any>(event: string, payload: Record<string, unknown>): Promise<any> {
    return this.socket.timeout(5000).emitWithAck(event, payload) as Promise<T>;
  }

  async join(roomId: string, resumeToken: string) {
    this.roomId = roomId;
    this.resumeToken = resumeToken;
    return this.emit("room:join", { roomId, resumeToken, protocolVersion: 1 });
  }

  host(event: string, extra: Record<string, unknown> = {}) {
    return this.emit(event, { roomId: this.roomId, idempotencyKey: randomUUID(), ...extra });
  }

  answer(matchQuestionId: string, optionKey: string, idempotencyKey: string = randomUUID()) {
    return this.emit("answer:submit", { roomId: this.roomId, matchQuestionId, optionKey, idempotencyKey });
  }

  of(event: string): any[] {
    return this.events.filter((e) => e.event === event).map((e) => e.payload);
  }

  last(event: string): any {
    return this.of(event).at(-1);
  }

  async waitFor(event: string, predicate: (p: any) => boolean = () => true, timeoutMs = 6000): Promise<any> {
    const seen = this.events.find((e) => e.event === event && predicate(e.payload));
    if (seen) return seen.payload;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.offAny(listener);
        reject(new Error(`timed out waiting for ${event}`));
      }, timeoutMs);
      const listener = (name: string, payload: unknown) => {
        if (name === event && predicate(payload)) {
          clearTimeout(timer);
          this.socket.offAny(listener);
          resolve(payload);
        }
      };
      this.socket.onAny(listener);
    });
  }

  close() {
    this.socket.disconnect();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function uid(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
