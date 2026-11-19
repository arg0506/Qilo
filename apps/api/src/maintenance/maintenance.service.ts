import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { and, eq, lt, notExists, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../config/config.ts";
import { DB, type Db } from "../db/db.ts";
import { analyticsEvents, auditEvents, reports, roomPlayers, rooms, users } from "../db/schema.ts";
import { REDIS } from "../redis/redis.module.ts";
import { GameService } from "../realtime/game.service.ts";

const DAY = 86_400_000;

// Housekeeping (spec 14.3, Appendix A). One instance at a time holds a Redis
// lease, so a fleet does not run the same purge twice.
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger("Maintenance");
  private timer?: NodeJS.Timeout;
  private lastRetention = 0;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly game: GameService,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.RUN_MAINTENANCE) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    const lease = await this.redis.set("maintenance:lease", "1", "EX", 55, "NX");
    if (!lease) return;
    try {
      await this.expireLobbies();
      if (Date.now() - this.lastRetention > 6 * 3600_000) {
        await this.retention();
        this.lastRetention = Date.now();
      }
    } catch (err) {
      this.log.error(`maintenance failed: ${String(err)}`);
    }
  }

  // Safety net for lobby expiry in case a timer job was lost.
  async expireLobbies() {
    for (const { id } of await this.game.staleLobbies()) {
      await this.game.onTimer({ type: "lobby_expiry", roomId: id });
    }
  }

  async retention() {
    const now = Date.now();
    // Guests inactive for 30 days are purged unless upgraded. Their results
    // stay, anonymized, so other players' standings do not change.
    const purged = await this.db
      .update(users)
      .set({ authSubject: null, displayName: "Guest", email: null, avatarUrl: null, status: "purged" })
      .where(
        and(
          eq(users.isGuest, true),
          eq(users.status, "active"),
          lt(users.lastActiveAt, new Date(now - 30 * DAY)),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(roomPlayers)
              .innerJoin(rooms, eq(rooms.id, roomPlayers.roomId))
              .where(and(eq(roomPlayers.userId, users.id), sql`${rooms.status} not in ('FINISHED','CANCELLED','EXPIRED','ENDED_EARLY')`)),
          ),
        ),
      )
      .returning({ id: users.id });
    await this.db.delete(auditEvents).where(and(eq(auditEvents.entityType, "room"), lt(auditEvents.createdAt, new Date(now - 90 * DAY))));
    await this.db.delete(reports).where(and(sql`${reports.status} <> 'open'`, lt(reports.resolvedAt, new Date(now - 365 * DAY))));
    await this.db.delete(analyticsEvents).where(lt(analyticsEvents.createdAt, new Date(now - 396 * DAY)));
    if (purged.length) this.log.log(`purged ${purged.length} inactive guests`);
    return { purgedGuests: purged.length };
  }
}
