import { Inject, Injectable, Logger } from "@nestjs/common";
import { DB, type DbOrTx, type Db } from "../db/db.ts";
import { auditEvents } from "../db/schema.ts";

// Security and moderation trail (spec 14.1). Writes never block the caller's
// success path: a failed audit write is logged, not thrown, unless a
// transaction is supplied, in which case it is part of that transaction.
@Injectable()
export class AuditService {
  private readonly log = new Logger("Audit");

  constructor(@Inject(DB) private readonly db: Db) {}

  async record(
    action: string,
    entityType: string,
    entityId: string | null,
    actorId: string | null,
    metadata: Record<string, unknown> = {},
    tx?: DbOrTx,
  ): Promise<void> {
    const write = (tx ?? this.db).insert(auditEvents).values({ action, entityType, entityId, actorId, metadata });
    if (tx) {
      await write;
      return;
    }
    await write.catch((err: unknown) => this.log.error(`audit write failed for ${action}: ${String(err)}`));
  }
}
