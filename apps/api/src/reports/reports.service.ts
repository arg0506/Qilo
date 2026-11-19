import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DB, type Db } from "../db/db.ts";
import { auditEvents, quizzes, reports, rooms, users } from "../db/schema.ts";
import { AppError } from "../common/errors.ts";
import { cleanText, parseInput } from "../common/validation.ts";
import { LIMITS, RateLimitService } from "../common/rate-limit.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import type { AuthUser } from "../auth/auth-user.ts";

const REASONS = ["harassment", "hate", "sexual", "violence", "personal_data", "cheating", "spam", "other"] as const;
const SAFETY = new Set(["harassment", "hate", "sexual", "violence", "personal_data"]);

const createSchema = z.object({
  targetType: z.enum(["quiz", "player", "room"]),
  targetId: z.string().uuid(),
  reason: z.enum(REASONS),
  details: z.string().max(1000).default(""),
});

const resolveSchema = z.object({
  action: z.enum(["dismiss", "remove_quiz", "ban_host", "suspend_user", "no_action"]),
  note: z.string().max(1000).default(""),
});

// Reports and the moderation queue (spec 14.4, MVP-16). Safety reports are
// prioritized: first review within 2 business days, others within 7 days.
@Injectable()
export class ReportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  async create(user: AuthUser, body: unknown) {
    const input = parseInput(createSchema, body);
    await this.rateLimit.hit("report", user.id, LIMITS.report.limit, LIMITS.report.windowSec);
    const exists =
      input.targetType === "quiz"
        ? await this.db.query.quizzes.findFirst({ where: eq(quizzes.id, input.targetId) })
        : input.targetType === "room"
          ? await this.db.query.rooms.findFirst({ where: eq(rooms.id, input.targetId) })
          : await this.db.query.users.findFirst({ where: eq(users.id, input.targetId) });
    if (!exists) throw new AppError("NOT_FOUND", "We could not find what you are reporting.");
    if (input.targetType === "player" && input.targetId === user.id) throw new AppError("VALIDATION_ERROR", "You cannot report yourself.");
    const priority = SAFETY.has(input.reason) ? "safety" : "normal";
    const [row] = await this.db
      .insert(reports)
      .values({ reporterId: user.id, targetType: input.targetType, targetId: input.targetId, reason: input.reason, details: cleanText(input.details), priority })
      .returning();
    return {
      id: row!.id,
      status: row!.status,
      reviewWithin: priority === "safety" ? "2 business days" : "7 days",
    };
  }

  async queue(query: unknown) {
    const { status, limit, offset } = parseInput(
      z.object({
        status: z.enum(["open", "resolved", "dismissed"]).default("open"),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      query,
    );
    const rows = await this.db
      .select()
      .from(reports)
      .where(eq(reports.status, status))
      .orderBy(sql`case when ${reports.priority} = 'safety' then 0 else 1 end`, asc(reports.createdAt))
      .limit(limit)
      .offset(offset);
    const now = Date.now();
    return {
      items: rows.map((r) => {
        const slaDays = r.priority === "safety" ? 2 : 7;
        return { ...r, slaDueAt: new Date(r.createdAt.getTime() + slaDays * 86_400_000).toISOString(), overdue: r.status === "open" && now > r.createdAt.getTime() + slaDays * 86_400_000 };
      }),
    };
  }

  // Resolves a report and applies the moderator's action, all audited.
  async resolve(admin: AuthUser, reportId: string, body: unknown) {
    if (!z.string().uuid().safeParse(reportId).success) throw new AppError("NOT_FOUND");
    const input = parseInput(resolveSchema, body);
    return this.db.transaction(async (tx) => {
      const [report] = await tx.select().from(reports).where(eq(reports.id, reportId)).for("update");
      if (!report) throw new AppError("NOT_FOUND", "Report not found.");
      if (report.status !== "open") throw new AppError("INVALID_STATE", "This report is already closed.");

      let subjectUserId: string | null = null;
      if (report.targetType === "player") subjectUserId = report.targetId;
      if (report.targetType === "room") subjectUserId = (await tx.query.rooms.findFirst({ where: eq(rooms.id, report.targetId) }))?.hostUserId ?? null;
      if (report.targetType === "quiz") subjectUserId = (await tx.query.quizzes.findFirst({ where: eq(quizzes.id, report.targetId) }))?.ownerId ?? null;

      switch (input.action) {
        case "remove_quiz":
          if (report.targetType !== "quiz") throw new AppError("VALIDATION_ERROR", "Only quiz reports can remove a quiz.");
          await tx.update(quizzes).set({ removedByModeration: true, status: "archived" }).where(eq(quizzes.id, report.targetId));
          break;
        case "ban_host":
          if (!subjectUserId) throw new AppError("VALIDATION_ERROR", "No user to act on.");
          await tx.update(users).set({ canHost: false }).where(eq(users.id, subjectUserId));
          break;
        case "suspend_user":
          if (!subjectUserId) throw new AppError("VALIDATION_ERROR", "No user to act on.");
          await tx.update(users).set({ status: "suspended" }).where(eq(users.id, subjectUserId));
          break;
        default:
          break;
      }
      const status = input.action === "dismiss" ? "dismissed" : "resolved";
      const [row] = await tx
        .update(reports)
        .set({ status, resolution: `${input.action}${input.note ? `: ${cleanText(input.note)}` : ""}`, resolvedBy: admin.id, resolvedAt: new Date() })
        .where(and(eq(reports.id, report.id)))
        .returning();
      await this.audit.record(`moderation.${input.action}`, report.targetType, report.targetId, admin.id, { reportId: report.id, subjectUserId, note: input.note }, tx);
      return row;
    });
  }

  async auditLog(query: unknown) {
    const { limit } = parseInput(z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }), query);
    return { items: await this.db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(limit) };
  }
}
