import 'models.dart';

// Starter content used until the quiz library is connected (MVP-03).
const List<Question> starterQuestions = [
  Question(
    prompt: 'Which planet is known as the Red Planet?',
    options: ['Venus', 'Mars', 'Jupiter', 'Saturn'],
    correctIndex: 1,
    explanation: 'Iron oxide on the surface gives Mars its red colour.',
  ),
  Question(
    prompt: 'How many sides does a hexagon have?',
    options: ['Five', 'Six', 'Seven', 'Eight'],
    correctIndex: 1,
    explanation: 'Hexa means six in Greek.',
  ),
  Question(
    prompt: 'The Great Wall of China is visible from space with the naked eye.',
    options: ['True', 'False'],
    correctIndex: 1,
    explanation: 'It is too narrow to be seen from orbit without aid.',
    type: QuestionType.trueFalse,
  ),
  Question(
    prompt: 'Which gas do plants absorb during photosynthesis?',
    options: ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Helium'],
    correctIndex: 2,
    explanation: 'Plants take in carbon dioxide and release oxygen.',
  ),
  Question(
    prompt: 'In which year did the IBM Simon, an early touchscreen smartphone, go on sale?',
    options: ['1992', '1994', '2001', '2007'],
    correctIndex: 1,
    explanation: 'It was unveiled in 1992 and went on sale in 1994.',
  ),
];

const List<Player> samplePlayers = [
  Player(id: 'me', name: 'You', avatarColorValue: 0xFF9D7BFF, isHost: true),
  Player(id: 'b1', name: 'Maya Chen', avatarColorValue: 0xFF3DDC97, isBot: true),
  Player(id: 'b2', name: 'Leo Park', avatarColorValue: 0xFFFFB84D, isBot: true),
  Player(id: 'b3', name: 'Ana Souza', avatarColorValue: 0xFFFF7AB2, isBot: true),
  Player(id: 'b4', name: 'Kofi Mensah', avatarColorValue: 0xFF5AC8FA, isBot: true),
];
