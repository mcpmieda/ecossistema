// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { comparePtBrNumericLabelsV1 } from '../../shared/gradebook-contracts/string-order-v1';
import {
  localDayMonthTimeTextV1,
  PT_BR_COLLATOR_V1,
  PT_BR_LOCAL_SHORT_DATE_TIME_V1,
  PT_BR_UP_TO_1_DECIMAL_V1,
  PT_BR_UP_TO_2_DECIMALS_V1,
  PT_BR_UP_TO_3_DECIMALS_V1,
  schoolDateTimeTextV1,
  schoolShortDateTimeTextV1,
} from '../../shared/locale-format-v1';
import { SCHOOL_TIME_ZONE_V1 } from '../../shared/school-time-zone-v1';

// Issue #1490, finding 1: every constant must give exactly what the per-call Intl object gave.
const labels = ['1º', '2º', '10º', 'Álgebra', 'algebra', 'Ética', 'ética', 'Etica', '1º ano B', '1º ano A', '10º ano', '', ' '];
const sign = (value: number) => Math.sign(value);
const pairs = labels.flatMap((left) => labels.map((right) => [left, right] as const));

describe('ordem pt-BR com collator reutilizado', () => {
  it('comparePtBrNumericLabelsV1 compara como localeCompare com numeric', () => {
    for (const [left, right] of pairs)
      expect(sign(comparePtBrNumericLabelsV1(left, right)), `${left} × ${right}`).toBe(
        sign(left.localeCompare(right, 'pt-BR', { numeric: true })),
      );
    const order = ['Ética', '10º', 'algebra', '2º', 'Álgebra', '1º'];
    expect([...order].sort(comparePtBrNumericLabelsV1)).toEqual(
      [...order].sort((left, right) => left.localeCompare(right, 'pt-BR', { numeric: true })),
    );
  });

  it('PT_BR_COLLATOR_V1 compara como localeCompare sem opções', () => {
    for (const [left, right] of pairs)
      expect(sign(PT_BR_COLLATOR_V1.compare(left, right)), `${left} × ${right}`).toBe(
        sign(left.localeCompare(right, 'pt-BR')),
      );
    const order = ['Ética', '10º', 'algebra', '2º', 'Álgebra', '1º'];
    expect([...order].sort((left, right) => PT_BR_COLLATOR_V1.compare(left, right))).toEqual(
      [...order].sort((left, right) => left.localeCompare(right, 'pt-BR')),
    );
  });
});

describe('números pt-BR com NumberFormat reutilizado', () => {
  const values = [0, 1, 1500, 9999, 10000, 7333, 123_456_789, -2500, 0.0004];
  it('casas decimais iguais às de toLocaleString', () => {
    for (const value of values) {
      expect(PT_BR_UP_TO_3_DECIMALS_V1.format(value / 1000)).toBe(
        (value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 }),
      );
      expect(PT_BR_UP_TO_2_DECIMALS_V1.format(value / 1000)).toBe(
        (value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 }),
      );
      expect(PT_BR_UP_TO_1_DECIMAL_V1.format(value / 1000)).toBe(
        (value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }),
      );
    }
  });
});

describe('datas pt-BR com DateTimeFormat reutilizado', () => {
  const instants = [
    '2026-11-16T10:30:00.000Z',
    '2026-01-01T02:59:59.999Z',
    '2026-02-28T23:00:00-03:00',
    '2000-02-29T12:00:00Z',
    '1969-12-31T23:59:59Z',
    0,
    1_763_300_000_000,
    new Date('2026-06-15T15:45:12Z'),
  ];
  const invalid = ['', 'não é data', Number.NaN];

  it('fuso da escola sem estilo: igual a toLocaleString com timeZone', () => {
    for (const value of [...instants, ...invalid])
      expect(schoolDateTimeTextV1(value), String(value)).toBe(
        new Date(value).toLocaleString('pt-BR', { timeZone: SCHOOL_TIME_ZONE_V1 }),
      );
    expect(schoolDateTimeTextV1('2026-11-16T10:30:00.000Z')).toBe('16/11/2026, 07:30:00');
  });

  it('fuso da escola curto: igual a toLocaleString com dateStyle/timeStyle', () => {
    for (const value of [...instants, ...invalid])
      expect(schoolShortDateTimeTextV1(value), String(value)).toBe(
        new Date(value).toLocaleString('pt-BR', {
          dateStyle: 'short',
          timeStyle: 'short',
          timeZone: SCHOOL_TIME_ZONE_V1,
        }),
      );
  });

  it('fuso do aparelho: igual ao formatter montado por chamada', () => {
    for (const value of instants) {
      const date = new Date(value);
      expect(PT_BR_LOCAL_SHORT_DATE_TIME_V1.format(date)).toBe(
        new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date),
      );
    }
    for (const value of [...instants, ...invalid])
      expect(localDayMonthTimeTextV1(value), String(value)).toBe(
        new Date(value).toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
      );
  });
});
