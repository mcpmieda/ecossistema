// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  bulletinGradeTextV2,
  bulletinRecoveryGradeTextV2,
} from '../../../src/features/gradebook/bulletins/bulletin-format-v2';

// The two copies removed from the page and the PDF renderer (issue #1490, findings 1 and 3e).
function previousGrade(value: number | null): string {
  return value === null
    ? '—'
    : (value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}
function previousRecoveryGrade(value: number | 'NC' | 'RR' | null): string {
  if (value === 'NC') return 'N/C';
  if (value === 'RR') return 'R/R';
  return previousGrade(value);
}

describe('Boletim: uma formatação de nota para tela e PDF', () => {
  it('mostra cada nota como antes', () => {
    for (const value of [0, 1, 1500, 9999, 10000, 7333, 100, 6000, 9500, 10_000_000, null])
      expect(bulletinGradeTextV2(value), String(value)).toBe(previousGrade(value));
    expect([0, 1, 1500, 9999, 10000, 7333].map(bulletinGradeTextV2)).toEqual([
      '0',
      '0,001',
      '1,5',
      '9,999',
      '10',
      '7,333',
    ]);
  });

  it('mantém N/C, R/R e ausência na recuperação', () => {
    for (const value of ['NC', 'RR', null, 0, 5500, 7333] as const)
      expect(bulletinRecoveryGradeTextV2(value), String(value)).toBe(previousRecoveryGrade(value));
    expect(bulletinRecoveryGradeTextV2('NC')).toBe('N/C');
    expect(bulletinRecoveryGradeTextV2('RR')).toBe('R/R');
    expect(bulletinRecoveryGradeTextV2(null)).toBe('—');
  });
});
