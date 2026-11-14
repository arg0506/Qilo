import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'tokens.dart';

ThemeData buildQuizArenaTheme() {
  const colorScheme = ColorScheme.dark(
    primary: QA.accent,
    onPrimary: QA.onAccent,
    secondary: QA.accentSoft,
    surface: QA.surface,
    onSurface: QA.text,
    error: QA.incorrect,
    outline: QA.outline,
  );

  final baseText = GoogleFonts.spaceGroteskTextTheme(
    ThemeData(brightness: Brightness.dark, useMaterial3: true).textTheme,
  ).apply(bodyColor: QA.text, displayColor: QA.text);

  final textTheme = baseText.copyWith(
    displayLarge: baseText.displayLarge?.copyWith(
      fontWeight: FontWeight.w600,
      height: 1.02,
      letterSpacing: -1.5,
    ),
    headlineMedium: baseText.headlineMedium?.copyWith(
      fontWeight: FontWeight.w600,
      height: 1.1,
      letterSpacing: -0.6,
    ),
    titleLarge: baseText.titleLarge?.copyWith(fontWeight: FontWeight.w600),
    bodyLarge: baseText.bodyLarge?.copyWith(height: 1.4),
    labelLarge: baseText.labelLarge?.copyWith(fontWeight: FontWeight.w600),
  );

  return ThemeData(
    brightness: Brightness.dark,
    useMaterial3: true,
    colorScheme: colorScheme,
    scaffoldBackgroundColor: QA.background,
    textTheme: textTheme,
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      foregroundColor: QA.text,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: QA.accent,
        foregroundColor: QA.onAccent,
        minimumSize: const Size(0, QA.controlMin),
        shape: const StadiumBorder(),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: QA.text,
        side: const BorderSide(color: QA.outline),
        minimumSize: const Size(0, QA.controlMin),
        shape: const StadiumBorder(),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: QA.surface,
      hintStyle: const TextStyle(color: QA.textMuted),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(QA.radiusTile),
        borderSide: BorderSide.none,
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(QA.radiusTile),
        borderSide: const BorderSide(color: QA.accent, width: 1.5),
      ),
    ),
  );
}
