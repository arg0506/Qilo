// classic-v1 scoring profile (spec section 8.4).
// All values are in milliseconds and points; the server is the only caller.

export const CLASSIC_V1 = {
  version: "classic-v1",
  basePoints: 500,
  maxSpeedBonus: 500,
  streakStepPoints: 50,
  streakMaxSteps: 4,
} as const;

export interface AnswerTiming {
  startedAtMs: number;
  receivedAtMs: number;
  durationMs: number;
}

export interface ScoreInput extends AnswerTiming {
  correct: boolean;
  // Consecutive correct answers before this question.
  streakBefore: number;
}

export interface ScoreResult {
  base: number;
  speed: number;
  streak: number;
  total: number;
  streakAfter: number;
}

export function speedBonus(timing: AnswerTiming): number {
  const elapsed = Math.min(
    Math.max(timing.receivedAtMs - timing.startedAtMs, 0),
    timing.durationMs,
  );
  const speedRatio = 1 - elapsed / timing.durationMs;
  return Math.round(CLASSIC_V1.maxSpeedBonus * speedRatio);
}

export function streakBonus(streakIncludingCurrent: number): number {
  if (streakIncludingCurrent < 2) return 0;
  const steps = Math.min(streakIncludingCurrent - 1, CLASSIC_V1.streakMaxSteps);
  return CLASSIC_V1.streakStepPoints * steps;
}

// Wrong answers and timeouts score zero and reset the streak.
export function scoreAnswer(input: ScoreInput): ScoreResult {
  if (!input.correct) {
    return { base: 0, speed: 0, streak: 0, total: 0, streakAfter: 0 };
  }
  const streakAfter = input.streakBefore + 1;
  const base = CLASSIC_V1.basePoints;
  const speed = speedBonus(input);
  const streak = streakBonus(streakAfter);
  return { base, speed, streak, total: base + speed + streak, streakAfter };
}
