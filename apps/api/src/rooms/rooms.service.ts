import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../config/config.ts";
import { DB, type Db, type Tx } from "../db/db.ts";
import { displayTokens, matchPlayerResults, quizVersions, roomPlayers, rooms, type RoomSettings } from "../db/schema.ts";
import { AppError } from "../common/errors.ts";
import { hashSecret, newSecret } from "../common/tokens.ts";
import { parseInput } from "../common/validation.ts";
import { LIMITS, RateLimitService } from "../common/rate-limit.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { AnalyticsService } from "../analytics/analytics.service.ts";
import { generateRoomCode, isValidRoomCode } from "../room/room-code.ts";
import { isTerminal } from "../game/lifecycle.ts";
import type { AuthUser } from "../auth/auth-user.ts";
import { sanitizeDisplayName } from "../users/users.service.ts";
import { QuizzesService } from "../quizzes/quizzes.service.ts";
import { GameService } from "../realtime/game.service.ts";
import { ServerEvents as E } from "../realtime/protocol.ts";
import { Effects } from "../realtime/effects.ts";
import { activePlayers, getMatch, lockRoom, membership, phaseOf, serializePlayer, type RoomRow } from "./room-repo.ts";
import { SnapshotService } from "./snapshot.service.ts";

const pacingSeconds = z.number().int().min(3).max(15);

const roomSettingsInput = z.object({
  questionDurationSeconds: z.number().int().min(5).max(120).nullable().optional(),
  shuffleQuestions: z.boolean().optional(),
  shuffleOptions: z.boolean().optional(),
  lateJoin: z.boolean().optional(),
  revealSeconds: pacingSeconds.optional(),
  scoreboardSeconds: pacingSeconds.optional(),
});

export const createRoomSchema = z
  .object({
    quizId: z.string().uuid().optional(),
    quizVersionId: z.string().uuid().optional(),
    pacing: z.enum(["automatic", "host_paced"]).default("automatic"),
    visibility: z.enum(["private", "unlisted"]).default("private"),
    maxPlayers: z.number().int().min(2).default(20),
    displayName: z.string().max(60).optional(),
    settings: roomSettingsInput.default({}),
  })
  .refine((v) => v.quizId || v.quizVersionId, { message: "Choose a quiz to host.", path: ["quizId"] });

export const joinRoomSchema = z.object({
  code: z.string().min(1).max(20),
  displayName: z.string().max(60).optional(),
});

export const rematchSchema = z.object({
  quizVersion: z.enum(["same", "latest"]).default("same"),
  pacing: z.enum(["automatic", "host_paced"]).optional(),
  settings: roomSettingsInput.optional(),
});

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

const PG_UNIQUE_VIOLATION = "23505";

