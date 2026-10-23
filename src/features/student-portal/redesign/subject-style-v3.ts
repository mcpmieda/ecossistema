import {
  BookMarked,
  BookOpen,
  Calculator,
  Dumbbell,
  FlaskConical,
  Globe2,
  HeartHandshake,
  Landmark,
  Languages,
  Monitor,
  Palette,
  PenLine,
  Scale,
  type LucideIcon,
} from 'lucide-react';

/*
 * Each subject with a colour and an icon of its own (owner decision 23/10/2026: "leitura mais
 * fácil"), the same on every day, so a parent finds Matemática at a glance. Works with the official
 * name ("CIÊNCIAS") and the Smecel's ("CIENCIAS"); a subject not listed here still gets a steady
 * colour from its name and a plain book.
 */
const KNOWN_V3: readonly [RegExp, LucideIcon, number][] = [
  [/PORTUGUES/u, BookOpen, 0],
  [/MATEMATICA/u, Calculator, 1],
  [/CIENCIAS/u, FlaskConical, 2],
  [/HISTORIA/u, Landmark, 3],
  [/GEOGRAFIA/u, Globe2, 4],
  [/ARTE/u, Palette, 5],
  [/EDUCACAO FISICA|ED\. FISICA/u, Dumbbell, 6],
  [/INGLESA|INGLES|ESPANHOL/u, Languages, 7],
  [/RELIGIOSO|RELIGIAO/u, HeartHandshake, 8],
  [/REDACAO/u, PenLine, 9],
  [/ETICA|CIDADANIA/u, Scale, 10],
  [/INFORMATICA|COMPUTACAO/u, Monitor, 11],
];
export const SUBJECT_TONES_V3 = 12;

export function subjectStyleV3(subject: string): { Icon: LucideIcon; tone: number } {
  // Official names have accents ("CIÊNCIAS", "ED. FÍSICA"): compared without them.
  const name = subject
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toUpperCase();
  const known = KNOWN_V3.find(([pattern]) => pattern.test(name));
  if (known) return { Icon: known[1], tone: known[2] };
  let hash = 0;
  for (const letter of name) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
  return { Icon: BookMarked, tone: hash % SUBJECT_TONES_V3 };
}
