import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../config/config.ts";
import { DB, type Db } from "../db/db.ts";
import { users } from "../db/schema.ts";
import { AppError } from "../common/errors.ts";
import { cleanText } from "../common/validation.ts";
import type { VerifiedIdentity } from "../auth/token-verifier.ts";
import type { AuthUser } from "../auth/auth-user.ts";

export const DISPLAY_NAME_MAX = 24;

export function sanitizeDisplayName(raw: string): string {
  const name = cleanText(raw).slice(0, DISPLAY_NAME_MAX);
  if (name.length < 1) throw new AppError("VALIDATION_ERROR", "Display name cannot be empty.");
  return name;
}

function guestName(subject: string): string {
  const tail = subject.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase();
  return `Guest ${tail || "0000"}`;
}

type UserRow = typeof users.$inferSelect;

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    authSubject: row.authSubject ?? "",
    isGuest: row.isGuest,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: row.role === "admin" ? "admin" : "user",
    canHost: row.canHost,
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // Maps a verified Supabase identity to a Qilo user, creating the row on
  // first sight. A Supabase anonymous user keeps the same subject when it is
  // upgraded, so history carries over without any merge step.
  async resolve(identity: VerifiedIdentity): Promise<AuthUser> {
    const existing = await this.db.query.users.findFirst({
      where: and(eq(users.authSubject, identity.subject), isNotNull(users.authSubject)),
    });
    if (existing) {
      if (existing.status !== "active") {
        throw new AppError("FORBIDDEN", "This account is not active.");
      }
      const updates: Partial<UserRow> = {};
      if (existing.lastActiveAt.getTime() < Date.now() - 5 * 60_000) updates.lastActiveAt = new Date();
      if (existing.isGuest && !identity.isAnonymous) updates.isGuest = false;
      if (identity.email && existing.email !== identity.email) updates.email = identity.email;
      if (this.config.adminSubjects.has(identity.subject) && existing.role !== "admin") updates.role = "admin";
      if (Object.keys(updates).length === 0) return toAuthUser(existing);
      const [row] = await this.db.update(users).set(updates).where(eq(users.id, existing.id)).returning();
      return toAuthUser(row!);
    }
    const [row] = await this.db
      .insert(users)
      .values({
        authSubject: identity.subject,
        isGuest: identity.isAnonymous,
        email: identity.email,
        displayName: identity.suggestedName
          ? sanitizeDisplayName(identity.suggestedName)
          : guestName(identity.subject),
        role: this.config.adminSubjects.has(identity.subject) ? "admin" : "user",
      })
      .onConflictDoNothing()
      .returning();
    if (row) return toAuthUser(row);
    // Lost a race with a concurrent first request for the same subject.
    return this.resolve(identity);
  }

  async getById(id: string): Promise<UserRow> {
    const row = await this.db.query.users.findFirst({ where: eq(users.id, id) });
    if (!row) throw new AppError("NOT_FOUND", "User not found.");
    return row;
  }

  async updateProfile(id: string, changes: { displayName?: string; avatarUrl?: string | null }): Promise<UserRow> {
    const set: Partial<UserRow> = {};
    if (changes.displayName !== undefined) set.displayName = sanitizeDisplayName(changes.displayName);
    if (changes.avatarUrl !== undefined) set.avatarUrl = changes.avatarUrl;
    if (Object.keys(set).length === 0) return this.getById(id);
    const [row] = await this.db.update(users).set(set).where(eq(users.id, id)).returning();
    return row!;
  }

  async touch(id: string): Promise<void> {
    await this.db.update(users).set({ lastActiveAt: sql`now()` }).where(eq(users.id, id));
  }
}
