import { z } from 'zod';
import {
  GRADEBOOK_ACADEMIC_YEAR_MIN_V2,
  GRADEBOOK_ACADEMIC_YEAR_MAX_V2,
} from '../academic-year-v2';

export const ASSESSMENT_NAME_KEYS_V1 = ['1:1', '1:2', '2:1', '2:2', '3:1', '3:2'] as const;
const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) =>
      !Array.from(value).some((char) => char.codePointAt(0)! < 32 || char.codePointAt(0)! === 127),
    'Invalid assessment label',
  );
export const assessmentNamesSchemaV1 = z
  .object({
    '1:1': name.optional(),
    '1:2': name.optional(),
    '2:1': name.optional(),
    '2:2': name.optional(),
    '3:1': name.optional(),
    '3:2': name.optional(),
  })
  .strict();
export type AssessmentNamesV1 = z.infer<typeof assessmentNamesSchemaV1>;
const year = z
  .number()
  .int()
  .min(GRADEBOOK_ACADEMIC_YEAR_MIN_V2)
  .max(GRADEBOOK_ACADEMIC_YEAR_MAX_V2);
const version = z.number().int().nonnegative().safe();
export const assessmentNamesRequestSchemaV1 = z.discriminatedUnion('operation', [
  z.object({ contractVersion: z.literal(1), operation: z.literal('read'), year }).strict(),
  z
    .object({
      contractVersion: z.literal(1),
      operation: z.literal('save'),
      year,
      expectedVersion: version,
      names: assessmentNamesSchemaV1,
    })
    .strict(),
]);
export const assessmentNamesResponseSchemaV1 = z.union([
  z
    .object({
      contractVersion: z.literal(1),
      state: z.literal('ready'),
      year,
      version,
      names: assessmentNamesSchemaV1,
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      state: z.enum(['invalid-request', 'not-authorized', 'not-found', 'conflict', 'unavailable']),
    })
    .strict(),
]);
export type AssessmentNamesRequestV1 = z.infer<typeof assessmentNamesRequestSchemaV1>;
export type AssessmentNamesResponseV1 = z.infer<typeof assessmentNamesResponseSchemaV1>;
export type AssessmentNamesReadyV1 = Extract<AssessmentNamesResponseV1, { state: 'ready' }>;

/** Labels never change an instrument's identity or its academic calculation. */
export function assessmentLabelV1(
  slot: number,
  term: number,
  names: AssessmentNamesV1 = {},
  sourceLabel?: string | null,
): string {
  const key = `${term}:${slot}` as keyof AssessmentNamesV1;
  if ((slot === 1 || slot === 2) && names[key]) return names[key]!;
  if (sourceLabel?.trim()) return sourceLabel.trim();
  if (slot === 1) {
    return 'Avaliação 1';
  }
  if (slot === 2) {
    return 'Avaliação 2';
  }
  if (slot === 3) {
    return 'Prova paralela';
  }
  return `Atividade ${slot - 10}`;
}

export function sameAssessmentNamesV1(left: AssessmentNamesV1, right: AssessmentNamesV1): boolean {
  return ASSESSMENT_NAME_KEYS_V1.every((key) => left[key] === right[key]);
}
