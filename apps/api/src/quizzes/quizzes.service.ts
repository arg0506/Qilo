import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, inArray, max, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { DB, type Db, type DbOrTx } from "../db/db.ts";
import {
  draftQuestions,
  questionAnswers,
  questionOptions,
  questions,
  quizVersions,
  quizzes,
  reports,
  type QuizSettings,
} from "../db/schema.ts";
import { AppError } from "../common/errors.ts";
import { cleanText, parseInput } from "../common/validation.ts";
import { MediaService } from "../media/media.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { AnalyticsService } from "../analytics/analytics.service.ts";
import type { AuthUser } from "../auth/auth-user.ts";
import {
  LIMITS,
  OPTION_COUNT,
  questionInputSchema,
  quizSettingsSchema,
  validateForPublish,
  type QuestionType,
} from "./quiz-rules.ts";

const VISIBILITY = ["private", "unlisted"] as const;

export const createQuizSchema = z.object({
  title: z.string().min(1).max(LIMITS.titleMax),
  description: z.string().max(LIMITS.descriptionMax).default(""),
  category: z.string().min(1).max(40).default("general"),
  language: z.string().min(2).max(10).default("en"),
  visibility: z.enum(VISIBILITY).default("private"),
  coverUrl: z.string().url().nullable().optional(),
  settings: quizSettingsSchema.default({
    questionDurationSeconds: LIMITS.defaultDurationSeconds,
    shuffleQuestions: false,
    shuffleOptions: true,
    scoringProfile: "classic-v1",
  }),
});

export const updateQuizSchema = z.object({
  title: z.string().min(1).max(LIMITS.titleMax).optional(),
  description: z.string().max(LIMITS.descriptionMax).optional(),
  category: z.string().min(1).max(40).optional(),
  language: z.string().min(2).max(10).optional(),
  visibility: z.enum(VISIBILITY).optional(),
  coverUrl: z.string().url().nullable().optional(),
  settings: quizSettingsSchema.partial().optional(),
});

