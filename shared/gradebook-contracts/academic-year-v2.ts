/** Academic years materialized from an imported master Relation. */
export const GRADEBOOK_ACADEMIC_YEAR_MIN_V2 = 2000;
export const GRADEBOOK_ACADEMIC_YEAR_MAX_V2 = 9999;

export function isGradebookAcademicYearV2(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    Number(value) >= GRADEBOOK_ACADEMIC_YEAR_MIN_V2 &&
    Number(value) <= GRADEBOOK_ACADEMIC_YEAR_MAX_V2;
}
