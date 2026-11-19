import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Player, client, sleep, startTestApp, tokenFor, uid, type TestApp } from "./harness.ts";

let app: TestApp;
let api: ReturnType<typeof client>;
const open: Player[] = [];

before(async () => {
  app = await startTestApp();
  api = client(app.baseUrl);
});
after(async () => {
  for (const p of open) p.close();
  await app.close();
});

const FRIDAY = "5e1d0000-0000-4000-8000-000000000001";

// Two-question quiz whose answer keys the test knows: Q1 -> B, Q2 -> A.
async function customQuiz(token: string, count = 2) {
  const quiz = await api("POST", "/quizzes", { token, body: { title: "Test quiz", settings: { shuffleOptions: false, questionDurationSeconds: 20 } } });
  for (let i = 0; i < count; i += 1) {
    const r = await api("POST", `/quizzes/${quiz.body.id}/questions`, {
      token,
      body: {
        type: "mcq",
        prompt: `Question ${i + 1}`,
        options: [
          { key: "A", label: `a${i}` },
          { key: "B", label: `b${i}` },
          { key: "C", label: `c${i}` },
        ],
        correctOptionKey: i % 2 === 0 ? "B" : "A",
        explanation: `Because ${i + 1}`,
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const pub = await api("POST", `/quizzes/${quiz.body.id}/publish`, { token });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  return quiz.body.id as string;
}
const KEY = (position: number) => (position % 2 === 0 ? "B" : "A");

async function connect(token: string) {
  const p = new Player(app.baseUrl, { token });
  open.push(p);
  await p.connected();
  return p;
}

async function hostRoom(opts: { quizCount?: number; pacing?: string; settings?: Record<string, unknown>; maxPlayers?: number } = {}) {
  const token = await tokenFor(uid("host"), { name: "Host" });
  const quizId = await customQuiz(token, opts.quizCount ?? 2);
  const res = await api("POST", "/rooms", {
    token,
    body: { quizId, pacing: opts.pacing ?? "automatic", maxPlayers: opts.maxPlayers ?? 20, settings: { revealSeconds: 5, scoreboardSeconds: 5, ...(opts.settings ?? {}) } },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const host = await connect(token);
  host.userId = res.body.snapshot.me.userId;
  const joined = await host.join(res.body.roomId, res.body.resumeToken);
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return { host, hostToken: token, roomId: res.body.roomId as string, code: res.body.code as string, quizId };
}

async function addPlayer(code: string, name: string, opts: { anonymous?: boolean } = {}) {
  const token = await tokenFor(uid("p"), { anonymous: opts.anonymous ?? true });
  const res = await api("POST", "/rooms/join", { token, body: { code, displayName: name } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const p = await connect(token);
  p.userId = res.body.snapshot.me.userId;
  const joined = await p.join(res.body.roomId, res.body.resumeToken);
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return Object.assign(p, { token });
}

const question = (p: Player, position: number) => p.waitFor("question:started", (q) => q.position === position);

describe("full match", () => {
  test("automatic pacing: three players play a match end to end with consistent results", async () => {
    const { host, roomId, code } = await hostRoom();
    const maya = await addPlayer(code, "Maya");
    const leo = await addPlayer(code, "Leo");
    await host.waitFor("room:updated", (u) => u.changes.players?.length === 3);

    const start = await host.host("host:start");
    assert.equal(start.ok, true, JSON.stringify(start));

    // Q1: host and Maya right (host faster), Leo wrong -> early reveal.
    const q1 = await question(host, 0);
    assert.equal(q1.total, 2);
    assert.equal(q1.correctOptionKeys, undefined, "no answer key before reveal");
    assert.ok((await host.answer(q1.matchQuestionId, KEY(0))).ok);
    await sleep(60);
    assert.ok((await maya.answer(q1.matchQuestionId, KEY(0))).ok);
    assert.ok((await leo.answer(q1.matchQuestionId, "C")).ok);
    const r1 = await host.waitFor("question:revealed", (r) => r.position === 0);
    assert.equal(r1.reason, "all_answered");
    assert.deepEqual(r1.correctOptionKeys, ["B"]);
    assert.deepEqual(r1.distribution, { A: 0, B: 2, C: 1 });
    const hostScore1 = await host.waitFor("score:update", (s) => s.matchQuestionId === q1.matchQuestionId);
    const leoScore1 = await leo.waitFor("score:update", (s) => s.matchQuestionId === q1.matchQuestionId);
    assert.equal(hostScore1.isCorrect, true);
    assert.equal(hostScore1.breakdown.base, 500);
    assert.ok(hostScore1.breakdown.speed > 400);
    assert.equal(leoScore1.pointsEarned, 0);
    assert.equal(leoScore1.streak, 0);

    // Q2: only the host answers (correct, 2nd in a row -> streak bonus 50); others time out.
    const q2 = await question(host, 1);
    assert.ok((await host.answer(q2.matchQuestionId, KEY(1))).ok);
    const r2 = await maya.waitFor("question:revealed", (r) => r.position === 1);
    assert.equal(r2.reason, "deadline");
    const hostScore2 = await host.waitFor("score:update", (s) => s.matchQuestionId === q2.matchQuestionId);
    assert.equal(hostScore2.breakdown.streak, 50);
    assert.equal(hostScore2.streak, 2);
    const mayaScore2 = await maya.waitFor("score:update", (s) => s.matchQuestionId === q2.matchQuestionId);
    assert.equal(mayaScore2.status, "timeout");
    assert.equal(mayaScore2.streak, 0);

    const finals = await Promise.all([host, maya, leo].map((p) => p.waitFor("game:finished")));
    // Final standings are identical for every player (spec 17.2).
    assert.deepEqual(finals[0].results, finals[1].results);
    assert.deepEqual(finals[1].results, finals[2].results);
    assert.equal(finals[0].completionReason, "finished");
    const ranks = finals[0].results.map((r: any) => [r.displayName, r.rank]);
    assert.deepEqual(ranks, [["Host", 1], ["Maya", 2], ["Leo", 3]]);

    // ...and match what was persisted.
    const summary = await api("GET", `/matches/${finals[0].matchId}`, { token: maya.token });
    assert.equal(summary.status, 200);
    assert.deepEqual(
      summary.body.results.map((r: any) => [r.userId, r.rank, r.totalScore]),
      finals[0].results.map((r: any) => [r.userId, r.rank, r.totalScore]),
    );
    assert.equal(summary.body.questions.length, 2);
    assert.equal(summary.body.questions[0].myAnswer.isCorrect, true);
    assert.equal(summary.body.me.accuracy, 0.5);
    assert.equal(summary.body.match.isPartial, false);

    // Nothing private leaked: no event before a reveal carried the answer key
    // or anyone's individual choice.
    for (const p of [host, maya, leo]) {
      for (const e of p.events) {
        if (["question:started", "question:progress", "answer:accepted"].includes(e.event)) {
          const text = JSON.stringify(e.payload);
          assert.ok(!text.includes("correctOptionKeys"), `${e.event} leaked the answer key`);
          assert.ok(!/"optionKey"|"isCorrect"|"pointsEarned"/.test(text), `${e.event} leaked a choice or score`);
        }
      }
      // A player only ever receives their own score:update.
      assert.ok(p.of("score:update").every((s) => s.playerId === p.userId));
    }
    void roomId;
  });

  test("host-paced: the scoreboard waits for the host, and only the host can advance", async () => {
    const { host, code } = await hostRoom({ pacing: "host_paced" });
    const p = await addPlayer(code, "Ana");
    await host.host("host:start");
    const q1 = await question(p, 0);
    await host.answer(q1.matchQuestionId, KEY(0));
    await p.answer(q1.matchQuestionId, KEY(0));
    const board = await p.waitFor("leaderboard:update", (l) => !l.isFinal);
    assert.equal(board.waitingForHost, true);
    await sleep(500);
    assert.equal(p.of("question:started").length, 1, "no automatic advance");

    const notHost = await p.emit("host:next", { roomId: p.roomId, idempotencyKey: randomUUID() });
    assert.equal(notHost.error.code, "HOST_ONLY");
    for (const cmd of ["host:pause", "host:lock", "host:close", "host:resume"]) {
      const res = await p.emit(cmd, { roomId: p.roomId, idempotencyKey: randomUUID(), locked: true });
      assert.equal(res.error.code, "HOST_ONLY", cmd);
    }
    const next = await host.host("host:next");
    assert.equal(next.ok, true, JSON.stringify(next));
    await question(p, 1);
  });
});

describe("answer rules", () => {
  test("first answer locks, duplicates are idempotent, invalid options and late answers are rejected", async () => {
    const { host, code } = await hostRoom({ settings: { questionDurationSeconds: 30 } });
    const p = await addPlayer(code, "Kofi");
    await host.host("host:start");
    const q1 = await question(p, 0);

    const bad = await p.answer(q1.matchQuestionId, "Z");
    assert.equal(bad.error.code, "OPTION_INVALID");
    assert.equal(p.last("answer:rejected").code, "OPTION_INVALID");

    const key = randomUUID();
    const first = await p.answer(q1.matchQuestionId, KEY(0), key);
    assert.equal(first.ok, true);
    const retry = await p.answer(q1.matchQuestionId, KEY(0), key);
    assert.equal(retry.ok, true);
    assert.equal(retry.data.duplicate, true);
    assert.equal(retry.data.acceptedAt, first.data.acceptedAt);
    const change = await p.answer(q1.matchQuestionId, "A");
    assert.equal(change.error.code, "ANSWER_ALREADY_SUBMITTED");

    // Let the deadline pass without the host answering.
    const revealed = await p.waitFor("question:revealed", (r) => r.position === 0);
    assert.equal(revealed.reason, "deadline");
    const late = await host.answer(q1.matchQuestionId, KEY(0));
    assert.equal(late.error.code, "ANSWER_DEADLINE_PASSED");

    // The duplicate did not award points twice.
    const score = await p.waitFor("score:update", (s) => s.matchQuestionId === q1.matchQuestionId);
    assert.ok(score.pointsEarned >= 500 && score.pointsEarned <= 1000);
    assert.equal(score.totalScore, score.pointsEarned);
  });

  test("simultaneous answers are both accepted and scored by server time", async () => {
    const { host, code } = await hostRoom();
    const a = await addPlayer(code, "Ana");
    const b = await addPlayer(code, "Ben");
    await host.host("host:start");
    const q = await question(a, 0);
    const [ra, rb] = await Promise.all([a.answer(q.matchQuestionId, KEY(0)), b.answer(q.matchQuestionId, KEY(0))]);
    assert.ok(ra.ok && rb.ok);
    await host.answer(q.matchQuestionId, "C");
    const [sa, sb] = await Promise.all([
      a.waitFor("score:update", (s) => s.matchQuestionId === q.matchQuestionId),
      b.waitFor("score:update", (s) => s.matchQuestionId === q.matchQuestionId),
    ]);
    const expected = (s: any) => 500 + s.breakdown.speed;
    assert.equal(sa.pointsEarned, expected(sa));
    assert.equal(sb.pointsEarned, expected(sb));
    assert.ok(Math.abs(sa.breakdown.speed - sb.breakdown.speed) <= 30, "near-simultaneous answers get near-equal speed bonus");
  });

  test("early reveal ignores players who have disconnected", async () => {
    const { host, code } = await hostRoom({ settings: { questionDurationSeconds: 60 } });
    const a = await addPlayer(code, "Ana");
    const gone = await addPlayer(code, "Gone");
    await host.host("host:start");
    const q = await question(a, 0);
    gone.close();
    await host.waitFor("player:presence", (e) => e.playerId === gone.userId && e.state === "RECONNECTING");
    await host.answer(q.matchQuestionId, KEY(0));
    await a.answer(q.matchQuestionId, KEY(0));
    const r = await a.waitFor("question:revealed", (x) => x.position === 0, 1500);
    assert.equal(r.reason, "all_answered");
  });
});

describe("reconnect", () => {
  test("a returning player gets a full snapshot with their accepted answer, score and streak", async () => {
    const { host, code } = await hostRoom({ quizCount: 3, settings: { questionDurationSeconds: 40 } });
    const p = await addPlayer(code, "Ravi");
    await host.host("host:start");
    const q1 = await question(p, 0);
    await p.answer(q1.matchQuestionId, KEY(0));
    await host.answer(q1.matchQuestionId, "C");
    await p.waitFor("score:update", (s) => s.matchQuestionId === q1.matchQuestionId);

    const q2 = await question(p, 1);
    const accepted = await p.answer(q2.matchQuestionId, KEY(1));
    p.close();
    await host.waitFor("player:presence", (e) => e.playerId === p.userId && e.state === "RECONNECTING");

    // Same identity, new socket, same resume token.
    const back = await connect(p.token);
    const joined = await back.join(p.roomId, p.resumeToken);
    assert.equal(joined.ok, true, JSON.stringify(joined));
    const snap = joined.data.snapshot;
    assert.equal(snap.room.status, "QUESTION_ACTIVE");
    assert.equal(snap.currentQuestion.matchQuestionId, q2.matchQuestionId);
    assert.equal(snap.currentQuestion.correctOptionKeys, undefined);
    assert.equal(snap.reveal, null);
    assert.equal(snap.me.answer.optionKey, KEY(1));
    assert.equal(snap.me.answer.acceptedAt, accepted.data.acceptedAt);
    assert.equal(snap.me.answer.isCorrect, undefined, "correctness stays private until reveal");
    assert.equal(snap.me.streak, 1);
    assert.ok(snap.me.totalScore >= 500);
    await host.waitFor("player:presence", (e) => e.playerId === p.userId && e.state === "CONNECTED");

    await host.answer(q2.matchQuestionId, "C");
    const s2 = await back.waitFor("score:update", (s) => s.matchQuestionId === q2.matchQuestionId);
    assert.equal(s2.streak, 2, "streak preserved across the reconnect");
  });

  test("after the grace period a player is DISCONNECTED but keeps the seat", async () => {
    const { host, code } = await hostRoom();
    const p = await addPlayer(code, "Mo");
    p.close();
    await host.waitFor("player:presence", (e) => e.playerId === p.userId && e.state === "DISCONNECTED", 3000);
    const back = await connect(p.token);
    assert.equal((await back.join(p.roomId, p.resumeToken)).ok, true);
  });

  test("a resume token never grants another identity's seat", async () => {
    const { code } = await hostRoom();
    const p = await addPlayer(code, "Owner");
    const thief = await connect(await tokenFor(uid("thief")));
    const res = await thief.join(p.roomId, p.resumeToken);
    assert.equal(res.error.code, "RESUME_TOKEN_INVALID");
  });
});

describe("lobby and joining", () => {
  test("join errors: unknown, locked, full, started, ended, removed", async () => {
    const guest = await tokenFor(uid("g"), { anonymous: true });
    assert.equal((await api("POST", "/rooms/join", { token: guest, body: { code: "ZZZZZZ" } })).body.error.code, "ROOM_NOT_FOUND");

    const locked = await hostRoom();
    assert.equal((await locked.host.host("host:lock", { locked: true })).ok, true);
    assert.equal((await api("POST", "/rooms/join", { token: guest, body: { code: locked.code } })).body.error.code, "ROOM_LOCKED");
    await locked.host.host("host:lock", { locked: false });
    const ok = await api("POST", "/rooms/join", { token: guest, body: { code: locked.code.toLowerCase() } });
    assert.equal(ok.status, 200, "codes are case-insensitive");

    const full = await hostRoom({ maxPlayers: 2 });
    await addPlayer(full.code, "One");
    assert.equal((await api("POST", "/rooms/join", { token: await tokenFor(uid("g")), body: { code: full.code } })).body.error.code, "ROOM_FULL");

    const started = await hostRoom();
    await addPlayer(started.code, "One");
    await started.host.host("host:start");
    assert.equal((await api("POST", "/rooms/join", { token: await tokenFor(uid("g")), body: { code: started.code } })).body.error.code, "GAME_ALREADY_STARTED");

    const closed = await hostRoom();
    await closed.host.host("host:close");
    await closed.host.waitFor("game:finished");
    assert.equal((await api("POST", "/rooms/join", { token: await tokenFor(uid("g")), body: { code: closed.code } })).body.error.code, "ROOM_NOT_JOINABLE");
  });

  test("a removed player is evicted and can rejoin neither by code nor by resume token", async () => {
    const { host, code } = await hostRoom();
    const p = await addPlayer(code, "Spammy");
    const res = await host.host("host:remove", { playerId: p.userId });
    assert.equal(res.ok, true, JSON.stringify(res));
    await p.waitFor("room:removed");
    assert.equal((await api("POST", "/rooms/join", { token: p.token, body: { code } })).body.error.code, "PLAYER_REMOVED");
    const again = await connect(p.token);
    assert.equal((await again.join(p.roomId, p.resumeToken)).error.code, "PLAYER_REMOVED");
    const players = host.last("room:updated").changes.players;
    assert.ok(!players.some((x: any) => x.userId === p.userId));
  });

  test("the host needs at least 2 players to start", async () => {
    const { host } = await hostRoom();
    const res = await host.host("host:start");
    assert.equal(res.error.code, "GAME_NOT_STARTABLE");
  });

  test("an inactive lobby expires", async () => {
    app.config.LOBBY_EXPIRY_MS = 300;
    try {
      const { host, code } = await hostRoom();
      const fin = await host.waitFor("game:finished", () => true, 3000);
      assert.equal(fin.completionReason, "expired");
      const res = await api("POST", "/rooms/join", { token: await tokenFor(uid("g")), body: { code } });
      assert.equal(res.body.error.code, "ROOM_NOT_JOINABLE");
    } finally {
      app.config.LOBBY_EXPIRY_MS = 1_800_000;
    }
  });

  test("repeated invalid codes lock the caller out", async () => {
    const token = await tokenFor(uid("guesser"));
    let last;
    for (let i = 0; i < 9; i += 1) last = await api("POST", "/rooms/join", { token, body: { code: "QQQQQQ" } });
    assert.equal(last!.body.error.code, "RATE_LIMITED");
  });

  test("late join: a late joiner sees the current question but scores nothing for it", async () => {
    const { host, code } = await hostRoom({ settings: { lateJoin: true, questionDurationSeconds: 40 } });
    const early = await addPlayer(code, "Early");
    await host.host("host:start");
    const q1 = await question(early, 0);
    const late = await addPlayer(code, "Late");
    const snap = late.last("room:snapshot").snapshot;
    assert.equal(snap.currentQuestion.matchQuestionId, q1.matchQuestionId);
    assert.ok((await late.answer(q1.matchQuestionId, KEY(0))).ok);
    await early.answer(q1.matchQuestionId, KEY(0));
    await host.answer(q1.matchQuestionId, KEY(0));
    const s = await late.waitFor("score:update", (x) => x.matchQuestionId === q1.matchQuestionId);
    assert.equal(s.pointsEarned, 0);
    assert.equal(s.status, "late");
    const q2 = await question(late, 1);
    await Promise.all([late, early, host].map((p) => p.answer(q2.matchQuestionId, KEY(1))));
    const s2 = await late.waitFor("score:update", (x) => x.matchQuestionId === q2.matchQuestionId);
    assert.ok(s2.pointsEarned >= 500, "scores from the next question");
  });
});

describe("host controls and absence", () => {
  test("pause lets the question finish, then waits; resume continues", async () => {
    const { host, code } = await hostRoom({ quizCount: 2 });
    const p = await addPlayer(code, "Zed");
    await host.host("host:start");
    const q1 = await question(p, 0);
    const pause = await host.host("host:pause");
    assert.equal(pause.ok, true);
    assert.equal(pause.data.status, "QUESTION_ACTIVE", "the open question keeps running");
    await p.answer(q1.matchQuestionId, KEY(0));
    await host.answer(q1.matchQuestionId, KEY(0));
    await p.waitFor("question:revealed", (r) => r.position === 0);
    const paused = await p.waitFor("game:paused");
    assert.equal(paused.reason, "host");
    await sleep(400);
    assert.equal(p.of("question:started").length, 1);
    const resumed = await host.host("host:resume");
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    await p.waitFor("game:resumed");
    await question(p, 1);
  });

  test("a host absent past grace and the 5-minute window ends the match early with partial results", async () => {
    const { host, code } = await hostRoom({ quizCount: 3 });
    const p = await addPlayer(code, "Pat");
    await host.host("host:start");
    const q1 = await question(p, 0);
    await host.answer(q1.matchQuestionId, KEY(0));
    host.close();
    // During grace the game keeps running.
    await p.waitFor("room:updated", (u) => u.changes.hostPresence === "grace");
    await p.answer(q1.matchQuestionId, KEY(0));
    await p.waitFor("question:revealed", (r) => r.position === 0);
    const paused = await p.waitFor("game:paused", () => true, 4000);
    assert.equal(paused.reason, "host_absent");
    assert.ok(paused.resumeDeadlineAt);
    const fin = await p.waitFor("game:finished", () => true, 4000);
    assert.equal(fin.completionReason, "ended_early");
    const summary = await api("GET", `/matches/${fin.matchId}`, { token: p.token });
    assert.equal(summary.body.match.isPartial, true);
    assert.equal(summary.body.match.completedQuestions, 1);
  });

  test("a host who returns within the window resumes the game", async () => {
    const { host, hostToken, code, roomId } = await hostRoom({ quizCount: 2 });
    const p = await addPlayer(code, "Pat");
    await host.host("host:start");
    const q1 = await question(p, 0);
    await host.answer(q1.matchQuestionId, KEY(0));
    const resume = host.resumeToken;
    host.close();
    await p.answer(q1.matchQuestionId, KEY(0));
    await p.waitFor("game:paused", (g) => g.reason === "host_absent", 4000);
    const back = await connect(hostToken);
    assert.equal((await back.join(roomId, resume)).ok, true);
    await p.waitFor("game:resumed");
    await question(p, 1);
  });
});

describe("rematch, Big Screen and history", () => {
  test("rematch creates a linked room and invites connected players", async () => {
    const { host, hostToken, code, roomId } = await hostRoom({ quizCount: 1 });
    const p = await addPlayer(code, "Ida", { anonymous: false });
    await host.host("host:start");
    const q = await question(p, 0);
    await Promise.all([host.answer(q.matchQuestionId, KEY(0)), p.answer(q.matchQuestionId, "C")]);
    const fin = await p.waitFor("game:finished");

    const notHost = await api("POST", `/rooms/${roomId}/rematch`, { token: p.token, body: {} });
    assert.equal(notHost.body.error.code, "HOST_ONLY");
    const rematch = await api("POST", `/rooms/${roomId}/rematch`, { token: hostToken, body: { quizVersion: "latest" } });
    assert.equal(rematch.status, 201, JSON.stringify(rematch.body));
    assert.equal(rematch.body.snapshot.room.rematchOfRoomId, roomId);
    const invite = await p.waitFor("room:rematch");
    assert.equal(invite.code, rematch.body.code);
    const joined = await api("POST", "/rooms/join", { token: p.token, body: { code: invite.code } });
    assert.equal(joined.status, 200);

    // The previous match's results are untouched.
    const old = await api("GET", `/matches/${fin.matchId}`, { token: p.token });
    assert.equal(old.body.results.length, 2);
    // Signed-in players see the match in their history.
    const history = await api("GET", "/me/matches", { token: p.token });
    assert.equal(history.body.items[0].matchId, fin.matchId);
    assert.equal(history.body.items[0].playerCount, 2);
  });

  test("the Big Screen sees public state only and cannot send commands; revoked tokens are refused", async () => {
    const { host, hostToken, code, roomId } = await hostRoom({ quizCount: 1 });
    const p = await addPlayer(code, "Bo");
    const tokenRes = await api("POST", `/rooms/${roomId}/display-tokens`, { token: hostToken });
    assert.equal(tokenRes.status, 201);
    const notHost = await api("POST", `/rooms/${roomId}/display-tokens`, { token: p.token });
    assert.equal(notHost.body.error.code, "HOST_ONLY");

    const screen = new Player(app.baseUrl, { displayToken: tokenRes.body.displayToken });
    open.push(screen);
    await screen.connected();
    const snap = await screen.waitFor("room:snapshot");
    assert.equal(snap.snapshot.me, null);
    const cmd = await screen.emit("host:start", { roomId, idempotencyKey: randomUUID() });
    assert.equal(cmd.error.code, "FORBIDDEN");
    const ans = await screen.emit("answer:submit", { roomId, matchQuestionId: randomUUID(), optionKey: "A", idempotencyKey: randomUUID() });
    assert.equal(ans.error.code, "FORBIDDEN");

    await host.host("host:start");
    const q = await screen.waitFor("question:started");
    await Promise.all([host.answer(q.matchQuestionId, KEY(0)), p.answer(q.matchQuestionId, KEY(0))]);
    await screen.waitFor("question:revealed");
    await screen.waitFor("game:finished");
    assert.equal(screen.of("score:update").length, 0);
    assert.equal(screen.of("answer:accepted").length, 0);
    assert.ok(screen.of("leaderboard:update").length > 0);

    const revoke = await api("DELETE", `/rooms/${roomId}/display-tokens/${tokenRes.body.tokenId}`, { token: hostToken });
    assert.equal(revoke.body.revoked, true);
    const again = new Player(app.baseUrl, { displayToken: tokenRes.body.displayToken });
    open.push(again);
    await assert.rejects(again.connected());
  });

  test("sockets without credentials are refused", async () => {
    const anon = new Player(app.baseUrl, {});
    open.push(anon);
    await assert.rejects(anon.connected());
  });
});
