// Shared queries for room, match and question state.

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/db.ts";
import {
  answers,
  matchPlayerResults,
  matchQuestions,
  matches,
  questionAnswers,
  questionOptions,
  questions,
  roomPlayers,
  rooms,
} from "../db/schema.ts";
import { AppError } from "../common/errors.ts";
import { rankStandings } from "../game/standings.ts";
import type { RoomPhase } from "../game/lifecycle.ts";

export type RoomRow = typeof rooms.$inferSelect;
export type PlayerRow = typeof roomPlayers.$inferSelect;
export type MatchRow = typeof matches.$inferSelect;
export type MatchQuestionRow = typeof matchQuestions.$inferSelect;
export type ResultRow = typeof matchPlayerResults.$inferSelect;

export const TERMINAL_STATUSES: RoomPhase[] = ["FINISHED", "CANCELLED", "EXPIRED", "ENDED_EARLY"];

export function phaseOf(room: RoomRow): RoomPhase {
  return room.status as RoomPhase;
}

// Row lock that serializes every state change for one room across instances.
export async function lockRoom(tx: DbOrTx, roomId: string): Promise<RoomRow> {
  const [row] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for("update");
  if (!row) throw new AppError("ROOM_NOT_FOUND", "Room not found.");
  return row;
}

export async function getRoom(tx: DbOrTx, roomId: string): Promise<RoomRow> {
  const row = await tx.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
  if (!row) throw new AppError("ROOM_NOT_FOUND", "Room not found.");
  return row;
}

export async function activePlayers(tx: DbOrTx, roomId: string): Promise<PlayerRow[]> {
  return tx
    .select()
    .from(roomPlayers)
    .where(and(eq(roomPlayers.roomId, roomId), isNull(roomPlayers.removedAt)))
    .orderBy(asc(roomPlayers.joinedAt));
}

export async function membership(tx: DbOrTx, roomId: string, userId: string): Promise<PlayerRow | undefined> {
  return tx.query.roomPlayers.findFirst({
    where: and(eq(roomPlayers.roomId, roomId), eq(roomPlayers.userId, userId)),
  });
}

export async function getMatch(tx: DbOrTx, matchId: string): Promise<MatchRow> {
  const row = await tx.query.matches.findFirst({ where: eq(matches.id, matchId) });
  if (!row) throw new AppError("INVALID_STATE", "Match not found.");
  return row;
}

export async function matchQuestionAt(tx: DbOrTx, matchId: string, position: number) {
  return tx.query.matchQuestions.findFirst({
    where: and(eq(matchQuestions.matchId, matchId), eq(matchQuestions.position, position)),
  });
}

export interface QuestionContent {
  id: string;
  type: string;
  prompt: string;
  mediaUrl: string | null;
  explanation: string;
  durationSeconds: number;
  options: { key: string; label: string }[];
  correctOptionKeys: string[];
}

export async function questionContent(tx: DbOrTx, questionId: string): Promise<QuestionContent> {
  const q = await tx.query.questions.findFirst({ where: eq(questions.id, questionId) });
  if (!q) throw new AppError("INVALID_STATE", "Question not found.");
  const opts = await tx
    .select()
    .from(questionOptions)
    .where(eq(questionOptions.questionId, q.id))
    .orderBy(asc(questionOptions.position));
  const key = await tx.query.questionAnswers.findFirst({ where: eq(questionAnswers.questionId, q.id) });
  return {
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    mediaUrl: q.mediaUrl,
    explanation: q.explanation,
    durationSeconds: q.durationSeconds,
    options: opts.map((o) => ({ key: o.optionKey, label: o.label })),
    correctOptionKeys: key?.correctOptionKeys ?? [],
  };
}

// The question as players see it while it is open: display order, no answer key.
export function publicQuestion(mq: MatchQuestionRow, content: QuestionContent, total: number) {
  const byKey = new Map(content.options.map((o) => [o.key, o]));
  return {
    matchQuestionId: mq.id,
    position: mq.position,
    total,
    type: content.type,
    prompt: content.prompt,
    mediaUrl: content.mediaUrl,
    options: mq.optionOrder.map((k) => ({ key: k, label: byKey.get(k)?.label ?? "" })),
    durationMs: mq.durationMs,
    startedAt: mq.startedAt?.toISOString() ?? null,
    deadlineAt: mq.deadlineAt?.toISOString() ?? null,
  };
}

export function revealPayload(mq: MatchQuestionRow, content: QuestionContent) {
  const distribution: Record<string, number> = {};
  for (const key of mq.optionOrder) distribution[key] = mq.distribution?.[key] ?? 0;
  return {
    matchQuestionId: mq.id,
    position: mq.position,
    correctOptionKeys: content.correctOptionKeys,
    explanation: content.explanation,
    distribution,
  };
}

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  rank: number;
  totalScore: number;
  correctCount: number;
  longestStreak: number;
  totalAnswerTimeMs: number;
}

// Standings for the room's current members. Removed players drop out of the
// board; their rows stay for audit.
export async function leaderboard(tx: DbOrTx, matchId: string, roomId: string): Promise<LeaderboardEntry[]> {
  const rows = await tx
    .select({ r: matchPlayerResults, removedAt: roomPlayers.removedAt })
    .from(matchPlayerResults)
    .innerJoin(roomPlayers, and(eq(roomPlayers.roomId, roomId), eq(roomPlayers.userId, matchPlayerResults.userId)))
    .where(eq(matchPlayerResults.matchId, matchId));
  const active = rows.filter((x) => x.removedAt === null).map((x) => x.r);
  const ranked = rankStandings(
    active.map((r) => ({
      userId: r.userId,
      totalScore: r.totalScore,
      correctCount: r.correctCount,
      totalAnswerTimeMs: r.totalAnswerTimeMs,
      longestStreak: r.longestStreak,
    })),
  );
  const names = new Map(active.map((r) => [r.userId, r.displayNameSnapshot]));
  return ranked.map((r) => ({
    userId: r.userId,
    displayName: names.get(r.userId) ?? "Player",
    rank: r.rank,
    totalScore: r.totalScore,
    correctCount: r.correctCount,
    longestStreak: r.longestStreak,
    totalAnswerTimeMs: r.totalAnswerTimeMs,
  }));
}

export async function persistRanks(tx: DbOrTx, matchId: string, entries: LeaderboardEntry[]) {
  if (entries.length === 0) return;
  const cases = sql.join(
    entries.map((e) => sql`when ${e.userId}::uuid then ${e.rank}::int`),
    sql` `,
  );
  await tx
    .update(matchPlayerResults)
    .set({ rank: sql`case ${matchPlayerResults.userId} ${cases} end` })
    .where(and(eq(matchPlayerResults.matchId, matchId), inArray(matchPlayerResults.userId, entries.map((e) => e.userId))));
}

export async function answersFor(tx: DbOrTx, matchQuestionId: string) {
  return tx.select().from(answers).where(eq(answers.matchQuestionId, matchQuestionId));
}

export function serializePlayer(p: PlayerRow) {
  return {
    userId: p.userId,
    displayName: p.displayNameSnapshot,
    role: p.role,
    connectionState: p.connectionState,
    isReady: p.isReady,
    joinedAt: p.joinedAt.toISOString(),
  };
}
