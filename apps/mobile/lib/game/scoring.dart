// Client-side mirror of the server's classic-v1 scoring profile (spec 8.4).
// The server is authoritative; this copy exists so the mock game and tests
// behave like the real engine until the realtime gateway is connected.

import 'dart:math' as math;

class ScoringProfile {
  const ScoringProfile._();

  static const String version = 'classic-v1';
  static const int basePoints = 500;
  static const int maxSpeedBonus = 500;
  static const int streakStepPoints = 50;
  static const int streakMaxSteps = 4;
}

class ScoreBreakdown {
  const ScoreBreakdown({
    required this.base,
    required this.speed,
    required this.streak,
    required this.streakAfter,
  });

  final int base;
  final int speed;
  final int streak;
  final int streakAfter;

  int get total => base + speed + streak;

  static const ScoreBreakdown none =
      ScoreBreakdown(base: 0, speed: 0, streak: 0, streakAfter: 0);
}

ScoreBreakdown scoreAnswer({
  required bool correct,
  required int streakBefore,
  required Duration elapsed,
  required Duration duration,
}) {
  if (!correct) return ScoreBreakdown.none;

  final durationMs = duration.inMilliseconds;
  final elapsedMs = math.min(
    math.max(elapsed.inMilliseconds, 0),
    durationMs,
  );
  final speedRatio = 1 - elapsedMs / durationMs;
  final speed = (ScoringProfile.maxSpeedBonus * speedRatio).round();

  final streakAfter = streakBefore + 1;
  final steps = math.min(streakAfter - 1, ScoringProfile.streakMaxSteps);
  final streak = streakAfter < 2 ? 0 : ScoringProfile.streakStepPoints * steps;

  return ScoreBreakdown(
    base: ScoringProfile.basePoints,
    speed: speed,
    streak: streak,
    streakAfter: streakAfter,
  );
}
