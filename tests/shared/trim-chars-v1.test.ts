import { describe, expect, it } from 'vitest';
import { trimCharsV1, trimEndCharsV1, trimStartCharsV1 } from '../../shared/trim-chars-v1';

// Every replacement must give exactly what the regular expression it replaces gave.
const alphabet = ['=', '.', ' ', '-', 'a', 'Z', '0', '\t', 'é'];
function samples(count: number) {
  let seed = 7;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: next() % 12 }, () => alphabet[next() % alphabet.length]).join(''),
  );
}

describe('trim chars v1', () => {
  it('matches the regular expressions it replaces', () => {
    for (const value of samples(5000)) {
      expect(trimEndCharsV1(value, '=')).toBe(value.replace(/=+$/u, ''));
      expect(trimEndCharsV1(value, '. ')).toBe(value.replace(/[. ]+$/u, ''));
      expect(trimEndCharsV1(value, '.')).toBe(value.replace(/[.]+$/u, ''));
      expect(trimCharsV1(value, '. -')).toBe(value.replaceAll(/^[. -]+|[. -]+$/gu, ''));
      expect(trimCharsV1(value, ' ')).toBe(value.replace(/^ +| +$/gu, ''));
      expect(trimStartCharsV1(value, ' ')).toBe(value.replace(/^ +/u, ''));
    }
  });

  it('keeps a text without those characters and empties a text made only of them', () => {
    expect(trimEndCharsV1('abc', '=')).toBe('abc');
    expect(trimEndCharsV1('===', '=')).toBe('');
    expect(trimCharsV1('', '. -')).toBe('');
  });
});
