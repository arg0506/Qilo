// Quiz content rules (spec 5.4 and 14.4). Pure functions, shared by the editor
// endpoints (shape checks) and publishing (full validation).

import { z } from "zod";

export const QUESTION_TYPES = ["mcq", "true_false", "image_mcq"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const LIMITS = {
  titleMax: 120,
  descriptionMax: 500,
  promptMax: 300,
  optionLabelMax: 120,
  explanationMax: 500,
  questionsMax: 100,
  durationMinSeconds: 5,
  durationMaxSeconds: 120,
  defaultDurationSeconds: 20,
} as const;

export const OPTION_COUNT: Record<QuestionType, { min: number; max: number }> = {
  mcq: { min: 2, max: 6 },
  true_false: { min: 2, max: 2 },
  image_mcq: { min: 2, max: 4 },
};

export const OPTION_KEYS = ["A", "B", "C", "D", "E", "F"] as const;

export const quizSettingsSchema = z.object({
  questionDurationSeconds: z
    .number()
    .int()
    .min(LIMITS.durationMinSeconds)
    .max(LIMITS.durationMaxSeconds)
    .default(LIMITS.defaultDurationSeconds),
  shuffleQuestions: z.boolean().default(false),
  shuffleOptions: z.boolean().default(true),
  scoringProfile: z.literal("classic-v1").default("classic-v1"),
});

const optionSchema = z.object({
  key: z.enum(OPTION_KEYS),
  label: z.string().max(LIMITS.optionLabelMax),
});

export const questionInputSchema = z.object({
  type: z.enum(QUESTION_TYPES),
  prompt: z.string().max(LIMITS.promptMax),
  mediaUrl: z.string().url().nullable().optional(),
  explanation: z.string().max(LIMITS.explanationMax).default(""),
  durationSeconds: z
    .number()
    .int()
    .min(LIMITS.durationMinSeconds)
    .max(LIMITS.durationMaxSeconds)
    .nullable()
    .optional(),
  options: z.array(optionSchema).min(2).max(6),
  correctOptionKey: z.enum(OPTION_KEYS),
  position: z.number().int().min(0).optional(),
});

export type QuestionInput = z.infer<typeof questionInputSchema>;

export interface DraftQuestionLike {
  id?: string;
  type: string;
  prompt: string;
  mediaUrl: string | null;
  explanation: string;
  durationSeconds: number | null;
  options: { key: string; label: string }[];
  correctOptionKey: string;
}

export interface Issue {
  questionIndex: number | null;
  field: string;
  message: string;
}

// Content screen at publish time: a short prohibited-term list plus personal
// data patterns. Matches hold the quiz for review instead of publishing.
const PROHIBITED = [/\bkill yourself\b/i, /\bkys\b/i, /\bnazi\b/i];
const PERSONAL_DATA = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, // email address
  /(?:\+?\d[\s-]?){10,13}/, // phone number
  /\b\d{4}\s?\d{4}\s?\d{4}\b/, // 12-digit national id shape
];

export function screenText(text: string): string | null {
  if (PROHIBITED.some((re) => re.test(text))) return "prohibited term";
  if (PERSONAL_DATA.some((re) => re.test(text))) return "possible personal data";
  return null;
}

export function validateForPublish(
  quiz: { title: string; description: string },
  qs: DraftQuestionLike[],
  isAllowedMedia: (url: string) => boolean,
): { issues: Issue[]; flags: Issue[] } {
  const issues: Issue[] = [];
  const flags: Issue[] = [];
  const add = (questionIndex: number | null, field: string, message: string) =>
    issues.push({ questionIndex, field, message });

  if (quiz.title.trim().length === 0) add(null, "title", "Add a title.");
  if (quiz.title.length > LIMITS.titleMax) add(null, "title", `Keep the title under ${LIMITS.titleMax} characters.`);
  if (qs.length === 0) add(null, "questions", "Add at least one question.");
  if (qs.length > LIMITS.questionsMax) add(null, "questions", `A quiz can have at most ${LIMITS.questionsMax} questions.`);

  for (const text of [quiz.title, quiz.description]) {
    const reason = screenText(text);
    if (reason) flags.push({ questionIndex: null, field: "title", message: `Held for review: ${reason}.` });
  }

  qs.forEach((q, i) => {
    if (!(QUESTION_TYPES as readonly string[]).includes(q.type)) {
      add(i, "type", "Unknown question type.");
      return;
    }
    const type = q.type as QuestionType;
    const prompt = q.prompt.trim();
    if (prompt.length === 0) add(i, "prompt", "Write the question.");
    if (prompt.length > LIMITS.promptMax) add(i, "prompt", `Keep the question under ${LIMITS.promptMax} characters.`);

    const { min, max } = OPTION_COUNT[type];
    if (q.options.length < min || q.options.length > max) {
      add(i, "options", min === max ? `Needs exactly ${min} options.` : `Needs ${min} to ${max} options.`);
    }
    const keys = q.options.map((o) => o.key);
    if (new Set(keys).size !== keys.length) add(i, "options", "Option keys must be unique.");
    const labels = q.options.map((o) => o.label.trim().toLowerCase());
    if (labels.some((l) => l.length === 0)) add(i, "options", "Every option needs text.");
    if (new Set(labels).size !== labels.length) add(i, "options", "Options must be different from each other.");
    if (!keys.includes(q.correctOptionKey)) add(i, "correctOptionKey", "Choose the correct answer.");

    if (type === "image_mcq") {
      if (!q.mediaUrl) add(i, "mediaUrl", "Image questions need an image.");
    }
    if (q.mediaUrl && !isAllowedMedia(q.mediaUrl)) add(i, "mediaUrl", "Upload the image through Qilo.");
    if (
      q.durationSeconds !== null &&
      (q.durationSeconds < LIMITS.durationMinSeconds || q.durationSeconds > LIMITS.durationMaxSeconds)
    ) {
      add(i, "durationSeconds", `Timer must be ${LIMITS.durationMinSeconds} to ${LIMITS.durationMaxSeconds} seconds.`);
    }

    for (const text of [q.prompt, q.explanation, ...q.options.map((o) => o.label)]) {
      const reason = screenText(text);
      if (reason) {
        flags.push({ questionIndex: i, field: "content", message: `Held for review: ${reason}.` });
        break;
      }
    }
  });

  return { issues, flags };
}

// Default options for a new true/false question.
export const TRUE_FALSE_OPTIONS = [
  { key: "A", label: "True" },
  { key: "B", label: "False" },
];
