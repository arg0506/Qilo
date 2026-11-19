import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { DB, type Db } from "../db/db.ts";
import { answers, matchPlayerResults, matchQuestions, matches, quizVersions, roomPlayers, rooms } from "../db/schema.ts";
import { AppError } from "../common/errors.ts";
import { parseInput } from "../common/validation.ts";
import type { AuthUser } from "../auth/auth-user.ts";
import { publicQuestion, questionContent, revealPayload } from "../rooms/room-repo.ts";

const DONE = ["FINISHED", "ENDED_EARLY"];

@Injectable()
export class MatchesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // Final standings exactly as persisted (spec 17.2), plus a per-question
  // review for the viewer (MVP-10).
  async get(user: AuthUser, matchId: string) {
    if (!z.string().uuid().safeParse(matchId).success) throw new AppError("NOT_FOUND", "Match not found.");
    const match = await this.db.query.matches.findFirst({ where: eq(matches.id, matchId) });
    if (!match) throw new AppError("NOT_FOUND", "Match not found.");
    const room = await this.db.query.rooms.findFirst({ where: eq(rooms.id, match.roomId) });
    const mine = await this.db.query.matchPlayerResults.findFirst({
      where: and(eq(matchPlayerResults.matchId, match.id), eq(matchPlayerResults.userId, user.id)),
    });
    if (!mine && room?.hostUserId !== user.id) throw new AppError("NOT_FOUND", "Match not found.");
    const version = await this.db.query.quizVersions.findFirst({ where: eq(quizVersions.id, match.quizVersionId) });

    const rows = await this.db
      .select({ r: matchPlayerResults, removedAt: roomPlayers.removedAt })
      .from(matchPlayerResults)
      .innerJoin(roomPlayers, and(eq(roomPlayers.roomId, match.roomId), eq(roomPlayers.userId, matchPlayerResults.userId)))
      .where(eq(matchPlayerResults.matchId, match.id))
      .orderBy(asc(matchPlayerResults.rank), desc(matchPlayerResults.totalScore));
    const results = rows
      .filter((x) => x.removedAt === null)
      .map(({ r }) => ({
        userId: r.userId,
        displayName: r.displayNameSnapshot,
        rank: r.rank,
        totalScore: r.totalScore,
        correctCount: r.correctCount,
        longestStreak: r.longestStreak,
        totalAnswerTimeMs: r.totalAnswerTimeMs,
      }));

    const mqs = await this.db
      .select()
      .from(matchQuestions)
      .where(and(eq(matchQuestions.matchId, match.id), isNotNull(matchQuestions.revealedAt)))
      .orderBy(asc(matchQuestions.position));
    const myAnswers = mqs.length
      ? await this.db
          .select()
          .from(answers)
          .where(and(inArray(answers.matchQuestionId, mqs.map((m) => m.id)), eq(answers.userId, user.id)))
      : [];
    const review = [];
    for (const mq of mqs) {
      const content = await questionContent(this.db, mq.questionId);
      const a = myAnswers.find((x) => x.matchQuestionId === mq.id);
      const q = publicQuestion(mq, content, match.questionCount);
      review.push({
        type: q.type,
        prompt: q.prompt,
        mediaUrl: q.mediaUrl,
        options: q.options,
        ...revealPayload(mq, content),
        myAnswer: a
          ? {
              optionKey: a.optionKey,
              status: a.status,
              isCorrect: a.status === "accepted" && a.isCorrect,
              pointsEarned: a.totalPoints,
              breakdown: { base: a.basePoints, speed: a.speedPoints, streak: a.streakPoints },
              elapsedMs: a.elapsedMs,
            }
          : null,
      });
    }
    const answeredQuestions = review.length;
    return {
      match: {
        id: match.id,
        roomId: match.roomId,
        status: match.status,
        completionReason: match.completionReason,
        // Ended-early matches are labelled as partial and are never ranked.
        isPartial: match.completionReason === "ended_early",
        startedAt: match.startedAt.toISOString(),
        endedAt: match.endedAt?.toISOString() ?? null,
        questionCount: match.questionCount,
        completedQuestions: answeredQuestions,
        scoringProfile: match.scoringProfile,
        quizTitle: version?.title ?? "Quiz",
      },
      results,
      me: mine
        ? {
            rank: mine.rank,
            totalScore: mine.totalScore,
            correctCount: mine.correctCount,
            accuracy: answeredQuestions ? Math.round((mine.correctCount / answeredQuestions) * 100) / 100 : 0,
            longestStreak: mine.longestStreak,
          }
        : null,
      questions: review,
    };
  }

  async history(user: AuthUser, query: unknown) {
    const { limit, offset } = parseInput(
      z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).default(0) }),
      query,
    );
    const rows = await this.db
      .select({
        matchId: matches.id,
        roomId: matches.roomId,
        quizTitle: quizVersions.title,
        status: matches.status,
        completionReason: matches.completionReason,
        endedAt: matches.endedAt,
        questionCount: matches.questionCount,
        rank: matchPlayerResults.rank,
        totalScore: matchPlayerResults.totalScore,
        correctCount: matchPlayerResults.correctCount,
        playerCount: sql<number>`(select count(*) from match_player_results x where x.match_id = ${matches.id})`,
      })
      .from(matchPlayerResults)
      .innerJoin(matches, eq(matches.id, matchPlayerResults.matchId))
      .innerJoin(quizVersions, eq(quizVersions.id, matches.quizVersionId))
      .where(and(eq(matchPlayerResults.userId, user.id), inArray(matches.status, DONE)))
      .orderBy(desc(matches.endedAt))
      .limit(limit + 1)
      .offset(offset);
    return {
      items: rows.slice(0, limit).map((r) => ({
        ...r,
        playerCount: Number(r.playerCount),
        isPartial: r.completionReason === "ended_early",
        endedAt: r.endedAt?.toISOString() ?? null,
      })),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }
}
