import 'package:flutter/material.dart';

import '../design/tokens.dart';
import '../design/widgets.dart';
import '../game/models.dart';
import '../game/room_code.dart';
import 'lobby_screen.dart';

class ResultsScreen extends StatelessWidget {
  const ResultsScreen({
    super.key,
    required this.standings,
    required this.localPlayerId,
    required this.questionCount,
    required this.isHost,
  });

  final List<PlayerScore> standings;
  final String localPlayerId;
  final int questionCount;
  final bool isHost;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final ranked = [...standings]
      ..sort((a, b) => (a.rank ?? 999).compareTo(b.rank ?? 999));
    final local = ranked.firstWhere((s) => s.player.id == localPlayerId);
    final top = ranked.take(3).toList();
    final rest = ranked.skip(3).toList();

    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        title: const Text('Results'),
        centerTitle: true,
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(QA.gutter),
          children: [
            Text('You finished #${local.rank}', style: theme.textTheme.displayLarge?.copyWith(fontSize: 44)),
            const SizedBox(height: 8),
            Text(
              '${local.totalScore} points · ${local.correctCount} of $questionCount correct · best streak ${local.longestStreak}',
              style: theme.textTheme.bodyLarge?.copyWith(color: QA.textMuted),
            ),
            const SizedBox(height: 24),
            _Podium(top: top),
            const SizedBox(height: 24),
            if (rest.isNotEmpty) ...[
              Text('Everyone else', style: theme.textTheme.titleLarge),
              const SizedBox(height: 12),
              for (final s in rest)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: SurfaceCard(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    child: Row(
                      children: [
                        SizedBox(
                          width: 28,
                          child: Text('${s.rank}', style: const TextStyle(color: QA.textMuted, fontWeight: FontWeight.w700)),
                        ),
                        Expanded(child: Text(s.player.name, style: const TextStyle(fontWeight: FontWeight.w600))),
                        Text('${s.totalScore}', style: const TextStyle(fontWeight: FontWeight.w700)),
                      ],
                    ),
                  ),
                ),
            ],
            const SizedBox(height: 24),
            FilledButton(
              onPressed: () => Navigator.of(context).pushReplacement(
                MaterialPageRoute<void>(
                  builder: (_) => LobbyScreen(
                    room: RoomArgs(
                      code: generateRoomCode(),
                      isHost: isHost,
                      hostPaced: false,
                      playerName: local.player.name,
                    ),
                  ),
                ),
              ),
              child: const Text('Rematch'),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst),
              child: const Text('Back to home'),
            ),
          ],
        ),
      ),
    );
  }
}

class _Podium extends StatelessWidget {
  const _Podium({required this.top});

  final List<PlayerScore> top;

  @override
  Widget build(BuildContext context) {
    // Visual order 2nd, 1st, 3rd, with heights by rank.
    final byRank = {for (final s in top) s.rank ?? 0: s};
    final order = [2, 1, 3];
    const heights = {1: 170.0, 2: 130.0, 3: 110.0};
    return SizedBox(
      height: 230,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          for (final rank in order)
            Expanded(
              child: byRank[rank] == null
                  ? const SizedBox.shrink()
                  : _PodiumStep(score: byRank[rank]!, height: heights[rank]!, rank: rank),
            ),
        ],
      ),
    );
  }
}

class _PodiumStep extends StatelessWidget {
  const _PodiumStep({required this.score, required this.height, required this.rank});

  final PlayerScore score;
  final double height;
  final int rank;

  @override
  Widget build(BuildContext context) {
    final isFirst = rank == 1;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          PlayerAvatar(
            initials: score.player.initials,
            color: Color(score.player.avatarColorValue),
            size: isFirst ? 56 : 46,
          ),
          const SizedBox(height: 8),
          Text(score.player.name, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center),
          Text('${score.totalScore}', style: const TextStyle(color: QA.textMuted)),
          const SizedBox(height: 8),
          Container(
            height: height,
            alignment: Alignment.topCenter,
            padding: const EdgeInsets.only(top: 12),
            decoration: BoxDecoration(
              color: isFirst ? QA.accent : QA.surfaceHigh,
              borderRadius: const BorderRadius.vertical(top: Radius.circular(QA.radiusCard)),
            ),
            child: Text(
              '$rank',
              style: TextStyle(
                fontSize: 34,
                fontWeight: FontWeight.w700,
                color: isFirst ? QA.onAccent : QA.text,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
