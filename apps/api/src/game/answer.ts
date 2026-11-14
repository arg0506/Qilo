// Answer acceptance (spec section 12.2). Checks run in the order the spec gives,
// so the same submission always gets the same error code.

import type { RoomPhase } from "./lifecycle.ts";

export type AnswerErrorCode =
  | "FORBIDDEN"
  | "GAME_PAUSED"
  | "ANSWER_DEADLINE_PASSED"
  | "OPTION_INVALID"
  | "ANSWER_ALREADY_SUBMITTED";

export interface ActiveQuestion {
  phase: RoomPhase;
  deadlineAtMs: number;
  optionKeys: readonly string[];
}

export interface ExistingAnswer {
  idempotencyKey: string;
  optionKey: string;
}

export interface AnswerSubmission {
  isMember: boolean;
  optionKey: string;
  idempotencyKey: string;
  receivedAtMs: number;
}

export type AnswerDecision =
  | { ok: true; duplicate: false }
  | { ok: true; duplicate: true }
  | { ok: false; code: AnswerErrorCode };

export function decideAnswer(
  question: ActiveQuestion,
  existing: ExistingAnswer | undefined,
  submission: AnswerSubmission,
): AnswerDecision {
  if (!submission.isMember) return { ok: false, code: "FORBIDDEN" };

  // A retry of the exact accepted command returns the original result.
  if (existing && existing.idempotencyKey === submission.idempotencyKey) {
    return { ok: true, duplicate: true };
  }

  if (question.phase === "PAUSED") return { ok: false, code: "GAME_PAUSED" };
  if (question.phase !== "QUESTION_ACTIVE") {
    return { ok: false, code: "ANSWER_DEADLINE_PASSED" };
  }
  if (submission.receivedAtMs > question.deadlineAtMs) {
    return { ok: false, code: "ANSWER_DEADLINE_PASSED" };
  }
  if (!question.optionKeys.includes(submission.optionKey)) {
    return { ok: false, code: "OPTION_INVALID" };
  }
  // First accepted answer locks (decision D-07).
  if (existing) return { ok: false, code: "ANSWER_ALREADY_SUBMITTED" };

  return { ok: true, duplicate: false };
}

// Early reveal (decision D-09): every currently connected player has answered.
// Disconnected players never hold the question open.
export function shouldRevealEarly(
  connectedPlayerIds: readonly string[],
  answeredPlayerIds: ReadonlySet<string>,
): boolean {
  return (
    connectedPlayerIds.length > 0 &&
    connectedPlayerIds.every((id) => answeredPlayerIds.has(id))
  );
}