export const listQuizzesSchema = z.object({
  scope: z.enum(["mine", "starter", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

type QuizRow = typeof quizzes.$inferSelect;
type DraftRow = typeof draftQuestions.$inferSelect;

function serializeDraftQuestion(q: DraftRow) {
  return {
    id: q.id,
    position: q.position,
    type: q.type,
    prompt: q.prompt,
    mediaUrl: q.mediaUrl,
    explanation: q.explanation,
    durationSeconds: q.durationSeconds,
    options: q.options,
    correctOptionKey: q.correctOptionKey,
  };
}

@Injectable()
export class QuizzesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly media: MediaService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
  ) {}

  // ---- Reading ---------------------------------------------------------

  canRead(quiz: QuizRow, user: AuthUser | undefined): boolean {
    if (user && quiz.ownerId === user.id) return true;
    if (quiz.removedByModeration) return false;
    if (quiz.isStarter) return quiz.status === "published";
    return quiz.visibility !== "private" && quiz.status === "published";
  }

  async list(user: AuthUser | undefined, query: unknown) {
    const { scope, limit, offset } = parseInput(listQuizzesSchema, query);
    if (scope === "mine" && !user) throw new AppError("UNAUTHORIZED");

    const starter = and(eq(quizzes.isStarter, true), eq(quizzes.status, "published"));
    const mine = user ? and(eq(quizzes.ownerId, user.id), ne(quizzes.status, "archived")) : undefined;
    const where = scope === "mine" ? mine : scope === "starter" ? starter : mine ? or(mine, starter) : starter;

    const rows = await this.db
      .select()
      .from(quizzes)
      .where(where)
      .orderBy(desc(quizzes.isStarter), desc(quizzes.updatedAt))
      .limit(limit + 1)
      .offset(offset);
    const page = rows.slice(0, limit);
    const counts = await this.versionQuestionCounts(page.map((q) => q.currentVersionId).filter((v): v is string => !!v));
    return {
      items: page.map((q) => this.summary(q, user, counts.get(q.currentVersionId ?? "") ?? 0)),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }

  private async versionQuestionCounts(versionIds: string[]): Promise<Map<string, number>> {
    if (versionIds.length === 0) return new Map();
    const rows = await this.db
      .select({ versionId: questions.quizVersionId, n: count() })
      .from(questions)
      .where(inArray(questions.quizVersionId, versionIds))
      .groupBy(questions.quizVersionId);
    return new Map(rows.map((r) => [r.versionId, Number(r.n)]));
  }

  private summary(q: QuizRow, user: AuthUser | undefined, publishedQuestionCount: number) {
    return {
      id: q.id,
      title: q.title,
      description: q.description,
      category: q.category,
      language: q.language,
      coverUrl: q.coverUrl,
      visibility: q.visibility,
      status: q.status,
      isStarter: q.isStarter,
      isOwner: !!user && q.ownerId === user.id,
      settings: q.settings,
      currentVersionId: q.currentVersionId,
      publishedQuestionCount,
      hasDraftChanges: q.hasDraftChanges,
      updatedAt: q.updatedAt.toISOString(),
    };
  }

  async get(user: AuthUser | undefined, id: string) {
    const quiz = await this.findQuiz(id);
    if (!this.canRead(quiz, user)) throw new AppError("NOT_FOUND", "Quiz not found.");
    const isOwner = !!user && quiz.ownerId === user.id;

    let currentVersion = null;
    if (quiz.currentVersionId) {
      const version = await this.db.query.quizVersions.findFirst({ where: eq(quizVersions.id, quiz.currentVersionId) });
      const counts = await this.versionQuestionCounts([quiz.currentVersionId]);
      if (version) {
        currentVersion = {
          id: version.id,
          versionNumber: version.versionNumber,
          questionCount: counts.get(version.id) ?? 0,
          publishedAt: version.publishedAt.toISOString(),
        };
      }
    }
    const result: Record<string, unknown> = {
      ...this.summary(quiz, user, currentVersion?.questionCount ?? 0),
      currentVersion,
    };
    // Only the owner sees draft content and answer keys.
    if (isOwner) {
      const drafts = await this.db
        .select()
        .from(draftQuestions)
        .where(eq(draftQuestions.quizId, quiz.id))
        .orderBy(asc(draftQuestions.position));
      result.questions = drafts.map(serializeDraftQuestion);
    }
    return result;
  }

  async findQuiz(id: string, tx: DbOrTx = this.db): Promise<QuizRow> {
    if (!z.string().uuid().safeParse(id).success) throw new AppError("NOT_FOUND", "Quiz not found.");
    const quiz = await tx.query.quizzes.findFirst({ where: eq(quizzes.id, id) });
    if (!quiz) throw new AppError("NOT_FOUND", "Quiz not found.");
    return quiz;
  }

  private async ownedQuiz(user: AuthUser, id: string, tx: DbOrTx = this.db): Promise<QuizRow> {
    const quiz = await this.findQuiz(id, tx);
    if (quiz.ownerId !== user.id) {
      throw new AppError(this.canRead(quiz, user) ? "FORBIDDEN" : "NOT_FOUND", this.canRead(quiz, user) ? "Only the owner can edit this quiz." : "Quiz not found.");
    }
    if (quiz.status === "archived") throw new AppError("INVALID_STATE", "Archived quizzes cannot be edited.");
    return quiz;
  }

  // ---- Writing ---------------------------------------------------------

  async create(user: AuthUser, body: unknown) {
    const input = parseInput(createQuizSchema, body);
    const [row] = await this.db
      .insert(quizzes)
      .values({
        ownerId: user.id,
        title: cleanText(input.title),
        description: cleanText(input.description),
        category: cleanText(input.category).toLowerCase(),
        language: input.language,
        visibility: input.visibility,
        coverUrl: input.coverUrl ?? null,
        settings: input.settings as QuizSettings,
      })
      .returning();
    this.analytics.track("quiz_created", user.id, {});
    return this.get(user, row!.id);
  }

  async update(user: AuthUser, id: string, body: unknown) {
    const input = parseInput(updateQuizSchema, body);
    const quiz = await this.ownedQuiz(user, id);
    const set: Partial<QuizRow> = { updatedAt: new Date() };
    if (input.title !== undefined) set.title = cleanText(input.title);
    if (input.description !== undefined) set.description = cleanText(input.description);
    if (input.category !== undefined) set.category = cleanText(input.category).toLowerCase();
    if (input.language !== undefined) set.language = input.language;
    if (input.visibility !== undefined) set.visibility = input.visibility;
    if (input.coverUrl !== undefined) set.coverUrl = input.coverUrl;
    if (input.settings) set.settings = { ...quiz.settings, ...input.settings } as QuizSettings;
    // Content and settings changes need a new publish; visibility does not.
    const contentKeys = Object.keys(input).filter((k) => k !== "visibility");
    if (contentKeys.length > 0) set.hasDraftChanges = true;
    await this.db.update(quizzes).set(set).where(eq(quizzes.id, quiz.id));
    return this.get(user, quiz.id);
  }

  async archive(user: AuthUser, id: string) {
    const quiz = await this.ownedQuiz(user, id);
    await this.db.update(quizzes).set({ status: "archived", updatedAt: new Date() }).where(eq(quizzes.id, quiz.id));
    await this.audit.record("quiz.archived", "quiz", quiz.id, user.id);
    return { id: quiz.id, status: "archived" };
  }

  private checkOptionShape(type: QuestionType, options: { key: string }[], correct: string) {
    const { min, max } = OPTION_COUNT[type];
    if (options.length < min || options.length > max) {
      throw new AppError("VALIDATION_ERROR", min === max ? `This question type needs exactly ${min} options.` : `This question type needs ${min} to ${max} options.`);
    }
    const keys = options.map((o) => o.key);
    if (new Set(keys).size !== keys.length) throw new AppError("VALIDATION_ERROR", "Option keys must be unique.");
    if (!keys.includes(correct)) throw new AppError("VALIDATION_ERROR", "The correct answer must be one of the options.");
  }

  async addQuestion(user: AuthUser, quizId: string, body: unknown) {
    const input = parseInput(questionInputSchema, body);
    this.checkOptionShape(input.type, input.options, input.correctOptionKey);
    return this.db.transaction(async (tx) => {
      const quiz = await this.ownedQuiz(user, quizId, tx);
      await tx.execute(sql`select id from quizzes where id = ${quiz.id} for update`);
      const [{ total, top }] = (await tx
        .select({ total: count(), top: max(draftQuestions.position) })
        .from(draftQuestions)
        .where(eq(draftQuestions.quizId, quiz.id))) as [{ total: number; top: number | null }];
      if (Number(total) >= LIMITS.questionsMax) {
        throw new AppError("VALIDATION_ERROR", `A quiz can have at most ${LIMITS.questionsMax} questions.`);
      }
      const end = top === null ? 0 : Number(top) + 1;
      const position = input.position === undefined ? end : Math.min(input.position, end);
      if (position < end) {
        await tx
          .update(draftQuestions)
          .set({ position: sql`${draftQuestions.position} + 1` })
          .where(and(eq(draftQuestions.quizId, quiz.id), sql`${draftQuestions.position} >= ${position}`));
      }
      const [row] = await tx
        .insert(draftQuestions)
        .values({
          quizId: quiz.id,
          position,
          type: input.type,
          prompt: cleanText(input.prompt),
          mediaUrl: input.mediaUrl ?? null,
          explanation: cleanText(input.explanation),
          durationSeconds: input.durationSeconds ?? null,
          options: input.options.map((o) => ({ key: o.key, label: cleanText(o.label) })),
          correctOptionKey: input.correctOptionKey,
        })
        .returning();
      await tx.update(quizzes).set({ hasDraftChanges: true, updatedAt: new Date() }).where(eq(quizzes.id, quiz.id));
      return serializeDraftQuestion(row!);
    });
  }

  private async ownedDraftQuestion(user: AuthUser, questionId: string, tx: DbOrTx) {
    if (!z.string().uuid().safeParse(questionId).success) throw new AppError("NOT_FOUND", "Question not found.");
    const row = await tx.query.draftQuestions.findFirst({ where: eq(draftQuestions.id, questionId) });
    if (!row) throw new AppError("NOT_FOUND", "Question not found.");
    await this.ownedQuiz(user, row.quizId, tx);
    return row;
  }

  async updateQuestion(user: AuthUser, questionId: string, body: unknown) {
    const input = parseInput(questionInputSchema.partial(), body);
    return this.db.transaction(async (tx) => {
      const current = await this.ownedDraftQuestion(user, questionId, tx);
      const type = (input.type ?? current.type) as QuestionType;
      const options = input.options ?? current.options;
      const correct = input.correctOptionKey ?? current.correctOptionKey;
      this.checkOptionShape(type, options, correct);
      const [row] = await tx
        .update(draftQuestions)
        .set({
          type,
          prompt: input.prompt !== undefined ? cleanText(input.prompt) : current.prompt,
          mediaUrl: input.mediaUrl !== undefined ? input.mediaUrl : current.mediaUrl,
          explanation: input.explanation !== undefined ? cleanText(input.explanation) : current.explanation,
          durationSeconds: input.durationSeconds !== undefined ? input.durationSeconds : current.durationSeconds,
          options: options.map((o) => ({ key: o.key, label: cleanText(o.label) })),
          correctOptionKey: correct,
        })
        .where(eq(draftQuestions.id, current.id))
        .returning();
      await tx.update(quizzes).set({ hasDraftChanges: true, updatedAt: new Date() }).where(eq(quizzes.id, current.quizId));
      return serializeDraftQuestion(row!);
    });
  }

  async deleteQuestion(user: AuthUser, questionId: string) {
    await this.db.transaction(async (tx) => {
      const current = await this.ownedDraftQuestion(user, questionId, tx);
      await tx.delete(draftQuestions).where(eq(draftQuestions.id, current.id));
      await tx
        .update(draftQuestions)
        .set({ position: sql`${draftQuestions.position} - 1` })
        .where(and(eq(draftQuestions.quizId, current.quizId), sql`${draftQuestions.position} > ${current.position}`));
      await tx.update(quizzes).set({ hasDraftChanges: true, updatedAt: new Date() }).where(eq(quizzes.id, current.quizId));
    });
    return { id: questionId, deleted: true };
  }

  async reorder(user: AuthUser, quizId: string, body: unknown) {
    const { questionIds } = parseInput(z.object({ questionIds: z.array(z.string().uuid()).min(1) }), body);
    await this.db.transaction(async (tx) => {
      const quiz = await this.ownedQuiz(user, quizId, tx);
      const rows = await tx.select({ id: draftQuestions.id }).from(draftQuestions).where(eq(draftQuestions.quizId, quiz.id));
      const existing = new Set(rows.map((r) => r.id));
      if (existing.size !== questionIds.length || questionIds.some((id) => !existing.has(id)) || new Set(questionIds).size !== questionIds.length) {
        throw new AppError("VALIDATION_ERROR", "Send every question id of this quiz exactly once.");
      }
      for (const [position, id] of questionIds.entries()) {
        await tx.update(draftQuestions).set({ position }).where(eq(draftQuestions.id, id));
      }
      await tx.update(quizzes).set({ hasDraftChanges: true, updatedAt: new Date() }).where(eq(quizzes.id, quiz.id));
    });
    return this.get(user, quizId);
  }

  // ---- Publishing and preview -----------------------------------------

  private async loadValidatedDraft(user: AuthUser, quiz: QuizRow, tx: DbOrTx) {
    const drafts = await tx
      .select()
      .from(draftQuestions)
      .where(eq(draftQuestions.quizId, quiz.id))
      .orderBy(asc(draftQuestions.position));
    const urls = drafts.map((d) => d.mediaUrl).filter((u): u is string => !!u);
    const allowed = await this.media.allowedUrls(user.id, urls);
    const result = validateForPublish(quiz, drafts, (url) => allowed.has(url));
    return { drafts, ...result };
  }

  async publish(user: AuthUser, quizId: string) {
    const outcome = await this.db.transaction(async (tx) => {
      const quiz = await this.ownedQuiz(user, quizId, tx);
      await tx.execute(sql`select id from quizzes where id = ${quiz.id} for update`);
      const { drafts, issues, flags } = await this.loadValidatedDraft(user, quiz, tx);
      if (issues.length > 0) {
        return { ok: false as const, error: new AppError("QUIZ_NOT_PUBLISHABLE", "Fix these issues before publishing.", { issues }) };
      }
      if (flags.length > 0) {
        await tx.insert(reports).values({
          reporterId: null,
          targetType: "quiz",
          targetId: quiz.id,
          reason: "automated_screen",
          details: flags.map((f) => f.message).join(" "),
          priority: "safety",
        });
        return {
          ok: false as const,
          error: new AppError("QUIZ_NOT_PUBLISHABLE", "This quiz is held for a quick review before it can be published.", { held: true, flags }),
        };
      }

      const [{ top }] = (await tx
        .select({ top: max(quizVersions.versionNumber) })
        .from(quizVersions)
        .where(eq(quizVersions.quizId, quiz.id))) as [{ top: number | null }];
      const versionNumber = (top === null ? 0 : Number(top)) + 1;
      const [version] = await tx
        .insert(quizVersions)
        .values({
          quizId: quiz.id,
          versionNumber,
          scoringProfile: quiz.settings.scoringProfile,
          settings: quiz.settings,
          title: quiz.title,
        })
        .returning();

      for (const [position, d] of drafts.entries()) {
        const [question] = await tx
          .insert(questions)
          .values({
            quizVersionId: version!.id,
            position,
            type: d.type,
            prompt: d.prompt,
            mediaUrl: d.mediaUrl,
            explanation: d.explanation,
            durationSeconds: d.durationSeconds ?? quiz.settings.questionDurationSeconds,
          })
          .returning();
        await tx.insert(questionOptions).values(
          d.options.map((o, i) => ({ questionId: question!.id, optionKey: o.key, label: o.label, position: i })),
        );
        await tx.insert(questionAnswers).values({ questionId: question!.id, correctOptionKeys: [d.correctOptionKey] });
      }
      await tx
        .update(quizzes)
        .set({ status: "published", currentVersionId: version!.id, hasDraftChanges: false, updatedAt: new Date() })
        .where(eq(quizzes.id, quiz.id));
      await this.audit.record("quiz.published", "quiz", quiz.id, user.id, { versionNumber }, tx);
      return { ok: true as const, version: version!, questionCount: drafts.length };
    });
    if (!outcome.ok) throw outcome.error;
    this.analytics.track("quiz_published", user.id, { questionCount: outcome.questionCount });
    return {
      quizId,
      version: {
        id: outcome.version.id,
        versionNumber: outcome.version.versionNumber,
        questionCount: outcome.questionCount,
        publishedAt: outcome.version.publishedAt.toISOString(),
      },
    };
  }

  // Preview plays the current draft with the real timer and reveal on the
  // client. Nothing is persisted: no room, match or results (spec 5.4).
  async preview(user: AuthUser, quizId: string) {
    const quiz = await this.ownedQuiz(user, quizId);
    const { drafts, issues } = await this.loadValidatedDraft(user, quiz, this.db);
    if (issues.length > 0) throw new AppError("QUIZ_NOT_PUBLISHABLE", "Fix these issues before previewing.", { issues });
    return {
      sessionId: `preview_${crypto.randomUUID()}`,
      quizId: quiz.id,
      title: quiz.title,
      scoringProfile: quiz.settings.scoringProfile,
      settings: quiz.settings,
      questions: drafts.map((d) => ({
        ...serializeDraftQuestion(d),
        durationSeconds: d.durationSeconds ?? quiz.settings.questionDurationSeconds,
      })),
    };
  }

  // A version a host may start a room from.
  async hostableVersion(user: AuthUser, input: { quizId?: string; quizVersionId?: string }) {
    let quiz: QuizRow;
    let versionId: string;
    if (input.quizVersionId) {
      const version = await this.db.query.quizVersions.findFirst({ where: eq(quizVersions.id, input.quizVersionId) });
      if (!version) throw new AppError("NOT_FOUND", "Quiz version not found.");
      quiz = await this.findQuiz(version.quizId);
      versionId = version.id;
    } else if (input.quizId) {
      quiz = await this.findQuiz(input.quizId);
      if (!quiz.currentVersionId) throw new AppError("INVALID_STATE", "Publish this quiz before hosting it.");
      versionId = quiz.currentVersionId;
    } else {
      throw new AppError("VALIDATION_ERROR", "Choose a quiz to host.");
    }
    const isOwner = quiz.ownerId === user.id;
    if (!isOwner && !this.canRead(quiz, user)) throw new AppError("NOT_FOUND", "Quiz not found.");
    if (quiz.status === "archived" || quiz.removedByModeration) {
      throw new AppError("INVALID_STATE", "This quiz can no longer be hosted.");
    }
    const version = await this.db.query.quizVersions.findFirst({ where: eq(quizVersions.id, versionId) });
    if (!version) throw new AppError("INVALID_STATE", "Publish this quiz before hosting it.");
    return { quiz, version };
  }
}
