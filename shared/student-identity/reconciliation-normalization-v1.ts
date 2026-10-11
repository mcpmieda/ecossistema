/** The comparison contract shared by report preview and the authoritative server. */
export const STUDENT_RECONCILIATION_NORMALIZATION_VERSION_V1 = 1 as const;

export function normalizeStudentNameV1(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toUpperCase();
}

export function reportClassReferenceV1(label: string, shift: string, stage: string): string {
  return JSON.stringify([
    normalizeStudentNameV1(label),
    normalizeStudentNameV1(shift),
    normalizeStudentNameV1(stage),
  ]);
}

export type CivilDateResultV1 =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly reason: 'missing' | 'invalid' | 'future' };

function civilDateV1(year: number, month: number, day: number): string | null {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]!) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Dates are civil values: UTC is used only for Excel's integer day arithmetic. */
export function parseCivilDateV1(
  value: string | number | null,
  date1904: boolean,
  today: string,
  required: boolean,
): CivilDateResultV1 {
  if (value === null || (typeof value === 'string' && value.trim() === '')) {
    return required ? { ok: false, reason: 'missing' } : { ok: true, value: null };
  }
  let result: string | null = null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < (date1904 ? 0 : 1) || value > 2958465) {
      return { ok: false, reason: 'invalid' };
    }
    if (!date1904 && value === 60) return { ok: false, reason: 'invalid' };
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
    const days = !date1904 && value > 60 ? value - 1 : value;
    const date = new Date(epoch + days * 86_400_000);
    result = civilDateV1(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  } else {
    const text = value.trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
    const local = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(text);
    if (iso) result = civilDateV1(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    else if (local) result = civilDateV1(Number(local[3]), Number(local[2]), Number(local[1]));
  }
  if (!result) return { ok: false, reason: 'invalid' };
  if (result > today) return { ok: false, reason: 'future' };
  return { ok: true, value: result };
}

export type InepResultV1 =
  | { readonly ok: true; readonly value: string | null; readonly key: string | null }
  | { readonly ok: false; readonly reason: 'invalid' };

export function normalizeInepV1(value: string | number | null): InepResultV1 {
  if (value === null) return { ok: true, value: null, key: null };
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    return { ok: false, reason: 'invalid' };
  }
  const original = String(value).trim();
  if (original === '') return { ok: true, value: null, key: null };
  const key = original.replace(/[.\s]/gu, '');
  return /^\d+$/u.test(key) ? { ok: true, value: original, key } : { ok: false, reason: 'invalid' };
}

export type ReportClassClassificationV1 =
  | {
      readonly kind: 'regular';
      readonly stage: 6 | 7 | 8 | 9;
      readonly academicYear: number;
      readonly classKey: string;
      readonly shiftKey: 'MATUTINO' | 'VESPERTINO';
    }
  | { readonly kind: 'excluded' | 'unknown' };

/** V1 accepts the source labels verified for the regular final years. */
export function classifyReportClassV1(
  classLabel: string,
  stageLabel: string,
  shift: string,
): ReportClassClassificationV1 {
  const classKey = normalizeStudentNameV1(classLabel);
  const stageKey = normalizeStudentNameV1(stageLabel);
  const shiftKey = normalizeStudentNameV1(shift);
  if (/\b(?:MULTIFUNCIONAL|AEE)\b|ATIVIDADE COMPLEMENTAR/u.test(`${classKey} ${stageKey}`)) {
    return { kind: 'excluded' };
  }
  const label = /^([6-9])([A-Z]) (\d{4})\s*-\s*(MATUTINO|VESPERTINO)$/u.exec(classKey);
  const stage = /^ENSINO FUNDAMENTAL DE 9 ANOS - ([6-9])º ANO$/u.exec(stageKey);
  if (!label || !stage || label[1] !== stage[1] || label[4] !== shiftKey) {
    return { kind: 'unknown' };
  }
  return {
    kind: 'regular',
    stage: Number(stage[1]) as 6 | 7 | 8 | 9,
    academicYear: Number(label[3]),
    classKey,
    shiftKey: shiftKey as 'MATUTINO' | 'VESPERTINO',
  };
}
