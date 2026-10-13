import { z } from 'zod';
import {
  GRADEBOOK_ACADEMIC_YEAR_MAX_V2,
  GRADEBOOK_ACADEMIC_YEAR_MIN_V2,
} from '../academic-year-v2';

export const YEAR_RESET_CONTRACT_VERSION_V1 = 1 as const;
export const YEAR_RESET_BODY_BYTES_V1 = 2_048;

const year = z
  .number()
  .int()
  .min(GRADEBOOK_ACADEMIC_YEAR_MIN_V2)
  .max(GRADEBOOK_ACADEMIC_YEAR_MAX_V2);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const yearResetCountsSchemaV1 = z
  .object({
    academicYear: count,
    students: count,
    classes: count,
    teachers: count,
    subjects: count,
    bindings: count,
    offers: count,
    assessments: count,
    grades: count,
    closures: count,
    imports: count,
    diagnostics: count,
    auditTrail: count,
    council: count,
    bulletins: count,
    histories: count,
    reconciliation: count,
    totalRows: count,
  })
  .strict();

export type YearResetCountsV1 = z.infer<typeof yearResetCountsSchemaV1>;

const revision = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/u);

export const yearResetRequestSchemaV1 = z.discriminatedUnion('operation', [
  z
    .object({
      contractVersion: z.literal(YEAR_RESET_CONTRACT_VERSION_V1),
      operation: z.literal('preview'),
      year,
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(YEAR_RESET_CONTRACT_VERSION_V1),
      operation: z.literal('execute'),
      year,
      previewRevision: revision,
      confirmationPhrase: z.string().min(11).max(12),
      understandsIrreversible: z.literal(true),
    })
    .strict(),
]);

export type YearResetRequestV1 = z.infer<typeof yearResetRequestSchemaV1>;

const failureState = z.enum([
  'invalid-request',
  'not-authorized',
  'not-found',
  'preview-changed',
  'portal-linked-accounts',
  'unavailable',
]);
export type YearResetFailureV1 = z.infer<typeof failureState>;

export const yearResetResponseSchemaV1 = z.union([
  z
    .object({
      contractVersion: z.literal(YEAR_RESET_CONTRACT_VERSION_V1),
      state: failureState,
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(YEAR_RESET_CONTRACT_VERSION_V1),
      state: z.literal('ready'),
      operation: z.literal('preview'),
      year,
      counts: yearResetCountsSchemaV1,
      previewRevision: revision,
      confirmationPhrase: z.string().min(11).max(12),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(YEAR_RESET_CONTRACT_VERSION_V1),
      state: z.literal('ready'),
      operation: z.literal('execute'),
      year,
      deletedRows: count,
    })
    .strict(),
]);

export type YearResetResponseV1 = z.infer<typeof yearResetResponseSchemaV1>;

export function confirmationPhraseForYearResetV1(academicYear: number): string {
  return `RESETAR ${String(academicYear)}`;
}
