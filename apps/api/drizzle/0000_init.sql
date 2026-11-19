CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"actor" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_question_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"option_key" text,
	"received_at" timestamp with time zone NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"is_correct" boolean NOT NULL,
	"base_points" integer NOT NULL,
	"speed_points" integer NOT NULL,
	"streak_points" integer NOT NULL,
	"total_points" integer NOT NULL,
	"streak_after" integer NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "display_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "display_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "draft_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"prompt" text NOT NULL,
	"media_url" text,
	"explanation" text DEFAULT '' NOT NULL,
	"duration_seconds" integer,
	"options" jsonb NOT NULL,
	"correct_option_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_player_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name_snapshot" text NOT NULL,
	"total_score" integer DEFAULT 0 NOT NULL,
	"correct_count" integer DEFAULT 0 NOT NULL,
	"answered_count" integer DEFAULT 0 NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"longest_streak" integer DEFAULT 0 NOT NULL,
	"total_answer_time_ms" integer DEFAULT 0 NOT NULL,
	"rank" integer,
	"joined_position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"option_order" text[] NOT NULL,
	"duration_ms" integer NOT NULL,
	"started_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"revealed_at" timestamp with time zone,
	"distribution" jsonb
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"quiz_version_id" uuid NOT NULL,
	"status" text DEFAULT 'STARTING' NOT NULL,
	"scoring_profile" text NOT NULL,
	"question_count" integer NOT NULL,
	"current_position" integer DEFAULT -1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"completion_reason" text
);
--> statement-breakpoint
CREATE TABLE "media_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"path" text NOT NULL,
	"purpose" text NOT NULL,
	"mime_type" text NOT NULL,
	"declared_size" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"public_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_uploads_path_unique" UNIQUE("path")
);
--> statement-breakpoint
CREATE TABLE "question_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"correct_option_keys" text[] NOT NULL,
	CONSTRAINT "question_answers_question_id_unique" UNIQUE("question_id")
);
--> statement-breakpoint
CREATE TABLE "question_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"option_key" text NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"prompt" text NOT NULL,
	"media_url" text,
	"explanation" text DEFAULT '' NOT NULL,
	"duration_seconds" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"scoring_profile" text NOT NULL,
	"settings" jsonb NOT NULL,
	"title" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"is_starter" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"cover_url" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"settings" jsonb NOT NULL,
	"current_version_id" uuid,
	"has_draft_changes" boolean DEFAULT true NOT NULL,
	"removed_by_moderation" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"resolution" text,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "room_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name_snapshot" text NOT NULL,
	"role" text DEFAULT 'player' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connection_state" text DEFAULT 'DISCONNECTED' NOT NULL,
	"is_ready" boolean DEFAULT false NOT NULL,
	"disconnected_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"resume_token_hash" text
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"host_user_id" uuid NOT NULL,
	"quiz_version_id" uuid NOT NULL,
	"status" text DEFAULT 'LOBBY' NOT NULL,
	"mode" text DEFAULT 'classic' NOT NULL,
	"pacing" text DEFAULT 'automatic' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"max_players" integer DEFAULT 20 NOT NULL,
	"settings" jsonb NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"rematch_of_room_id" uuid,
	"current_match_id" uuid,
	"pause_requested" boolean DEFAULT false NOT NULL,
	"pause_reason" text,
	"host_presence" text DEFAULT 'connected' NOT NULL,
	"host_absent_since" timestamp with time zone,
	"phase_ends_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_subject" text,
	"is_guest" boolean DEFAULT true NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"email" text,
	"role" text DEFAULT 'user' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"can_host" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_match_question_id_match_questions_id_fk" FOREIGN KEY ("match_question_id") REFERENCES "public"."match_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "display_tokens" ADD CONSTRAINT "display_tokens_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_questions" ADD CONSTRAINT "draft_questions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_player_results" ADD CONSTRAINT "match_player_results_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_player_results" ADD CONSTRAINT "match_player_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_questions" ADD CONSTRAINT "match_questions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_questions" ADD CONSTRAINT "match_questions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_quiz_version_id_quiz_versions_id_fk" FOREIGN KEY ("quiz_version_id") REFERENCES "public"."quiz_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_answers" ADD CONSTRAINT "question_answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_options" ADD CONSTRAINT "question_options_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_quiz_version_id_quiz_versions_id_fk" FOREIGN KEY ("quiz_version_id") REFERENCES "public"."quiz_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_versions" ADD CONSTRAINT "quiz_versions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_players" ADD CONSTRAINT "room_players_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_players" ADD CONSTRAINT "room_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_quiz_version_id_quiz_versions_id_fk" FOREIGN KEY ("quiz_version_id") REFERENCES "public"."quiz_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_events_name_created_idx" ON "analytics_events" USING btree ("name","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "answers_question_user_uq" ON "answers" USING btree ("match_question_id","user_id");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","created_at");--> statement-breakpoint
CREATE INDEX "draft_questions_quiz_idx" ON "draft_questions" USING btree ("quiz_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "match_player_results_match_user_uq" ON "match_player_results" USING btree ("match_id","user_id");--> statement-breakpoint
CREATE INDEX "match_player_results_user_match_idx" ON "match_player_results" USING btree ("user_id","match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_questions_position_uq" ON "match_questions" USING btree ("match_id","position");--> statement-breakpoint
CREATE INDEX "matches_started_idx" ON "matches" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "matches_room_idx" ON "matches" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "question_options_key_uq" ON "question_options" USING btree ("question_id","option_key");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_version_position_uq" ON "questions" USING btree ("quiz_version_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_versions_quiz_number_uq" ON "quiz_versions" USING btree ("quiz_id","version_number");--> statement-breakpoint
CREATE INDEX "quizzes_owner_status_idx" ON "quizzes" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "reports_status_created_idx" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "room_players_room_user_uq" ON "room_players" USING btree ("room_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_active_code_uq" ON "rooms" USING btree ("code") WHERE "rooms"."status" not in ('FINISHED','CANCELLED','EXPIRED','ENDED_EARLY');--> statement-breakpoint
CREATE INDEX "rooms_status_expires_idx" ON "rooms" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth_subject_uq" ON "users" USING btree ("auth_subject") WHERE "users"."auth_subject" is not null;--> statement-breakpoint
CREATE INDEX "users_guest_activity_idx" ON "users" USING btree ("is_guest","last_active_at");