# Quiz Arena

A real-time multiplayer quiz platform. Specification: `Quiz_Arena_Complete_Product_and_Technical_Documentation_v1.1.docx` in the parent folder. UI reference: `.kombai/ui design/`.

## Layout

| Path | What it is | Status |
|---|---|---|
| `apps/api` | Authoritative game engine (TypeScript). Scoring (classic-v1), standings and tie-breaks, lifecycle state machine, answer acceptance, room codes. | Engine and tests done. REST and Socket.IO gateway next. |
| `apps/mobile` | Flutter client (Android, iOS, web later). Design system from the UI reference, splash, home, join, lobby, live game with reveal and scoreboard, results. | UI runs on a local mock game controller. Realtime repository next. |

The client mirrors the server's scoring for display and tests only. The server stays the source of truth (spec 7.1).

## Run the engine tests

```bash
cd apps/api
npm test
```

Requires Node 24 or newer. The engine has no dependencies.

## Run the mobile app

```bash
cd apps/mobile
flutter pub get
flutter test
flutter run
```

## Decisions applied

- Scoring, tie-breaks, streaks and timing rules follow the v1.1 spec (sections 8.3 to 8.9, decisions D-07, D-09, D-13, D-15, D-16).
- Host commands travel over the socket, not REST (D-05). The mobile lobby is wired for that; the transport is not connected yet.
- Design tokens (`apps/mobile/lib/design/tokens.dart`) are taken from the reference: charcoal surfaces, lavender accent, pill chips and large rounded cards.

## Status (verified)

| Check | Result |
|---|---|
| Engine tests (`apps/api`, `npm test`) | 31 of 31 pass |
| Flutter tests (`apps/mobile`, `flutter test`) | 13 of 13 pass |
| Flutter analyzer | No issues |
| Flutter web build (`flutter build web`) | Builds |

Not yet verified: Android, iOS and Windows builds (no Android SDK or Visual Studio here), and a visual pass on a device against the reference.

## Not built yet

- NestJS REST and Socket.IO gateway (the engine exists; the transport does not).
- Persistence (PostgreSQL), Redis room state, auth.
- Quiz library and editor (M1), Big Screen view, reporting.
- Realtime repository in the mobile app (currently a local mock).

## Local tooling

Flutter 3.47.9 is installed at `C:\Users\User\dev\flutter`, outside this repo. Run Flutter from a folder that is not the project root for first-time SDK setup, because the tool runs `pub upgrade` in the current directory.
