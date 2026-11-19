# Qilo realtime protocol (v1)

Socket.IO, namespace **`/game`**. The server is authoritative for timing, answers, scoring and ranking. Clients render state and send intents (spec 7.1, 8.1).

## Connecting

```js
const socket = io("https://api.example.com/game", {
  transports: ["websocket"],
  auth: { token: supabaseAccessToken },   // players and hosts
  // auth: { displayToken },              // Big Screen: read-only
});
```

A connection without valid credentials is refused with a `connect_error` whose `data` is the standard error body (`UNAUTHORIZED`).

## Envelope

Every server event carries:

```json
{ "protocolVersion": 1, "eventId": "uuid", "roomId": "uuid", "...": "event fields" }
```

Every client command is sent with an acknowledgement callback (`emitWithAck`) and gets back:

```json
{ "ok": true, "data": { } }
{ "ok": false, "error": { "code": "HOST_ONLY", "message": "Only the host can do that." } }
```

Host commands and answers carry an `idempotencyKey` (8 to 100 characters, a UUID is ideal). Sending the same key again returns the original result instead of running the command twice.

## Client → server

| Event | Payload | Who | Notes |
|---|---|---|---|
| `room:join` | `{ roomId, resumeToken, protocolVersion }` | member | Use the token from `POST /rooms` or `/rooms/join`. Acks with `{ snapshot }` and also emits `room:snapshot`. Use it again after any reconnect. |
| `room:sync` | `{ roomId }` | member, display | Fresh snapshot on demand. |
| `room:leave` | `{ roomId }` | member | Leaves voluntarily. A host leaving closes the room. |
| `player:ready` | `{ roomId, ready }` | member | Optional readiness in the lobby. |
| `answer:submit` | `{ roomId, matchQuestionId, optionKey, idempotencyKey }` | member | `optionKey` is the canonical key (`A`…`F`), never the display position. |
| `host:start` | `{ roomId, idempotencyKey }` | host | Needs at least 2 players. |
| `host:next` | `{ roomId, idempotencyKey }` | host | Host-paced mode, from the scoreboard. |
| `host:pause` | `{ roomId, idempotencyKey }` | host | The open question runs to its deadline and is revealed, then the game waits. |
| `host:resume` | `{ roomId, idempotencyKey }` | host | Starts the next question (or finishes). |
| `host:lock` | `{ roomId, locked, idempotencyKey }` | host | A locked room accepts no new players. |
| `host:remove` | `{ roomId, playerId, idempotencyKey }` | host | Revokes the player's seat and resume token for this room's life. |
| `host:close` | `{ roomId, idempotencyKey }` | host | Lobby → `CANCELLED`; mid-match → `ENDED_EARLY` with partial results. |
| `display:subscribe` | `{ roomId, displayToken }` | anyone | Alternative to connecting with `auth.displayToken`. |

## Server → client

| Event | Audience | Payload |
|---|---|---|
| `room:snapshot` | the joining socket, Big Screen | `{ snapshot }` (see below) |
| `room:updated` | room + Big Screen | `{ changes }`: room fields (status, isLocked, hostPresence, pauseRequested, phaseEndsAt…) or `players` |
| `player:presence` | room + Big Screen | `{ playerId, state: CONNECTED \| RECONNECTING \| DISCONNECTED }` |
| `game:starting` | room + Big Screen | `{ matchId, questionCount, countdownEndsAt }` |
| `question:started` | room + Big Screen | `{ matchQuestionId, position, total, type, prompt, mediaUrl, options: [{ key, label }], durationMs, startedAt, deadlineAt, serverTime }`. **No answer key.** |
| `answer:accepted` | the submitting user only | `{ matchQuestionId, acceptedAt }` |
| `answer:rejected` | the submitting socket only | `{ code, message }` |
| `question:progress` | room + Big Screen | `{ matchQuestionId, answeredCount, eligibleCount }`. Aggregate only. |
| `question:revealed` | room + Big Screen | `{ matchQuestionId, position, correctOptionKeys, explanation, distribution, reason: "deadline" \| "all_answered", revealEndsAt }` |
| `score:update` | each user, privately | `{ matchQuestionId, playerId, optionKey, status: accepted \| timeout \| late, isCorrect, pointsEarned, breakdown: { base, speed, streak }, streak, totalScore, rank }` |
| `leaderboard:update` | room + Big Screen | `{ entries: [{ userId, displayName, rank, totalScore, correctCount, longestStreak, totalAnswerTimeMs }], position, questionCount, isLastQuestion, isFinal, scoreboardEndsAt, waitingForHost }` |
| `game:paused` | room + Big Screen | `{ reason: "host" \| "host_absent", resumeDeadlineAt }` |
| `game:resumed` | room + Big Screen | `{}` |
| `game:finished` | room + Big Screen | `{ matchId, completionReason: finished \| ended_early \| cancelled \| expired, results }` |
| `room:removed` | the removed user | `{ reason }` |
| `room:rematch` | each connected player | `{ newRoomId, code, hostName }`. Join with `POST /rooms/join`. |

