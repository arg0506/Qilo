import type { z } from "zod";
import { AppError } from "./errors.ts";

// Parses untrusted input with a zod schema and turns failures into the
// standard VALIDATION_ERROR envelope with per-field details.
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Some fields are missing or invalid.",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

// Collapses whitespace and strips control characters from user-visible text.
export function cleanText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F​-‏‪-‮]/g, "").replace(/\s+/g, " ").trim();
}
