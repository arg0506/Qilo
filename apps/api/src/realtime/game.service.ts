import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../config/config.ts";
import { DB, type Db, type Tx } from "../db/db.ts";
import {
  answers,
  matchPlayerResults,
  matchQuestions,
  matches,
  questionOptions,
  questions,
  roomPlayers,
  rooms,
} from "../db/schema.ts";
import { REDIS } from "../redis/redis.module.ts";
import { AppError } from "../common/errors.ts";
import { hashSecret } from "../common/tokens.ts";
import { AuditService } from "../audit/audit.service.ts";
import { AnalyticsService } from "../analytics/analytics.service.ts";
import { transition, isInMatch, isTerminal, type RoomPhase } from "../game/lifecycle.ts";
import { decideAnswer, shouldRevealEarly } from "../game/answer.ts";
import { scoreAnswer } from "../game/scoring.ts";
import { matchOrder } from "../game/shuffle.ts";
import {
  activePlayers,
  answersFor,
  getMatch,
  leaderboard,
  lockRoom,
  matchQuestionAt,
  membership,
  persistRanks,
  phaseOf,
  publicQuestion,
  questionContent,
  revealPayload,
  serializePlayer,
  type MatchRow,
  type RoomRow,
} from "../rooms/room-repo.ts";
import { serializeRoom } from "../rooms/snapshot.service.ts";
import { Broadcaster } from "./broadcaster.service.ts";
import { Effects, type TimerJob } from "./effects.ts";
import { KeyedMutex } from "../common/keyed-mutex.ts";
import { ServerEvents as E } from "./protocol.ts";
import { TimersService } from "./timers.service.ts";

export const MIN_PLAYERS_TO_START = 2;
const FAST_ANSWER_MS = 300;
const FAST_ANSWER_FLAG_COUNT = 3;

export interface AnswerCommand {
  roomId: string;
  matchQuestionId: string;
  optionKey: string;
  idempotencyKey: string;
}

