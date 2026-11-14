// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classCodeV1 } from '../../../src/features/gradebook/import/class-code-v1';

/** The expression the issue #1426 (finding 4) proposed and validated, kept only as the oracle. */
function proposedClassCode(value: string): string | null {
  const text = value.normalize('NFD').replace(/[̀-ͯ]/gu, '').toUpperCase().replace(/\s+/gu, ' ').trim();
  const match = /(\d{1,2})\s*[º°ª]?\s*(?:ANO|SERIE)?\s*[-–.]?\s*([A-Z])(?![A-Z])/u.exec(text); // NOSONAR: oracle only
  return match ? `${match[1]}${match[2]}` : null;
}

describe('class code read from K3 and from the sheet name', () => {
  it('reads every way a class is written in the workbooks', () => {
    const cases: Array<[string, string | null]> = [
      ['6A', '6A'], ['6º ANO A', '6A'], ['6 A', '6A'], ['9ANO A', '9A'], ['9ºANO B', '9B'], ['7º ano C - Matutino', '7C'],
      ['6° ANO A', '6A'], ['6ª SÉRIE A', '6A'], ['TURMA 6A', '6A'], ['8A TARDE', '8A'], ['8º A (VESPERTINO)', '8A'],
      ['6º ANO - A', '6A'], ['6A1º', '6A'], ['9ANO', null], ['6º ANO', null], ['', null],
    ];
    for (const [text, code] of cases) expect(classCodeV1(text), text).toBe(code);
  });

  it('answers as the validated expression, for many generated headers', () => {
    const alphabet = ['6', '9', '1', '0', 'º', '°', 'ª', ' ', ' ', 'ANO', 'SÉRIE', 'SERIE', '-', '–', '.', 'A', 'B', 'E', 'O', 'TURMA', '(', ')'];
    let seed = 1426;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 20000; round += 1) {
      const length = 1 + Math.floor(random() * 8);
      const text = Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]!).join('');
      expect(classCodeV1(text), JSON.stringify(text)).toBe(proposedClassCode(text));
    }
  });
});
