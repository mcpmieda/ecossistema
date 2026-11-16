import { PT_BR_UP_TO_3_DECIMALS_V1 } from '../../../../shared/locale-format-v1';

/** A mark in thousandths as the Boletim shows it, on screen and in the PDF (one copy for both). */
export function bulletinGradeTextV2(value: number | null): string {
  return value === null ? '—' : PT_BR_UP_TO_3_DECIMALS_V1.format(value / 1000);
}

/** A recovery mark, or the N/C and R/R markers. */
export function bulletinRecoveryGradeTextV2(value: number | 'NC' | 'RR' | null): string {
  if (value === 'NC') return 'N/C';
  if (value === 'RR') return 'R/R';
  return bulletinGradeTextV2(value);
}
