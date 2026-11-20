import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.ts";
import { mediaUploads } from "../db/schema.ts";
import { AppError } from "../common/errors.ts";
import { newId } from "../common/tokens.ts";
import { AuditService } from "../audit/audit.service.ts";
import { MediaStorage, sniffImage } from "./storage.ts";

export const MEDIA_RULES = {
  mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  maxBytes: { question: 5 * 1024 * 1024, cover: 5 * 1024 * 1024, avatar: 2 * 1024 * 1024 },
} as const;
export type MediaPurpose = keyof typeof MEDIA_RULES.maxBytes;

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

@Injectable()
export class MediaService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: MediaStorage,
    private readonly audit: AuditService,
  ) {}

  async requestUpload(ownerId: string, purpose: MediaPurpose, mimeType: string, sizeBytes: number) {
    if (!(MEDIA_RULES.mimeTypes as readonly string[]).includes(mimeType)) {
      throw new AppError("MEDIA_REJECTED", "Only PNG, JPEG, WebP and GIF images are allowed.");
    }
    if (sizeBytes <= 0 || sizeBytes > MEDIA_RULES.maxBytes[purpose]) {
      throw new AppError("MEDIA_REJECTED", `Images for ${purpose} must be under ${MEDIA_RULES.maxBytes[purpose] / 1024 / 1024} MB.`);
    }
    const path = `${purpose}/${ownerId}/${newId()}.${EXT[mimeType]}`;
    const signed = await this.storage.createSignedUpload(path);
    const [row] = await this.db
      .insert(mediaUploads)
      .values({ ownerId, path, purpose, mimeType, declaredSize: sizeBytes })
      .returning();
    return { uploadId: row!.id, uploadUrl: signed.uploadUrl, token: signed.token, path, method: "PUT" as const };
  }

  // Runs after the client has uploaded the bytes. Checks the real size and
  // the file signature against the declared type, then publishes the URL.
  async complete(ownerId: string, uploadId: string) {
    const row = await this.db.query.mediaUploads.findFirst({
      where: and(eq(mediaUploads.id, uploadId), eq(mediaUploads.ownerId, ownerId)),
    });
    if (!row) throw new AppError("NOT_FOUND", "Upload not found.");
    if (row.status === "ready") return { uploadId: row.id, url: row.publicUrl! };
    if (row.status === "rejected") throw new AppError("MEDIA_REJECTED");

    const object = await this.storage.read(row.path);
    const reject = async (reason: string) => {
      await this.storage.remove(row.path).catch(() => undefined);
      await this.db.update(mediaUploads).set({ status: "rejected" }).where(eq(mediaUploads.id, row.id));
      await this.audit.record("media.rejected", "media", row.id, ownerId, { reason });
      throw new AppError("MEDIA_REJECTED", reason);
    };
    if (!object) throw new AppError("MEDIA_REJECTED", "The file has not been uploaded yet.");
    const limit = MEDIA_RULES.maxBytes[row.purpose as MediaPurpose];
    if (object.size > limit) await reject("The file is larger than allowed.");
    if (sniffImage(object.head) !== row.mimeType) await reject("The file content does not match its type.");

    const url = this.storage.publicUrl(row.path);
    await this.db.update(mediaUploads).set({ status: "ready", publicUrl: url }).where(eq(mediaUploads.id, row.id));
    return { uploadId: row.id, url };
  }

  // URLs a user may reference in quiz content: their own completed uploads.
  async allowedUrls(ownerId: string, urls: string[]): Promise<Set<string>> {
    if (urls.length === 0) return new Set();
    const rows = await this.db
      .select({ url: mediaUploads.publicUrl })
      .from(mediaUploads)
      .where(and(eq(mediaUploads.ownerId, ownerId), eq(mediaUploads.status, "ready"), inArray(mediaUploads.publicUrl, urls)));
    return new Set(rows.map((r) => r.url!).filter(Boolean));
  }
}
