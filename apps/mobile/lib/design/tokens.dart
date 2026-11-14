import 'package:flutter/material.dart';

// Colour and shape tokens taken from the UI reference
// (.kombai/ui design): near-black charcoal surfaces, a lavender accent,
// and large rounded pill and card shapes.
abstract final class QA {
  // Surfaces
  static const Color background = Color(0xFF0F0E12);
  static const Color surface = Color(0xFF1C1A21);
  static const Color surfaceHigh = Color(0xFF2A2730);
  static const Color outline = Color(0xFF3A3642);

  // Accent (lavender)
  static const Color accent = Color(0xFF9D7BFF);
  static const Color accentDeep = Color(0xFF6E4FE6);
  static const Color accentSoft = Color(0xFFCDBDFF);
  static const Color onAccent = Color(0xFF12091F);

  // Text
  static const Color text = Color(0xFFF5F3FF);
  static const Color textMuted = Color(0xFFA19CB3);

  // Answer states. Always paired with an icon and a label, never colour alone.
  static const Color correct = Color(0xFF3DDC97);
  static const Color incorrect = Color(0xFFFF5C7A);
  static const Color warning = Color(0xFFFFB84D);

  // Shape
  static const double radiusCard = 28;
  static const double radiusTile = 22;
  static const double radiusPill = 999;
  static const double gutter = 16;

  // Touch targets (spec 7): 48 dp for answers, 44 dp for other controls.
  static const double answerMinHeight = 56;
  static const double controlMin = 44;
}
