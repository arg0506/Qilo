// Room and match lifecycle (spec section 8.1).
// The server owns every transition; clients only send commands.

export const ROOM_PHASES = [
  "CREATED",
  "LOBBY",
  "STARTING",
  "QUESTION_ACTIVE",
  "QUESTION_LOCKED",
  "ANSWER_REVEAL",
  "SCOREBOARD",
  "NEXT_QUESTION",
  "PAUSED",
  "FINISHED",
  "CANCELLED",
  "EXPIRED",
  "ENDED_EARLY",
] as const;

export type RoomPhase = (typeof ROOM_PHASES)[number];

const TERMINAL: ReadonlySet<RoomPhase> = new Set([
  "FINISHED",
  "CANCELLED",
  "EXPIRED",
  "ENDED_EARLY",
]);

// Phases where a live match exists. Ending early is allowed from any of them.
const IN_MATCH: ReadonlySet<RoomPhase> = new Set([
  "STARTING",
  "QUESTION_ACTIVE",
  "QUESTION_LOCKED",
  "ANSWER_REVEAL",
  "SCOREBOARD",
  "NEXT_QUESTION",
  "PAUSED",
]);

const TRANSITIONS: Record<RoomPhase, readonly RoomPhase[]> = {
  CREATED: ["LOBBY"],
  LOBBY: ["STARTING", "CANCELLED", "EXPIRED"],
  STARTING: ["QUESTION_ACTIVE", "ENDED_EARLY"],
  QUESTION_ACTIVE: ["QUESTION_LOCKED", "ENDED_EARLY"],
  QUESTION_LOCKED: ["ANSWER_REVEAL", "ENDED_EARLY"],
  ANSWER_REVEAL: ["SCOREBOARD", "ENDED_EARLY"],
  SCOREBOARD: ["NEXT_QUESTION", "FINISHED", "PAUSED", "ENDED_EARLY"],
  NEXT_QUESTION: ["QUESTION_ACTIVE", "FINISHED", "PAUSED", "ENDED_EARLY"],
  // Resuming always goes to the next question; NEXT_QUESTION finishes the match
  // if none remain.
  PAUSED: ["NEXT_QUESTION", "ENDED_EARLY"],
  FINISHED: [],
  CANCELLED: [],
  EXPIRED: [],
  ENDED_EARLY: [],
};

export class InvalidTransitionError extends Error {
  readonly from: RoomPhase;
  readonly to: RoomPhase;

  constructor(from: RoomPhase, to: RoomPhase) {
    super(`Invalid room transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: RoomPhase, to: RoomPhase): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(from: RoomPhase, to: RoomPhase): RoomPhase {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

export function isTerminal(phase: RoomPhase): boolean {
  return TERMINAL.has(phase);
}

export function isInMatch(phase: RoomPhase): boolean {
  return IN_MATCH.has(phase);
}
