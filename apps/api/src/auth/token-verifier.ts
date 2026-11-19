import { Inject, Injectable } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { APP_CONFIG, type AppConfig } from "../config/config.ts";
import { AppError } from "../common/errors.ts";

// The identity facts Qilo takes from a Supabase access token. Nothing here is
// ever taken from a client-supplied field (spec 14.1).
export interface VerifiedIdentity {
  subject: string;
  isAnonymous: boolean;
  email: string | null;
  suggestedName: string | null;
}

@Injectable()
export class TokenVerifier {
  private readonly secret?: Uint8Array;
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    if (config.SUPABASE_JWT_SECRET) {
      this.secret = new TextEncoder().encode(config.SUPABASE_JWT_SECRET);
    } else if (config.SUPABASE_URL) {
      this.jwks = createRemoteJWKSet(new URL("/auth/v1/.well-known/jwks.json", config.SUPABASE_URL));
    }
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    let payload: JWTPayload;
    try {
      const options = { audience: this.config.SUPABASE_JWT_AUDIENCE };
      payload = this.secret
        ? (await jwtVerify(token, this.secret, { ...options, algorithms: ["HS256"] })).payload
        : (await jwtVerify(token, this.jwks!, options)).payload;
    } catch {
      throw new AppError("UNAUTHORIZED", "Your session is invalid or has expired.");
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new AppError("UNAUTHORIZED", "Your session is invalid or has expired.");
    }
    const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
    const name = [meta.display_name, meta.full_name, meta.name].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    return {
      subject: payload.sub,
      isAnonymous: payload.is_anonymous === true,
      email: typeof payload.email === "string" && payload.email ? payload.email : null,
      suggestedName: name ?? null,
    };
  }
}
