import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { scoreAnswer, speedBonus, streakBonus } from "./scoring.ts";
import { rankStandings, compareStandings } from "./standings.ts";
import { canTransition, transition, InvalidTransitionError } from "./lifecycle.ts";
import { decideAnswer, shouldRevealEarly } from "./answer.ts";
import { generateRoomCode, isValidRoomCode, allocateRoomCode, ROOM_CODE_ALPHABET } from "../room/room-code.ts";

const DURATION = 20_000;
const START = 1_000_000;

describe("classic-v1 scoring", () => {
  test("spec worked example: 4 s into 20 s, third correct in a row = 1000", () => {
    const result = scoreAnswer({
      correct: true,
      streakBefore: 2,
      startedAtMs: START,
      receivedAtMs: START + 4_000,
      durationMs: DURATION,
    });
    assert.deepEqual(result, { base: 500, speed: 400, streak: 100, total: 1000, streakAfter: 3 });
  });

  test("correct answer at the instant the question starts gets the full speed bonus", () => {
    assert.equal(speedBonus({ startedAtMs: START, receivedAtMs: START, durationMs: DURATION }), 500);
  });

  test("correct answer at the deadline gets no speed bonus but keeps the base", () => {
    const result = scoreAnswer({
      correct: true,
      streakBefore: 0,
      startedAtMs: START,
      receivedAtMs: START + DURATION,
      durationMs: DURATION,
    });
    assert.equal(result.total, 500);
  });

  test("a receive time before the start is clamped to the full bonus", () => {
    assert.equal(speedBonus({ startedAtMs: START, receivedAtMs: START - 5_000, durationMs: DURATION }), 500);
  });

  test("streak bonus steps: none for the first answer, then 50 per step, capped at 200", () => {
    assert.equal(streakBonus(1), 0);
    assert.equal(streakBonus(2), 50);
    assert.equal(streakBonus(3), 100);
    assert.equal(streakBonus(5), 200);
    assert.equal(streakBonus(12), 200);
  });

  test("maximum per correct answer is 1,200 and minimum is 500", () => {
    const max = scoreAnswer({ correct: true, streakBefore: 9, startedAtMs: START, receivedAtMs: START, durationMs: DURATION });
    const min = scoreAnswer({ correct: true, streakBefore: 0, startedAtMs: START, receivedAtMs: START + DURATION, durationMs: DURATION });
    assert.equal(max.total, 1200);
    assert.equal(min.total, 500);
  });

  test("a wrong answer scores zero and resets the streak", () => {
    const result = scoreAnswer({ correct: false, streakBefore: 4, startedAtMs: START, receivedAtMs: START, durationMs: DURATION });
    assert.deepEqual(result, { base: 0, speed: 0, streak: 0, total: 0, streakAfter: 0 });
  });
});

describe("standings and tie-breaks", () => {
  const p = (userId: string, totalScore: number, correctCount: number, totalAnswerTimeMs: number, longestStreak = 0) => ({
    userId, totalScore, correctCount, totalAnswerTimeMs, longestStreak,
  });

  test("higher score ranks first", () => {
    const ranked = rankStandings([p("a", 900, 1, 1), p("b", 1200, 1, 1)]);
    assert.deepEqual(ranked.map((r) => [r.userId, r.rank]), [["b", 1], ["a", 2]]);
  });

  test("equal score: more correct answers wins", () => {
    const ranked = rankStandings([p("a", 1000, 2, 5_000), p("b", 1000, 3, 9_000)]);
    assert.equal(ranked[0].userId, "b");
  });

  test("equal score and correct count: faster total answer time wins", () => {
    const ranked = rankStandings([p("a", 1000, 2, 9_000), p("b", 1000, 2, 4_000)]);
    assert.equal(ranked[0].userId, "b");
  });

  test("fully tied players share a rank and the next rank skips", () => {
    const ranked = rankStandings([p("a", 1000, 2, 4_000), p("b", 1000, 2, 4_000), p("c", 500, 1, 1_000)]);
    assert.deepEqual(ranked.map((r) => r.rank), [1, 1, 3]);
  });

  test("the comparator is zero for players tied on every key, so no arbitrary order is used", () => {
    assert.equal(compareStandings(p("a", 1, 1, 1), p("z", 1, 1, 1)), 0);
  });
});

