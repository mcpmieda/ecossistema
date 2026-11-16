import { z } from 'zod';
import {
  GRADEBOOK_ACADEMIC_YEAR_MAX_V2,
  GRADEBOOK_ACADEMIC_YEAR_MIN_V2,
} from '../academic-year-v2';
import {
  GRADEBOOK_IMPORT_DIAGNOSTIC_CODES_V1,
  GRADEBOOK_IMPORT_DIAGNOSTIC_FIELD_KINDS_V1,
  GRADEBOOK_IMPORT_DIAGNOSTIC_SEVERITIES_V1,
} from '../imports/import-diagnostics-v1';

export const IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1 = 1 as const;
export const IMPORT_DIAGNOSTIC_TREATMENT_ACTIONS_V1 = Object.freeze({
  acknowledged: 1,
  note: 2,
} as const);
export const IMPORT_DIAGNOSTIC_TREATMENT_ACTION_LABELS_V1 = Object.freeze({
  1: 'RECONHECIDO',
  2: 'ANOTAÇÃO',
} as const);
export const IMPORT_DIAGNOSTIC_TREATMENT_LIMITS_V1 = Object.freeze({
  contextFindings: 200,
  contextActions: 1_000,
  historyPage: 100,
  noteCharacters: 2_000,
  bodyBytes: 96_000,
});

const year = z
  .number()
  .int()
  .min(GRADEBOOK_ACADEMIC_YEAR_MIN_V2)
  .max(GRADEBOOK_ACADEMIC_YEAR_MAX_V2);
const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const boundedText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !value.includes('\0'));
const fileName = boundedText(255);
const findingKey = boundedText(320);
const idempotencyKey = z
  .string()
  .min(8)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const note = z
  .string()
  .trim()
  .min(3)
  .max(IMPORT_DIAGNOSTIC_TREATMENT_LIMITS_V1.noteCharacters)
  .refine((value) => !value.includes('\0'));
const action = z.union([
  z.literal(IMPORT_DIAGNOSTIC_TREATMENT_ACTIONS_V1.acknowledged),
  z.literal(IMPORT_DIAGNOSTIC_TREATMENT_ACTIONS_V1.note),
]);
const findingIdentity = z.object({ fileName, key: findingKey }).strict();
const historyCursor = z.object({ recordedAt: z.string().datetime({ offset: true }), id }).strict();

export const importDiagnosticTreatmentRequestSchemaV1 = z
  .discriminatedUnion('operation', [
    z
      .object({
        contractVersion: z.literal(IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1),
        operation: z.literal('context'),
        year,
        findings: z
          .array(findingIdentity)
          .min(1)
          .max(IMPORT_DIAGNOSTIC_TREATMENT_LIMITS_V1.contextFindings),
      })
      .strict(),
    z
      .object({
        contractVersion: z.literal(IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1),
        operation: z.literal('history'),
        year,
        limit: z.number().int().min(1).max(IMPORT_DIAGNOSTIC_TREATMENT_LIMITS_V1.historyPage),
        cursor: historyCursor.nullable(),
      })
      .strict(),
    z
      .object({
        contractVersion: z.literal(IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1),
        operation: z.literal('record'),
        year,
        diagnosticId: id,
        action,
        note: note.nullable(),
        idempotencyKey,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.operation === 'context') {
      const identities = value.findings.map((item) => `${item.fileName}\0${item.key}`);
      if (new Set(identities).size !== identities.length) {
        context.addIssue({ code: 'custom', path: ['findings'], message: 'duplicate finding' });
      }
    }
    if (value.operation === 'record') {
      const noteMatchesAction =
        (value.action === IMPORT_DIAGNOSTIC_TREATMENT_ACTIONS_V1.acknowledged &&
          value.note === null) ||
        (value.action === IMPORT_DIAGNOSTIC_TREATMENT_ACTIONS_V1.note && value.note !== null);
      if (!noteMatchesAction) {
        context.addIssue({ code: 'custom', path: ['note'], message: 'note/action mismatch' });
      }
    }
  });

export type ImportDiagnosticTreatmentRequestV1 = z.infer<
  typeof importDiagnosticTreatmentRequestSchemaV1
>;
export type ImportDiagnosticTreatmentActionV1 = z.infer<typeof action>;
export type ImportDiagnosticTreatmentHistoryCursorV1 = z.infer<typeof historyCursor>;

const treatmentRecord = z
  .object({
    id,
    diagnosticSourceId: id,
    academicYear: year,
    fileName,
    diagnosticHash: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/u),
    key: findingKey,
    severity: z.enum(GRADEBOOK_IMPORT_DIAGNOSTIC_SEVERITIES_V1),
    code: z.enum(GRADEBOOK_IMPORT_DIAGNOSTIC_CODES_V1),
    classCode: boundedText(24).nullable(),
    subject: boundedText(160).nullable(),
    period: boundedText(64).nullable(),
    studentNumber: z.number().int().min(1).max(32_767).nullable(),
    studentName: boundedText(240).nullable(),
    fieldKind: z.enum(GRADEBOOK_IMPORT_DIAGNOSTIC_FIELD_KINDS_V1),
    fieldLabel: boundedText(240).nullable(),
    action,
    actionLabel: z.enum(['RECONHECIDO', 'ANOTAÇÃO']),
    note: note.nullable(),
    recordedAt: z.string().datetime({ offset: true }),
    current: z.boolean(),
  })
  .strict();

export type ImportDiagnosticTreatmentRecordV1 = z.infer<typeof treatmentRecord>;

const failureState = z.enum([
  'invalid-request',
  'not-authorized',
  'not-found',
  'unavailable',
  'idempotency-conflict',
  'scope-too-large',
]);
export type ImportDiagnosticTreatmentFailureV1 = z.infer<typeof failureState>;

export const importDiagnosticTreatmentResponseSchemaV1 = z.union([
  z
    .object({
      contractVersion: z.literal(IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1),
      state: failureState,
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1),
      state: z.literal('ready'),
      operation: z.literal('context'),
      items: z.array(treatmentRecord).max(IMPORT_DIAGNOSTIC_TREATMENT_LIMITS_V1.contextActions),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1),
      state: z.literal('ready'),
      operation: z.literal('history'),
      items: z.array(treatmentRecord).max(IMPORT_DIAGNOSTIC_TREATMENT_LIMITS_V1.historyPage),
      nextCursor: historyCursor.nullable(),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1),
      state: z.literal('ready'),
      operation: z.literal('record'),
      item: treatmentRecord,
    })
    .strict(),
]);

export type ImportDiagnosticTreatmentResponseV1 = z.infer<
  typeof importDiagnosticTreatmentResponseSchemaV1
>;
