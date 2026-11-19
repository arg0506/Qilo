import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { screenText, validateForPublish, type DraftQuestionLike } from "./quiz-rules.ts";
import { matchOrder, shuffled } from "../game/shuffle.ts";

const q = (over: Partial<DraftQuestionLike> = {}): DraftQuestionLike => ({
  type: "mcq",
  prompt: "Which planet is known as the Red Planet?",
  mediaUrl: null,
  explanation: "",
  durationSeconds: null,
  options: [
    { key: "A", label: "Venus" },
    { key: "B", label: "Mars" },
  ],
  correctOptionKey: "B",
  ...over,
});
const quiz = { title: "Space", description: "" };
const anyMedia = () => true;

describe("publish validation", () => {
  test("a valid quiz has no issues", () => {
    assert.deepEqual(validateForPublish(quiz, [q()], anyMedia).issues, []);
  });

  test("a quiz needs a title and at least one question", () => {
    const { issues } = validateForPublish({ title: " ", description: "" }, [], anyMedia);
    assert.deepEqual(issues.map((i) => i.field).sort(), ["questions", "title"]);
  });

  test("multiple choice allows 2 to 6 options", () => {
    const one = q({ options: [{ key: "A", label: "x" }], correctOptionKey: "A" });
    assert.equal(validateForPublish(quiz, [one], anyMedia).issues[0]?.field, "options");
  });

  test("true/false needs exactly two options", () => {
    const three = q({
      type: "true_false",
      options: [
        { key: "A", label: "True" },
        { key: "B", label: "False" },
        { key: "C", label: "Maybe" },
      ],
    });
    assert.ok(validateForPublish(quiz, [three], anyMedia).issues.some((i) => i.field === "options"));
  });

  test("image questions need an image and at most 4 options", () => {
    const img = q({ type: "image_mcq" });
    assert.ok(validateForPublish(quiz, [img], anyMedia).issues.some((i) => i.field === "mediaUrl"));
  });

  test("the answer key must be one of the options", () => {
    assert.ok(validateForPublish(quiz, [q({ correctOptionKey: "D" })], anyMedia).issues.some((i) => i.field === "correctOptionKey"));
  });

  test("duplicate option text is rejected", () => {
    const dup = q({ options: [{ key: "A", label: "Mars" }, { key: "B", label: "mars " }] });
    assert.ok(validateForPublish(quiz, [dup], anyMedia).issues.some((i) => i.message.includes("different")));
  });

  test("timer overrides must be 5 to 120 seconds", () => {
    assert.ok(validateForPublish(quiz, [q({ durationSeconds: 3 })], anyMedia).issues.some((i) => i.field === "durationSeconds"));
  });

  test("media must come from Qilo uploads", () => {
    const { issues } = validateForPublish(quiz, [q({ mediaUrl: "https://evil.example/x.png" })], () => false);
    assert.ok(issues.some((i) => i.field === "mediaUrl"));
  });

  test("personal data and prohibited terms are flagged for review, not silently published", () => {
    assert.equal(screenText("Call me on +91 98765 43210"), "possible personal data");
    assert.equal(screenText("mail me at someone@example.com"), "possible personal data");
    assert.equal(screenText("What is 2 + 2?"), null);
    const { flags } = validateForPublish(quiz, [q({ prompt: "Email ravi@example.com for answers" })], anyMedia);
    assert.equal(flags.length, 1);
  });
});

describe("per-match ordering", () => {
  test("shuffle is a permutation", () => {
    const items = ["A", "B", "C", "D", "E", "F"];
    const out = shuffled(items);
    assert.deepEqual([...out].sort(), items);
  });

  test("order is preserved when shuffling is off", () => {
    assert.deepEqual(matchOrder(["A", "B", "C"], false), ["A", "B", "C"]);
  });

  test("a deterministic source gives a deterministic order", () => {
    assert.deepEqual(shuffled(["A", "B", "C"], () => 0), ["B", "C", "A"]);
  });
});
