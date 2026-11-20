// Side effects collected inside a database transaction and applied only after
// it commits, so clients never see state that was rolled back.

export type Audience = "members" | "public" | "display";

export type Emit =
  | { kind: "room"; roomId: string; audience: Audience; event: string; payload: Record<string, unknown> }
  | { kind: "user"; roomId: string; userId: string; event: string; payload: Record<string, unknown> };

export type TimerJob =
  | { type: "countdown_end"; roomId: string; matchId: string }
  | { type: "question_deadline"; roomId: string; matchQuestionId: string }
  | { type: "reveal_end"; roomId: string; matchQuestionId: string }
  | { type: "scoreboard_end"; roomId: string; matchQuestionId: string }
  | { type: "player_grace_end"; roomId: string; userId: string; since: number }
  | { type: "host_grace_end"; roomId: string; since: number }
  | { type: "host_absent_timeout"; roomId: string; since: number }
  | { type: "lobby_expiry"; roomId: string };

export interface Schedule {
  job: TimerJob;
  delayMs: number;
}

export class Effects {
  readonly emits: Emit[] = [];
  readonly schedules: Schedule[] = [];
  readonly after: (() => Promise<void>)[] = [];

  // Public events go to members and the Big Screen; member events do not.
  room(roomId: string, event: string, payload: Record<string, unknown>, audience: Audience = "public") {
    this.emits.push({ kind: "room", roomId, audience, event, payload });
  }

  user(roomId: string, userId: string, event: string, payload: Record<string, unknown>) {
    this.emits.push({ kind: "user", roomId, userId, event, payload });
  }

  schedule(job: TimerJob, delayMs: number) {
    this.schedules.push({ job, delayMs: Math.max(0, Math.round(delayMs)) });
  }

  then(fn: () => Promise<void>) {
    this.after.push(fn);
  }
}

export function jobId(job: TimerJob): string {
  switch (job.type) {
    case "countdown_end":
      return `countdown_${job.matchId}`;
    case "question_deadline":
    case "reveal_end":
    case "scoreboard_end":
      return `${job.type}_${job.matchQuestionId}`;
    case "player_grace_end":
      return `pgrace_${job.roomId}_${job.userId}_${job.since}`;
    case "host_grace_end":
      return `hgrace_${job.roomId}_${job.since}`;
    case "host_absent_timeout":
      return `habsent_${job.roomId}_${job.since}`;
    case "lobby_expiry":
      return `lobby_${job.roomId}_${Date.now()}`;
  }
}
