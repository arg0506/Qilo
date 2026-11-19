// Load check (spec 15, 17.1): many rooms with many players play full matches
// at once. Reports join and answer acknowledgement latency and verifies that
// every player in a room receives identical final standings.
//
//   npm run build && node dist/test/load.js --rooms 10 --players 20
//
// Starts the API as a child process against TEST_DATABASE_URL / TEST_REDIS_URL
// (or uses LOAD_API_URL if set).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Redis } from "ioredis";
import pg from "pg";
import { JWT_SECRET, Player, client, sleep, tokenFor } from "./harness.ts";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const ROOMS = arg("rooms", 10);
const PLAYERS = arg("players", 20);
const DB = process.env.TEST_DATABASE_URL ?? "postgres://qilo:qilo@127.0.0.1:5432/qilo_test";
const REDIS = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/1";
const PORT = 3999;

function pct(values: number[], p: number) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

async function startServer() {
  if (process.env.LOAD_API_URL) return { url: process.env.LOAD_API_URL, stop: async () => undefined };
  const pool = new pg.Pool({ connectionString: DB });
  await pool.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await pool.end();
  const redis = new Redis(REDIS);
  await redis.flushdb();
  await redis.quit();
  const main = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../main.js");
  const child = spawn(process.execPath, [main], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      LOG_LEVEL: "warn",
      PORT: String(PORT),
      DATABASE_URL: DB,
      REDIS_URL: REDIS,
      SUPABASE_JWT_SECRET: JWT_SECRET,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "unused-in-load-test",
      COUNTDOWN_MS: "500",
      TIME_SCALE: "0.25",
      RATE_LIMIT_SCALE: "1000",
      RUN_MAINTENANCE: "false",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const url = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${url}/health/ready`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return {
    url,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    },
  };
}

async function main() {
  const server = await startServer();
  const api = client(server.url);
  const joinMs: number[] = [];
  const phase = { rest: [] as number[], connect: [] as number[], roomJoin: [] as number[] };
  const answerMs: number[] = [];
  let mismatches = 0;
  const started = Date.now();

  const runRoom = async (r: number) => {
    const hostToken = await tokenFor(`load-host-${r}-${randomUUID()}`);
    const created = await api("POST", "/rooms", {
      token: hostToken,
      body: { quizId: "5e1d0000-0000-4000-8000-000000000001", maxPlayers: 50, settings: { revealSeconds: 3, scoreboardSeconds: 3 } },
    });
    if (created.status !== 201) throw new Error(`room create failed: ${JSON.stringify(created.body)}`);
    const host = new Player(server.url, { token: hostToken });
    await host.connected();
    await host.join(created.body.roomId, created.body.resumeToken);
    const players: Player[] = [host];
    await Promise.all(
      Array.from({ length: PLAYERS - 1 }, async (_, i) => {
        const token = await tokenFor(`load-p-${r}-${i}-${randomUUID()}`, { anonymous: true });
        const t0 = performance.now();
        const res = await api("POST", "/rooms/join", { token, body: { code: created.body.code, displayName: `P${i}` } });
        const t1 = performance.now();
        const p = new Player(server.url, { token });
        await p.connected();
        const t2 = performance.now();
        const joined = await p.join(res.body.roomId, res.body.resumeToken);
        phase.rest.push(t1 - t0);
        phase.connect.push(t2 - t1);
        phase.roomJoin.push(performance.now() - t2);
        if (!joined.ok) throw new Error(`join failed: ${JSON.stringify(joined)}`);
        joinMs.push(performance.now() - t0);
        players.push(p);
      }),
    );
    const start = await host.host("host:start");
    if (!start.ok) throw new Error(`start failed: ${JSON.stringify(start)}`);

    for (let q = 0; q < 6; q += 1) {
      await Promise.all(
        players.map(async (p) => {
          const question = await p.waitFor("question:started", (x) => x.position === q, 20_000);
          // Answer at a random moment in the first 70% of the window.
          await sleep(Math.random() * question.durationMs * 0.7);
          const key = question.options[Math.floor(Math.random() * question.options.length)].key;
          const t0 = performance.now();
          const ack = await p.answer(question.matchQuestionId, key);
          answerMs.push(performance.now() - t0);
          if (!ack.ok && ack.error.code !== "ANSWER_DEADLINE_PASSED") throw new Error(`answer failed: ${JSON.stringify(ack)}`);
        }),
      );
    }
    const finals = await Promise.all(players.map((p) => p.waitFor("game:finished", () => true, 30_000)));
    const reference = JSON.stringify(finals[0].results);
    mismatches += finals.filter((f) => JSON.stringify(f.results) !== reference).length;
    players.forEach((p) => p.close());
  };

  await Promise.all(Array.from({ length: ROOMS }, (_, r) => runRoom(r)));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    JSON.stringify(
      {
        rooms: ROOMS,
        playersPerRoom: PLAYERS,
        sockets: ROOMS * PLAYERS,
        answers: answerMs.length,
        durationSeconds: Number(seconds),
        joinMs: { p50: Math.round(pct(joinMs, 50)), p95: Math.round(pct(joinMs, 95)), p99: Math.round(pct(joinMs, 99)) },
        joinPhasesP50Ms: Object.fromEntries(Object.entries(phase).map(([k, v]) => [k, Math.round(pct(v, 50))])),
        answerAckMs: { p50: Math.round(pct(answerMs, 50)), p95: Math.round(pct(answerMs, 95)), p99: Math.round(pct(answerMs, 99)) },
        standingsMismatches: mismatches,
      },
      null,
      2,
    ),
  );
  await server.stop();
  if (mismatches > 0) process.exit(1);
}

await main();
