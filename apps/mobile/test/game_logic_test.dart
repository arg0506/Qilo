import 'dart:async';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:quiz_arena/game/game_controller.dart';
import 'package:quiz_arena/game/models.dart';
import 'package:quiz_arena/game/room_code.dart';
import 'package:quiz_arena/game/scoring.dart';

// Fake clock: each test steps time explicitly, so nothing depends on real delays.
class _FakeClock {
  DateTime now = DateTime(2026, 11, 13, 12);
  void elapse(Duration d) => now = now.add(d);
}

// The ticker is replaced with a no-op; tests call advance() directly.
Timer _noopScheduler(Duration _, void Function(Timer) _) => _NoopTimer();

class _NoopTimer implements Timer {
  @override
  void cancel() {}
  @override
  bool get isActive => false;
  @override
  int get tick => 0;
}

// Bot is deterministic: nextDouble() = 0 makes it answer correctly, and the
// delay draw is fixed by the underlying seeded generator.
class _BotRandom implements math.Random {
  final math.Random _seeded = math.Random(7);

  @override
  double nextDouble() => 0;
  @override
  int nextInt(int max) => _seeded.nextInt(max);
  @override
  bool nextBool() => _seeded.nextBool();
}

const _question = Question(
  prompt: 'Two plus two?',
  options: ['3', '4', '5'],
  correctIndex: 1,
  explanation: 'Basic arithmetic.',
);

const _duration = Duration(seconds: 20);

void main() {
  group('classic-v1 scoring (client mirror)', () {
    test('spec worked example totals 1000', () {
      final r = scoreAnswer(
        correct: true,
        streakBefore: 2,
        elapsed: const Duration(seconds: 4),
        duration: _duration,
      );
      expect(r.base, 500);
      expect(r.speed, 400);
      expect(r.streak, 100);
      expect(r.total, 1000);
      expect(r.streakAfter, 3);
    });

    test('a wrong answer scores zero and resets the streak', () {
      final r = scoreAnswer(
        correct: false,
        streakBefore: 4,
        elapsed: Duration.zero,
        duration: _duration,
      );
      expect(r.total, 0);
      expect(r.streakAfter, 0);
    });

    test('the maximum per correct answer is 1200 and the minimum is 500', () {
      final max = scoreAnswer(correct: true, streakBefore: 9, elapsed: Duration.zero, duration: _duration);
      final min = scoreAnswer(correct: true, streakBefore: 0, elapsed: _duration, duration: _duration);
      expect(max.total, 1200);
      expect(min.total, 500);
    });
  });

  group('GameController', () {
    late _FakeClock clock;

    GameController build({bool hostPaced = false, List<Question> questions = const [_question]}) {
      clock = _FakeClock();
      return GameController(
        questions: questions,
        players: const [
          Player(id: 'me', name: 'Me', avatarColorValue: 0xFF000000),
          Player(id: 'bot', name: 'Bot', avatarColorValue: 0xFF000000, isBot: true),
        ],
        localPlayerId: 'me',
        hostPaced: hostPaced,
        questionDuration: _duration,
        clock: () => clock.now,
        random: _BotRandom(),
        scheduler: _noopScheduler,
      );
    }

    test('the first answer locks; a second submission is rejected', () {
      final game = build()..start();
      expect(game.submit(1), isTrue);
      expect(game.submit(0), isFalse);
      expect(game.localAnswerIndex, 1);
    });

    test('an out-of-range option is rejected', () {
      final game = build()..start();
      expect(game.submit(7), isFalse);
      expect(game.localAnswered, isFalse);
    });

    test('answers after the deadline are rejected', () {
      final game = build()..start();
      clock.elapse(const Duration(seconds: 21));
      expect(game.submit(1), isFalse);
    });

    test('a fast correct answer scores 1000 once the question locks', () {
      final game = build()..start();
      game.submit(1); // at t = 0, so the full speed bonus applies
      // The bot answers within 6 s; once it has, everyone has answered and the
      // question locks early.
      clock.elapse(const Duration(seconds: 7));
      game.advance();
      expect(game.phase, GamePhase.reveal);
      expect(game.localScore.lastCorrect, isTrue);
      expect(game.localScore.lastPoints, 1000);
      expect(game.localScore.streak, 1);
    });

    test('a question with no answer at the deadline scores zero and breaks the streak', () {
      final game = build()..start();
      clock.elapse(const Duration(seconds: 21));
      game.advance();
      expect(game.phase, GamePhase.reveal);
      expect(game.localScore.lastPoints, 0);
      expect(game.localScore.lastOptionIndex, isNull);
      expect(game.localScore.streak, 0);
    });

    test('the reveal distribution counts only players who answered', () {
      final game = build()..start();
      game.submit(1);
      clock.elapse(const Duration(seconds: 7));
      game.advance();
      expect(game.distribution.fold<int>(0, (a, b) => a + b), 2);
      expect(game.distribution[1], 2);
    });

    test('automatic pacing moves through reveal and scoreboard and then finishes', () {
      final game = build()..start();
      clock.elapse(const Duration(seconds: 21));
      game.advance(); // reveal
      expect(game.phase, GamePhase.reveal);
      clock.elapse(const Duration(seconds: 5));
      game.advance(); // scoreboard
      expect(game.phase, GamePhase.scoreboard);
      clock.elapse(const Duration(seconds: 5));
      game.advance(); // one question only, so the match finishes
      expect(game.phase, GamePhase.finished);
    });

    test('host-paced mode waits for requestNext instead of timing out', () {
      final game = build(hostPaced: true)..start();
      clock.elapse(const Duration(seconds: 21));
      game.advance();
      clock.elapse(const Duration(seconds: 30));
      game.advance();
      expect(game.phase, GamePhase.scoreboard);
      expect(game.canAdvance, isTrue);
      game.requestNext();
      expect(game.phase, GamePhase.finished);
    });

    test('the bot answers correctly and outranks the player who did not answer', () {
      final game = build()..start();
      clock.elapse(const Duration(seconds: 21));
      game.advance();
      clock.elapse(const Duration(seconds: 5));
      game.advance();
      final me = game.scores.firstWhere((s) => s.player.id == 'me');
      final bot = game.scores.firstWhere((s) => s.player.id == 'bot');
      expect(me.totalScore, 0);
      expect(bot.totalScore, greaterThan(0));
      expect(bot.rank, 1);
      expect(me.rank, 2);
    });
  });

  group('room codes', () {
    test('codes are 6 characters from the unambiguous alphabet', () {
      for (var i = 0; i < 200; i++) {
        final code = generateRoomCode();
        expect(code.length, 6);
        for (final ch in code.split('')) {
          expect(roomCodeAlphabet.contains(ch), isTrue);
        }
        expect(RegExp('[O0I1]').hasMatch(code), isFalse);
      }
    });
  });
}

