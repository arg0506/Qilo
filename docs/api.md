# Qilo REST API (v1)

Base path: `/api/v1`. JSON in and out. Live host commands do **not** use REST: they go over the socket (see [realtime.md](realtime.md), decision D-05).

## Authentication

Every request that needs a user sends a Supabase access token:

```http
Authorization: Bearer <supabase access token>
```

| Who | How they get a token |
|---|---|
| Guest | `supabase.auth.signInAnonymously()` in the app. No email, no install wall. |
| Account | Any Supabase sign-in (email, OAuth). Upgrading a guest links an identity to the same Supabase user, so the user id and all history stay the same. |
| Moderator | An account whose Supabase user id is listed in `ADMIN_SUBJECTS`. |

The server never trusts a user id from the client. It verifies the token (HS256 secret or the project JWKS) and maps the `sub` claim to a Qilo user, creating the row on first use.

Auth levels used below: **none**, **optional** (token used if present), **user** (guest or account), **account** (not a guest), **host** (the room's host), **admin**.

## Errors

Every error has the same envelope (spec 11.2):

```json
{ "error": { "code": "ROOM_LOCKED", "message": "The host has locked this room.", "requestId": "4b1f…" } }
```

Clients branch on `code`, never on `message`. Validation errors add `details: [{ path, message }]`.

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Input failed validation. |
| `UNAUTHORIZED` | 401 | Missing, invalid or expired token. |
| `FORBIDDEN` | 403 | Not allowed (e.g. guest using an account feature, suspended user). |
| `NOT_FOUND` | 404 | No such resource, or not visible to you. |
| `ROOM_NOT_FOUND` | 404 | No active room has that code. |
| `ROOM_FULL` · `ROOM_LOCKED` · `ROOM_NOT_JOINABLE` · `GAME_ALREADY_STARTED` | 409 | Join refused. |
| `PLAYER_REMOVED` | 403 | The host removed you from this room. |
| `HOST_ONLY` | 403 | Only the host can do that. |
| `QUIZ_NOT_PUBLISHABLE` | 422 | `details.issues` lists problems, or `details.held` means the quiz is held for review. |
| `MEDIA_REJECTED` | 422 | Wrong type, too large, or bytes do not match the declared type. |
| `RATE_LIMITED` | 429 | `details.retryAfterSeconds` says when to retry. |
| `INTERNAL_ERROR` | 500 | Our fault. Quote the `requestId`. |

## Endpoints

### Health

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness. |
| `GET /health/ready` | none | Database and Redis checks. |

### Identity and profile

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /auth/guest` | user | Register the guest session; optional `{ "displayName" }`. |
| `POST /auth/upgrade` | user | Call with the refreshed token after linking an identity in Supabase. Marks the user as an account. |
| `GET /me` | user | Current profile. |
| `PATCH /me` | user | `{ displayName?, avatarUrl? }`. Avatar must be your own completed upload. |
| `GET /me/matches?limit&offset` | account | Completed matches with rank and score (MVP-14). |
| `GET /me/export` | account | Everything Qilo holds about you, as JSON. |
| `DELETE /me` | user | Deletes the account: profile anonymized, unplayed quizzes deleted, played quizzes archived, uploads removed, Supabase user deleted. |

### Quizzes

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /quizzes?scope=mine\|starter\|all&limit&offset` | optional | Your quizzes and the starter quizzes. |
| `POST /quizzes` | account | Create a draft. |
| `GET /quizzes/:id` | optional | Metadata and current version. Owners also get the draft questions with answer keys. |
| `PATCH /quizzes/:id` | account (owner) | Update title, description, category, language, visibility, cover, settings. |
| `POST /quizzes/:id/archive` | account (owner) | Archive. Running matches are unaffected. |
| `POST /quizzes/:id/questions` | account (owner) | Add a question (optional `position` to insert). |
| `POST /quizzes/:id/questions/reorder` | account (owner) | `{ "questionIds": [...] }` in the new order. |
| `PATCH /questions/:id` | account (owner) | Update a draft question. |
| `DELETE /questions/:id` | account (owner) | Remove a draft question. |
| `POST /quizzes/:id/publish` | account (owner) | Validate and create the next immutable version. |
| `POST /quizzes/:id/preview` | account (owner) | Practice session data for the current draft (with answer keys). Creates nothing. |

Question body:

```json
{
  "type": "mcq",
  "prompt": "Which planet is known as the Red Planet?",
  "options": [{ "key": "A", "label": "Venus" }, { "key": "B", "label": "Mars" }],
  "correctOptionKey": "B",
  "explanation": "Iron oxide on the surface gives Mars its red colour.",
  "durationSeconds": 20,
  "mediaUrl": null
}
```

Rules: `mcq` has 2 to 6 options, `true_false` exactly 2, `image_mcq` 2 to 4 and needs `mediaUrl`. Option keys are `A` to `F`. Timer override is 5 to 120 seconds. Quiz settings: `questionDurationSeconds` (default 20), `shuffleQuestions`, `shuffleOptions`, `scoringProfile: "classic-v1"`.

Publishing screens the text for prohibited terms and personal data (emails, phone numbers). A match holds the quiz for moderator review and returns `QUIZ_NOT_PUBLISHABLE` with `details.held = true`.

### Media

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /media/uploads` | user (account for quiz images) | `{ purpose: "question"\|"cover"\|"avatar", mimeType, sizeBytes }` → `{ uploadId, uploadUrl, token, path, method: "PUT" }`. |
| `POST /media/uploads/:id/complete` | user | Server checks real size and file signature, then returns `{ url }`. |

PNG, JPEG, WebP and GIF only. 5 MB for quiz images and covers, 2 MB for avatars. With Supabase configured, upload with `supabase.storage.from(bucket).uploadToSignedUrl(path, token, file)`.

### Rooms

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /rooms` | user | Create a room from a published quiz. Returns `{ roomId, code, resumeToken, snapshot }`. |
| `POST /rooms/join` | user | `{ code, displayName? }` → `{ roomId, code, resumeToken, snapshot }`. |
| `GET /rooms/:id` | member | Current snapshot. |
| `POST /rooms/:id/rematch` | host | `{ quizVersion: "same"\|"latest", pacing?, settings? }`. New linked room; connected players get `room:rematch`. |
| `POST /rooms/:id/display-tokens` | host | Big Screen token, shown once: `{ tokenId, displayToken }`. |
| `DELETE /rooms/:id/display-tokens/:tokenId` | host | Revoke. Connected screens are dropped. |

Create body (spec 11.1):

```json
{
  "quizId": "uuid",
  "pacing": "automatic",
  "visibility": "private",
  "maxPlayers": 20,
  "displayName": "Arpan",
  "settings": {
    "questionDurationSeconds": null,
    "shuffleQuestions": false,
    "shuffleOptions": true,
    "lateJoin": false,
    "revealSeconds": 5,
    "scoreboardSeconds": 5
  }
}
```

`quizVersionId` can replace `quizId` to pin a version. `questionDurationSeconds: null` keeps each question's own timer. Reveal and scoreboard are 3 to 15 seconds. `maxPlayers` is capped at 50 in beta.

Join checks run in this order: code format, lockout, room exists, removed (`PLAYER_REMOVED`), rejoin (same seat, new resume token), started (`GAME_ALREADY_STARTED` unless late join is on), locked (`ROOM_LOCKED`), full (`ROOM_FULL`). Codes are case-insensitive; spaces and dashes are ignored. Repeated invalid codes lock the caller out for 15 minutes.

### Matches

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /matches/:id` | participant or host | Persisted final standings, `me` (rank, score, accuracy, longest streak) and a per-question review with your answer. `match.isPartial` is true for ended-early matches. |

### Reports and moderation

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /reports` | user | `{ targetType: "quiz"\|"player"\|"room", targetId, reason, details? }`. Reasons: `harassment`, `hate`, `sexual`, `violence`, `personal_data`, `cheating`, `spam`, `other`. |
| `GET /admin/reports?status=open` | admin | Queue, safety reports first, with `slaDueAt` and `overdue`. |
| `POST /admin/reports/:id/resolve` | admin | `{ action: "dismiss"\|"no_action"\|"remove_quiz"\|"ban_host"\|"suspend_user", note? }`. |
| `GET /admin/audit?limit` | admin | Recent audit events. |

Safety reasons (harassment, hate, sexual, violence, personal data) get a 2-business-day first review target; others 7 days.

## Rate limits

Shared across instances through Redis. Room creation 10 per 10 minutes, joins 30 per minute, answers 30 per 10 seconds, host commands 60 per minute, reports 10 per hour, profile changes 20 per 10 minutes, socket connections 30 per minute per IP. Invalid join codes: 8 failures lock an identity out for 15 minutes; an IP needs 60, so one guesser cannot lock out a classroom behind one NAT.
