import { createHash, randomBytes, randomUUID } from "node:crypto";

// Opaque bearer secrets (resume tokens, display tokens). Only the SHA-256 hash
// is stored, so a database leak does not hand out seats.
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function newId(): string {
  return randomUUID();
}

// One-way pseudonym for analytics, so product events carry no direct identifier.
export function pseudonym(value: string, salt = "qilo-analytics"): string {
  return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 24);
}
