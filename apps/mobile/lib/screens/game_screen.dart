import 'package:flutter/material.dart';

import '../design/tokens.dart';
import '../design/widgets.dart';
import '../game/game_controller.dart';
import '../game/models.dart';
import 'results_screen.dart';

class GameScreen extends StatefulWidget {
  const GameScreen({
    super.key,
    required this.questions,
    required this.players,
    required this.localPlayerId,
    required this.hostPaced,
    required this.isHost,
  });

  final List<Question> questions;
  final List<Player> players;
  final String localPlayerId;
  final bool hostPaced;
  final bool isHost;

  @override
  State<GameScreen> createState() => _GameScreenState();
}

class _GameScreenState extends State<GameScreen> {
  late final GameController _game = GameController(
    questions: widget.questions,
    players: widget.players,
    localPlayerId: widget.localPlayerId,
    hostPaced: widget.hostPaced,
  )..start();

  bool _navigatedToResults = false;

  @override
  void dispose() {
    _game.dispose();
    super.dispose();
  }

  void _maybeShowResults() {
    if (_navigatedToResults) return;
    _navigatedToResults = true;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => ResultsScreen(
          standings: _game.scores,
          localPlayerId: widget.localPlayerId,
          questionCount: widget.questions.length,
          isHost: widget.isHost,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        _confirmLeave();
      },
      child: Scaffold(
        appBar: AppBar(
          leading: IconButton(
            tooltip: 'Leave game',
            icon: const Icon(Icons.close),
            onPressed: _confirmLeave,
          ),
          title: ListenableBuilder(
            listenable: _game,
            builder: (_, _) => Text(
              'Question ${_game.questionIndex + 1} of ${_game.questionCount}',
            ),
          ),
          centerTitle: true,
        ),
        body: SafeArea(
          child: ListenableBuilder(
            listenable: _game,
            builder: (context, _) {
              if (_game.phase == GamePhase.finished) {
                WidgetsBinding.instance.addPostFrameCallback((_) => _maybeShowResults());
              }
              return switch (_game.phase) {
                GamePhase.lobby => const SizedBox.shrink(),
                GamePhase.finished => const Center(child: CircularProgressIndicator()),
                GamePhase.question => _QuestionView(game: _game),
                GamePhase.reveal => _RevealView(game: _game),
                GamePhase.scoreboard => _ScoreboardView(game: _game, isHost: widget.isHost),
              };
            },
          ),
        ),
      ),
    );
  }

  Future<void> _confirmLeave() async {
    final leave = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: QA.surface,
        title: const Text('Leave this game?'),
        content: const Text('You will lose your seat and your score for this match.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Stay')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Leave')),
        ],
      ),
    );
    if (leave == true && mounted) Navigator.of(context).popUntil((r) => r.isFirst);
  }
}

class _TimerBar extends StatelessWidget {
  const _TimerBar({required this.game});

  final GameController game;

  @override
  Widget build(BuildContext context) {
    final seconds = (game.remaining.inMilliseconds / 1000).ceil();
    return Column(
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(QA.radiusPill),
          child: LinearProgressIndicator(
            value: game.questionProgress,
            minHeight: 8,
            backgroundColor: QA.surfaceHigh,
            color: seconds <= 5 ? QA.warning : QA.accent,
          ),
        ),
        const SizedBox(height: 8),
        Semantics(
          liveRegion: seconds <= 5,
          label: '$seconds seconds left',
          child: Text(
            '${seconds}s',
            style: Theme.of(context).textTheme.labelLarge?.copyWith(
                  color: seconds <= 5 ? QA.warning : QA.textMuted,
                ),
          ),
        ),
      ],
    );
  }
}

class _QuestionView extends StatelessWidget {
  const _QuestionView({required this.game});

  final GameController game;

  @override
  Widget build(BuildContext context) {
    final question = game.currentQuestion;
    final answered = game.localAnswered;
    final chosen = game.localAnswerIndex;
    final theme = Theme.of(context);

    return ListView(
      padding: const EdgeInsets.all(QA.gutter),
      children: [
        _TimerBar(game: game),
        const SizedBox(height: 20),
        Semantics(
          header: true,
          child: Text(question.prompt, style: theme.textTheme.headlineMedium),
        ),
        const SizedBox(height: 24),
        for (var i = 0; i < question.options.length; i++) ...[
          AnswerCard(
            letter: String.fromCharCode(65 + i),
            label: question.options[i],
            state: answered
                ? (i == chosen ? AnswerState.selected : AnswerState.dimmed)
                : AnswerState.idle,
            onTap: answered ? null : () => game.submit(i),
          ),
          const SizedBox(height: 12),
        ],
        const SizedBox(height: 8),
        Center(
          child: Text(
            answered
                ? 'Answer locked. Waiting for ${game.scores.length - game.answeredCount} moreâ€¦'
                : '${game.answeredCount} of ${game.scores.length} answered',
            style: theme.textTheme.bodyMedium?.copyWith(color: QA.textMuted),
          ),
        ),
      ],
    );
  }
}