@Injectable()
export class RoomsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly quizzes: QuizzesService,
    private readonly game: GameService,
    private readonly snapshots: SnapshotService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
  ) {}

  private lobbyExpiry() {
    return new Date(Date.now() + this.config.LOBBY_EXPIRY_MS);
  }

  // Inserts the room, retrying on the rare code collision with an active room.
  // The partial unique index makes the check atomic across instances.
  private async insertRoom(tx: Tx, values: Omit<typeof rooms.$inferInsert, "code">): Promise<RoomRow> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = generateRoomCode();
      try {
        const [row] = await tx.transaction(async (sp) => sp.insert(rooms).values({ ...values, code }).returning());
        return row!;
      } catch (err) {
        if ((err as { code?: string }).code !== PG_UNIQUE_VIOLATION && (err as { cause?: { code?: string } }).cause?.code !== PG_UNIQUE_VIOLATION) throw err;
      }
    }
    throw new AppError("INTERNAL_ERROR", "Could not allocate a room code.");
  }

  private async addMember(tx: Tx, roomId: string, userId: string, displayName: string, role: "host" | "player") {
    const resumeToken = newSecret();
    await tx
      .insert(roomPlayers)
      .values({ roomId, userId, displayNameSnapshot: displayName, role, resumeTokenHash: hashSecret(resumeToken) });
    return resumeToken;
  }

  async create(user: AuthUser, body: unknown) {
    const input = parseInput(createRoomSchema, body);
    if (!user.canHost) throw new AppError("FORBIDDEN", "Hosting is disabled for this account.");
    await this.rateLimit.hit("roomCreate", user.id, LIMITS.roomCreate.limit, LIMITS.roomCreate.windowSec);
    if (input.maxPlayers > this.config.ROOM_MAX_PLAYERS_CAP) {
      throw new AppError("VALIDATION_ERROR", `Rooms can hold at most ${this.config.ROOM_MAX_PLAYERS_CAP} players.`);
    }
    const { version } = await this.quizzes.hostableVersion(user, input);
    const displayName = input.displayName ? sanitizeDisplayName(input.displayName) : user.displayName;
    const settings: RoomSettings = {
      questionDurationSeconds: input.settings.questionDurationSeconds ?? null,
      shuffleQuestions: input.settings.shuffleQuestions ?? version.settings.shuffleQuestions,
      shuffleOptions: input.settings.shuffleOptions ?? version.settings.shuffleOptions,
      lateJoin: input.settings.lateJoin ?? false,
      revealSeconds: input.settings.revealSeconds ?? 5,
      scoreboardSeconds: input.settings.scoreboardSeconds ?? 5,
    };
    return this.createRoom(user, {
      quizVersionId: version.id,
      pacing: input.pacing,
      visibility: input.visibility,
      maxPlayers: input.maxPlayers,
      settings,
      displayName,
      rematchOfRoomId: null,
    });
  }

  private async createRoom(
    user: AuthUser,
    opts: {
      quizVersionId: string;
      pacing: string;
      visibility: string;
      maxPlayers: number;
      settings: RoomSettings;
      displayName: string;
      rematchOfRoomId: string | null;
    },
  ) {
    const { room, resumeToken } = await this.game.run(async (tx, fx) => {
      const room = await this.insertRoom(tx, {
        hostUserId: user.id,
        quizVersionId: opts.quizVersionId,
        status: "LOBBY",
        pacing: opts.pacing,
        visibility: opts.visibility,
        maxPlayers: opts.maxPlayers,
        settings: opts.settings,
        rematchOfRoomId: opts.rematchOfRoomId,
        expiresAt: this.lobbyExpiry(),
      });
      const resumeToken = await this.addMember(tx, room.id, user.id, opts.displayName, "host");
      fx.schedule({ type: "lobby_expiry", roomId: room.id }, this.config.LOBBY_EXPIRY_MS + 50);
      await this.audit.record("room.created", "room", room.id, user.id, { rematchOf: opts.rematchOfRoomId }, tx);
      return { room, resumeToken };
    });
    this.analytics.track("room_created", user.id, { pacing: opts.pacing, rematch: !!opts.rematchOfRoomId });
    return {
      roomId: room.id,
      code: room.code,
      resumeToken,
      snapshot: await this.snapshots.build(room.id, user.id),
    };
  }

  // Join by code (spec 8.2, MVP-06). Order of checks: code shape, lockout,
  // room exists, removed, rejoin, state, lock, capacity.
  async join(user: AuthUser, body: unknown, clientKey: string) {
    const input = parseInput(joinRoomSchema, body);
    const code = normalizeCode(input.code);
    const limiterKey = `${user.id}`;
    await this.rateLimit.assertNotLockedOut(limiterKey);
    await this.rateLimit.assertNotLockedOut(clientKey);
    await this.rateLimit.hit("roomJoin", limiterKey, LIMITS.roomJoin.limit, LIMITS.roomJoin.windowSec);

    const fail = async (err: AppError) => {
      await this.rateLimit.recordJoinFailure(limiterKey);
      await this.rateLimit.recordJoinFailure(clientKey, "ip");
      throw err;
    };
    if (!isValidRoomCode(code)) return fail(new AppError("ROOM_NOT_FOUND"));

    const latest = await this.db.query.rooms.findFirst({ where: eq(rooms.code, code), orderBy: desc(rooms.createdAt) });
    if (!latest) return fail(new AppError("ROOM_NOT_FOUND"));
    if (isTerminal(phaseOf(latest))) {
      // A recently ended room says so instead of "not found".
      if (Date.now() - (latest.endedAt ?? latest.updatedAt).getTime() < 24 * 3600_000) throw new AppError("ROOM_NOT_JOINABLE");
      return fail(new AppError("ROOM_NOT_FOUND"));
    }
    const displayName = input.displayName ? sanitizeDisplayName(input.displayName) : user.displayName;

    const { resumeToken } = await this.game.run(async (tx, fx) => {
      const room = await lockRoom(tx, latest.id);
      const phase = phaseOf(room);
      if (isTerminal(phase)) throw new AppError("ROOM_NOT_JOINABLE");
      const existing = await membership(tx, room.id, user.id);
      if (existing?.removedAt) throw new AppError("PLAYER_REMOVED");

      if (existing) {
        // Rejoining the same seat issues a fresh resume token.
        const resumeToken = newSecret();
        await tx
          .update(roomPlayers)
          .set({ resumeTokenHash: hashSecret(resumeToken), ...(phase === "LOBBY" ? { displayNameSnapshot: displayName } : {}) })
          .where(eq(roomPlayers.id, existing.id));
        return { resumeToken };
      }

      const inMatch = phase !== "LOBBY";
      if (inMatch && !room.settings.lateJoin) throw new AppError("GAME_ALREADY_STARTED");
      if (room.isLocked) throw new AppError("ROOM_LOCKED");
      const players = await activePlayers(tx, room.id);
      if (players.length >= room.maxPlayers) throw new AppError("ROOM_FULL");
      const taken = new Set(players.map((p) => p.displayNameSnapshot.toLowerCase()));
      let name = displayName;
      for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${displayName.slice(0, 21)} ${n}`;

      const resumeToken = await this.addMember(tx, room.id, user.id, name, "player");
      if (inMatch && room.currentMatchId) {
        const match = await getMatch(tx, room.currentMatchId);
        // Late joiners score from the next question onward (spec 8.2).
        const firstScored = phase === "STARTING" ? 0 : match.currentPosition + 1;
        await tx
          .insert(matchPlayerResults)
          .values({ matchId: match.id, userId: user.id, displayNameSnapshot: name, joinedPosition: firstScored })
          .onConflictDoNothing();
      }
      if (phase === "LOBBY") await tx.update(rooms).set({ expiresAt: this.lobbyExpiry(), updatedAt: new Date() }).where(eq(rooms.id, room.id));
      const updated = await activePlayers(tx, room.id);
      fx.room(room.id, E.roomUpdated, { changes: { players: updated.map(serializePlayer) } });
      return { resumeToken };
    }, latest.id);
    this.analytics.track("player_joined", user.id, { guest: user.isGuest });
    return {
      roomId: latest.id,
      code: latest.code,
      resumeToken,
      snapshot: await this.snapshots.build(latest.id, user.id),
    };
  }

  async get(user: AuthUser, roomId: string) {
    if (!z.string().uuid().safeParse(roomId).success) throw new AppError("ROOM_NOT_FOUND");
    const member = await membership(this.db, roomId, user.id);
    if (!member) throw new AppError("ROOM_NOT_FOUND");
    if (member.removedAt) throw new AppError("PLAYER_REMOVED");
    return this.snapshots.build(roomId, user.id);
  }

  private async hostedRoom(user: AuthUser, roomId: string) {
    if (!z.string().uuid().safeParse(roomId).success) throw new AppError("ROOM_NOT_FOUND");
    const room = await this.db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
    if (!room) throw new AppError("ROOM_NOT_FOUND");
    if (room.hostUserId !== user.id) throw new AppError("HOST_ONLY");
    return room;
  }

  // Rematch (spec 8.10): a new room linked to this one, same settings unless
  // changed. Every connected player gets a one-tap invite.
  async rematch(user: AuthUser, roomId: string, body: unknown) {
    const input = parseInput(rematchSchema, body ?? {});
    const room = await this.hostedRoom(user, roomId);
    if (!["FINISHED", "ENDED_EARLY"].includes(room.status)) {
      throw new AppError("INVALID_STATE", "A rematch can start once this game has ended.");
    }
    await this.rateLimit.hit("roomCreate", user.id, LIMITS.roomCreate.limit, LIMITS.roomCreate.windowSec);
    let versionId = room.quizVersionId;
    if (input.quizVersion === "latest") {
      const current = await this.db.query.quizVersions.findFirst({ where: eq(quizVersions.id, room.quizVersionId) });
      const { version } = await this.quizzes.hostableVersion(user, { quizId: current!.quizId });
      versionId = version.id;
    }
    const host = await membership(this.db, roomId, user.id);
    const created = await this.createRoom(user, {
      quizVersionId: versionId,
      pacing: input.pacing ?? room.pacing,
      visibility: room.visibility,
      maxPlayers: room.maxPlayers,
      settings: { ...room.settings, ...(input.settings ?? {}) } as RoomSettings,
      displayName: host?.displayNameSnapshot ?? user.displayName,
      rematchOfRoomId: room.id,
    });
    const players = await activePlayers(this.db, roomId);
    const fx = new Effects();
    for (const p of players) {
      if (p.userId === user.id || p.connectionState !== "CONNECTED") continue;
      fx.user(roomId, p.userId, E.roomRematch, {
        newRoomId: created.roomId,
        code: created.code,
        hostName: host?.displayNameSnapshot ?? user.displayName,
      });
    }
    await this.game.flush(fx);
    return created;
  }

  // Big Screen token (spec 4.2, 14.1): random, shown once, hashed at rest,
  // scoped to one room, read-only and revocable.
  async createDisplayToken(user: AuthUser, roomId: string) {
    const room = await this.hostedRoom(user, roomId);
    if (isTerminal(phaseOf(room))) throw new AppError("INVALID_STATE", "This room has ended.");
    const token = newSecret();
    const [row] = await this.db.insert(displayTokens).values({ roomId, tokenHash: hashSecret(token) }).returning();
    await this.audit.record("display_token.created", "room", roomId, user.id, { tokenId: row!.id });
    return { tokenId: row!.id, displayToken: token, roomId, code: room.code };
  }

  async revokeDisplayToken(user: AuthUser, roomId: string, tokenId: string) {
    await this.hostedRoom(user, roomId);
    if (!z.string().uuid().safeParse(tokenId).success) throw new AppError("NOT_FOUND");
    const [row] = await this.db
      .update(displayTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(displayTokens.id, tokenId), eq(displayTokens.roomId, roomId), isNull(displayTokens.revokedAt)))
      .returning();
    if (!row) throw new AppError("NOT_FOUND", "Display token not found.");
    // Drop every Big Screen socket; screens holding another valid token reconnect.
    this.game.disconnectDisplays(roomId);
    await this.audit.record("display_token.revoked", "room", roomId, user.id, { tokenId });
    return { tokenId, revoked: true };
  }

  async verifyDisplayToken(token: string) {
    const row = await this.db.query.displayTokens.findFirst({ where: eq(displayTokens.tokenHash, hashSecret(token)) });
    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() < Date.now())) return null;
    return row;
  }
}
