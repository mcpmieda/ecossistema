/**
 * The class code a K3 header or a sheet name writes: "6A", "6º ANO A", "9ANO A", "6ª SÉRIE A",
 * "7º ano C - Matutino", "TURMA 6A" → "6A"…; null when there is no class letter ("9ANO", "6º ANO").
 * Read in linear time (no backtracking expression). Shared by the recognizer and the Auditoria.
 */
const normalized = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/gu, '').toUpperCase().replace(/\s+/gu, ' ').trim();
const isSpaceV1 = (char: string | undefined) => char !== undefined && /\s/u.test(char);
const isDigitV1 = (char: string | undefined) => char !== undefined && char >= '0' && char <= '9';
const isLetterV1 = (char: string | undefined) => char !== undefined && char >= 'A' && char <= 'Z';
const CLASS_ORDINALS_V1 = new Set(['º', '°', 'ª']);
const CLASS_SEPARATORS_V1 = new Set(['-', '–', '.']);

/** The class code starting at `start` (1–2 digits, then the class letter), or null. */
function classCodeAtV1(text: string, start: number): string | null {
  let index = start;
  while (index - start < 2 && isDigitV1(text[index])) index += 1;
  const number = text.slice(start, index);
  const skipSpaces = () => { while (isSpaceV1(text[index])) index += 1; };
  skipSpaces();
  if (CLASS_ORDINALS_V1.has(text[index] ?? '')) index += 1;
  skipSpaces();
  for (const word of ['ANO', 'SERIE']) {
    if (text.startsWith(word, index)) {
      index += word.length;
      break;
    }
  }
  skipSpaces();
  if (CLASS_SEPARATORS_V1.has(text[index] ?? '')) index += 1;
  skipSpaces();
  const letter = text[index];
  return isLetterV1(letter) && !isLetterV1(text[index + 1]) ? `${number}${letter}` : null;
}

/**
 * "6A", "6º ANO A", "9ANO A", "6ª SÉRIE A", "7º ano C - Matutino", "TURMA 6A" → "6A"…; null when the
 * text has no class letter ("9ANO", "6º ANO"). The first number followed by a class letter wins.
 */
export function classCodeV1(value: string): string | null {
  const text = normalized(value);
  for (let index = 0; index < text.length; index += 1) {
    if (!isDigitV1(text[index])) continue;
    const code = classCodeAtV1(text, index);
    if (code !== null) return code;
  }
  return null;
}