`answer:accepted` deliberately carries no streak or correctness: either would reveal the answer before everyone else sees it. `score:update` arrives at reveal.

## Snapshot

Sent on join, on `room:sync`, and as the ack of `room:join`. After any reconnect the client redraws from it and never replays missed events (spec 12.3).

```json
{
  "serverTime": "…",
  "room": { "id", "code", "status", "pacing", "settings", "isLocked", "hostUserId", "hostPresence", "pauseRequested", "pauseReason", "phaseEndsAt", "rematchOfRoomId" },
  "quiz": { "title", "versionId" },
  "players": [{ "userId", "displayName", "role", "connectionState", "isReady", "joinedAt" }],
  "match": { "id", "status", "position", "questionCount", "completionReason" } | null,
  "currentQuestion": { "...as question:started" } | null,
  "reveal": { "...as question:revealed" } | null,
  "leaderboard": [ ... ],
  "me": { "userId", "totalScore", "streak", "rank", "answer": { "matchQuestionId", "optionKey", "acceptedAt", "isCorrect?", "pointsEarned?", "breakdown?" } | null } | null
}
```

`reveal` and the `isCorrect`/`pointsEarned` fields in `me.answer` appear only after the question has been revealed. The Big Screen gets `me: null`.

## Lifecycle

```
LOBBY → STARTING → QUESTION_ACTIVE → QUESTION_LOCKED → ANSWER_REVEAL → SCOREBOARD → NEXT_QUESTION → … → FINISHED
                                                                         ↘ PAUSED ↗
Terminal: FINISHED, CANCELLED (host closed the lobby), EXPIRED (lobby idle 30 min), ENDED_EARLY
```

- A question locks at `deadlineAt`, or as soon as every **connected** player has answered. Disconnected players never hold it open.
- Automatic pacing: reveal and scoreboard are timed (default 5 s each). Host-paced: the scoreboard waits for `host:next`.
- Use `phaseEndsAt` from `room:updated` or the snapshot to draw countdowns. Draw the question countdown from `deadlineAt` and `serverTime` (to correct for clock skew). The server alone decides whether an answer was in time.

## Reconnect and host absence

- A dropped socket moves the player to `RECONNECTING` for 60 s, then `DISCONNECTED`. The seat, score, streak and any accepted answer are kept until the room ends. Reconnect, then send `room:join` with the same resume token.
- If the host drops, the game keeps running for 60 s (host controls disabled; `hostPresence: "grace"`). It then pauses at the next scoreboard (`game:paused` with `reason: "host_absent"` and `resumeDeadlineAt`). If the host returns within 5 minutes, it resumes. Otherwise the match ends as `ENDED_EARLY` with partial results.

## Big Screen

Connect with `auth: { displayToken }` from `POST /rooms/:id/display-tokens`. The screen receives public events only: no `score:update`, no `answer:accepted`, no `me` in snapshots. It cannot send commands. Revoking the token drops connected screens.
