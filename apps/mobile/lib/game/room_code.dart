import 'dart:math';

// Mirrors apps/api/src/room/room-code.ts: 6 characters, no O/0 or I/1.
const String roomCodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const int roomCodeLength = 6;

String generateRoomCode([Random? random]) {
  final rng = random ?? Random.secure();
  return List.generate(
    roomCodeLength,
    (_) => roomCodeAlphabet[rng.nextInt(roomCodeAlphabet.length)],
  ).join();
}
