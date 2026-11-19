// PostgreSQL schema (spec section 10). UUID keys, UTC timestamps, immutable
// quiz versions referenced by matches, and the constraints from 10.1.

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Supabase auth user id (JWT `sub`). Null once an account is deleted or a
    // guest is purged.
    authSubject: text("auth_subject"),
    isGuest: boolean("is_guest").notNull().default(true),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    email: text("email"),
    role: text("role").notNull().default("user"), // user | admin
    status: text("status").notNull().default("active"), // active | suspended | deleted | purged
    canHost: boolean("can_host").notNull().default(true),
    createdAt: createdAt(),
    lastActiveAt: ts("last_active_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_auth_subject_uq").on(t.authSubject).where(sql`${t.authSubject} is not null`),
    index("users_guest_activity_idx").on(t.isGuest, t.lastActiveAt),
  ],
);

export type QuizSettings = {
  questionDurationSeconds: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  scoringProfile: "classic-v1";
};

export const quizzes = pgTable(
  "quizzes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Null for starter quizzes that Qilo ships.
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    isStarter: boolean("is_starter").notNull().default(false),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default("general"),
    language: text("language").notNull().default("en"),
    coverUrl: text("cover_url"),
    visibility: text("visibility").notNull().default("private"), // private | unlisted | public
    status: text("status").notNull().default("draft"), // draft | published | archived
    settings: jsonb("settings").$type<QuizSettings>().notNull(),
    currentVersionId: uuid("current_version_id"),
    hasDraftChanges: boolean("has_draft_changes").notNull().default(true),
    removedByModeration: boolean("removed_by_moderation").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("quizzes_owner_status_idx").on(t.ownerId, t.status)],
);

export type DraftOption = { key: string; label: string };

// The editable working copy of a quiz. Publishing snapshots it into
// quiz_versions / questions / question_options / question_answers.
export const draftQuestions = pgTable(
  "draft_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quizId: uuid("quiz_id").notNull().references(() => quizzes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    type: text("type").notNull(), // mcq | true_false | image_mcq
    prompt: text("prompt").notNull(),
    mediaUrl: text("media_url"),
    explanation: text("explanation").notNull().default(""),
    durationSeconds: integer("duration_seconds"),
    options: jsonb("options").$type<DraftOption[]>().notNull(),
    correctOptionKey: text("correct_option_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("draft_questions_quiz_idx").on(t.quizId, t.position)],
);

export const quizVersions = pgTable(
  "quiz_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quizId: uuid("quiz_id").notNull().references(() => quizzes.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    scoringProfile: text("scoring_profile").notNull(),
    settings: jsonb("settings").$type<QuizSettings>().notNull(),
    title: text("title").notNull(),
    publishedAt: ts("published_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("quiz_versions_quiz_number_uq").on(t.quizId, t.versionNumber)],
);

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quizVersionId: uuid("quiz_version_id")
      .notNull()
      .references(() => quizVersions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    type: text("type").notNull(),
    prompt: text("prompt").notNull(),
    mediaUrl: text("media_url"),
    explanation: text("explanation").notNull().default(""),
    durationSeconds: integer("duration_seconds").notNull(),
  },
  (t) => [uniqueIndex("questions_version_position_uq").on(t.quizVersionId, t.position)],
);

export const questionOptions = pgTable(
  "question_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionId: uuid("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
    optionKey: text("option_key").notNull(),
    label: text("label").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [uniqueIndex("question_options_key_uq").on(t.questionId, t.optionKey)],
);

// Server-only. Never serialized into a question payload before reveal.
export const questionAnswers = pgTable("question_answers", {
  id: uuid("id").primaryKey().defaultRandom(),
  questionId: uuid("question_id")
    .notNull()
    .unique()
    .references(() => questions.id, { onDelete: "cascade" }),
  correctOptionKeys: text("correct_option_keys").array().notNull(),
});

export type RoomSettings = {
  // Null keeps each question's own timer from the quiz version.
  questionDurationSeconds: number | null;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  lateJoin: boolean;
  revealSeconds: number;
  scoreboardSeconds: number;
};

export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    hostUserId: uuid("host_user_id").notNull().references(() => users.id),
    quizVersionId: uuid("quiz_version_id").notNull().references(() => quizVersions.id),
    status: text("status").notNull().default("LOBBY"),
    mode: text("mode").notNull().default("classic"),
    pacing: text("pacing").notNull().default("automatic"), // automatic | host_paced
    visibility: text("visibility").notNull().default("private"), // private | unlisted
    maxPlayers: integer("max_players").notNull().default(20),
    settings: jsonb("settings").$type<RoomSettings>().notNull(),
    isLocked: boolean("is_locked").notNull().default(false),
    rematchOfRoomId: uuid("rematch_of_room_id"),
    currentMatchId: uuid("current_match_id"),
    pauseRequested: boolean("pause_requested").notNull().default(false),
    pauseReason: text("pause_reason"), // host | host_absent
    hostPresence: text("host_presence").notNull().default("connected"), // connected | grace | absent
    hostAbsentSince: ts("host_absent_since"),
    // When the current timed phase (countdown, reveal, scoreboard) ends, so a
    // reconnecting client can redraw the same countdown.
    phaseEndsAt: ts("phase_ends_at"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
  },
  (t) => [
    // A code is unique among rooms that are not in a terminal state.
    uniqueIndex("rooms_active_code_uq")
      .on(t.code)
      .where(sql`${t.status} not in ('FINISHED','CANCELLED','EXPIRED','ENDED_EARLY')`),
    index("rooms_status_expires_idx").on(t.status, t.expiresAt),
  ],
);

