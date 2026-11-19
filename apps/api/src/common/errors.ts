// Stable machine-readable error codes (spec 11.2). Clients branch on `code`,
// never on `message`.
export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "ROOM_LOCKED",
  "ROOM_NOT_JOINABLE",
  "PLAYER_REMOVED",
  "HOST_ONLY",
  "GAME_ALREADY_STARTED",
  "GAME_PAUSED",
  "GAME_NOT_STARTABLE",
  "INVALID_STATE",
  "ANSWER_ALREADY_SUBMITTED",
  "ANSWER_DEADLINE_PASSED",
  "OPTION_INVALID",
  "RESUME_TOKEN_INVALID",
  "QUIZ_NOT_PUBLISHABLE",
  "RATE_LIMITED",
  "MEDIA_REJECTED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ROOM_NOT_FOUND: 404,
  ROOM_FULL: 409,
  ROOM_LOCKED: 409,
  ROOM_NOT_JOINABLE: 409,
  PLAYER_REMOVED: 403,
  HOST_ONLY: 403,
  GAME_ALREADY_STARTED: 409,
  GAME_PAUSED: 409,
  GAME_NOT_STARTABLE: 409,
  INVALID_STATE: 409,
  ANSWER_ALREADY_SUBMITTED: 409,
  ANSWER_DEADLINE_PASSED: 409,
  OPTION_INVALID: 400,
  RESUME_TOKEN_INVALID: 401,
  QUIZ_NOT_PUBLISHABLE: 422,
  RATE_LIMITED: 429,
  MEDIA_REJECTED: 422,
  INTERNAL_ERROR: 500,
};

const DEFAULT_MESSAGE: Partial<Record<ErrorCode, string>> = {
  UNAUTHORIZED: "Sign in or start a guest session to continue.",
  FORBIDDEN: "You do not have permission to do that.",
  ROOM_NOT_FOUND: "No active room has that code.",
  ROOM_FULL: "This room is full.",
  ROOM_LOCKED: "The host has locked this room.",
  ROOM_NOT_JOINABLE: "This room is no longer accepting players.",
  PLAYER_REMOVED: "You were removed from this room.",
  HOST_ONLY: "Only the host can do that.",
  GAME_ALREADY_STARTED: "This game has already started.",
  GAME_PAUSED: "The game is paused.",
  ANSWER_ALREADY_SUBMITTED: "You already answered this question.",
  ANSWER_DEADLINE_PASSED: "Time is up for this question.",
  OPTION_INVALID: "That option is not part of this question.",
  RESUME_TOKEN_INVALID: "Your seat could not be restored. Join again with the code.",
  RATE_LIMITED: "Too many attempts. Wait a moment and try again.",
  MEDIA_REJECTED: "That file was rejected.",
  INTERNAL_ERROR: "Something went wrong on our side.",
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? DEFAULT_MESSAGE[code] ?? code);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
}

export function toErrorBody(err: unknown, requestId?: string): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { code: err.code, message: err.message, details: err.details, requestId },
    };
  }
  return {
    status: 500,
    body: { code: "INTERNAL_ERROR", message: DEFAULT_MESSAGE.INTERNAL_ERROR!, requestId },
  };
}
