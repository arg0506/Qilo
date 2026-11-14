import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import 'models.dart';
import 'scoring.dart';

enum GamePhase { lobby, question, reveal, scoreboard, finished }

// Local stand-in for the authoritative server. It follows the lifecycle and
// rules in the spec (early reveal when all connected players answer, timeouts
// score zero, first answer locks, tie-breaks by score, correct count, time,
// streak). Swap for the realtime repository when the gateway exists.
class GameController extends ChangeNotifier {
  GameController({
    required this.questions,
    required List<Player> players,
    required this.localPlayerId,
    this.questionDuration = const Duration(seconds: 20),
    this.hostPaced = false,
    this.revealDuration = const Duration(seconds: 4),
    this.scoreboardDuration = const Duration(seconds: 4),
    DateTime Function()? clock,
    math.Random? random,
    Timer Function(Duration, void Function(Timer))? scheduler,
  })  : _clock = clock ?? DateTime.now,
        _random = random ?? math.Random(),
        _scores = {for (final p in players) p.id: PlayerScore(player: p)},
        _order = players.map((p) => p.id).toList() {
    _ticker = (scheduler ?? Timer.periodic)(
      const Duration(milliseconds: 100),
      (_) => advance(),
    );
  }

  final List<Question> questions;
  final String localPlayerId;
  final Duration questionDuration;
  final bool hostPaced;
  final Duration revealDuration;
  final Duration scoreboardDuration;

  final DateTime Function() _clock;
  final math.Random _random;
  final Map<String, PlayerScore> _scores;
  final List<String> _order;
  late final Timer _ticker;

  GamePhase _phase = GamePhase.lobby;
  int _questionIndex = 0;
  DateTime _questionStartedAt = DateTime.now();
  DateTime _deadlineAt = DateTime.now();
  DateTime _phaseEndsAt = DateTime.now();
  final Map<String, _Answer> _answers = {};
  final Map<String, DateTime> _botAnswerAt = {};
  List<int> _distribution = const [];
  bool _advanceRequested = false;

  GamePhase get phase => _phase;
  int get questionIndex => _questionIndex;
  Question get currentQuestion => questions[_questionIndex];
  int get questionCount => questions.length;
  List<PlayerScore> get scores => _order.map((id) => _scores[id]!).toList();
  PlayerScore get localScore => _scores[localPlayerId]!;
  List<int> get distribution => _distribution;
  bool get localAnswered => _answers.containsKey(localPlayerId);
  int? get localAnswerIndex => _answers[localPlayerId]?.optionIndex;
  bool get canAdvance => hostPaced && _phase == GamePhase.scoreboard;

  Duration get remaining {
    final end = switch (_phase) {
      GamePhase.question => _deadlineAt,
      GamePhase.reveal || GamePhase.scoreboard => _phaseEndsAt,
      _ => null,
    };
    if (end == null) return Duration.zero;
    final left = end.difference(_clock());
    return left.isNegative ? Duration.zero : left;
  }

  double get questionProgress {
    if (_phase != GamePhase.question) return 0;
    final total = questionDuration.inMilliseconds;
    return (remaining.inMilliseconds / total).clamp(0.0, 1.0);
  }

  int get answeredCount => _answers.length;

  void start() {
    if (_phase != GamePhase.lobby) return;
    _questionIndex = 0;
    _beginQuestion();
  }

  // Local player's answer. Returns false when rejected (already answered,
  // not in a question phase), matching the server's first-answer-locks rule.
  bool submit(int optionIndex) {
    if (_phase != GamePhase.question) return false;
    if (localAnswered) return false;
    if (optionIndex < 0 || optionIndex >= currentQuestion.options.length) return false;
    final now = _clock();
    if (now.isAfter(_deadlineAt)) return false;
    _answers[localPlayerId] = _Answer(optionIndex, now);
    _maybeEarlyLock();
    notifyListeners();
    return true;
  }

  void requestNext() {
    if (!canAdvance) return;
    _advanceRequested = true;
    advance();
  }

  // Drives every timed transition. Called by the ticker; tests call it directly.
  void advance() {
    final now = _clock();
    switch (_phase) {
      case GamePhase.question:
        _scheduleBotAnswers(now);
        if (!_maybeEarlyLock() && now.isAfter(_deadlineAt)) _lock();
      case GamePhase.reveal:
        if (!now.isBefore(_phaseEndsAt)) _enterScoreboard(now);
      case GamePhase.scoreboard:
        if (_advanceRequested || (!hostPaced && !now.isBefore(_phaseEndsAt))) {
          _advanceRequested = false;
          _nextQuestion();
        }
      case GamePhase.lobby:
      case GamePhase.finished:
        break;
    }
    notifyListeners();
  }

