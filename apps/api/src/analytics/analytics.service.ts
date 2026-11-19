import { Inject, Injectable, Logger } from "@nestjs/common";
import { DB, type Db } from "../db/db.ts";
import { analyticsEvents } from "../db/schema.ts";
import { pseudonym } from "../common/tokens.ts";

// Product events (spec 16.1). Actors are pseudonymized; no names, emails or
// raw user ids are stored.
@Injectable()
export class AnalyticsService {
  private readonly log = new Logger("Analytics");

  constructor(@Inject(DB) private readonly db: Db) {}

  track(name: string, actorId: string | null, properties: Record<string, unknown> = {}): void {
    this.db
      .insert(analyticsEvents)
      .values({ name, actor: actorId ? pseudonym(actorId) : null, properties })
      .catch((err: unknown) => this.log.warn(`analytics write failed for ${name}: ${String(err)}`));
  }
}