// The authoritative game engine for live rooms (spec 8 and 13). Every state
// change runs inside a transaction that holds the room's row lock, so commands,
// answers and timers for one room are applied one at a time and in order.
// Events and timers are released only after the transaction commits.
@Injectable()
export class GameService implements OnModuleInit {
  private readonly log = new Logger("Game");
  private readonly roomQueue = new KeyedMutex();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly broadcaster: Broadcaster,
    private readonly timers: TimersService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
  ) {}

  onModuleInit() {
    this.timers.register((job) => this.onTimer(job));
  }

  // Runs `fn` in a transaction and applies its effects after commit. With a
  // room id, work for that room is queued in-process first.
  async run<T>(fn: (tx: Tx, fx: Effects) => Promise<T>, roomId?: string): Promise<T> {
    const exec = async () => {
      const fx = new Effects();
      const result = await this.db.transaction((tx) => fn(tx, fx));
      await this.flush(fx);
      return result;
    };
    return roomId ? this.roomQueue.run(roomId, exec) : exec();
  }

  async flush(fx: Effects) {
    for (const emit of fx.emits) this.broadcaster.send(emit);
    for (const s of fx.schedules) {
      await this.timers.schedule(s.job, s.delayMs).catch((err: unknown) => this.log.error(`schedule ${s.job.type} failed: ${String(err)}`));
    }
    for (const fn of fx.after) await fn().catch((err: unknown) => this.log.error(`after-commit step failed: ${String(err)}`));
  }

  private scaled(ms: number) {
    return Math.max(1, Math.round(ms * this.config.TIME_SCALE));
  }

  private setStatus(room: RoomRow, to: RoomPhase): RoomPhase {
    const next = transition(phaseOf(room), to);
    room.status = next;
    return next;
  }

  private async saveRoom(tx: Tx, room: RoomRow, changes: Partial<RoomRow>) {
    Object.assign(room, changes);
    await tx.update(rooms).set({ ...changes, updatedAt: new Date() }).where(eq(rooms.id, room.id));
  }

  private roomUpdated(fx: Effects, room: RoomRow, extra: Record<string, unknown> = {}) {
    fx.room(room.id, E.roomUpdated, { changes: { ...serializeRoom(room), ...extra } });
  }

  private async assertHost(tx: Tx, room: RoomRow, userId: string) {
    if (room.hostUserId !== userId) throw new AppError("HOST_ONLY");
    const member = await membership(tx, room.id, userId);
    if (!member || member.removedAt) throw new AppError("HOST_ONLY");
  }

  // ---- Lobby -------------------------------------------------------------

  async setReady(roomId: string, userId: string, ready: boolean) {
    return this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      const member = await membership(tx, roomId, userId);
      if (!member || member.removedAt) throw new AppError("FORBIDDEN");
      await tx.update(roomPlayers).set({ isReady: ready }).where(eq(roomPlayers.id, member.id));
      await this.emitPlayers(tx, fx, room);
      return { ready };
    }, roomId);
  }

  async emitPlayers(tx: Tx, fx: Effects, room: RoomRow) {
    const players = await activePlayers(tx, room.id);
    fx.room(room.id, E.roomUpdated, { changes: { players: players.map(serializePlayer) } });
  }

  async lockLobby(roomId: string, userId: string, locked: boolean) {
    return this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      await this.assertHost(tx, room, userId);
      if (isTerminal(phaseOf(room))) throw new AppError("INVALID_STATE", "This room has ended.");
      await this.saveRoom(tx, room, { isLocked: locked });
      this.roomUpdated(fx, room);
      return { isLocked: locked };
    }, roomId);
  }

  async removePlayer(roomId: string, hostId: string, playerId: string) {
    const result = await this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      await this.assertHost(tx, room, hostId);
      if (playerId === hostId) throw new AppError("VALIDATION_ERROR", "The host cannot remove themselves.");
      const member = await membership(tx, roomId, playerId);
      if (!member || member.removedAt) throw new AppError("NOT_FOUND", "That player is not in this room.");
      // The resume token is revoked, so the seat cannot be reclaimed (spec 8.2).
      await tx
        .update(roomPlayers)
        .set({ removedAt: new Date(), resumeTokenHash: null, connectionState: "DISCONNECTED" })
        .where(eq(roomPlayers.id, member.id));
      await this.audit.record("room.player_removed", "room", roomId, hostId, { playerId }, tx);
      fx.user(roomId, playerId, E.roomRemoved, { reason: "removed_by_host" });
      fx.then(() => this.broadcaster.evict(roomId, playerId));
      await this.emitPlayers(tx, fx, room);
      if (room.currentMatchId) {
        fx.room(room.id, E.leaderboardUpdate, { entries: await leaderboard(tx, room.currentMatchId, room.id), isFinal: false });
      }
      return { removed: playerId };
    }, roomId);
    await this.checkEarlyReveal(roomId);
    return result;
  }

  // ---- Match start ---------------------------------------------------------

  async start(roomId: string, userId: string) {
    return this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      await this.assertHost(tx, room, userId);
      if (phaseOf(room) !== "LOBBY") {
        throw new AppError(isTerminal(phaseOf(room)) ? "ROOM_NOT_JOINABLE" : "GAME_ALREADY_STARTED");
      }
      const players = await activePlayers(tx, roomId);
      if (players.length < MIN_PLAYERS_TO_START) {
        throw new AppError("GAME_NOT_STARTABLE", `At least ${MIN_PLAYERS_TO_START} players are needed to start.`);
      }
      const versionQuestions = await tx
        .select()
        .from(questions)
        .where(eq(questions.quizVersionId, room.quizVersionId))
        .orderBy(asc(questions.position));
      if (versionQuestions.length === 0) throw new AppError("GAME_NOT_STARTABLE", "This quiz has no questions.");

      const version = await tx.query.quizVersions.findFirst({ where: (v, { eq: eqf }) => eqf(v.id, room.quizVersionId) });
      const ordered = matchOrder(versionQuestions, room.settings.shuffleQuestions);
      const optionRows = await tx
        .select()
        .from(questionOptions)
        .where(inArray(questionOptions.questionId, ordered.map((q) => q.id)))
        .orderBy(asc(questionOptions.position));

      const [match] = await tx
        .insert(matches)
        .values({
          roomId,
          quizVersionId: room.quizVersionId,
          status: "STARTING",
          scoringProfile: version?.scoringProfile ?? "classic-v1",
          questionCount: ordered.length,
        })
        .returning();
      await tx.insert(matchQuestions).values(
        ordered.map((q, position) => {
          const keys = optionRows.filter((o) => o.questionId === q.id).map((o) => o.optionKey);
          const seconds = room.settings.questionDurationSeconds ?? q.durationSeconds;
          return {
            matchId: match!.id,
            questionId: q.id,
            position,
            optionOrder: matchOrder(keys, room.settings.shuffleOptions),
            durationMs: this.scaled(seconds * 1000),
          };
        }),
      );
      await tx.insert(matchPlayerResults).values(
        players.map((p) => ({ matchId: match!.id, userId: p.userId, displayNameSnapshot: p.displayNameSnapshot })),
      );

      const countdownEndsAt = new Date(Date.now() + this.config.COUNTDOWN_MS);
      this.setStatus(room, "STARTING");
      await this.saveRoom(tx, room, { status: room.status, currentMatchId: match!.id, phaseEndsAt: countdownEndsAt, isLocked: room.isLocked });
      fx.room(roomId, E.gameStarting, {
        matchId: match!.id,
        questionCount: ordered.length,
        countdownEndsAt: countdownEndsAt.toISOString(),
      });
      this.roomUpdated(fx, room);
      fx.schedule({ type: "countdown_end", roomId, matchId: match!.id }, this.config.COUNTDOWN_MS);
      this.analytics.track("match_started", userId, { players: players.length, questions: ordered.length, pacing: room.pacing });
      return { matchId: match!.id, countdownEndsAt: countdownEndsAt.toISOString() };
    }, roomId);
  }

  // Opens the question at `position`. Caller holds the room lock.
  private async beginQuestion(tx: Tx, fx: Effects, room: RoomRow, match: MatchRow, position: number) {
    const mq = await matchQuestionAt(tx, match.id, position);
    if (!mq) throw new AppError("INVALID_STATE", "Question not found.");
    const startedAt = new Date();
    const deadlineAt = new Date(startedAt.getTime() + mq.durationMs);
    await tx.update(matchQuestions).set({ startedAt, deadlineAt }).where(eq(matchQuestions.id, mq.id));
    await tx.update(matches).set({ status: "QUESTION_ACTIVE", currentPosition: position }).where(eq(matches.id, match.id));
    this.setStatus(room, "QUESTION_ACTIVE");
    await this.saveRoom(tx, room, { status: room.status, phaseEndsAt: deadlineAt });

    const content = await questionContent(tx, mq.questionId);
    const payload = publicQuestion({ ...mq, startedAt, deadlineAt }, content, match.questionCount);
    fx.room(room.id, E.questionStarted, { ...payload, serverTime: startedAt.toISOString() });
    fx.room(room.id, E.questionProgress, { matchQuestionId: mq.id, answeredCount: 0, eligibleCount: await this.connectedCount(tx, room.id) });
    fx.schedule({ type: "question_deadline", roomId: room.id, matchQuestionId: mq.id }, mq.durationMs);
  }

  private async connectedCount(tx: Tx, roomId: string) {
    const players = await activePlayers(tx, roomId);
    return players.filter((p) => p.connectionState === "CONNECTED").length;
  }

  // ---- Answers -------------------------------------------------------------

  async submitAnswer(userId: string, cmd: AnswerCommand) {
    const receivedAt = new Date(); // Server time decides; clients never send timestamps.
    const outcome = await this.run(async (tx, fx) => {
      const room = await lockRoom(tx, cmd.roomId);
      const member = await membership(tx, room.id, userId);
      const isMember = !!member && !member.removedAt;
      const match = room.currentMatchId ? await getMatch(tx, room.currentMatchId) : null;
      const mq = match
        ? await tx.query.matchQuestions.findFirst({
            where: and(eq(matchQuestions.id, cmd.matchQuestionId), eq(matchQuestions.matchId, match.id)),
          })
        : undefined;
      if (!isMember) throw new AppError("FORBIDDEN");
      if (!match || !mq) {
        if (phaseOf(room) === "PAUSED") throw new AppError("GAME_PAUSED");
        throw new AppError("ANSWER_DEADLINE_PASSED");
      }

      const existing = await tx.query.answers.findFirst({
        where: and(eq(answers.matchQuestionId, mq.id), eq(answers.userId, userId)),
      });
      const isCurrent = mq.position === match.currentPosition && !mq.lockedAt;
      const phase: RoomPhase = isCurrent ? phaseOf(room) : phaseOf(room) === "PAUSED" ? "PAUSED" : "QUESTION_LOCKED";
      const decision = decideAnswer(
        { phase, deadlineAtMs: mq.deadlineAt?.getTime() ?? 0, optionKeys: mq.optionOrder },
        existing && existing.status !== "timeout"
          ? { idempotencyKey: existing.idempotencyKey ?? "", optionKey: existing.optionKey ?? "" }
          : undefined,
        { isMember, optionKey: cmd.optionKey, idempotencyKey: cmd.idempotencyKey, receivedAtMs: receivedAt.getTime() },
      );
      if (!decision.ok) throw new AppError(decision.code);
      if (decision.duplicate) {
        return { matchQuestionId: mq.id, acceptedAt: existing!.receivedAt.toISOString(), duplicate: true, earlyLock: false };
      }

      const result = await tx.query.matchPlayerResults.findFirst({
        where: and(eq(matchPlayerResults.matchId, match.id), eq(matchPlayerResults.userId, userId)),
      });
      const content = await questionContent(tx, mq.questionId);
      const correct = content.correctOptionKeys.includes(cmd.optionKey);
      const elapsedMs = Math.max(0, receivedAt.getTime() - mq.startedAt!.getTime());
      // A late joiner sees the question they arrived on but scores nothing for it.
      const scored = !!result && mq.position >= result.joinedPosition;
      const streakBefore = result?.currentStreak ?? 0;
      const score = scored
        ? scoreAnswer({ correct, streakBefore, startedAtMs: mq.startedAt!.getTime(), receivedAtMs: receivedAt.getTime(), durationMs: mq.durationMs })
        : { base: 0, speed: 0, streak: 0, total: 0, streakAfter: streakBefore };

      const inserted = await tx
        .insert(answers)
        .values({
          matchQuestionId: mq.id,
          userId,
          optionKey: cmd.optionKey,
          receivedAt,
          elapsedMs: Math.min(elapsedMs, mq.durationMs),
          isCorrect: correct,
          basePoints: score.base,
          speedPoints: score.speed,
          streakPoints: score.streak,
          totalPoints: score.total,
          streakAfter: score.streakAfter,
          status: scored ? "accepted" : "late",
          idempotencyKey: cmd.idempotencyKey,
        })
        .onConflictDoNothing()
        .returning({ id: answers.id });
      if (inserted.length === 0) throw new AppError("ANSWER_ALREADY_SUBMITTED");

      const players = await activePlayers(tx, room.id);
      const connected = players.filter((p) => p.connectionState === "CONNECTED").map((p) => p.userId);
      const answered = new Set(
        (await answersFor(tx, mq.id)).filter((a) => a.status !== "timeout").map((a) => a.userId),
      );
      fx.user(room.id, userId, E.answerAccepted, { matchQuestionId: mq.id, acceptedAt: receivedAt.toISOString() });
      fx.room(room.id, E.questionProgress, {
        matchQuestionId: mq.id,
        answeredCount: [...answered].filter((id) => players.some((p) => p.userId === id)).length,
        eligibleCount: connected.length,
      });
      if (elapsedMs < FAST_ANSWER_MS) fx.then(() => this.noteFastAnswer(match.id, userId, elapsedMs));
      return {
        matchQuestionId: mq.id,
        acceptedAt: receivedAt.toISOString(),
        duplicate: false,
        earlyLock: shouldRevealEarly(connected, answered),
      };
    }, cmd.roomId);
    if (outcome.earlyLock) await this.lockQuestion(cmd.roomId, outcome.matchQuestionId, "all_answered");
    return { matchQuestionId: outcome.matchQuestionId, acceptedAt: outcome.acceptedAt, duplicate: outcome.duplicate };
  }

  // Fair-play signal (spec 14.2): consistently sub-300 ms answers are flagged
  // for review, never auto-banned.
  private async noteFastAnswer(matchId: string, userId: string, elapsedMs: number) {
    const key = `fastanswers:${matchId}:${userId}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 6 * 3600);
    if (n === FAST_ANSWER_FLAG_COUNT) {
      await this.audit.record("fairplay.flagged", "match", matchId, null, { userId, reason: "consistent_sub_300ms_answers", lastElapsedMs: elapsedMs });
    }
  }

  // Early reveal when every connected player has answered (spec 8.9, D-09).
  async checkEarlyReveal(roomId: string) {
    const target = await this.db.transaction(async (tx) => {
      const room = await tx.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
      if (!room || phaseOf(room) !== "QUESTION_ACTIVE" || !room.currentMatchId) return null;
      const match = await getMatch(tx, room.currentMatchId);
      const mq = await matchQuestionAt(tx, match.id, match.currentPosition);
      if (!mq || mq.lockedAt) return null;
      const players = await activePlayers(tx, roomId);
      const connected = players.filter((p) => p.connectionState === "CONNECTED").map((p) => p.userId);
      const answered = new Set((await answersFor(tx, mq.id)).filter((a) => a.status !== "timeout").map((a) => a.userId));
      return shouldRevealEarly(connected, answered) ? mq.id : null;
    });
    if (target) await this.lockQuestion(roomId, target, "all_answered");
  }

  // ---- Lock, reveal, scoreboard ---------------------------------------------

  // Idempotent: runs at the deadline or on early completion; a second run is a
  // no-op (spec 13.3).
  async lockQuestion(roomId: string, matchQuestionId: string, reason: "deadline" | "all_answered") {
    await this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      if (phaseOf(room) !== "QUESTION_ACTIVE" || !room.currentMatchId) return;
      const match = await getMatch(tx, room.currentMatchId);
      const mq = await matchQuestionAt(tx, match.id, match.currentPosition);
      if (!mq || mq.id !== matchQuestionId || mq.lockedAt) return;
      // A deadline job may fire a few milliseconds early; never lock before time.
      if (reason === "deadline" && mq.deadlineAt && Date.now() < mq.deadlineAt.getTime()) {
        fx.schedule({ type: "question_deadline", roomId, matchQuestionId }, mq.deadlineAt.getTime() - Date.now() + 5);
        return;
      }

      const now = new Date();
      this.setStatus(room, "QUESTION_LOCKED");
      const players = await activePlayers(tx, roomId);
      const activeIds = new Set(players.map((p) => p.userId));
      const existing = await answersFor(tx, mq.id);
      const answeredIds = new Set(existing.map((a) => a.userId));

      // Timeouts: zero points and the streak resets (spec 8.4).
      const timeouts = players.filter((p) => !answeredIds.has(p.userId));
      if (timeouts.length > 0) {
        await tx.insert(answers).values(
          timeouts.map((p) => ({
            matchQuestionId: mq.id,
            userId: p.userId,
            optionKey: null,
            receivedAt: now,
            elapsedMs: mq.durationMs,
            isCorrect: false,
            basePoints: 0,
            speedPoints: 0,
            streakPoints: 0,
            totalPoints: 0,
            streakAfter: 0,
            status: "timeout",
          })),
        ).onConflictDoNothing();
      }
      const all = await answersFor(tx, mq.id);
      const results = await tx.select().from(matchPlayerResults).where(eq(matchPlayerResults.matchId, match.id));

      for (const r of results) {
        if (!activeIds.has(r.userId)) continue;
        const a = all.find((x) => x.userId === r.userId);
        if (!a) continue;
        const scored = a.status === "accepted";
        const isLate = a.status === "late";
        const correct = scored && a.isCorrect;
        const streak = isLate ? r.currentStreak : a.streakAfter;
        await tx
          .update(matchPlayerResults)
          .set({
            totalScore: r.totalScore + a.totalPoints,
            correctCount: r.correctCount + (correct ? 1 : 0),
            answeredCount: r.answeredCount + (a.status === "timeout" ? 0 : 1),
            currentStreak: streak,
            longestStreak: Math.max(r.longestStreak, streak),
            totalAnswerTimeMs: r.totalAnswerTimeMs + (correct ? a.elapsedMs : 0),
          })
          .where(eq(matchPlayerResults.id, r.id));
      }

      const distribution: Record<string, number> = {};
      for (const key of mq.optionOrder) distribution[key] = 0;
      for (const a of all) if (a.optionKey && a.status !== "timeout" && activeIds.has(a.userId)) distribution[a.optionKey] = (distribution[a.optionKey] ?? 0) + 1;

      const entries = await leaderboard(tx, match.id, roomId);
      await persistRanks(tx, match.id, entries);
      await tx.update(matchQuestions).set({ lockedAt: now, revealedAt: now, distribution }).where(eq(matchQuestions.id, mq.id));

      const revealMs = this.scaled(room.settings.revealSeconds * 1000);
      this.setStatus(room, "ANSWER_REVEAL");
      await this.saveRoom(tx, room, { status: room.status, phaseEndsAt: new Date(now.getTime() + revealMs) });
      await tx.update(matches).set({ status: "ANSWER_REVEAL" }).where(eq(matches.id, match.id));

      const content = await questionContent(tx, mq.questionId);
      fx.room(roomId, E.questionRevealed, { ...revealPayload({ ...mq, distribution }, content), reason, revealEndsAt: room.phaseEndsAt!.toISOString() });
      const rankOf = new Map(entries.map((e) => [e.userId, e]));
      for (const a of all) {
        if (!activeIds.has(a.userId)) continue;
        const entry = rankOf.get(a.userId);
        fx.user(roomId, a.userId, E.scoreUpdate, {
          matchQuestionId: mq.id,
          playerId: a.userId,
          optionKey: a.optionKey,
          status: a.status,
          isCorrect: a.status === "accepted" && a.isCorrect,
          pointsEarned: a.totalPoints,
          breakdown: { base: a.basePoints, speed: a.speedPoints, streak: a.streakPoints },
          streak: a.status === "late" ? (results.find((r) => r.userId === a.userId)?.currentStreak ?? 0) : a.streakAfter,
          totalScore: entry?.totalScore ?? 0,
          rank: entry?.rank ?? null,
        });
      }
      fx.schedule({ type: "reveal_end", roomId, matchQuestionId: mq.id }, revealMs);
    }, roomId);
  }

  private async onRevealEnd(roomId: string, matchQuestionId: string) {
    await this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      if (phaseOf(room) !== "ANSWER_REVEAL" || !room.currentMatchId) return;
      const match = await getMatch(tx, room.currentMatchId);
      const mq = await matchQuestionAt(tx, match.id, match.currentPosition);
      if (!mq || mq.id !== matchQuestionId) return;

      const entries = await leaderboard(tx, match.id, roomId);
      const isLast = match.currentPosition >= match.questionCount - 1;
      this.setStatus(room, "SCOREBOARD");
      await tx.update(matches).set({ status: "SCOREBOARD" }).where(eq(matches.id, match.id));

      if (room.pacing === "automatic") {
        const scoreboardMs = this.scaled(room.settings.scoreboardSeconds * 1000);
        await this.saveRoom(tx, room, { status: room.status, phaseEndsAt: new Date(Date.now() + scoreboardMs) });
        fx.schedule({ type: "scoreboard_end", roomId, matchQuestionId: mq.id }, scoreboardMs);
      } else {
        await this.saveRoom(tx, room, { status: room.status, phaseEndsAt: null });
      }
      fx.room(roomId, E.leaderboardUpdate, {
        entries,
        position: match.currentPosition,
        questionCount: match.questionCount,
        isLastQuestion: isLast,
        isFinal: false,
        scoreboardEndsAt: room.phaseEndsAt?.toISOString() ?? null,
        waitingForHost: room.pacing === "host_paced",
      });
      this.roomUpdated(fx, room);

      // A host-paced pause takes effect as soon as the scoreboard is up.
      if (room.pacing === "host_paced" && room.pauseRequested) await this.enterPause(tx, fx, room);
    }, roomId);
  }

  // Leaves the scoreboard: pause, next question or finish.
  private async advance(tx: Tx, fx: Effects, room: RoomRow) {
    if (!room.currentMatchId) return;
    const match = await getMatch(tx, room.currentMatchId);
    if (room.pauseRequested && phaseOf(room) === "SCOREBOARD") {
      await this.enterPause(tx, fx, room);
      return;
    }
    if (match.currentPosition >= match.questionCount - 1) {
      await this.finish(tx, fx, room, match, "finished");
      return;
    }
    this.setStatus(room, "NEXT_QUESTION");
    await this.beginQuestion(tx, fx, room, match, match.currentPosition + 1);
  }

  private async enterPause(tx: Tx, fx: Effects, room: RoomRow) {
    this.setStatus(room, "PAUSED");
    const resumeDeadlineAt =
      room.pauseReason === "host_absent" && room.hostAbsentSince
        ? new Date(room.hostAbsentSince.getTime() + this.config.HOST_PAUSE_MAX_MS)
        : null;
    await this.saveRoom(tx, room, { status: room.status, phaseEndsAt: resumeDeadlineAt });
    if (room.currentMatchId) await tx.update(matches).set({ status: "PAUSED" }).where(eq(matches.id, room.currentMatchId));
    fx.room(room.id, E.gamePaused, { reason: room.pauseReason ?? "host", resumeDeadlineAt: resumeDeadlineAt?.toISOString() ?? null });
    this.roomUpdated(fx, room);
  }

  // ---- Host commands -------------------------------------------------------

  async next(roomId: string, userId: string) {
    return this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      await this.assertHost(tx, room, userId);
      if (room.hostPresence !== "connected") throw new AppError("INVALID_STATE", "Host controls are paused while you reconnect.");
      if (phaseOf(room) === "PAUSED") throw new AppError("GAME_PAUSED", "Resume the game first.");
      if (phaseOf(room) !== "SCOREBOARD") throw new AppError("INVALID_STATE", "You can move on once the scoreboard is showing.");
      await this.advance(tx, fx, room);
      return { status: room.status };
    }, roomId);
  }

  // A pause lets the current question run to its deadline and reveal, then
  // waits. No new question starts until the host resumes (spec 8.6).
  async pause(roomId: string, userId: string) {
    return this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      await this.assertHost(tx, room, userId);
      const phase = phaseOf(room);
      if (!isInMatch(phase)) throw new AppError("INVALID_STATE", "There is no game to pause.");
      if (phase === "PAUSED") return { status: phase, pauseRequested: true };
      await this.saveRoom(tx, room, { pauseRequested: true, pauseReason: "host" });
      if (phase === "SCOREBOARD" || phase === "NEXT_QUESTION") await this.enterPause(tx, fx, room);
      else this.roomUpdated(fx, room);
      return { status: room.status, pauseRequested: true };
    }, roomId);
  }

  async resume(roomId: string, userId: string) {
    return this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      await this.assertHost(tx, room, userId);
      if (room.hostPresence !== "connected") throw new AppError("INVALID_STATE", "Host controls are paused while you reconnect.");
      await this.resumeInTx(tx, fx, room);
      return { status: room.status };
    }, roomId);
  }

  private async resumeInTx(tx: Tx, fx: Effects, room: RoomRow) {
    const wasPaused = phaseOf(room) === "PAUSED";
    await this.saveRoom(tx, room, { pauseRequested: false, pauseReason: null });
    if (!wasPaused) {
      this.roomUpdated(fx, room);
      return;
    }
    const match = await getMatch(tx, room.currentMatchId!);
    fx.room(room.id, E.gameResumed, {});
    if (match.currentPosition >= match.questionCount - 1) {
      this.setStatus(room, "NEXT_QUESTION");
      await this.finish(tx, fx, room, match, "finished");
      return;
    }
    this.setStatus(room, "NEXT_QUESTION");
    await this.beginQuestion(tx, fx, room, match, match.currentPosition + 1);
  }

  async close(roomId: string, userId: string | null, reason: "host_closed" | "host_absent") {
    return this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      if (userId) await this.assertHost(tx, room, userId);
      return this.closeInTx(tx, fx, room, reason, userId);
    }, roomId);
  }

  private async closeInTx(tx: Tx, fx: Effects, room: RoomRow, reason: string, actorId: string | null) {
    const phase = phaseOf(room);
    if (isTerminal(phase)) return { status: phase };
    if (phase === "LOBBY" || phase === "CREATED") {
      this.setStatus(room, "CANCELLED");
      await this.saveRoom(tx, room, { status: room.status, endedAt: new Date(), phaseEndsAt: null });
      fx.room(room.id, E.gameFinished, { matchId: null, completionReason: "cancelled", results: [] });
      this.roomUpdated(fx, room);
      await this.audit.record("room.cancelled", "room", room.id, actorId, { reason }, tx);
      return { status: room.status };
    }
    const match = await getMatch(tx, room.currentMatchId!);
    await this.finish(tx, fx, room, match, "ended_early");
    await this.audit.record("room.ended_early", "room", room.id, actorId, { reason }, tx);
    return { status: room.status };
  }

  // Completed questions only are counted: an open question's answers were
  // never added to totals, so partial results are exactly the locked ones.
  private async finish(tx: Tx, fx: Effects, room: RoomRow, match: MatchRow, reason: "finished" | "ended_early") {
    const entries = await leaderboard(tx, match.id, room.id);
    await persistRanks(tx, match.id, entries);
    const endedAt = new Date();
    this.setStatus(room, reason === "finished" ? "FINISHED" : "ENDED_EARLY");
    await this.saveRoom(tx, room, { status: room.status, endedAt, phaseEndsAt: null, pauseRequested: false });
    await tx
      .update(matches)
      .set({ status: room.status, endedAt, completionReason: reason })
      .where(eq(matches.id, match.id));
    fx.room(room.id, E.leaderboardUpdate, { entries, isFinal: true, position: match.currentPosition, questionCount: match.questionCount });
    fx.room(room.id, E.gameFinished, { matchId: match.id, completionReason: reason, results: entries });
    this.roomUpdated(fx, room);
    this.analytics.track("match_finished", null, { reason, players: entries.length, questions: match.questionCount });
  }

  // ---- Presence and host absence ------------------------------------------------

  async connected(roomId: string, userId: string) {
    await this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      const member = await membership(tx, roomId, userId);
      if (!member || member.removedAt) return;
      await tx
        .update(roomPlayers)
        .set({ connectionState: "CONNECTED", disconnectedAt: null })
        .where(eq(roomPlayers.id, member.id));
      fx.room(roomId, E.playerPresence, { playerId: userId, state: "CONNECTED" });
      if (room.hostUserId === userId && room.hostPresence !== "connected") {
        const wasAbsentPause = room.pauseReason === "host_absent";
        await this.saveRoom(tx, room, { hostPresence: "connected", hostAbsentSince: null });
        // Host back within 5 minutes: resume from the current state (spec 8.6).
        if (wasAbsentPause) await this.resumeInTx(tx, fx, room);
        else this.roomUpdated(fx, room);
      }
    }, roomId);
  }

  async disconnected(roomId: string, userId: string) {
    await this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      if (isTerminal(phaseOf(room))) return;
      const member = await membership(tx, roomId, userId);
      if (!member || member.removedAt) return;
      const since = Date.now();
      await tx
        .update(roomPlayers)
        .set({ connectionState: "RECONNECTING", disconnectedAt: new Date(since) })
        .where(eq(roomPlayers.id, member.id));
      fx.room(roomId, E.playerPresence, { playerId: userId, state: "RECONNECTING" });
      fx.schedule({ type: "player_grace_end", roomId, userId, since }, this.config.PLAYER_GRACE_MS);
      if (room.hostUserId === userId) {
        await this.saveRoom(tx, room, { hostPresence: "grace" });
        this.roomUpdated(fx, room);
        fx.schedule({ type: "host_grace_end", roomId, since }, this.config.HOST_GRACE_MS);
      }
    }, roomId);
    // A player who drops no longer holds the question open.
    await this.checkEarlyReveal(roomId);
  }

  private async onPlayerGraceEnd(roomId: string, userId: string, since: number) {
    await this.run(async (tx, fx) => {
      await lockRoom(tx, roomId);
      const member = await membership(tx, roomId, userId);
      if (!member || member.removedAt || member.connectionState !== "RECONNECTING") return;
      if (member.disconnectedAt?.getTime() !== since) return;
      // The seat and score stay; the player can rejoin until the room ends.
      await tx.update(roomPlayers).set({ connectionState: "DISCONNECTED" }).where(eq(roomPlayers.id, member.id));
      fx.room(roomId, E.playerPresence, { playerId: userId, state: "DISCONNECTED" });
    }, roomId);
  }

  private async onHostGraceEnd(roomId: string, since: number) {
    await this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      if (room.hostPresence !== "grace" || isTerminal(phaseOf(room))) return;
      const host = await membership(tx, roomId, room.hostUserId);
      if (!host || host.disconnectedAt?.getTime() !== since) return;
      const absentSince = new Date();
      await this.saveRoom(tx, room, { hostPresence: "absent", hostAbsentSince: absentSince });
      fx.schedule({ type: "host_absent_timeout", roomId, since: absentSince.getTime() }, this.config.HOST_PAUSE_MAX_MS);
      if (isInMatch(phaseOf(room))) {
        await this.saveRoom(tx, room, { pauseRequested: true, pauseReason: "host_absent" });
        const phase = phaseOf(room);
        if (phase === "SCOREBOARD" || phase === "NEXT_QUESTION") await this.enterPause(tx, fx, room);
        else if (phase !== "PAUSED") this.roomUpdated(fx, room);
        else {
          // Already paused by the host: the absence clock still applies.
          await this.saveRoom(tx, room, { pauseReason: "host_absent" });
          await this.enterPauseRefresh(fx, room);
        }
      } else {
        this.roomUpdated(fx, room);
      }
    }, roomId);
  }

  private async enterPauseRefresh(fx: Effects, room: RoomRow) {
    const resumeDeadlineAt = room.hostAbsentSince ? new Date(room.hostAbsentSince.getTime() + this.config.HOST_PAUSE_MAX_MS) : null;
    fx.room(room.id, E.gamePaused, { reason: "host_absent", resumeDeadlineAt: resumeDeadlineAt?.toISOString() ?? null });
    this.roomUpdated(fx, room);
  }

  private async onHostAbsentTimeout(roomId: string, since: number) {
    await this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      if (room.hostPresence !== "absent" || room.hostAbsentSince?.getTime() !== since) return;
      // Host gone for 5 minutes: end early with partial results (spec 8.6).
      await this.closeInTx(tx, fx, room, "host_absent", null);
    }, roomId);
  }

  private async onLobbyExpiry(roomId: string) {
    await this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      if (phaseOf(room) !== "LOBBY") return;
      const remaining = room.expiresAt.getTime() - Date.now();
      if (remaining > 0) {
        fx.schedule({ type: "lobby_expiry", roomId }, remaining + 50);
        return;
      }
      this.setStatus(room, "EXPIRED");
      await this.saveRoom(tx, room, { status: room.status, endedAt: new Date() });
      fx.room(roomId, E.gameFinished, { matchId: null, completionReason: "expired", results: [] });
      this.roomUpdated(fx, room);
    }, roomId);
  }

  private async onCountdownEnd(roomId: string, matchId: string) {
    await this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      if (phaseOf(room) !== "STARTING" || room.currentMatchId !== matchId) return;
      const match = await getMatch(tx, matchId);
      await this.beginQuestion(tx, fx, room, match, 0);
    }, roomId);
  }

  async onTimer(job: TimerJob) {
    switch (job.type) {
      case "countdown_end":
        return this.onCountdownEnd(job.roomId, job.matchId);
      case "question_deadline":
        return this.lockQuestion(job.roomId, job.matchQuestionId, "deadline");
      case "reveal_end":
        return this.onRevealEnd(job.roomId, job.matchQuestionId);
      case "scoreboard_end":
        return this.run(async (tx, fx) => {
          const room = await lockRoom(tx, job.roomId);
          if (phaseOf(room) !== "SCOREBOARD" || !room.currentMatchId) return;
          const match = await getMatch(tx, room.currentMatchId);
          const mq = await matchQuestionAt(tx, match.id, match.currentPosition);
          if (mq?.id !== job.matchQuestionId) return;
          await this.advance(tx, fx, room);
        }, job.roomId);
      case "player_grace_end":
        return this.onPlayerGraceEnd(job.roomId, job.userId, job.since);
      case "host_grace_end":
        return this.onHostGraceEnd(job.roomId, job.since);
      case "host_absent_timeout":
        return this.onHostAbsentTimeout(job.roomId, job.since);
      case "lobby_expiry":
        return this.onLobbyExpiry(job.roomId);
    }
  }

  // ---- Membership via socket --------------------------------------------------

  // Verifies a resume token for this user and room (spec 8.7). A token never
  // grants another identity's seat, and a removed player's token is revoked.
  async verifySeat(roomId: string, userId: string, resumeToken: string) {
    const member = await membership(this.db, roomId, userId);
    if (!member) throw new AppError("RESUME_TOKEN_INVALID");
    if (member.removedAt) throw new AppError("PLAYER_REMOVED");
    if (!member.resumeTokenHash || member.resumeTokenHash !== hashSecret(resumeToken)) {
      throw new AppError("RESUME_TOKEN_INVALID");
    }
    const room = await this.db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
    if (!room) throw new AppError("ROOM_NOT_FOUND");
    return { member, room };
  }

  async leave(roomId: string, userId: string) {
    return this.run(async (tx, fx) => {
      const room = await lockRoom(tx, roomId);
      const member = await membership(tx, roomId, userId);
      if (!member || member.removedAt) return { left: true };
      if (room.hostUserId === userId) {
        // The host leaving closes the room.
        return { left: true, ...(await this.closeInTx(tx, fx, room, "host_left", userId)) };
      }
      if (phaseOf(room) === "LOBBY") {
        await tx.delete(roomPlayers).where(eq(roomPlayers.id, member.id));
      } else {
        await tx.update(roomPlayers).set({ connectionState: "DISCONNECTED", disconnectedAt: new Date() }).where(eq(roomPlayers.id, member.id));
      }
      fx.then(() => this.broadcaster.evict(roomId, userId));
      await this.emitPlayers(tx, fx, room);
      return { left: true };
    }, roomId);
  }

  // Used by maintenance to recover rooms whose timers were lost.
  async staleLobbies(limit = 100) {
    return this.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.status, "LOBBY"), sql`${rooms.expiresAt} < now()`))
      .limit(limit);
  }

  disconnectDisplays(roomId: string) {
    this.broadcaster.namespace?.in(`display:${roomId}`).disconnectSockets(true);
  }

  async removedFromRoom(roomId: string, userId: string) {
    const m = await this.db.query.roomPlayers.findFirst({
      where: and(eq(roomPlayers.roomId, roomId), eq(roomPlayers.userId, userId), isNull(roomPlayers.removedAt)),
    });
    return !m;
  }
}
