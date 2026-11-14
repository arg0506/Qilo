// Final standings and tie-breaks (spec sections 7.5 and 8.5).
// Arrival order at the server is never used as a tie-breaker.

export interface PlayerStanding {
  userId: string;
  totalScore: number;
  correctCount: number;
  totalAnswerTimeMs: number;
  longestStreak: number;
}

export interface RankedStanding extends PlayerStanding {
  rank: number;
}

// Negative when a should sort before b.
export function compareStandings(a: PlayerStanding, b: PlayerStanding): number {
  return (
    b.totalScore - a.totalScore ||
    b.correctCount - a.correctCount ||
    a.totalAnswerTimeMs - b.totalAnswerTimeMs ||
    b.longestStreak - a.longestStreak
  );
}

// Competition ranking: players equal on every tie-break key share a rank,
// and the next rank skips the shared places (1, 1, 3).
export function rankStandings(players: PlayerStanding[]): RankedStanding[] {
  const sorted = [...players].sort(compareStandings);
  const ranked: RankedStanding[] = [];
  sorted.forEach((player, index) => {
    const previous = ranked[index - 1];
    const tiedWithPrevious =
      previous !== undefined && compareStandings(previous, player) === 0;
    const rank = tiedWithPrevious ? previous.rank : index + 1;
    ranked.push({ ...player, rank });
  });
  return ranked;
}
