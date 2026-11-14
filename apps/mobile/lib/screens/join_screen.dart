import 'package:flutter/material.dart';

import '../design/tokens.dart';
import 'lobby_screen.dart';

class JoinScreen extends StatefulWidget {
  const JoinScreen({super.key});

  @override
  State<JoinScreen> createState() => _JoinScreenState();
}

class _JoinScreenState extends State<JoinScreen> {
  static const _codeLength = 6;
  // Matches the server alphabet: no O, 0, I or 1 (spec Appendix A).
  static const _alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  final _code = TextEditingController();
  final _name = TextEditingController(text: 'Guest');
  String? _error;

  @override
  void dispose() {
    _code.dispose();
    _name.dispose();
    super.dispose();
  }

  void _join() {
    final code = _code.text.trim().toUpperCase();
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Enter a display name.');
      return;
    }
    if (code.length != _codeLength || code.split('').any((c) => !_alphabet.contains(c))) {
      setState(() => _error = 'Codes are 6 characters, letters and digits only.');
      return;
    }
    setState(() => _error = null);
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => LobbyScreen(
          room: RoomArgs(code: code, isHost: false, hostPaced: false, playerName: name),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Join a game')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(QA.gutter),
          children: [
            Text('Enter the room code', style: theme.textTheme.headlineMedium),
            const SizedBox(height: 8),
            Text('Ask your host for the 6-character code on their screen.',
                style: theme.textTheme.bodyLarge?.copyWith(color: QA.textMuted)),
            const SizedBox(height: 28),
            TextField(
              controller: _code,
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              maxLength: _codeLength,
              textAlign: TextAlign.center,
              style: theme.textTheme.headlineMedium?.copyWith(letterSpacing: 8),
              decoration: const InputDecoration(
                counterText: '',
                hintText: 'K7M4QX',
              ),
              onSubmitted: (_) => _join(),
            ),
            const SizedBox(height: 18),
            TextField(
              controller: _name,
              maxLength: 20,
              decoration: const InputDecoration(
                labelText: 'Display name',
                counterText: '',
              ),
              onSubmitted: (_) => _join(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Semantics(
                liveRegion: true,
                child: Text(_error!, style: const TextStyle(color: QA.incorrect)),
              ),
            ],
            const SizedBox(height: 28),
            FilledButton(onPressed: _join, child: const Text('Join game')),
          ],
        ),
      ),
    );
  }
}
