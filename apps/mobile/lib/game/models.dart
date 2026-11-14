class Question {
  const Question({
    required this.prompt,
    required this.options,
    required this.correctIndex,
    required this.explanation,
    this.type = QuestionType.multipleChoice,
  });

  final String prompt;
  final List<String> options;
  final int correctIndex;
  final String explanation;
  final QuestionType type;
}

enum QuestionType { multipleChoice, trueFalse, imageChoice }

class Player {
  const Player({
    required this.id,
    required this.name,
    required this.avatarColorValue,
    this.isHost = false,
    this.isBot = false,
  });

  final String id;
  final String name;
  final int avatarColorValue;
  final bool isHost;
  final bool isBot;

  String get initials {
    final parts = name.trim().split(RegExp(r'\s+'));
    if (parts.isEmpty || parts.first.isEmpty) return '?';
    final first = parts.first[0];
    final second = parts.length > 1 ? parts[1][0] : '';
    return (first + second).toUpperCase();
  }
}

class PlayerScore {
  PlayerScore({required this.player});

  final Player player;
  int totalScore = 0;
  int correctCount = 0;
  int totalAnswerTimeMs = 0;
  int streak = 0;
  int longestStreak = 0;
  int? lastPoints;
  int? lastOptionIndex;
  bool? lastCorrect;
  int? rank;
}
