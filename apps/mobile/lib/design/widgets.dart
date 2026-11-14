import 'package:flutter/material.dart';

import 'tokens.dart';

class GemLogo extends StatelessWidget {
  const GemLogo({super.key, this.size = 96});

  final double size;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: _GemPainter()),
    );
  }
}

class _GemPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final outline = Path()
      ..moveTo(w * 0.50, h * 0.02)
      ..lineTo(w * 0.86, h * 0.30)
      ..lineTo(w * 0.78, h * 0.88)
      ..lineTo(w * 0.30, h * 0.96)
      ..lineTo(w * 0.12, h * 0.46)
      ..close();

    final body = Paint()
      ..shader = const LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [QA.accentSoft, QA.accent, QA.accentDeep],
      ).createShader(Offset.zero & size);
    canvas.drawPath(outline, body);

    final facet = Paint()..color = QA.accentSoft.withValues(alpha: 0.55);
    final facetPath = Path()
      ..moveTo(w * 0.50, h * 0.02)
      ..lineTo(w * 0.50, h * 0.52)
      ..lineTo(w * 0.12, h * 0.46)
      ..close();
    canvas.drawPath(facetPath, facet);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class PillChip extends StatelessWidget {
  const PillChip({
    super.key,
    required this.label,
    this.selected = false,
    this.onTap,
    this.icon,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final fg = selected ? QA.onAccent : QA.text;
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      child: Material(
        color: selected ? QA.accent : Colors.transparent,
        shape: StadiumBorder(
          side: BorderSide(color: selected ? QA.accent : QA.outline),
        ),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: QA.controlMin),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (icon != null) ...[
                    Icon(icon, size: 18, color: fg),
                    const SizedBox(width: 6),
                  ],
                  Text(label, style: TextStyle(color: fg, fontWeight: FontWeight.w600)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class RoundIconButton extends StatelessWidget {
  const RoundIconButton({
    super.key,
    required this.icon,
    required this.label,
    this.onTap,
    this.filled = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: label,
      child: Material(
        color: filled ? QA.accent : QA.surfaceHigh,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(
            width: QA.controlMin,
            height: QA.controlMin,
            child: Icon(icon, color: filled ? QA.onAccent : QA.text),
          ),
        ),
      ),
    );
  }
}

// The large lavender card used on Home, matching the reference's feature tiles.
class FeatureCard extends StatelessWidget {
  const FeatureCard({
    super.key,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.onTap,
    this.height = 220,
  });

  final String title;
  final String subtitle;
  final IconData icon;
  final VoidCallback onTap;
  final double height;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: QA.accent,
      borderRadius: BorderRadius.circular(QA.radiusCard),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: SizedBox(
          height: height,
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(icon, color: QA.onAccent, size: 30),
                const Spacer(),
                Text(
                  title,
                  style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                        color: QA.onAccent,
                      ),
                ),
                const SizedBox(height: 6),
                Text(
                  subtitle,
                  style: const TextStyle(color: QA.onAccent, height: 1.3),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class SurfaceCard extends StatelessWidget {
  const SurfaceCard({super.key, required this.child, this.padding = const EdgeInsets.all(20), this.onTap});

  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: QA.surface,
      borderRadius: BorderRadius.circular(QA.radiusCard),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(padding: padding, child: child),
      ),
    );
  }
}

class PlayerAvatar extends StatelessWidget {
  const PlayerAvatar({super.key, required this.initials, required this.color, this.size = 44});

  final String initials;
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return CircleAvatar(
      radius: size / 2,
      backgroundColor: color,
      child: Text(
        initials,
        style: TextStyle(
          color: QA.onAccent,
          fontWeight: FontWeight.w700,
          fontSize: size * 0.34,
        ),
      ),
    );
  }
}

// Answer card with shape, letter and label. States are conveyed by icon and
// text as well as colour (spec 7).
enum AnswerState { idle, selected, correct, incorrect, dimmed }

class AnswerCard extends StatelessWidget {
  const AnswerCard({
    super.key,
    required this.letter,
    required this.label,
    required this.state,
    this.onTap,
  });

  final String letter;
  final String label;
  final AnswerState state;
  final VoidCallback? onTap;

  static const _icons = <AnswerState, IconData>{
    AnswerState.selected: Icons.radio_button_checked,
    AnswerState.correct: Icons.check_circle,
    AnswerState.incorrect: Icons.cancel,
  };

  static const _stateLabel = <AnswerState, String>{
    AnswerState.selected: 'Your answer',
    AnswerState.correct: 'Correct',
    AnswerState.incorrect: 'Incorrect',
  };

  @override
  Widget build(BuildContext context) {
    final accent = switch (state) {
      AnswerState.correct => QA.correct,
      AnswerState.incorrect => QA.incorrect,
      AnswerState.selected => QA.accent,
      _ => QA.outline,
    };
    final fill = switch (state) {
      AnswerState.correct => QA.correct.withValues(alpha: 0.14),
      AnswerState.incorrect => QA.incorrect.withValues(alpha: 0.14),
      AnswerState.selected => QA.accent.withValues(alpha: 0.18),
      _ => QA.surface,
    };
    final enabled = onTap != null;
    final text = state == AnswerState.dimmed
        ? QA.textMuted
        : QA.text;
    final badge = _icons[state];
    final semantic = _stateLabel[state];

    return Semantics(
      button: enabled,
      enabled: enabled,
      label: semantic == null ? 'Option $letter: $label' : 'Option $letter: $label. $semantic',
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        constraints: const BoxConstraints(minHeight: QA.answerMinHeight),
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(QA.radiusTile),
          border: Border.all(color: accent, width: state == AnswerState.idle ? 1 : 1.5),
        ),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(QA.radiusTile),
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              child: Row(
                children: [
                  Container(
                    width: 34,
                    height: 34,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: state == AnswerState.idle ? QA.surfaceHigh : accent,
                      shape: BoxShape.circle,
                    ),
                    child: Text(
                      letter,
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        color: state == AnswerState.idle ? QA.text : QA.onAccent,
                      ),
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Text(
                      label,
                      style: TextStyle(color: text, fontSize: 17, fontWeight: FontWeight.w500),
                    ),
                  ),
                  if (badge != null) ...[
                    const SizedBox(width: 8),
                    Icon(badge, color: accent),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class DistributionBar extends StatelessWidget {
  const DistributionBar({super.key, required this.label, required this.count, required this.total, required this.highlight});

  final String label;
  final int count;
  final int total;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final share = total == 0 ? 0.0 : count / total;
    final pct = (share * 100).round();
    return Semantics(
      label: '$label: $count players, $pct percent',
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(label, style: const TextStyle(color: QA.text))),
                Text('$pct%', style: const TextStyle(color: QA.textMuted)),
              ],
            ),
            const SizedBox(height: 6),
            ClipRRect(
              borderRadius: BorderRadius.circular(QA.radiusPill),
              child: LinearProgressIndicator(
                value: share,
                minHeight: 10,
                backgroundColor: QA.surfaceHigh,
                color: highlight ? QA.correct : QA.accent,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
