import { Injectable } from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config/config.ts";
import { newSecret } from "../common/tokens.ts";

export interface SignedUpload {
  uploadUrl: string;
  token: string;
}

export interface StoredObject {
  head: Buffer;
  size: number;
}

// Object storage behind signed uploads (spec 5.4, 14.1). Supabase Storage in
// deployed environments; an in-memory store for local development and tests.
export abstract class MediaStorage {
  abstract createSignedUpload(path: string): Promise<SignedUpload>;
  abstract read(path: string): Promise<StoredObject | null>;
  abstract publicUrl(path: string): string;
  abstract remove(path: string): Promise<void>;
}

export class SupabaseMediaStorage extends MediaStorage {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string, private readonly bucket: string) {
    super();
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  async createSignedUpload(path: string): Promise<SignedUpload> {
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUploadUrl(path);
    if (error || !data) throw new Error(`signed upload failed: ${error?.message}`);
    return { uploadUrl: data.signedUrl, token: data.token };
  }

  async read(path: string): Promise<StoredObject | null> {
    const { data, error } = await this.client.storage.from(this.bucket).download(path);
    if (error || !data) return null;
    const bytes = Buffer.from(await data.arrayBuffer());
    return { head: bytes.subarray(0, 16), size: bytes.length };
  }

  publicUrl(path: string): string {
    return this.client.storage.from(this.bucket).getPublicUrl(path).data.publicUrl;
  }

  async remove(path: string): Promise<void> {
    await this.client.storage.from(this.bucket).remove([path]);
  }
}

@Injectable()
export class MemoryMediaStorage extends MediaStorage {
  private readonly objects = new Map<string, Buffer>();
  private readonly pending = new Map<string, string>(); // token -> path

  constructor(private readonly base: () => string) {
    super();
  }

  private get baseUrl() {
    return this.base();
  }

  async createSignedUpload(path: string): Promise<SignedUpload> {
    const token = newSecret(18);
    this.pending.set(token, path);
    return { uploadUrl: `${this.baseUrl}/api/v1/media/dev-upload/${token}`, token };
  }

  // Called by the development upload endpoint.
  accept(token: string, body: Buffer): boolean {
    const path = this.pending.get(token);
    if (!path) return false;
    this.pending.delete(token);
    this.objects.set(path, body);
    return true;
  }

  get(path: string): Buffer | undefined {
    return this.objects.get(path);
  }

  async read(path: string): Promise<StoredObject | null> {
    const bytes = this.objects.get(path);
    return bytes ? { head: bytes.subarray(0, 16), size: bytes.length } : null;
  }

  publicUrl(path: string): string {
    return `${this.baseUrl}/api/v1/media/dev-object/${encodeURIComponent(path)}`;
  }

  async remove(path: string): Promise<void> {
    this.objects.delete(path);
  }
}

export function createStorage(config: AppConfig): MediaStorage {
  if (config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseMediaStorage(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, config.SUPABASE_STORAGE_BUCKET);
  }
  if (config.NODE_ENV === "production") {
    throw new Error("Production needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for media storage");
  }
  return new MemoryMediaStorage(() => config.PUBLIC_BASE_URL ?? `http://127.0.0.1:${config.PORT}`);
}

// File-signature check: the declared MIME type must match the bytes.
export function sniffImage(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