describe("lifecycle", () => {
  test("the normal path is allowed", () => {
    const path = ["CREATED", "LOBBY", "STARTING", "QUESTION_ACTIVE", "QUESTION_LOCKED", "ANSWER_REVEAL", "SCOREBOARD", "NEXT_QUESTION", "FINISHED"] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`);
    }
  });

  test("pause is allowed between questions and resumes to the next question", () => {
    assert.equal(transition("SCOREBOARD", "PAUSED"), "PAUSED");
    assert.equal(transition("PAUSED", "NEXT_QUESTION"), "NEXT_QUESTION");
  });

  test("a question cannot start directly from the lobby", () => {
    assert.throws(() => transition("LOBBY", "QUESTION_ACTIVE"), InvalidTransitionError);
  });

  test("terminal states have no exits", () => {
    for (const to of ["LOBBY", "QUESTION_ACTIVE", "FINISHED"] as const) {
      assert.equal(canTransition("FINISHED", to), false);
    }
  });

  test("a host can end a live match early from any in-match phase", () => {
    for (const from of ["QUESTION_ACTIVE", "ANSWER_REVEAL", "PAUSED"] as const) {
      assert.ok(canTransition(from, "ENDED_EARLY"));
    }
  });
});

describe("answer acceptance", () => {
  const question = { phase: "QUESTION_ACTIVE" as const, deadlineAtMs: START + DURATION, optionKeys: ["A", "B", "C", "D"] };
  const ok = { isMember: true, optionKey: "B", idempotencyKey: "k1", receivedAtMs: START + 1_000 };

  test("a valid answer before the deadline is accepted", () => {
    assert.deepEqual(decideAnswer(question, undefined, ok), { ok: true, duplicate: false });
  });

  test("an answer at the exact deadline is accepted, one millisecond later is rejected", () => {
    assert.equal(decideAnswer(question, undefined, { ...ok, receivedAtMs: START + DURATION }).ok, true);
    assert.deepEqual(decideAnswer(question, undefined, { ...ok, receivedAtMs: START + DURATION + 1 }), { ok: false, code: "ANSWER_DEADLINE_PASSED" });
  });

  test("a retry of the same accepted command is a duplicate, not a second answer", () => {
    const existing = { idempotencyKey: "k1", optionKey: "B" };
    assert.deepEqual(decideAnswer(question, existing, ok), { ok: true, duplicate: true });
  });

  test("a second, different answer is rejected because the first locks", () => {
    const existing = { idempotencyKey: "k0", optionKey: "A" };
    assert.deepEqual(decideAnswer(question, existing, ok), { ok: false, code: "ANSWER_ALREADY_SUBMITTED" });
  });

  test("an option that is not on the question is rejected", () => {
    assert.deepEqual(decideAnswer(question, undefined, { ...ok, optionKey: "Z" }), { ok: false, code: "OPTION_INVALID" });
  });

  test("non-members are rejected before anything else", () => {
    assert.deepEqual(decideAnswer(question, undefined, { ...ok, isMember: false }), { ok: false, code: "FORBIDDEN" });
  });

  test("answers during a pause return GAME_PAUSED", () => {
    assert.deepEqual(decideAnswer({ ...question, phase: "PAUSED" }, undefined, ok), { ok: false, code: "GAME_PAUSED" });
  });

  test("early reveal requires every connected player to have answered", () => {
    assert.equal(shouldRevealEarly(["a", "b"], new Set(["a"])), false);
    assert.equal(shouldRevealEarly(["a", "b"], new Set(["a", "b"])), true);
  });

  test("early reveal ignores answers from players who are not connected", () => {
    assert.equal(shouldRevealEarly(["a"], new Set(["a", "gone"])), true);
  });

  test("no connected players never triggers an early reveal", () => {
    assert.equal(shouldRevealEarly([], new Set()), false);
  });
});

describe("room codes", () => {
  test("codes are 6 characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateRoomCode();
      assert.ok(isValidRoomCode(code), code);
    }
  });

  test("the alphabet excludes O, 0, I and 1", () => {
    for (const ch of ["O", "0", "I", "1"]) assert.equal(ROOM_CODE_ALPHABET.includes(ch), false);
  });

  test("allocation skips active codes", () => {
    const taken = new Set(["AAAAAA"]);
    const sequence = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
    let i = 0;
    const code = allocateRoomCode((c) => taken.has(c), 10, () => sequence[i++ % sequence.length]);
    assert.equal(code, "BBBBBB");
  });

  test("allocation fails loudly when every attempt collides", () => {
    assert.throws(() => allocateRoomCode(() => true, 3), /unique room code/);
  });
});
