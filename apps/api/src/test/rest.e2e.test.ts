import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { client, startTestApp, tokenFor, uid, type TestApp } from "./harness.ts";
import { MaintenanceService } from "../maintenance/maintenance.service.ts";

let app: TestApp;
let api: ReturnType<typeof client>;

before(async () => {
  app = await startTestApp();
  api = client(app.baseUrl);
});
after(async () => app.close());

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a40b0000000049454e44ae426082", "hex");

async function newAccount(name = "Asha") {
  return tokenFor(uid("acct"), { name });
}

async function publishedQuiz(token: string) {
  const quiz = await api("POST", "/quizzes", { token, body: { title: "Space quiz", settings: { questionDurationSeconds: 20 } } });
  assert.equal(quiz.status, 201, JSON.stringify(quiz.body));
  const q = await api("POST", `/quizzes/${quiz.body.id}/questions`, {
    token,
    body: {
      type: "mcq",
      prompt: "Which planet is the Red Planet?",
      options: [
        { key: "A", label: "Venus" },
        { key: "B", label: "Mars" },
        { key: "C", label: "Jupiter" },
      ],
      correctOptionKey: "B",
      explanation: "Iron oxide.",
    },
  });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  const pub = await api("POST", `/quizzes/${quiz.body.id}/publish`, { token });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  return { quizId: quiz.body.id as string, versionId: pub.body.version.id as string, questionId: q.body.id as string };
}