  void _beginQuestion() {
    _answers.clear();
    _botAnswerAt.clear();
    _distribution = List.filled(currentQuestion.options.length, 0);
    _questionStartedAt = _clock();
    _deadlineAt = _questionStartedAt.add(questionDuration);
    for (final score in _scores.values) {
      score.lastPoints = null;
      score.lastOptionIndex = null;
      score.lastCorrect = null;
    }
    for (final p in _scores.values.map((s) => s.player)) {
      if (!p.isBot) continue;
      final delayMs = 1500 + _random.nextInt(4500);
      _botAnswerAt[p.id] = _questionStartedAt.add(Duration(milliseconds: delayMs));
    }
    _phase = GamePhase.question;
    notifyListeners();
  }

  void _scheduleBotAnswers(DateTime now) {
    for (final entry in _botAnswerAt.entries.toList()) {
      if (now.isBefore(entry.value)) continue;
      _botAnswerAt.remove(entry.key);
      if (_answers.containsKey(entry.key)) continue;
      final options = currentQuestion.options.length;
      final correct = _random.nextDouble() < 0.7;
      final choice = correct
          ? currentQuestion.correctIndex
          : (currentQuestion.correctIndex + 1 + _random.nextInt(options - 1)) % options;
      _answers[entry.key] = _Answer(choice, entry.value);
    }
  }

  bool _maybeEarlyLock() {
    final connected = _scores.values.map((s) => s.player.id);
    final everyoneAnswered = connected.every(_answers.containsKey);
    if (_phase == GamePhase.question && everyoneAnswered) {
      _lock();
      return true;
    }
    return false;
  }

  void _lock() {
    final correct = currentQuestion.correctIndex;
    _distribution = List.filled(currentQuestion.options.length, 0);
    for (final id in _order) {
      final score = _scores[id]!;
      final answer = _answers[id];
      if (answer != null) _distribution[answer.optionIndex] += 1;

      final isCorrect = answer != null && answer.optionIndex == correct;
      final elapsed = answer == null
          ? questionDuration
          : answer.at.difference(_questionStartedAt);
      final result = scoreAnswer(
        correct: isCorrect,
        streakBefore: score.streak,
        elapsed: elapsed,
        duration: questionDuration,
      );

      score.lastPoints = result.total;
      score.lastOptionIndex = answer?.optionIndex;
      score.lastCorrect = isCorrect;
      score.totalScore += result.total;
      score.correctCount += isCorrect ? 1 : 0;
      score.totalAnswerTimeMs += isCorrect ? elapsed.inMilliseconds : 0;
      score.streak = result.streakAfter;
      score.longestStreak = math.max(score.longestStreak, score.streak);
    }
    _phase = GamePhase.reveal;
    _phaseEndsAt = _clock().add(revealDuration);
    notifyListeners();
  }

  void _enterScoreboard(DateTime now) {
    _rankAll();
    _phase = GamePhase.scoreboard;
    _phaseEndsAt = now.add(scoreboardDuration);
    notifyListeners();
  }

  void _nextQuestion() {
    if (_questionIndex + 1 >= questions.length) {
      _rankAll();
      _phase = GamePhase.finished;
      return;
    }
    _questionIndex += 1;
    _beginQuestion();
  }

  // Matches the server's comparator: total score, correct count, total answer
  // time (ascending), longest streak. Equal players share a rank.
  void _rankAll() {
    final sorted = scores.toList()..sort(_compareStandings);
    for (var i = 0; i < sorted.length; i++) {
      final tied = i > 0 && _compareStandings(sorted[i - 1], sorted[i]) == 0;
      sorted[i].rank = tied ? sorted[i - 1].rank : i + 1;
    }
  }

  static int _compareStandings(PlayerScore a, PlayerScore b) {
    final byScore = b.totalScore.compareTo(a.totalScore);
    if (byScore != 0) return byScore;
    final byCorrect = b.correctCount.compareTo(a.correctCount);
    if (byCorrect != 0) return byCorrect;
    final byTime = a.totalAnswerTimeMs.compareTo(b.totalAnswerTimeMs);
    if (byTime != 0) return byTime;
    return b.longestStreak.compareTo(a.longestStreak);
  }

  @override
  void dispose() {
    _ticker.cancel();
    super.dispose();
  }
}

class _Answer {
  const _Answer(this.optionIndex, this.at);
  final int optionIndex;
  final DateTime at;
}