class _RevealView extends StatelessWidget {
  const _RevealView({required this.game});

  final GameController game;

  @override
  Widget build(BuildContext context) {
    final question = game.currentQuestion;
    final local = game.localScore;
    final theme = Theme.of(context);
    final total = game.scores.length;
    final correctIndex = question.correctIndex;

    return ListView(
      padding: const EdgeInsets.all(QA.gutter),
      children: [
        SurfaceCard(
          child: Row(
            children: [
              Icon(
                local.lastCorrect == true ? Icons.check_circle : Icons.cancel,
                color: local.lastCorrect == true ? QA.correct : QA.incorrect,
                size: 34,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(
                  local.lastCorrect == true
                      ? 'Correct'
                      : (local.lastOptionIndex == null ? 'No answer' : 'Not this time'),
                  style: theme.textTheme.titleLarge,
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text('+${local.lastPoints ?? 0}', style: theme.textTheme.headlineMedium?.copyWith(color: QA.accent)),
                  if (local.streak >= 2)
                    Text('${local.streak} streak', style: const TextStyle(color: QA.textMuted)),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        Text(question.prompt, style: theme.textTheme.titleLarge),
        const SizedBox(height: 14),
        for (var i = 0; i < question.options.length; i++) ...[
          AnswerCard(
            letter: String.fromCharCode(65 + i),
            label: question.options[i],
            state: i == correctIndex
                ? AnswerState.correct
                : (i == game.localAnswerIndex ? AnswerState.incorrect : AnswerState.dimmed),
          ),
          const SizedBox(height: 10),
        ],
        const SizedBox(height: 12),
        SurfaceCard(
          child: Text(question.explanation, style: theme.textTheme.bodyLarge),
        ),
        const SizedBox(height: 20),
        Text('Answers', style: theme.textTheme.titleLarge),
        for (var i = 0; i < question.options.length; i++)
          DistributionBar(
            label: question.options[i],
            count: game.distribution[i],
            total: total,
            highlight: i == correctIndex,
          ),
      ],
    );
  }
}

class _ScoreboardView extends StatelessWidget {
  const _ScoreboardView({required this.game, required this.isHost});

  final GameController game;
  final bool isHost;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final ordered = [...game.scores]..sort((a, b) => b.totalScore.compareTo(a.totalScore));
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.all(QA.gutter),
            children: [
              Text('Standings', style: theme.textTheme.headlineMedium),
              const SizedBox(height: 16),
              for (final s in ordered)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _StandingRow(score: s, isLocal: s.player.id == game.localPlayerId),
                ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(QA.gutter, 0, QA.gutter, QA.gutter),
          child: game.canAdvance && isHost
              ? FilledButton(
                  onPressed: game.requestNext,
                  child: const Text('Next question'),
                )
              : Text(
                  game.canAdvance
                      ? 'Waiting for the hostâ€¦'
                      : 'Next question in ${(game.remaining.inMilliseconds / 1000).ceil()}s',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyLarge?.copyWith(color: QA.textMuted),
                ),
        ),
      ],
    );
  }
}

class _StandingRow extends StatelessWidget {
  const _StandingRow({required this.score, required this.isLocal});

  final PlayerScore score;
  final bool isLocal;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: isLocal ? QA.accent.withValues(alpha: 0.16) : QA.surface,
        borderRadius: BorderRadius.circular(QA.radiusTile),
        border: isLocal ? Border.all(color: QA.accent) : null,
      ),
      child: Row(
        children: [
          SizedBox(
            width: 28,
            child: Text(
              '${score.rank ?? '-'}',
              style: const TextStyle(fontWeight: FontWeight.w700, color: QA.textMuted),
            ),
          ),
          PlayerAvatar(initials: score.player.initials, color: Color(score.player.avatarColorValue), size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              isLocal ? '${score.player.name} (you)' : score.player.name,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          Text('${score.totalScore}', style: const TextStyle(fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }
}

