import 'dart:async';

import 'package:flutter/material.dart';

import '../design/tokens.dart';
import '../design/widgets.dart';
import '../game/models.dart';
import '../game/sample_quiz.dart';
import 'game_screen.dart';

class RoomArgs {
  const RoomArgs({
    required this.code,
    required this.isHost,
    required this.hostPaced,
    required this.playerName,
  });

  final String code;
  final bool isHost;
  final bool hostPaced;
  final String playerName;
}

class LobbyScreen extends StatefulWidget {
  const LobbyScreen({super.key, required this.room});

  final RoomArgs room;

  @override
  State<LobbyScreen> createState() => _LobbyScreenState();
}

class _LobbyScreenState extends State<LobbyScreen> {
  late bool _hostPaced = widget.room.hostPaced;
  bool _locked = false;
  bool _starting = false;
  Timer? _mockHostStart;

  late final List<Player> _players = [
    Player(
      id: 'me',
      name: widget.room.playerName,
      avatarColorValue: QA.accent.toARGB32(),
      isHost: widget.room.isHost,
    ),
    ...samplePlayers.where((p) => p.id != 'me'),
  ];

  @override
  void initState() {
    super.initState();
    // Until the gateway exists, a guest's host "starts" the game after a
    // short delay so the full flow can be exercised.
    if (!widget.room.isHost) {
      _mockHostStart = Timer(const Duration(seconds: 6), _start);
    }
  }

  @override
  void dispose() {
    _mockHostStart?.cancel();
    super.dispose();
  }

  void _start() {
    if (_starting) return;
    _mockHostStart?.cancel();
    setState(() => _starting = true);
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => GameScreen(
          questions: starterQuestions,
          players: _players,
          localPlayerId: 'me',
          hostPaced: _hostPaced,
          isHost: widget.room.isHost,
        ),
      ),
    );
  }

  void _copyCode() {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Room code ${widget.room.code} copied to share.')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isHost = widget.room.isHost;
    return Scaffold(
      appBar: AppBar(
        title: Text(isHost ? 'Your room' : 'Lobby'),
        leading: IconButton(
          tooltip: 'Leave',
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(QA.gutter),
          children: [
            SurfaceCard(
              child: Column(
                children: [
                  Text('ROOM CODE', style: theme.textTheme.labelLarge?.copyWith(color: QA.textMuted, letterSpacing: 2)),
                  const SizedBox(height: 8),
                  SelectableText(
                    widget.room.code,
                    style: theme.textTheme.displayLarge?.copyWith(fontSize: 46, letterSpacing: 6),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      OutlinedButton.icon(
                        onPressed: _copyCode,
                        icon: const Icon(Icons.copy_rounded, size: 18),
                        label: const Text('Copy'),
                      ),
                      const SizedBox(width: 12),
                      FilledButton.icon(
                        onPressed: _copyCode,
                        icon: const Icon(Icons.ios_share_rounded, size: 18),
                        label: const Text('Share'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            Row(
              children: [
                Text('Players', style: theme.textTheme.titleLarge),
                const SizedBox(width: 8),
                PillChip(label: '${_players.length}'),
              ],
            ),
            const SizedBox(height: 12),
            GridView.count(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              crossAxisCount: 2,
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              childAspectRatio: 2.4,
              children: [for (final p in _players) _PlayerTile(player: p)],
            ),
            if (isHost) ...[
              const SizedBox(height: 24),
              SurfaceCard(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
                child: Column(
                  children: [
                    SwitchListTile(
                      value: _hostPaced,
                      onChanged: (v) => setState(() => _hostPaced = v),
                      title: const Text('Host-paced'),
                      subtitle: const Text('You press Next after each scoreboard'),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                    ),
                    SwitchListTile(
                      value: _locked,
                      onChanged: (v) => setState(() => _locked = v),
                      title: const Text('Lock room'),
                      subtitle: const Text('Stop new players from joining'),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 24),
              FilledButton(
                onPressed: _players.length >= 2 ? _start : null,
                child: Text(_players.length >= 2 ? 'Start game' : 'Waiting for at least 2 players'),
              ),
            ] else ...[
              const SizedBox(height: 28),
              Center(
                child: Column(
                  children: [
                    const SizedBox(
                      width: 28,
                      height: 28,
                      child: CircularProgressIndicator(strokeWidth: 3),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      _starting ? 'Starting…' : 'Waiting for the host to start',
                      style: theme.textTheme.bodyLarge?.copyWith(color: QA.textMuted),
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _PlayerTile extends StatelessWidget {
  const _PlayerTile({required this.player});

  final Player player;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: QA.surface,
        borderRadius: BorderRadius.circular(QA.radiusTile),
      ),
      child: Row(
        children: [
          PlayerAvatar(initials: player.initials, color: Color(player.avatarColorValue), size: 36),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(player.name, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
                Text(player.isHost ? 'Host' : 'Ready', style: const TextStyle(color: QA.textMuted, fontSize: 12)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
