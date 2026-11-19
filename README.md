<p align="center">
  <img src="docs/assets/hero.svg" alt="Qilo: real-time multiplayer quiz battles" width="100%">
</p>

<p align="center">
  <img alt="Engine tests" src="https://img.shields.io/badge/engine%20tests-31%2F31%20passing-3DDC97?style=flat-square">
  <img alt="Flutter tests" src="https://img.shields.io/badge/flutter%20tests-13%2F13%20passing-3DDC97?style=flat-square">
  <img alt="Flutter" src="https://img.shields.io/badge/Flutter-3.x-9D7BFF?style=flat-square&logo=flutter&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-Node%2024-9D7BFF?style=flat-square&logo=typescript&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-A19CB3?style=flat-square">
</p>

# Qilo

**Qilo is a live, competitive quiz platform.** A host opens a room from a quiz and shares a 6-character code. Players join from their phones and answer against a timer that the server controls. The server checks each answer, scores it and publishes live standings, then shows the final results.

It is built for the moment a group wants to compete on knowledge *right now*: two friends on a sofa, a classroom on a projector, or a 500-person community event.

> **Name note:** the code and the product spec still use the working title **Quiz Arena** (package `quiz_arena`, `@quiz-arena/api`). Qilo is the repository name.

---

## Contents

