import 'package:flutter/material.dart';

import 'design/theme.dart';
import 'screens/splash_screen.dart';

void main() {
  runApp(const QuizArenaApp());
}

class QuizArenaApp extends StatelessWidget {
  const QuizArenaApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Quiz Arena',
      debugShowCheckedModeBanner: false,
      theme: buildQuizArenaTheme(),
      home: const SplashScreen(),
    );
  }
}
