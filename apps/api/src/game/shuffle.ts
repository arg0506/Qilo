// Per-match ordering (spec 8.8). Questions and options are shuffled once when
// a match starts, so every player sees the same order. Answers always carry
// the canonical option key, never the display position.

import { randomInt } from "node:crypto";

export function shuffled<T>(items: readonly T[], random: (max: number) => number = randomInt): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function matchOrder<T>(
  items: readonly T[],
  shuffle: boolean,
  random?: (max: number) => number,
): T[] {
  return shuffle ? shuffled(items, random) : [...items];
}