export const roomPlayers = pgTable(
  "room_players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id),
    displayNameSnapshot: text("display_name_snapshot").notNull(),
    role: text("role").notNull().default("player"), // host | player
    joinedAt: ts("joined_at").notNull().defaultNow(),
    connectionState: text("connection_state").notNull().default("DISCONNECTED"), // CONNECTED | RECONNECTING | DISCONNECTED
    isReady: boolean("is_ready").notNull().default(false),
    disconnectedAt: ts("disconnected_at"),
    removedAt: ts("removed_at"),
    resumeTokenHash: text("resume_token_hash"),
  },
  (t) => [uniqueIndex("room_players_room_user_uq").on(t.roomId, t.userId)],
);

export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    quizVersionId: uuid("quiz_version_id").notNull().references(() => quizVersions.id),
    status: text("status").notNull().default("STARTING"),
    scoringProfile: text("scoring_profile").notNull(),
    questionCount: integer("question_count").notNull(),
    currentPosition: integer("current_position").notNull().default(-1),
    startedAt: ts("started_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
    completionReason: text("completion_reason"), // finished | ended_early | cancelled
  },
  (t) => [index("matches_started_idx").on(t.startedAt), index("matches_room_idx").on(t.roomId)],
);

export const matchQuestions = pgTable(
  "match_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
    questionId: uuid("question_id").notNull().references(() => questions.id),
    position: integer("position").notNull(),
    // Display order of canonical option keys, fixed once per match (spec 8.8).
    optionOrder: text("option_order").array().notNull(),
    durationMs: integer("duration_ms").notNull(),
    startedAt: ts("started_at"),
    deadlineAt: ts("deadline_at"),
    lockedAt: ts("locked_at"),
    revealedAt: ts("revealed_at"),
    distribution: jsonb("distribution").$type<Record<string, number>>(),
  },
  (t) => [uniqueIndex("match_questions_position_uq").on(t.matchId, t.position)],
);

export const answers = pgTable(
  "answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchQuestionId: uuid("match_question_id")
      .notNull()
      .references(() => matchQuestions.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id),
    optionKey: text("option_key"),
    receivedAt: ts("received_at").notNull(),
    elapsedMs: integer("elapsed_ms").notNull(),
    isCorrect: boolean("is_correct").notNull(),
    basePoints: integer("base_points").notNull(),
    speedPoints: integer("speed_points").notNull(),
    streakPoints: integer("streak_points").notNull(),
    totalPoints: integer("total_points").notNull(),
    streakAfter: integer("streak_after").notNull(),
    // accepted | timeout | late (a late joiner's answer: shown, never scored)
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key"),
  },
  // One accepted answer per player per question (spec 10.1).
  (t) => [uniqueIndex("answers_question_user_uq").on(t.matchQuestionId, t.userId)],
);

export const matchPlayerResults = pgTable(
  "match_player_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id),
    displayNameSnapshot: text("display_name_snapshot").notNull(),
    totalScore: integer("total_score").notNull().default(0),
    correctCount: integer("correct_count").notNull().default(0),
    answeredCount: integer("answered_count").notNull().default(0),
    currentStreak: integer("current_streak").notNull().default(0),
    longestStreak: integer("longest_streak").notNull().default(0),
    totalAnswerTimeMs: integer("total_answer_time_ms").notNull().default(0),
    rank: integer("rank"),
    joinedPosition: integer("joined_position").notNull().default(0),
  },
  (t) => [
    uniqueIndex("match_player_results_match_user_uq").on(t.matchId, t.userId),
    index("match_player_results_user_match_idx").on(t.userId, t.matchId),
  ],
);

export const displayTokens = pgTable("display_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: createdAt(),
  expiresAt: ts("expires_at"),
  revokedAt: ts("revoked_at"),
});

export const mediaUploads = pgTable("media_uploads", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  path: text("path").notNull().unique(),
  purpose: text("purpose").notNull(), // question | cover | avatar
  mimeType: text("mime_type").notNull(),
  declaredSize: integer("declared_size").notNull(),
  status: text("status").notNull().default("pending"), // pending | ready | rejected
  publicUrl: text("public_url"),
  createdAt: createdAt(),
});

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterId: uuid("reporter_id").references(() => users.id, { onDelete: "set null" }),
    targetType: text("target_type").notNull(), // quiz | player | room
    targetId: uuid("target_id").notNull(),
    reason: text("reason").notNull(),
    details: text("details").notNull().default(""),
    status: text("status").notNull().default("open"), // open | resolved | dismissed
    priority: text("priority").notNull().default("normal"), // safety | normal
    resolution: text("resolution"),
    resolvedBy: uuid("resolved_by"),
    createdAt: createdAt(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [index("reports_status_created_idx").on(t.status, t.createdAt)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_entity_idx").on(t.entityType, t.createdAt)],
);

// Product analytics with no direct identifiers (spec 14.3, 16.1).
export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    actor: text("actor"),
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("analytics_events_name_created_idx").on(t.name, t.createdAt)],
);
