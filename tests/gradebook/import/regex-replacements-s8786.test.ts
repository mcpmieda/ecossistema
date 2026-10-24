import { describe, expect, it } from 'vitest';
import { parseRelationStatusV9 } from '../../../src/features/gradebook/import/master-relation-v9';
import { withoutTrailingYearV1 } from '../../../src/features/gradebook/import/spreadsheet-recognizer';

// The backtracking regular expressions replaced for Sonar S8786, kept here to prove the same result.
function relationStatusBefore(status: string) {
  const foi = status.match(/^FOI\s+PARA(?:\s+O)?\s+(.+)$/u);
  if (foi?.[1]) return [6, foi[1].trim().toUpperCase()];
  const estava = status.match(/^ESTAVA\s+NO\s+(.+)$/u);
  if (estava?.[1]) return [7, estava[1].trim().toUpperCase()];
  return null;
}
function relationStatusAfter(raw: string) {
  try {
    const value = parseRelationStatusV9(raw);
    return value[0] === 6 || value[0] === 7 ? [...value] : null;
  } catch {
    return null;
  }
}

function texts(alphabet: readonly string[], count: number, length: number) {
  let seed = 11;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: next() % length }, () => alphabet[next() % alphabet.length]).join(''),
  );
}

describe('regular expressions replaced for S8786', () => {
  it('reads the transfer statuses as before', () => {
    const words = ['FOI', 'PARA', 'O', 'ESTAVA', 'NO', '6º', 'ANO', 'A', 'OLIVEIRA', ' ', '  '];
    const cases = [
      'FOI PARA O 6º ANO A',
      'FOI PARA 6º ANO',
      'FOI PARA O',
      'FOI PARA OLIVEIRA',
      'FOI PARA  O  X',
      'ESTAVA NO 7º ANO B',
      ...texts(words, 4000, 7).map((parts) => parts.trim()),
    ];
    for (const status of cases) {
      // parseRelationStatusV9 normalizes first; compare on texts that normalization keeps as they are.
      if (status !== status.trim() || /\s{2,}/u.test(status)) continue;
      expect(relationStatusAfter(status), status).toEqual(relationStatusBefore(status));
    }
  });

  it('drops a trailing year and its separators as before', () => {
    const characters = ['M', 'A', ' ', '-', '–', '—', '_', ':', '2', '0', '1', '9', '\t', ' '];
    for (const text of [
      ...texts(characters, 20000, 14),
      'MARIA - 2026',
      'X - - 2024',
      '2026',
      'NOTAS 2025 ',
    ]) {
      expect(withoutTrailingYearV1(text), JSON.stringify(text)).toBe(
        text.replace(/\s*[-–—_:]*\s*20\d{2}\s*$/u, ''),
      );
    }
  });

  it('refuses a fraction of a second as before', () => {
    const before = (value: string) => /\.\d*[1-9]\d*(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
    const after = (value: string) => {
      const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/u.exec(value)?.[1];
      return fraction !== undefined && /[1-9]/u.test(fraction);
    };
    const characters = ['.', '0', '5', 'Z', '+', '-', ':', '1', 'T'];
    for (const value of [
      ...texts(characters, 20000, 12),
      '2026-01-01T00:00:00.500Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.10-03:00',
    ]) {
      expect(after(value), value).toBe(before(value));
    }
  });
});
