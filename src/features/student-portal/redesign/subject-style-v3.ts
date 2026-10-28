import {
  BookIconV3,
  CalculatorIconV3,
  DumbbellIconV3,
  EarthIconV3,
  FlaskIconV3,
  HeartIconV3,
  LandmarkIconV3,
  LanguagesIconV3,
  MarkedBookIconV3,
  MonitorIconV3,
  PaletteIconV3,
  PenIconV3,
  ScaleIconV3,
  type ScheduleIconV3,
} from './schedule-icons-v3';

/*
 * Each subject with a colour and an icon of its own (owner decision 23/10/2026: "leitura mais
 * fácil"), the same on every day, so a parent finds Matemática at a glance. Works with the official
 * name ("CIÊNCIAS") and the Smecel's ("CIENCIAS"); a subject not listed here still gets a steady
 * colour from its name and a plain book. The icons move while their lesson is going on
 * (schedule-icons-v3).
 */
const KNOWN_V3: readonly [RegExp, ScheduleIconV3, number][] = [
  [/PORTUGUES/u, BookIconV3, 0],
  [/MATEMATICA/u, CalculatorIconV3, 1],
  [/CIENCIAS/u, FlaskIconV3, 2],
  [/HISTORIA/u, LandmarkIconV3, 3],
  [/GEOGRAFIA/u, EarthIconV3, 4],
  [/ARTE/u, PaletteIconV3, 5],
  [/EDUCACAO FISICA|ED\. FISICA/u, DumbbellIconV3, 6],
  [/INGLESA|INGLES|ESPANHOL/u, LanguagesIconV3, 7],
  [/RELIGIOSO|RELIGIAO/u, HeartIconV3, 8],
  [/REDACAO/u, PenIconV3, 9],
  [/ETICA|CIDADANIA/u, ScaleIconV3, 10],
  [/INFORMATICA|COMPUTACAO/u, MonitorIconV3, 11],
];
export const SUBJECT_TONES_V3 = 12;

export function subjectStyleV3(subject: string): { Icon: ScheduleIconV3; tone: number } {
  // Official names have accents ("CIÊNCIAS", "ED. FÍSICA"): compared without them.
  const name = subject
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toUpperCase();
  const known = KNOWN_V3.find(([pattern]) => pattern.test(name));
  if (known) return { Icon: known[1], tone: known[2] };
  let hash = 0;
  for (const letter of name) hash = (hash * 31 + letter.codePointAt(0)!) >>> 0;
  return { Icon: MarkedBookIconV3, tone: hash % SUBJECT_TONES_V3 };
}