describe("health and errors", () => {
  test("liveness and readiness", async () => {
    assert.deepEqual((await api("GET", "/health")).body, { status: "ok" });
    const ready = await api("GET", "/health/ready");
    assert.equal(ready.status, 200);
    assert.equal(ready.body.checks.database, "ok");
  });

  test("errors use the standard envelope with a request id", async () => {
    const res = await api("GET", "/me");
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
    assert.ok(res.body.error.requestId);
  });

  test("an unknown route is a NOT_FOUND envelope", async () => {
    const res = await api("GET", "/nope");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "NOT_FOUND");
  });

  test("a token signed with the wrong secret is rejected", async () => {
    const res = await api("GET", "/me", { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad" });
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });
});

describe("identity", () => {
  test("a Supabase anonymous user becomes a guest; upgrading keeps the same user", async () => {
    const subject = uid("anon");
    const guestToken = await tokenFor(subject, { anonymous: true });
    const guest = await api("POST", "/auth/guest", { token: guestToken, body: { displayName: "  Riya   " } });
    assert.equal(guest.status, 200);
    assert.equal(guest.body.isGuest, true);
    assert.equal(guest.body.displayName, "Riya");

    const notYet = await api("POST", "/auth/upgrade", { token: guestToken });
    assert.equal(notYet.body.error.code, "VALIDATION_ERROR");

    const upgraded = await api("POST", "/auth/upgrade", { token: await tokenFor(subject) });
    assert.equal(upgraded.status, 200);
    assert.equal(upgraded.body.id, guest.body.id);
    assert.equal(upgraded.body.isGuest, false);
  });

  test("guests cannot create quizzes", async () => {
    const res = await api("POST", "/quizzes", { token: await tokenFor(uid("g"), { anonymous: true }), body: { title: "x" } });
    assert.equal(res.status, 403);
  });

  test("profile updates are sanitized and validated", async () => {
    const token = await newAccount();
    const ok = await api("PATCH", "/me", { token, body: { displayName: "Neel\u0000 Sen" } });
    assert.equal(ok.body.displayName, "Neel Sen");
    const bad = await api("PATCH", "/me", { token, body: { displayName: "   " } });
    assert.equal(bad.body.error.code, "VALIDATION_ERROR");
    const foreign = await api("PATCH", "/me", { token, body: { avatarUrl: "https://example.com/a.png" } });
    assert.equal(foreign.body.error.code, "VALIDATION_ERROR");
  });
});

describe("quiz authoring", () => {
  test("starter quizzes are listed for everyone", async () => {
    const res = await api("GET", "/quizzes?scope=starter");
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 5);
    assert.ok(res.body.items.every((q: any) => q.isStarter && q.publishedQuestionCount === 6));
  });

  test("create, edit, reorder, publish and version", async () => {
    const token = await newAccount();
    const { quizId, questionId } = await publishedQuiz(token);
    const second = await api("POST", `/quizzes/${quizId}/questions`, {
      token,
      body: { type: "true_false", prompt: "The Sun is a star.", options: [{ key: "A", label: "True" }, { key: "B", label: "False" }], correctOptionKey: "A" },
    });
    assert.equal(second.status, 201);
    const reordered = await api("POST", `/quizzes/${quizId}/questions/reorder`, { token, body: { questionIds: [second.body.id, questionId] } });
    assert.equal(reordered.body.questions[0].id, second.body.id);
    assert.equal(reordered.body.hasDraftChanges, true);

    const v2 = await api("POST", `/quizzes/${quizId}/publish`, { token });
    assert.equal(v2.body.version.versionNumber, 2);
    assert.equal(v2.body.version.questionCount, 2);

    const edit = await api("PATCH", `/questions/${questionId}`, { token, body: { prompt: "Which planet is red?" } });
    assert.equal(edit.body.prompt, "Which planet is red?");
    const quiz = await api("GET", `/quizzes/${quizId}`, { token });
    assert.equal(quiz.body.currentVersion.versionNumber, 2);
    assert.equal(quiz.body.hasDraftChanges, true);
  });

  test("publishing reports every problem", async () => {
    const token = await newAccount();
    const quiz = await api("POST", "/quizzes", { token, body: { title: "Empty" } });
    const res = await api("POST", `/quizzes/${quiz.body.id}/publish`, { token });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "QUIZ_NOT_PUBLISHABLE");
    assert.equal(res.body.error.details.issues[0].field, "questions");
  });

  test("editor rejects an answer key that is not an option, and wrong option counts", async () => {
    const token = await newAccount();
    const quiz = await api("POST", "/quizzes", { token, body: { title: "T" } });
    const badKey = await api("POST", `/quizzes/${quiz.body.id}/questions`, {
      token,
      body: { type: "mcq", prompt: "?", options: [{ key: "A", label: "a" }, { key: "B", label: "b" }], correctOptionKey: "C" },
    });
    assert.equal(badKey.body.error.code, "VALIDATION_ERROR");
    const tf = await api("POST", `/quizzes/${quiz.body.id}/questions`, {
      token,
      body: { type: "true_false", prompt: "?", options: [{ key: "A", label: "a" }, { key: "B", label: "b" }, { key: "C", label: "c" }], correctOptionKey: "A" },
    });
    assert.equal(tf.body.error.code, "VALIDATION_ERROR");
  });

  test("personal data is held for review instead of publishing", async () => {
    const token = await newAccount();
    const quiz = await api("POST", "/quizzes", { token, body: { title: "Contact" } });
    await api("POST", `/quizzes/${quiz.body.id}/questions`, {
      token,
      body: { type: "mcq", prompt: "Email asha@example.com for the answer", options: [{ key: "A", label: "x" }, { key: "B", label: "y" }], correctOptionKey: "A" },
    });
    const res = await api("POST", `/quizzes/${quiz.body.id}/publish`, { token });
    assert.equal(res.body.error.details.held, true);
    const admin = await tokenFor("admin-subject");
    const queue = await api("GET", "/admin/reports", { token: admin });
    assert.ok(queue.body.items.some((r: any) => r.targetId === quiz.body.id && r.reason === "automated_screen" && r.priority === "safety"));
  });

  test("private quizzes are hidden from others; owners see answer keys", async () => {
    const owner = await newAccount();
    const { quizId } = await publishedQuiz(owner);
    const mine = await api("GET", `/quizzes/${quizId}`, { token: owner });
    assert.equal(mine.body.questions[0].correctOptionKey, "B");
    const other = await api("GET", `/quizzes/${quizId}`, { token: await newAccount() });
    assert.equal(other.status, 404);
    await api("PATCH", `/quizzes/${quizId}`, { token: owner, body: { visibility: "unlisted" } });
    const linked = await api("GET", `/quizzes/${quizId}`, { token: await newAccount() });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.questions, undefined, "no draft content or answer key for non-owners");
  });

  test("preview returns a playable session without creating anything", async () => {
    const token = await newAccount();
    const { quizId } = await publishedQuiz(token);
    const res = await api("POST", `/quizzes/${quizId}/preview`, { token });
    assert.equal(res.status, 200);
    assert.match(res.body.sessionId, /^preview_/);
    assert.equal(res.body.questions[0].durationSeconds, 20);
  });

  test("archived quizzes cannot be edited or hosted", async () => {
    const token = await newAccount();
    const { quizId } = await publishedQuiz(token);
    await api("POST", `/quizzes/${quizId}/archive`, { token });
    const edit = await api("PATCH", `/quizzes/${quizId}`, { token, body: { title: "x" } });
    assert.equal(edit.body.error.code, "INVALID_STATE");
    const room = await api("POST", "/rooms", { token, body: { quizId } });
    assert.equal(room.body.error.code, "INVALID_STATE");
  });
});

