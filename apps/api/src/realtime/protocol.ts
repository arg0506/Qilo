// Realtime contract (spec section 12). Namespace /game. Every server event
// carries protocolVersion, eventId and roomId. Every client command carries an
// idempotencyKey and is acknowledged with AckResult.

import type { ErrorCode } from "../common/errors.ts";

export const PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSIONS = [1];
export const NAMESPACE = "/game";

export const ClientEvents = {
  roomJoin: "room:join",
  roomLeave: "room:leave",
  roomSync: "room:sync",
  playerReady: "player:ready",
  answerSubmit: "answer:submit",
  hostStart: "host:start",
  hostNext: "host:next",
  hostPause: "host:pause",
  hostResume: "host:resume",
  hostLock: "host:lock",
  hostRemove: "host:remove",
  hostClose: "host:close",
  displaySubscribe: "display:subscribe",
} as const;

export const ServerEvents = {
  roomSnapshot: "room:snapshot",
  roomUpdated: "room:updated",
  roomRemoved: "room:removed",
  roomRematch: "room:rematch",
  gameStarting: "game:starting",
  questionStarted: "question:started",
  answerAccepted: "answer:accepted",
  answerRejected: "answer:rejected",
  questionProgress: "question:progress",
  questionRevealed: "question:revealed",
  scoreUpdate: "score:update",
  leaderboardUpdate: "leaderboard:update",
  gamePaused: "game:paused",
  gameResumed: "game:resumed",
  gameFinished: "game:finished",
  playerPresence: "player:presence",
  error: "error",
} as const;

export type AckResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string; details?: unknown } };

export const channel = {
  members: (roomId: string) => `room:${roomId}`,
  display: (roomId: string) => `display:${roomId}`,
  user: (userId: string) => `user:${userId}`,
};
