// Join codes (spec sections 8.2 and Appendix A): 6 characters, no O/0 or I/1,
// drawn from a cryptographically secure source.

import { randomInt } from "node:crypto";

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(random: (max: number) => number = randomInt): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_ALPHABET[random(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export function isValidRoomCode(code: string): boolean {
  return (
    code.length === ROOM_CODE_LENGTH &&
    [...code].every((ch) => ROOM_CODE_ALPHABET.includes(ch))
  );
}

// Retries on collision with an active room. Throws if every attempt collides,
// which signals an exhausted code space rather than a silent duplicate.
export function allocateRoomCode(
  isActive: (code: string) => boolean,
  maxAttempts = 10,
  random: (max: number) => number = randomInt,
): string {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generateRoomCode(random);
    if (!isActive(code)) return code;
  }
  throw new Error("Could not allocate a unique room code");
}
