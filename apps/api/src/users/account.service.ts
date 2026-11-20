import { Inject, Injectable, Logger } from "@nestjs/common";
import { createClient } from "@supabase/supabase-js";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../config/config.ts";
import { DB, type Db } from "../db/db.ts";
import {
  draftQuestions,
  matchPlayerResults,
  matches,
  mediaUploads,
  quizVersions,
  quizzes,
  reports,
  roomPlayers,
  rooms,
  users,
} from "../db/schema.ts";
import { AuditService } from "../audit/audit.service.ts";
import { MediaStorage } from "../media/storage.ts";
import { GameService } from "../realtime/game.service.ts";
import type { AuthUser } from "../auth/auth-user.ts";
import { TERMINAL_STATUSES } from "../rooms/room-repo.ts";

export const DELETED_NAME = "Deleted player";

// Data export and account deletion (spec 11, 14.3). Match results are kept
// but anonymized, so other players' standings stay intact.
@Injectable()
export class AccountService {
  private readonly log = new Logger("Account");

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly storage: MediaStorage,
    private readonly audit: AuditService,
    private readonly game: GameService,
  ) {}

  async export(user: AuthUser) {
    const profile = await this.db.query.users.findFirst({ where: eq(users.id, user.id) });
    const ownQuizzes = await this.db.select().from(quizzes).where(eq(quizzes.ownerId, user.id));
    const drafts = ownQuizzes.length
      ? await this.db.select().from(draftQuestions).where(inArray(draftQuestions.quizId, ownQuizzes.map((q) => q.id)))
      : [];
    const results = await this.db
      .select({ r: matchPlayerResults, m: matches })
      .from(matchPlayerResults)
      .innerJoin(matches, eq(matches.id, matchPlayerResults.matchId))
      .where(eq(matchPlayerResults.userId, user.id));
    const filed = await this.db.select().from(reports).where(eq(reports.reporterId, user.id));
    const hosted = await this.db.select({ id: rooms.id, code: rooms.code, status: rooms.status, createdAt: rooms.createdAt }).from(rooms).where(eq(rooms.hostUserId, user.id));
    const uploads = await this.db.select().from(mediaUploads).where(eq(mediaUploads.ownerId, user.id));
    return {
      exportedAt: new Date().toISOString(),
      profile: profile && {
        id: profile.id,
        displayName: profile.displayName,
        email: profile.email,
        avatarUrl: profile.avatarUrl,
        isGuest: profile.isGuest,
        createdAt: profile.createdAt,
        lastActiveAt: profile.lastActiveAt,
      },
      quizzes: ownQuizzes.map((q) => ({ ...q, questions: drafts.filter((d) => d.quizId === q.id) })),
      matches: results.map(({ r, m }) => ({
        matchId: m.id,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        completionReason: m.completionReason,
        rank: r.rank,
        totalScore: r.totalScore,
        correctCount: r.correctCount,
        longestStreak: r.longestStreak,
      })),
      roomsHosted: hosted,
      reportsFiled: filed.map((r) => ({ id: r.id, targetType: r.targetType, reason: r.reason, status: r.status, createdAt: r.createdAt })),
      uploads: uploads.map((u) => ({ id: u.id, purpose: u.purpose, url: u.publicUrl, createdAt: u.createdAt })),
    };
  }

  async delete(user: AuthUser) {
    // Close any live room this user hosts so nobody is left waiting.
    const hostedLive = await this.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.hostUserId, user.id), notInArray(rooms.status, TERMINAL_STATUSES)));
    for (const r of hostedLive) await this.game.close(r.id, user.id, "host_closed").catch(() => undefined);

    const uploads = await this.db.select().from(mediaUploads).where(eq(mediaUploads.ownerId, user.id));
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ displayName: DELETED_NAME, authSubject: null, email: null, avatarUrl: null, status: "deleted", canHost: false })
        .where(eq(users.id, user.id));
      await tx.update(roomPlayers).set({ displayNameSnapshot: DELETED_NAME, resumeTokenHash: null }).where(eq(roomPlayers.userId, user.id));
      await tx.update(matchPlayerResults).set({ displayNameSnapshot: DELETED_NAME }).where(eq(matchPlayerResults.userId, user.id));

      // Quizzes: delete those never played; archive and detach the rest.
      const owned = await tx.select({ id: quizzes.id }).from(quizzes).where(eq(quizzes.ownerId, user.id));
      for (const q of owned) {
        const played = await tx
          .select({ id: matches.id })
          .from(matches)
          .innerJoin(quizVersions, eq(quizVersions.id, matches.quizVersionId))
          .where(eq(quizVersions.quizId, q.id))
          .limit(1);
        const hostedRoom = await tx
          .select({ id: rooms.id })
          .from(rooms)
          .innerJoin(quizVersions, eq(quizVersions.id, rooms.quizVersionId))
          .where(eq(quizVersions.quizId, q.id))
          .limit(1);
        if (played.length === 0 && hostedRoom.length === 0) {
          await tx.delete(quizzes).where(eq(quizzes.id, q.id));
        } else {
          await tx.update(quizzes).set({ status: "archived", visibility: "private", ownerId: null, title: "Deleted quiz", description: "" }).where(eq(quizzes.id, q.id));
          await tx.delete(draftQuestions).where(eq(draftQuestions.quizId, q.id));
        }
      }
      await tx.delete(mediaUploads).where(eq(mediaUploads.ownerId, user.id));
      await this.audit.record("user.deleted", "user", user.id, user.id, {}, tx);
    });
    for (const u of uploads) await this.storage.remove(u.path).catch(() => undefined);

    if (this.config.SUPABASE_URL && this.config.SUPABASE_SERVICE_ROLE_KEY && user.authSubject) {
      const admin = createClient(this.config.SUPABASE_URL, this.config.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      const { error } = await admin.auth.admin.deleteUser(user.authSubject);
      if (error) this.log.error(`Supabase user deletion failed for ${user.id}: ${error.message}`);
    }
    return { deleted: true };
  }
}
