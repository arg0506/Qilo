import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DB, type Db, type DbOrTx } from "../db/db.ts";
import { answers, matchPlayerResults, quizVersions } from "../db/schema.ts";
import {
  activePlayers,
  getMatch,
  getRoom,
  leaderboard,
  matchQuestionAt,
  phaseOf,
  publicQuestion,
  questionContent,
  revealPayload,
  serializePlayer,
  type RoomRow,
} from "./room-repo.ts";

const QUESTION_VISIBLE = new Set(["QUESTION_ACTIVE", "QUESTION_LOCKED", "ANSWER_REVEAL", "SCOREBOARD", "PAUSED", "NEXT_QUESTION"]);
const REVEAL_VISIBLE = new Set(["ANSWER_REVEAL", "SCOREBOARD", "PAUSED", "NEXT_QUESTION", "FINISHED", "ENDED_EARLY"]);

export function serializeRoom(room: RoomRow) {
  return {
    id: room.id,
    code: room.code,
    status: room.status,
    mode: room.mode,
    pacing: room.pacing,
    visibility: room.visibility,
    maxPlayers: room.maxPlayers,
    settings: room.settings,
    isLocked: room.isLocked,
    hostUserId: room.hostUserId,
    hostPresence: room.hostPresence,
    pauseRequested: room.pauseRequested,
    pauseReason: room.pauseReason,
    phaseEndsAt: room.phaseEndsAt?.toISOString() ?? null,
    rematchOfRoomId: room.rematchOfRoomId,
    quizVersionId: room.quizVersionId,
    expiresAt: room.expiresAt.toISOString(),
  };
}

// Full state for a joining or reconnecting client (spec 8.7, 12.3). Clients
// never replay missed events; they redraw from this. `viewerId` is null for
// the Big Screen, which receives only the public subset.
@Injectable()
export class SnapshotService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async build(roomId: string, viewerId: string | null, tx: DbOrTx = this.db) {
    const room = await getRoom(tx, roomId);
    const players = await activePlayers(tx, roomId);
    const version = await tx.query.quizVersions.findFirst({ where: eq(quizVersions.id, room.quizVersionId) });
    const phase = phaseOf(room);

    const snapshot: Record<string, unknown> = {
      serverTime: new Date().toISOString(),
      room: serializeRoom(room),
      quiz: version ? { title: version.title, versionId: version.id } : null,
      players: players.map(serializePlayer),
      match: null,
      currentQuestion: null,
      reveal: null,
      leaderboard: [],
      me: null,
    };

    if (room.currentMatchId) {
      const match = await getMatch(tx, room.currentMatchId);
      snapshot.match = {
        id: match.id,
        status: match.status,
        position: match.currentPosition,
        questionCount: match.questionCount,
        completionReason: match.completionReason,
      };
      snapshot.leaderboard = await leaderboard(tx, match.id, room.id);

      const mq = match.currentPosition >= 0 ? await matchQuestionAt(tx, match.id, match.currentPosition) : undefined;
      if (mq) {
        const content = await questionContent(tx, mq.questionId);
        if (QUESTION_VISIBLE.has(phase) || REVEAL_VISIBLE.has(phase)) {
          snapshot.currentQuestion = publicQuestion(mq, content, match.questionCount);
        }
        // The answer key appears only once the question has been revealed.
        if (mq.revealedAt && REVEAL_VISIBLE.has(phase)) {
          snapshot.reveal = revealPayload(mq, content);
        }
        if (viewerId) {
          const myAnswer = await tx.query.answers.findFirst({
            where: and(eq(answers.matchQuestionId, mq.id), eq(answers.userId, viewerId)),
          });
          const myResult = await tx.query.matchPlayerResults.findFirst({
            where: and(eq(matchPlayerResults.matchId, match.id), eq(matchPlayerResults.userId, viewerId)),
          });
          const revealed = !!mq.revealedAt;
          snapshot.me = {
            userId: viewerId,
            totalScore: myResult?.totalScore ?? 0,
            streak: myResult?.currentStreak ?? 0,
            rank: myResult?.rank ?? null,
            answer:
              myAnswer && myAnswer.status !== "timeout"
                ? {
                    matchQuestionId: mq.id,
                    optionKey: myAnswer.optionKey,
                    acceptedAt: myAnswer.receivedAt.toISOString(),
                    // Points and correctness stay private until reveal.
                    ...(revealed
                      ? {
                          isCorrect: myAnswer.isCorrect,
                          pointsEarned: myAnswer.totalPoints,
                          breakdown: { base: myAnswer.basePoints, speed: myAnswer.speedPoints, streak: myAnswer.streakPoints },
                        }
                      : {}),
                  }
                : null,
          };
        }
      }
      if (viewerId && !snapshot.me) {
        const myResult = await tx.query.matchPlayerResults.findFirst({
          where: and(eq(matchPlayerResults.matchId, match.id), eq(matchPlayerResults.userId, viewerId)),
        });
        snapshot.me = { userId: viewerId, totalScore: myResult?.totalScore ?? 0, streak: myResult?.currentStreak ?? 0, rank: myResult?.rank ?? null, answer: null };
      }
    } else if (viewerId) {
      snapshot.me = { userId: viewerId, totalScore: 0, streak: 0, rank: null, answer: null };
    }
    return snapshot;
  }
}
