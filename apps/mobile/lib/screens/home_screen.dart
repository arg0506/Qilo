import 'package:flutter/material.dart';

import '../design/tokens.dart';
import '../design/widgets.dart';
import '../game/sample_quiz.dart';
import 'join_screen.dart';
import 'lobby_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  String _filter = 'All';
  static const _filters = ['All', 'Live', 'Starter'];

  void _hostGame() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => const LobbyScreen(
          room: RoomArgs(code: 'K7M4QX', isHost: true, hostPaced: false, playerName: 'You'),
        ),
      ),
    );
  }

  void _join() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const JoinScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(QA.gutter, 8, QA.gutter, 32),
          children: [
            Row(
              children: [
                const PlayerAvatar(initials: 'YO', color: QA.accent, size: 44),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Welcome back', style: theme.textTheme.bodyLarge?.copyWith(color: QA.textMuted)),
                      Text('Guest player', style: theme.textTheme.titleLarge),
                    ],
                  ),
                ),
                RoundIconButton(
                  icon: Icons.settings_outlined,
                  label: 'Settings',
                  onTap: () => ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Settings arrive with accounts (M1).')),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 28),
            Semantics(
              header: true,
              child: Text(
                'Play.\nCompete.\nWin.',
                style: theme.textTheme.displayLarge?.copyWith(fontSize: 56),
              ),
            ),
            const SizedBox(height: 22),
            SizedBox(
              height: 46,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: _filters.length,
                separatorBuilder: (_, _) => const SizedBox(width: 10),
                itemBuilder: (_, i) => PillChip(
                  label: _filters[i],
                  selected: _filter == _filters[i],
                  onTap: () => setState(() => _filter = _filters[i]),
                ),
              ),
            ),
            const SizedBox(height: 22),
            FeatureCard(
              title: 'Host a game',
              subtitle: 'Create a room from a quiz and invite your group.',
              icon: Icons.podcasts_rounded,
              onTap: _hostGame,
              height: 240,
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: SurfaceCard(
                    onTap: _join,
                    child: const _MiniTile(
                      icon: Icons.keyboard_alt_outlined,
                      title: 'Join with code',
                      subtitle: 'Enter the 6-character code',
                    ),
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: SurfaceCard(
                    onTap: () => _startingQuizzes(context),
                    child: const _MiniTile(
                      icon: Icons.menu_book_outlined,
                      title: 'Starter quizzes',
                      subtitle: '5 ready to play',
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 28),
            Text('Live now', style: theme.textTheme.titleLarge),
            const SizedBox(height: 12),
            _LiveRoomRow(
              title: 'Friday Trivia',
              host: 'Maya Chen',
              players: samplePlayers.length,
              onTap: _join,
            ),
          ],
        ),
      ),
    );
  }

  void _startingQuizzes(BuildContext context) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Quiz library arrives in M1. Host a game to try the live flow.')),
    );
  }
}

class _MiniTile extends StatelessWidget {
  const _MiniTile({required this.icon, required this.title, required this.subtitle});

  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SizedBox(
      height: 170,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: QA.accent, size: 28),
          const Spacer(),
          Text(title, style: theme.textTheme.titleLarge),
          const SizedBox(height: 4),
          Text(subtitle, style: theme.textTheme.bodyMedium?.copyWith(color: QA.textMuted)),
        ],
      ),
    );
  }
}

class _LiveRoomRow extends StatelessWidget {
  const _LiveRoomRow({required this.title, required this.host, required this.players, required this.onTap});

  final String title;
  final String host;
  final int players;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return SurfaceCard(
      onTap: onTap,
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          const CircleAvatar(radius: 22, backgroundColor: QA.surfaceHigh, child: Icon(Icons.bolt, color: QA.accent)),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 17)),
                const SizedBox(height: 2),
                Text('Hosted by $host Â· $players players',
                    style: const TextStyle(color: QA.textMuted)),
              ],
            ),
          ),
          const Icon(Icons.chevron_right, color: QA.textMuted),
        ],
      ),
    );
  }
}

