// Starter quizzes that Qilo ships (MVP-03). Idempotent: fixed ids, inserted
// once and published as version 1.

import { eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import { draftQuestions, questionAnswers, questionOptions, questions, quizVersions, quizzes, type QuizSettings } from "./schema.ts";

type Q = { prompt: string; options: string[]; correct: number; explanation: string; type?: "mcq" | "true_false" };
type Starter = { id: string; title: string; description: string; category: string; questions: Q[] };

const TF = ["True", "False"];

export const STARTER_QUIZZES: Starter[] = [
  {
    id: "5e1d0000-0000-4000-8000-000000000001",
    title: "Friday Trivia",
    description: "A quick warm-up mix of everyday knowledge.",
    category: "general",
    questions: [
      { prompt: "Which planet is known as the Red Planet?", options: ["Venus", "Mars", "Jupiter", "Saturn"], correct: 1, explanation: "Iron oxide on the surface gives Mars its red colour." },
      { prompt: "How many sides does a hexagon have?", options: ["Five", "Six", "Seven", "Eight"], correct: 1, explanation: "Hexa means six in Greek." },
      { prompt: "The Great Wall of China is visible from space with the naked eye.", options: TF, correct: 1, type: "true_false", explanation: "It is too narrow to be seen from orbit without aid." },
      { prompt: "Which gas do plants absorb during photosynthesis?", options: ["Oxygen", "Nitrogen", "Carbon dioxide", "Helium"], correct: 2, explanation: "Plants take in carbon dioxide and release oxygen." },
      { prompt: "How many continents are there?", options: ["Five", "Six", "Seven", "Eight"], correct: 2, explanation: "Africa, Antarctica, Asia, Australia, Europe, North America and South America." },
      { prompt: "In which year did the IBM Simon, an early touchscreen smartphone, go on sale?", options: ["1992", "1994", "2001", "2007"], correct: 1, explanation: "It was unveiled in 1992 and went on sale in 1994." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000002",
    title: "Science Sprint",
    description: "Elements, planets and the human body.",
    category: "science",
    questions: [
      { prompt: "What is the chemical symbol for gold?", options: ["Go", "Gd", "Au", "Ag"], correct: 2, explanation: "Au comes from the Latin word aurum." },
      { prompt: "What is the largest planet in our solar system?", options: ["Saturn", "Jupiter", "Neptune", "Earth"], correct: 1, explanation: "Jupiter is more than twice as massive as all the other planets combined." },
      { prompt: "How many bones are in the adult human body?", options: ["186", "206", "226", "256"], correct: 1, explanation: "Babies have more; many fuse as we grow." },
      { prompt: "Sound travels faster in water than in air.", options: TF, correct: 0, type: "true_false", explanation: "Sound moves about four times faster in water." },
      { prompt: "What is the hardest natural substance?", options: ["Quartz", "Iron", "Diamond", "Granite"], correct: 2, explanation: "Diamond tops the Mohs hardness scale at 10." },
      { prompt: "Which part of a plant or animal cell holds most of its DNA?", options: ["Nucleus", "Ribosome", "Cell wall", "Vacuole"], correct: 0, explanation: "The nucleus stores the cell's chromosomes." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000003",
    title: "Around the World",
    description: "Capitals, rivers and oceans.",
    category: "geography",
    questions: [
      { prompt: "What is the capital of Australia?", options: ["Sydney", "Melbourne", "Canberra", "Perth"], correct: 2, explanation: "Canberra was chosen as a compromise between Sydney and Melbourne." },
      { prompt: "Which is the largest ocean?", options: ["Atlantic", "Indian", "Arctic", "Pacific"], correct: 3, explanation: "The Pacific covers about a third of Earth's surface." },
      { prompt: "Which is the smallest country by area?", options: ["Monaco", "Vatican City", "San Marino", "Malta"], correct: 1, explanation: "Vatican City covers less than half a square kilometre." },
      { prompt: "Mount Everest sits on the border of Nepal and which country?", options: ["India", "Bhutan", "China", "Pakistan"], correct: 2, explanation: "The border with China (Tibet) runs across the summit." },
      { prompt: "The Sahara is the largest hot desert in the world.", options: TF, correct: 0, type: "true_false", explanation: "Only the cold polar deserts are larger." },
      { prompt: "Which is the longest river in Africa?", options: ["Congo", "Niger", "Zambezi", "Nile"], correct: 3, explanation: "The Nile flows north for about 6,650 km." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000004",
    title: "India Trivia",
    description: "History, places and symbols of India.",
    category: "india",
    questions: [
      { prompt: "What is the capital of West Bengal?", options: ["Siliguri", "Kolkata", "Durgapur", "Howrah"], correct: 1, explanation: "Kolkata was also the capital of British India until 1911." },
      { prompt: "Which river does the Howrah Bridge cross?", options: ["Ganga at Varanasi", "Hooghly", "Damodar", "Brahmaputra"], correct: 1, explanation: "It links Howrah and Kolkata across the Hooghly." },
      { prompt: "In which year did Rabindranath Tagore win the Nobel Prize in Literature?", options: ["1905", "1913", "1921", "1930"], correct: 1, explanation: "He was the first non-European to win it." },
      { prompt: "The Ashoka Chakra on India's national flag has 24 spokes.", options: TF, correct: 0, type: "true_false", explanation: "The wheel in navy blue has 24 spokes." },
      { prompt: "What is India's national animal?", options: ["Lion", "Elephant", "Tiger", "Peacock"], correct: 2, explanation: "The Bengal tiger was adopted in 1973." },
      { prompt: "Which state has the longest coastline in India?", options: ["Gujarat", "Tamil Nadu", "Maharashtra", "Andhra Pradesh"], correct: 0, explanation: "Gujarat's coastline is the longest of any Indian state." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000005",
    title: "Tech Talk",
    description: "Computers, code and the web.",
    category: "technology",
    questions: [
      { prompt: "What does CPU stand for?", options: ["Central Processing Unit", "Computer Power Unit", "Core Program Utility", "Central Peripheral Unit"], correct: 0, explanation: "The CPU executes a program's instructions." },
      { prompt: "What does HTML stand for?", options: ["HyperText Markup Language", "High Transfer Machine Language", "Hyperlink Text Mode Language", "Home Tool Markup Language"], correct: 0, explanation: "HTML describes the structure of web pages." },
      { prompt: "How many bits are in a byte?", options: ["4", "8", "16", "32"], correct: 1, explanation: "A byte is 8 bits, enough for 256 values." },
      { prompt: "The Python language was named after the comedy group Monty Python.", options: TF, correct: 0, type: "true_false", explanation: "Guido van Rossum was a fan of Monty Python's Flying Circus." },
      { prompt: "Who is often called the father of the computer?", options: ["Alan Turing", "Charles Babbage", "Ada Lovelace", "John von Neumann"], correct: 1, explanation: "Babbage designed the Analytical Engine in the 1830s." },
      { prompt: "Which company created the Flutter UI toolkit?", options: ["Meta", "Microsoft", "Google", "Apple"], correct: 2, explanation: "Google released Flutter 1.0 in 2018." },
    ],
  },
];

const KEYS = ["A", "B", "C", "D", "E", "F"];
const SETTINGS: QuizSettings = { questionDurationSeconds: 20, shuffleQuestions: false, shuffleOptions: true, scoringProfile: "classic-v1" };

export async function seedStarterQuizzes(db: Db): Promise<number> {
  let created = 0;
  for (const starter of STARTER_QUIZZES) {
    const exists = await db.query.quizzes.findFirst({ where: eq(quizzes.id, starter.id) });
    if (exists) continue;
    await db.transaction(async (tx) => {
      await tx.insert(quizzes).values({
        id: starter.id,
        ownerId: null,
        isStarter: true,
        title: starter.title,
        description: starter.description,
        category: starter.category,
        visibility: "unlisted",
        status: "published",
        settings: SETTINGS,
        hasDraftChanges: false,
      });
      const [version] = await tx
        .insert(quizVersions)
        .values({ quizId: starter.id, versionNumber: 1, scoringProfile: "classic-v1", settings: SETTINGS, title: starter.title })
        .returning();
      for (const [position, q] of starter.questions.entries()) {
        const options = q.options.map((label, i) => ({ key: KEYS[i]!, label }));
        const type = q.type ?? "mcq";
        await tx.insert(draftQuestions).values({
          quizId: starter.id,
          position,
          type,
          prompt: q.prompt,
          explanation: q.explanation,
          options,
          correctOptionKey: KEYS[q.correct]!,
        });
        const [row] = await tx
          .insert(questions)
          .values({ quizVersionId: version!.id, position, type, prompt: q.prompt, explanation: q.explanation, durationSeconds: SETTINGS.questionDurationSeconds })
          .returning();
        await tx.insert(questionOptions).values(options.map((o, i) => ({ questionId: row!.id, optionKey: o.key, label: o.label, position: i })));
        await tx.insert(questionAnswers).values({ questionId: row!.id, correctOptionKeys: [KEYS[q.correct]!] });
      }
      await tx.update(quizzes).set({ currentVersionId: version!.id }).where(eq(quizzes.id, starter.id));
    });
    created += 1;
  }
  return created;
}
