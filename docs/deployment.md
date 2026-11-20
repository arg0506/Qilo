# Running and deploying the Qilo API

## Local development

Requirements: Node.js 22.12+, PostgreSQL 16, Redis 7. Docker Compose can run all three:

```bash
cp apps/api/.env.example apps/api/.env      # fill in the Supabase values
docker compose up --build                   # Postgres, Redis and the API on :3000
```

Without Docker:

```bash
cd apps/api
npm install
cp .env.example .env                        # point DATABASE_URL / REDIS_URL at your services
npm run dev                                 # builds, migrates, seeds starter quizzes, starts on :3000
```

Without Supabase storage keys outside production, uploads use an in-memory store with local `PUT` URLs, so the full flow works offline.

## Tests

```bash
cd apps/api
createdb qilo_test                          # or set TEST_DATABASE_URL
npm test                                    # unit + end-to-end (REST and multi-client socket matches)
npm run load -- --rooms 10 --players 20     # concurrent full matches; prints latency percentiles
```

The end-to-end suite drops and recreates the `public` schema of the test database, and flushes Redis database 1. Never point it at real data.

## Supabase setup

1. **Authentication → Providers:** enable **Anonymous sign-ins** (guests) and any providers you want for accounts (email, Google…).
2. **Project Settings → API:** copy the project URL to `SUPABASE_URL` and the service role key to `SUPABASE_SERVICE_ROLE_KEY` (server only).
3. **JWT verification:**
   - Projects using the legacy JWT secret: set `SUPABASE_JWT_SECRET`.
   - Projects using asymmetric signing keys: leave `SUPABASE_JWT_SECRET` empty. The API verifies against `SUPABASE_URL/auth/v1/.well-known/jwks.json`.
4. **Storage:** create a bucket named `qilo-media` (or set `SUPABASE_STORAGE_BUCKET`), marked **public** for reads. Uploads only happen through signed URLs that the API issues after checking type and size, and the API checks the file signature before the URL can be used in a quiz.
5. **Moderators:** put their Supabase user ids in `ADMIN_SUBJECTS`.

Upgrading a guest: in the app, call `supabase.auth.updateUser({ email })` or `linkIdentity(...)` on the anonymous session, refresh the session, then call `POST /api/v1/auth/upgrade` with the new access token. The Supabase user id does not change, so the player's history stays.

## Production

- Build the image from `apps/api/Dockerfile`. It runs as a non-root user and has a health check on `/health`.
- Migrations and starter quizzes run on boot and are idempotent. To run them as a release step instead, set `MIGRATE_ON_BOOT=false` and run `npm run db:migrate && npm run db:seed`.
- **Scaling out:** run several instances behind a load balancer with sticky sessions **off**. Socket.IO uses the Redis adapter, so broadcasts reach every instance. Room state lives in PostgreSQL behind row locks, and timers are BullMQ jobs in Redis, so any instance can handle any command or timer. If a process restarts, its pending timers fire on another instance.
- Clients must use the `websocket` transport (no long-polling), because there is no sticky routing.
- `RUN_WORKERS=false` keeps an instance from processing timer jobs, and `RUN_MAINTENANCE=false` keeps it from running housekeeping. Only one instance at a time runs maintenance anyway, through a Redis lease.
- Redis needs persistence (AOF) so delayed timer jobs survive a Redis restart.
- Size `DB_POOL_MAX` (default 30) against your Postgres connection limit times the number of instances.

## Housekeeping

Every 6 hours, one instance:

- purges guests inactive for 30 days who are not in a live room (results stay, anonymized),
- deletes room audit logs older than 90 days, resolved reports older than a year, and analytics events older than 13 months.

Every minute it also expires lobbies idle past 30 minutes, as a safety net for lost timer jobs.

## Measured performance

From `npm run load` on one 2-vCPU container, with the API, PostgreSQL, Redis and all load clients sharing the machine:

| Scenario | Answer ack p50 / p95 / p99 | Join p50 | Standings mismatches |
|---|---|---|---|
| 10 rooms × 20 players, all joining at once | 10 / 26 / 39 ms | 2.2 s | 0 |
| 1 room × 50 players | 12 / 23 / 51 ms | 1.1 s | 0 |

The spec targets are answer processing p95 under 300 ms and median join under 5 seconds. Measure again on your real infrastructure before raising the room cap.