- [Why Qilo](#why-qilo)
- [How a match works](#how-a-match-works)
- [Architecture](#architecture)
- [The game engine](#the-game-engine)
  - [Scoring: classic-v1](#scoring-classic-v1)
  - [Standings and tie-breaks](#standings-and-tie-breaks)
  - [Match lifecycle](#match-lifecycle)
  - [Answer acceptance](#answer-acceptance)
  - [Room codes](#room-codes)
- [The Flutter app](#the-flutter-app)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Project status](#project-status)
- [Roadmap](#roadmap)
- [Design decisions](#design-decisions)
- [Documentation](#documentation)
- [License](#license)

---

## Why Qilo

| Principle | What it means in practice |
|---|---|
| ⚡ **Start in seconds** | A player joins with a code and a name. No install wall and no account needed. |
| ⚖️ **Fair by construction** | The server owns timing, answer acceptance, scoring and ranking. Clients only display state and send intents. |
| 👀 **Clear at every moment** | Players always know the phase, the time left, their status and what comes next. |
| 📶 **Forgiving networks** | A brief disconnect never costs a player their seat, and offline players never hold a question open. |

---

## How a match works

<p align="center">
  <img src="docs/assets/screens.svg" alt="Player journey: splash, home, join, lobby, question and reveal, results" width="100%">
</p>

<sub>These are illustrations of the screens in <code>apps/mobile/lib/screens</code>, not device screenshots.</sub>

1. **Host** creates a room and gets a code like `K7PX3M`.
2. **Players** enter the code, appear in the lobby, and the host starts the game once at least 2 players are in.
3. Each **question** runs on a server deadline (20 s by default). The first answer a player submits is final.
4. The question **locks** at the deadline, or earlier if every connected player has answered. Then the correct answer, an explanation and the answer distribution are **revealed**.
5. A **scoreboard** shows the standings. The game moves on automatically, or waits for the host in *host-paced* mode.
6. After the last question, the **results** screen shows a podium and offers a rematch.

The planned realtime protocol for one question looks like this (event names from spec §12):

```mermaid
sequenceDiagram
    autonumber
    participant H as Host app
    participant S as Server (engine)
    participant P as Player app

    H->>S: host:start { roomId, idempotencyKey }
    S-->>P: game:starting { countdownEndsAt }
    S-->>P: question:started { prompt, options, startedAt, deadlineAt }
    Note over S,P: No answer key is sent to clients
    P->>S: answer:submit { matchQuestionId, optionKey, idempotencyKey }
    S-->>P: answer:accepted { acceptedAt, streak }
    S-->>H: question:progress { answeredCount, eligibleCount }
    Note over S: Deadline passes or every connected player answered
    S-->>P: question:revealed { correctOptionKeys, explanation, distribution }
    S-->>P: score:update { pointsEarned, breakdown, streak, totalScore }
    S-->>P: leaderboard:update { entries }
    H->>S: host:next (host-paced mode only)
```

---

## Architecture

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Architecture: Flutter app talks to a NestJS REST API and a Socket.IO gateway, both backed by the game engine, PostgreSQL and Redis" width="100%">
</p>

The project follows a **server-authoritative** model. The Flutter client keeps a copy of the scoring rules **for display and tests only**. The server is always the source of truth (spec §7.1).

The plan is to share contracts, not code. The Dart and TypeScript sides each implement the same rules, and both are checked against the same worked examples from the spec. Later, versioned schemas will be shared from `packages/api-contracts`.

---

## The game engine

`apps/api/src` holds a TypeScript engine with **no runtime dependencies**. Each rule lives in a small, pure function, so it is easy to test exhaustively before any transport is added.

| Module | File | Responsibility |
|---|---|---|
| Scoring | [`game/scoring.ts`](apps/api/src/game/scoring.ts) | `classic-v1` points: base, speed bonus, streak bonus |
| Standings | [`game/standings.ts`](apps/api/src/game/standings.ts) | Tie-break comparator and competition ranking |
| Lifecycle | [`game/lifecycle.ts`](apps/api/src/game/lifecycle.ts) | Room and match state machine with guarded transitions |
| Answer | [`game/answer.ts`](apps/api/src/game/answer.ts) | Answer acceptance, idempotency and early reveal |
| Room codes | [`room/room-code.ts`](apps/api/src/room/room-code.ts) | Secure 6-character codes with collision retry |

### Scoring: classic-v1

<p align="center">
  <img src="docs/assets/scoring.svg" alt="classic-v1 scoring: base 500, speed bonus up to 500, streak bonus up to 200, maximum 1200 per question" width="100%">
</p>

```text
correct     → 500 base
            + round(500 × (1 − elapsed ÷ duration))      speed bonus, 0 to 500
            + 50 × min(streak − 1, 4)                    streak bonus, 0 to 200
wrong/late  → 0 points, streak resets to 0
```

**Worked example (spec §8.4):** a player answers correctly 4 s into a 20 s question, and it is their third correct answer in a row. That gives `500 + 400 + 100 = 1,000` points. This exact case is a test on both the server and the client.

```ts
import { scoreAnswer } from "./game/scoring.ts";

scoreAnswer({
  correct: true,
  streakBefore: 2,
  startedAtMs: 0,
  receivedAtMs: 4_000,
  durationMs: 20_000,
});
// → { base: 500, speed: 400, streak: 100, total: 1000, streakAfter: 3 }
```

Every match stores its scoring-profile version, so old scores can always be explained.

### Standings and tie-breaks

Players are sorted by these keys, in order:

| # | Key | Direction |
|---|---|---|
| 1 | Total score | higher first |
| 2 | Correct answers | more first |
| 3 | Total answer time | faster first |
| 4 | Longest streak | longer first |

If players are still tied after all four keys, they **share the rank** and the next rank skips (`1, 1, 3`). The order in which answers arrived at the server is **never** used to break a tie.

### Match lifecycle

The server owns every transition. Clients only send commands. An invalid move throws `InvalidTransitionError`.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> CREATED
    CREATED --> LOBBY
    LOBBY --> STARTING
    LOBBY --> CANCELLED
    LOBBY --> EXPIRED
    STARTING --> QUESTION_ACTIVE
    QUESTION_ACTIVE --> QUESTION_LOCKED
    QUESTION_LOCKED --> ANSWER_REVEAL
    ANSWER_REVEAL --> SCOREBOARD
    SCOREBOARD --> NEXT_QUESTION
    SCOREBOARD --> PAUSED
    SCOREBOARD --> FINISHED
    NEXT_QUESTION --> QUESTION_ACTIVE
    NEXT_QUESTION --> PAUSED
    NEXT_QUESTION --> FINISHED
    PAUSED --> NEXT_QUESTION: resume
    FINISHED --> [*]
    CANCELLED --> [*]
    EXPIRED --> [*]
```

> **Not drawn, to keep the diagram readable:** the host can move the match to `ENDED_EARLY` from any in-match phase (`STARTING` through `PAUSED`). Pausing is allowed only *between* questions, and resuming always goes to the next question.

### Answer acceptance

Checks run in the order the spec gives (§12.2), so the same submission always gets the same error code:

```mermaid
flowchart TD
    A[answer:submit] --> B{Room member?}
    B -- no --> X1[FORBIDDEN]
    B -- yes --> C{Same idempotencyKey<br/>as accepted answer?}
    C -- yes --> OK2[✓ duplicate: return original result]
    C -- no --> D{Phase is PAUSED?}
    D -- yes --> X2[GAME_PAUSED]
    D -- no --> E{Phase is QUESTION_ACTIVE<br/>and before deadline?}
    E -- no --> X3[ANSWER_DEADLINE_PASSED]
    E -- yes --> F{Option exists<br/>on question?}
    F -- no --> X4[OPTION_INVALID]
    F -- yes --> G{Already answered?}
    G -- yes --> X5[ANSWER_ALREADY_SUBMITTED]
    G -- no --> OK[✓ accepted]

    classDef ok fill:#3DDC97,color:#0F0E12,stroke:none
    classDef bad fill:#FF5C7A,color:#0F0E12,stroke:none
    class OK,OK2 ok
    class X1,X2,X3,X4,X5 bad
```

- An answer received **exactly at** the deadline is accepted. One millisecond later, it is rejected.
- **Early reveal** (D-09) fires when every *currently connected* player has answered. Disconnected players never hold a question open.

### Room codes

- 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, which leaves out the easily confused **O/0** and **I/1**.
- Drawn from `node:crypto`'s `randomInt`, a cryptographically secure source.
- `allocateRoomCode` retries when a code collides with an active room. It throws instead of silently creating a duplicate when the code space is exhausted.

---

## The Flutter app

`apps/mobile` is a Flutter client for Android and iOS, with web planned for later. It is fully playable today against a **local mock game** (`GameController`) with bot players. The mock follows the same rules as the engine: first answer locks, early reveal, timeouts score zero, and the same tie-breaks.

| Area | Path | Notes |
|---|---|---|
| Screens | `lib/screens/` | splash, home, join, lobby, game (question, reveal, scoreboard), results |
| Design system | `lib/design/` | `tokens.dart`, `theme.dart`, reusable widgets |
| Game logic | `lib/game/` | `GameController`, models, scoring mirror, room codes, 5 starter questions |
| Tests | `test/game_logic_test.dart` | scoring, answer locking, deadlines, pacing modes, bots, room codes |

### Design tokens

| Token | Colour | Use |
|---|---|---|
| `background` | ![#0F0E12](https://placehold.co/14x14/0F0E12/0F0E12.png) `#0F0E12` | App background |
| `surface` | ![#1C1A21](https://placehold.co/14x14/1C1A21/1C1A21.png) `#1C1A21` | Cards and tiles |
| `accent` | ![#9D7BFF](https://placehold.co/14x14/9D7BFF/9D7BFF.png) `#9D7BFF` | Primary actions, highlights |
| `correct` | ![#3DDC97](https://placehold.co/14x14/3DDC97/3DDC97.png) `#3DDC97` | Correct answers |
| `incorrect` | ![#FF5C7A](https://placehold.co/14x14/FF5C7A/FF5C7A.png) `#FF5C7A` | Wrong answers |
| `warning` | ![#FFB84D](https://placehold.co/14x14/FFB84D/FFB84D.png) `#FFB84D` | Streaks, time running out |

Answer states are always shown with an **icon and a label as well as colour**, never colour alone. Touch targets are at least **56 dp** for answers and **44 dp** for other controls. Cards use a 28 px radius and buttons are pill-shaped, following the UI reference in [`docs/ui-reference`](docs/ui-reference).

---

## Repository layout

```text
qilo/
├── apps/
│   ├── api/                      # TypeScript game engine (server-authoritative)
│   │   ├── package.json
│   │   └── src/
│   │       ├── game/
│   │       │   ├── scoring.ts    # classic-v1
│   │       │   ├── standings.ts  # tie-breaks + ranking
│   │       │   ├── lifecycle.ts  # state machine
│   │       │   ├── answer.ts     # acceptance + early reveal
│   │       │   └── game.test.ts  # 31 tests
│   │       └── room/
│   │           └── room-code.ts
│   └── mobile/                   # Flutter client
│       ├── lib/
│       │   ├── design/           # tokens, theme, widgets
│       │   ├── game/             # controller, models, scoring mirror
│       │   ├── screens/          # 6 screens
│       │   └── main.dart
│       └── test/
├── docs/
│   ├── assets/                   # README illustrations (SVG)
│   ├── ui-reference/             # visual reference
│   └── Quiz_Arena_Complete_Product_and_Technical_Documentation_v1.1.docx
├── LICENSE
└── README.md
```

---

## Getting started

### Prerequisites

- **Node.js 24+** for the engine. It runs TypeScript directly, with no build step and no dependencies.
- **Flutter 3.x** (Dart SDK `^3.13.7`) for the mobile app.

### Run the engine tests

```bash
cd apps/api
npm test            # node --test src/**/*.test.ts
```

On Node 22, you can run the same tests with `node --experimental-strip-types --test src/**/*.test.ts`.

### Run the mobile app

```bash
cd apps/mobile
flutter pub get
flutter test        # 13 tests
flutter run         # pick a device or emulator
```

> **Tip:** when you set up the Flutter SDK for the first time, run Flutter from a folder that is *not* this project's root. The tool runs `pub upgrade` in the current directory.

---

## Project status

| Check | Result |
|---|---|
| Engine tests (`apps/api`, `npm test`) | ✅ 31 of 31 pass |
| Flutter tests (`apps/mobile`, `flutter test`) | ✅ 13 of 13 pass |
| Flutter analyzer | ✅ No issues |
| Flutter web build (`flutter build web`) | ✅ Builds |
| Android, iOS, Windows builds | ⏳ Not yet verified |
| On-device visual pass against the reference | ⏳ Not yet done |

---

## Roadmap

Following the implementation order in spec §18.1:

- [x] Scoring module and state machine, with exhaustive unit tests, before any UI
- [x] Flutter design system and screens for lobby, gameplay, reveal and results
- [x] Local mock game with bots, both pacing modes, mirrored rules
- [ ] NestJS REST API and Socket.IO realtime gateway
- [ ] Realtime repository in the Flutter app (replacing the mock)
- [ ] PostgreSQL persistence, Redis room state and presence, auth (guest to account)
- [ ] Full match with 3 to 5 test clients in both pacing modes
- [ ] Reconnect, host-absence handling, observability, load tests, security controls
- [ ] Quiz library and editor (M1), Big Screen display view, reporting
- [ ] Closed beta

---

## Design decisions

These come from the v1.1 spec's decision log.

| ID | Decision |
|---|---|
| **D-05** | Host commands travel over the socket, not REST. The lobby UI is already wired for this. |
| **D-07** | A player's first accepted answer is final. A different second answer is rejected. |
| **D-09** | A question reveals early once every *connected* player has answered. |
| **D-13** | Scoring is `classic-v1` (see [Scoring](#scoring-classic-v1)), stored per match. Changing a profile never alters past results. |
| **D-14** | Automatic pacing is the default. Host-paced mode is available to every host and recommended for events and classrooms. |
| **D-15** | If the host drops: 60 s grace, then up to 5 minutes `PAUSED`, then `ENDED_EARLY` with partial results. *(Planned, not built.)* |
| **D-16** | Options are shuffled once per match, in the same order for everyone, with canonical option keys. *(Planned, not built.)* |
| §8.5 | Tie-breaks never use arrival order. Fully tied players share a rank. |

---

## Documentation

- 📘 **Product and technical spec v1.1:** [`docs/Quiz_Arena_Complete_Product_and_Technical_Documentation_v1.1.docx`](docs/Quiz_Arena_Complete_Product_and_Technical_Documentation_v1.1.docx). It covers personas, the screen inventory, the lifecycle, scoring, the data model, REST and realtime contracts, security, fair play, the test plan and release operations.
- 🎨 **UI reference:** [`docs/ui-reference/`](docs/ui-reference)

---

## License

[MIT](LICENSE) © 2026 Arpan Roy
