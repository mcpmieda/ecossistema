// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { declaredTermV1 } from '../../../src/features/gradebook/import/audit-rules-v1';

/** The former reading, kept here only as the oracle: same answers, now without backtracking. */
function formerDeclaredTerm(value: string): number | null {
  const text = value.normalize('NFD').replace(/[̀-ͯ]/gu, '').toUpperCase().replace(/\s+/gu, ' ').trim();
  // The old expression on purpose (short inputs only): it is what the new reader must match.
  const match = /\b(III|II|I|[123])\s*(?:º|°|O)?\s*TRIM/u.exec(text); // NOSONAR
  if (!match) return null;
  return ({ I: 1, II: 2, III: 3, 1: 1, 2: 2, 3: 3 } as Record<string, number>)[match[1]!] ?? null;
}

describe('the term named in K4', () => {
  it('reads the usual headers', () => {
    expect(declaredTermV1('II TRIMESTRE')).toBe(2);
    expect(declaredTermV1('3º trimestre')).toBe(3);
    expect(declaredTermV1('1° TRIM.')).toBe(1);
    expect(declaredTermV1('III TRIMESTRE 2026')).toBe(3);
    expect(declaredTermV1('IIII TRIMESTRE')).toBeNull();
    expect(declaredTermV1('RECUPERAÇÃO')).toBeNull();
  });

  it('answers exactly as the former expression, for many generated headers', () => {
    const alphabet = ['I', 'I', 'I', '1', '2', '3', '4', ' ', ' ', 'º', '°', 'O', 'TRIM', 'TRIMESTRE', 'A', '_', 'X', '\t', 'ESTRE'];
    let seed = 20261114;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 20000; round += 1) {
      const length = 1 + Math.floor(random() * 9);
      const text = Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]!).join('');
      expect(declaredTermV1(text), JSON.stringify(text)).toBe(formerDeclaredTerm(text));
    }
  });
});