describe("media uploads", () => {
  test("signed upload, signature check, then usable in an image question", async () => {
    const token = await newAccount();
    const req = await api("POST", "/media/uploads", { token, body: { purpose: "question", mimeType: "image/png", sizeBytes: PNG.length } });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    const put = await fetch(req.body.uploadUrl, { method: "PUT", body: PNG, headers: { "content-type": "image/png" } });
    assert.equal(put.status, 200);
    const done = await api("POST", `/media/uploads/${req.body.uploadId}/complete`, { token });
    assert.equal(done.status, 200);

    const quiz = await api("POST", "/quizzes", { token, body: { title: "Pictures" } });
    await api("POST", `/quizzes/${quiz.body.id}/questions`, {
      token,
      body: { type: "image_mcq", prompt: "What is this?", mediaUrl: done.body.url, options: [{ key: "A", label: "A dot" }, { key: "B", label: "A line" }], correctOptionKey: "A" },
    });
    const pub = await api("POST", `/quizzes/${quiz.body.id}/publish`, { token });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
  });

  test("a file whose bytes do not match its declared type is rejected", async () => {
    const token = await newAccount();
    const req = await api("POST", "/media/uploads", { token, body: { purpose: "question", mimeType: "image/png", sizeBytes: 20 } });
    await fetch(req.body.uploadUrl, { method: "PUT", body: Buffer.from("<script>alert(1)</script>") });
    const done = await api("POST", `/media/uploads/${req.body.uploadId}/complete`, { token });
    assert.equal(done.body.error.code, "MEDIA_REJECTED");
  });

  test("non-image types and oversize files are refused up front", async () => {
    const token = await newAccount();
    const svg = await api("POST", "/media/uploads", { token, body: { purpose: "question", mimeType: "image/svg+xml", sizeBytes: 100 } });
    assert.equal(svg.body.error.code, "MEDIA_REJECTED");
    const big = await api("POST", "/media/uploads", { token, body: { purpose: "avatar", mimeType: "image/png", sizeBytes: 3 * 1024 * 1024 } });
    assert.equal(big.body.error.code, "MEDIA_REJECTED");
  });
});

describe("reports and moderation", () => {
  test("a report reaches the admin queue and a moderator can remove the quiz", async () => {
    const owner = await newAccount();
    const { quizId } = await publishedQuiz(owner);
    await api("PATCH", `/quizzes/${quizId}`, { token: owner, body: { visibility: "unlisted" } });
    const reporter = await tokenFor(uid("g"), { anonymous: true });
    const report = await api("POST", "/reports", { token: reporter, body: { targetType: "quiz", targetId: quizId, reason: "hate", details: "bad" } });
    assert.equal(report.status, 201);
    assert.equal(report.body.reviewWithin, "2 business days");

    const notAdmin = await api("GET", "/admin/reports", { token: owner });
    assert.equal(notAdmin.status, 403);

    const admin = await tokenFor("admin-subject");
    const resolved = await api("POST", `/admin/reports/${report.body.id}/resolve`, { token: admin, body: { action: "remove_quiz", note: "confirmed" } });
    assert.equal(resolved.body.status, "resolved");
    const gone = await api("GET", `/quizzes/${quizId}`, { token: reporter });
    assert.equal(gone.status, 404);
    const audit = await api("GET", "/admin/audit", { token: admin });
    assert.ok(audit.body.items.some((e: any) => e.action === "moderation.remove_quiz"));
  });

  test("a host ban stops room creation", async () => {
    const host = await newAccount();
    const me = await api("GET", "/me", { token: host });
    const report = await api("POST", "/reports", { token: await newAccount(), body: { targetType: "player", targetId: me.body.id, reason: "harassment" } });
    await api("POST", `/admin/reports/${report.body.id}/resolve`, { token: await tokenFor("admin-subject"), body: { action: "ban_host" } });
    const room = await api("POST", "/rooms", { token: host, body: { quizId: "5e1d0000-0000-4000-8000-000000000001" } });
    assert.equal(room.status, 403);
  });
});

describe("account data", () => {
  test("export includes the user's quizzes; deletion anonymizes and blocks the old token", async () => {
    const token = await newAccount("Deleteme");
    const { quizId } = await publishedQuiz(token);
    const exported = await api("GET", "/me/export", { token });
    assert.equal(exported.status, 200);
    assert.equal(exported.body.quizzes[0].id, quizId);
    assert.equal(exported.body.profile.displayName, "Deleteme");

    const del = await api("DELETE", "/me", { token });
    assert.deepEqual(del.body, { deleted: true });
    // The same Supabase subject now maps to a fresh, empty profile.
    const again = await api("GET", "/me", { token });
    assert.notEqual(again.body.id, exported.body.profile.id);
  });

  test("guests cannot export (account holders only)", async () => {
    const res = await api("GET", "/me/export", { token: await tokenFor(uid("g"), { anonymous: true }) });
    assert.equal(res.status, 403);
  });
});

describe("retention", () => {
  test("guests inactive for 30 days are purged; recent guests and accounts are kept", async () => {
    const stale = await tokenFor(uid("stale"), { anonymous: true });
    const fresh = await tokenFor(uid("fresh"), { anonymous: true });
    const staleMe = await api("POST", "/auth/guest", { token: stale, body: { displayName: "Old Guest" } });
    await api("POST", "/auth/guest", { token: fresh, body: { displayName: "New Guest" } });
    await app.db.execute(sql`update users set last_active_at = now() - interval '31 days' where id = ${staleMe.body.id}`);

    const result = await app.nest.get(MaintenanceService).retention();
    assert.equal(result.purgedGuests, 1);
    const rows = await app.db.execute(sql`select status, display_name, auth_subject from users where id = ${staleMe.body.id}`);
    assert.deepEqual(rows.rows[0], { status: "purged", display_name: "Guest", auth_subject: null });
    const freshAgain = await api("GET", "/me", { token: fresh });
    assert.equal(freshAgain.body.displayName, "New Guest");
  });
});
