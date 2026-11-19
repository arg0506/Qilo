import type { users } from "../db/schema.ts";

export function serializeMe(row: typeof users.$inferSelect) {
  return {
    id: row.id,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    isGuest: row.isGuest,
    role: row.role,
    canHost: row.canHost,
    createdAt: row.createdAt.toISOString(),
  };
}
