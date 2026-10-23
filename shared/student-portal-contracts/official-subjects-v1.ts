/*
 * The school's official subject names (owner decision 23/10/2026: "consumir o nome das disciplinas
 * oficiais"), the same as gradebook.disciplina for 2026, the names the Notas show. The Smecel's grid
 * writes them its own way ("LINGUA PORTUGUESA", "INFORMATICA/COMPUTACAO", "ENSINO RELIGIOSO"); the
 * Portal shows the official one ("PORTUGUÊS", "COMPUTAÇÃO", "RELIGIÃO") and keeps the Smecel's name
 * only for a subject not on this list.
 */
export const OFFICIAL_SUBJECTS_2026_V1 = [
  'PORTUGUÊS',
  'MATEMÁTICA',
  'CIÊNCIAS',
  'HISTÓRIA',
  'GEOGRAFIA',
  'ARTE',
  'ED. FÍSICA',
  'INGLÊS',
  'RELIGIÃO',
  'REDAÇÃO',
  'ÉTICA',
  'COMPUTAÇÃO',
] as const;

/** Upper case, no accents, words only: "ED. FÍSICA" → ["ED", "FISICA"]. */
const wordsOf = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/u)
    .filter((word) => word.length > 1 || /\d/u.test(word));
/** A word of the official name found in the Smecel's: the same start ("ED" in "EDUCACAO",
 * "PORTUGUES" in "PORTUGUESA") or the same first six letters ("RELIGIAO" and "RELIGIOSO"). */
const sameWord = (official: string, smecel: string) =>
  smecel.startsWith(official) ||
  (official.length >= 6 && smecel.length >= 6 && official.slice(0, 6) === smecel.slice(0, 6));

/**
 * The official name of a subject as the Smecel writes it: the official name all of whose words are
 * in it (the one with the most words when several are), or the Smecel's own name when none is.
 */
export function officialSubjectV1(
  smecel: string,
  official: readonly string[] = OFFICIAL_SUBJECTS_2026_V1,
): string {
  const words = wordsOf(smecel);
  let best: { name: string; size: number } | null = null;
  for (const name of official) {
    const wanted = wordsOf(name);
    if (wanted.length && wanted.every((word) => words.some((each) => sameWord(word, each))))
      if (!best || wanted.length > best.size) best = { name, size: wanted.length };
  }
  return best?.name ?? smecel;
}
