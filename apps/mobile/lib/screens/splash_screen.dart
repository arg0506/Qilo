import 'dart:async';

import 'package:flutter/material.dart';

import '../design/tokens.dart';
import '../design/widgets.dart';
import 'home_screen.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer(const Duration(milliseconds: 1600), _goHome);
  }

  void _goHome() {
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      PageRouteBuilder<void>(
        transitionDuration: const Duration(milliseconds: 400),
        pageBuilder: (_, _, _) => const HomeScreen(),
        transitionsBuilder: (_, animation, _, child) =>
            FadeTransition(opacity: animation, child: child),
      ),
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const Spacer(flex: 3),
            const GemLogo(size: 120),
            const Spacer(flex: 4),
            Padding(
              padding: const EdgeInsets.only(bottom: 40),
              child: Semantics(
                header: true,
                child: Text(
                  'Quiz Arena',
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(
                        color: QA.text,
                        letterSpacing: 0.4,
                      ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

