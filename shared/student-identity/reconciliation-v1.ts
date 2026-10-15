import { z } from 'zod';
import { studentUidV1, STUDENT_NAME_MAX_LENGTH_V1 } from './student-identity-v1';

export const RECONCILIATION_ROUTE_V1 = '/api/student-reconciliation/v1';
/** The pending count stops one past this; the Centro shows it as "50+". */
export const RECONCILIATION_PENDING_CAP_V1 = 50;
export const REPORT_MAX_ROWS_V1 = 10000;
export const REPORT_BODY_BYTES_V1 = 8 * 1024 * 1024;
const text = z.string().max(STUDENT_NAME_MAX_LENGTH_V1);
const dateCell = z.union([z.string().max(40), z.number().finite(), z.null()]);
const sourceCell = z.union([z.string().max(300), z.number().finite(), z.null()]);
export const reportRowV1 = z
  .object({
    sourceRow: z.number().int().min(2).max(10001),
    name: text,
    birthDate: dateCell,
    filiation1: text.nullable(),
    inep: sourceCell,
    enrollmentHash: text,
    classLabel: text,
    shift: text,
    stageLabel: text,
    status: text,
    enrolledAt: dateCell,
    transferredAt: dateCell,
  })
  .strict();
export type ReportRowV1 = z.infer<typeof reportRowV1>;
export const reportClassLinkV1 = z
  .object({
    classLabel: text,
    shift: text,
    stageLabel: text,
    gradebookClassId: z.number().int().positive().nullable(),
    confirmRegular: z.boolean().default(false),
  })
  .strict();
export type ReportClassLinkV1 = z.infer<typeof reportClassLinkV1>;
const revision = z.number().int().nonnegative().safe();
const base = { contractVersion: z.literal(1), academicYear: z.literal(2026) };
const mutation = {
  ...base,
  generation: z.uuid(),
  expectedRevision: revision,
  idempotencyKey: z.uuid(),
};
export const reconciliationRequestV1 = z.discriminatedUnion('operation', [
  z
    .object({
      ...base,
      operation: z.literal('list'),
      cursor: z.string().max(2000).nullable().default(null),
      classId: z.number().int().positive().nullable().default(null),
      search: z.string().max(200).default(''),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  z.object({ ...base, operation: z.literal('catalog') }).strict(),
  z.object({ ...base, operation: z.literal('pending-count') }).strict(),
  z
    .object({
      ...mutation,
      operation: z.literal('prepare'),
      normalizationVersion: z.literal(1),
      sourceFormat: z.literal('smecel-report-v1'),
      date1904: z.boolean(),
      sourceYear: z.number().int().min(1900).max(9999).nullable(),
      confirmYear: z.boolean(),
      sourceGeneratedAt: z.iso.datetime({ offset: true }).nullable(),
      rows: z.array(reportRowV1).min(1).max(REPORT_MAX_ROWS_V1),
      classLinks: z.array(reportClassLinkV1).max(200),
    })
    .strict(),
  z
    .object({
      ...mutation,
      operation: z.literal('apply'),
      batchId: z.uuid(),
      confirmDifferences: z.boolean(),
    })
    .strict(),
  z.object({ ...mutation, operation: z.literal('stage'), batchId: z.uuid() }).strict(),
  z
    .object({
      ...mutation,
      operation: z.literal('activate-pending'),
      batchId: z.uuid(),
      classLinks: z.array(reportClassLinkV1).max(200),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('detail'),
      sourceId: z.uuid().optional(),
      studentUid: studentUidV1.optional(),
    })
    .strict()
    .refine((v) => Boolean(v.sourceId) !== Boolean(v.studentUid)),
  z
    .object({
      ...mutation,
      operation: z.literal('resolve'),
      sourceId: z.uuid(),
      studentUid: studentUidV1,
      action: z.enum(['associate', 'reject', 'separate', 'release', 'confirm']),
      expectedLinkVersion: revision,
      revertsDecisionId: z.uuid().nullable().default(null),
    })
    .strict(),
  z
    .object({
      ...mutation,
      operation: z.literal('select-observation'),
      studentUid: studentUidV1,
      observationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      ...mutation,
      operation: z.literal('class-link'),
      reportClassId: z.uuid(),
      gradebookClassId: z.number().int().positive().nullable(),
    })
    .strict(),
  z
    .object({
      ...mutation,
      operation: z.literal('name-source'),
      nameSource: z.enum(['relation', 'report']),
    })
    .strict(),
]);
export type ReconciliationRequestV1 = z.infer<typeof reconciliationRequestV1>;
export type ReconciliationMutationV1 = Extract<
  ReconciliationRequestV1,
  { expectedRevision: number }
>;
export type ReconciliationPrepareV1 = Extract<ReconciliationRequestV1, { operation: 'prepare' }>;
export const reconciliationPersonV1 = z
  .object({
    kind: z.literal('person'),
    studentUid: studentUidV1,
    academicStudentId: z.number().int().positive(),
    academicYear: z.literal(2026),
    name: z.string(),
    relationName: z.string(),
    classId: z.number().int().positive().nullable(),
    classLabel: z.string().nullable(),
    version: revision,
    reconciliation: z.enum([
      'without-report',
      'pending',
      'reconciled',
      'review-required',
      'missing-current-report',
    ]),
    portal: z.enum(['with-portal', 'without-portal']),
    accountId: studentUidV1.nullable(),
    possibleSamePerson: z.boolean(),
  })
  .strict();
export const reconciliationPendingV1 = z
  .object({
    kind: z.literal('external'),
    id: z.string(),
    sourceId: z.uuid().nullable(),
    batchId: z.uuid(),
    name: z.string(),
    classLabel: z.string(),
    reason: z.string(),
    expiresAt: z.string().nullable(),
    warning: z.boolean(),
    sourceRow: z.number().int().nullable(),
  })
  .strict();
export const reconciliationListItemV1 = z.discriminatedUnion('kind', [
  reconciliationPersonV1,
  reconciliationPendingV1,
]);
export type ReconciliationListItemV1 = z.infer<typeof reconciliationListItemV1>;
export type ReconciliationContextV1 = {
  generation: string;
  revision: number;
  nameSource: 'relation' | 'report';
  relationAvailable: boolean;
};
export type ReconciliationValidationErrorV1 = {
  sourceRow: number;
  name: string;
  classLabel: string;
  field: 'birthDate' | 'inep' | 'enrolledAt' | 'transferredAt' | 'class';
  reason: string;
};
export type ReconciliationResponseV1 =
  | {
      contractVersion: 1;
      state: 'ready';
      operation: 'catalog';
      context: ReconciliationContextV1;
      classes: { id: number; label: string; stage: number }[];
      reportClasses: {
        id: string;
        label: string;
        shift: string;
        stageLabel: string;
        classId: number | null;
        reviewRequired: boolean;
      }[];
    }
  | {
      contractVersion: 1;
      state: 'ready';
      operation: 'pending-count';
      /** Rows of the pending view (an external row, or a student not reconciled), capped at 51. */
      pending: number;
    }
  | {
      contractVersion: 1;
      state: 'ready';
      operation: 'list';
      context: ReconciliationContextV1;
      items: ReconciliationListItemV1[];
      nextCursor: string | null;
    }
  | {
      contractVersion: 1;
      state: 'ready';
      operation: 'prepare' | 'activate-pending';
      context: ReconciliationContextV1;
      batchId: string;
      batchState: 'awaiting_relation' | 'review_required' | 'preparing';
      expiresAt: string;
      differences: string[];
      counts: { rows: number; linked: number; pending: number };
      credentialsReady: boolean;
    }
  | { contractVersion: 1; state: 'ready'; operation: 'stage'; ready: boolean; remaining: number }
  | {
      contractVersion: 1;
      state: 'ready';
      operation: 'detail';
      context: ReconciliationContextV1;
      selectedObservationId: string | null;
      sources: {
        id: string;
        name: string;
        birthDate: string;
        filiation1: string | null;
        inep: string | null;
        classLabel: string;
        studentUid: string | null;
        version: number;
        observationId: string;
        decisionId: string | null;
        reviewRequired: boolean;
      }[];
      candidates: { studentUid: string; name: string; classLabel: string }[];
      history: { id: string; action: string; at: string; reason: string; version: number }[];
    }
  | {
      contractVersion: 1;
      state: 'committed';
      context: ReconciliationContextV1;
      operationId: string;
    }
  | { contractVersion: 1; state: 'validation-failed'; errors: ReconciliationValidationErrorV1[] }
  | {
      contractVersion: 1;
      state: 'conflict' | 'invalid-request' | 'not-authorized' | 'unavailable' | 'expired';
      reason?: string;
    };

const reconciliationContextV1 = z
  .object({
    generation: z.uuid(),
    revision,
    nameSource: z.enum(['relation', 'report']),
    relationAvailable: z.boolean(),
  })
  .strict();
export const reconciliationResponseV1: z.ZodType<ReconciliationResponseV1> = z.union([
  z
    .object({
      contractVersion: z.literal(1),
      state: z.literal('ready'),
      operation: z.literal('catalog'),
      context: reconciliationContextV1,
      classes: z
        .array(
          z
            .object({ id: z.number().int().positive(), label: z.string(), stage: z.number().int() })
            .strict(),
        )
        .max(200),
      reportClasses: z
        .array(
          z
            .object({
              id: z.string().min(1).max(200),
              label: z.string(),
              shift: z.string(),
              stageLabel: z.string(),
              classId: z.number().int().positive().nullable(),
              reviewRequired: z.boolean(),
            })
            .strict(),
        )
        .max(200),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      state: z.literal('ready'),
      operation: z.literal('pending-count'),
      pending: z.number().int().min(0).max(RECONCILIATION_PENDING_CAP_V1 + 1),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      state: z.literal('ready'),
      operation: z.literal('list'),
      context: reconciliationContextV1,
      items: z.array(reconciliationListItemV1).max(100),
      nextCursor: z.string().max(2000).nullable(),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      state: z.literal('ready'),
      operation: z.enum(['prepare', 'activate-pending']),
      context: reconciliationContextV1,
      batchId: z.uuid(),
      batchState: z.enum(['awaiting_relation', 'review_required', 'preparing']),
      expiresAt: z.string(),
      differences: z.array(z.string()),
      counts: z.object({ rows: revision, linked: revision, pending: revision }).strict(),
      credentialsReady: z.boolean(),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      state: z.literal('ready'),
      operation: z.literal('stage'),
      ready: z.boolean(),
      remaining: revision,
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      state: z.literal('ready'),
      operation: z.literal('detail'),
      context: reconciliationContextV1,
      selectedObservationId: z.uuid().nullable(),
      sources: z.array(
        z
          .object({
            id: z.uuid(),
            name: z.string(),
            birthDate: z.string(),
            filiation1: z.string().nullable(),
            inep: z.string().nullable(),
            classLabel: z.string(),
            studentUid: studentUidV1.nullable(),
            version: revision,
            observationId: z.uuid(),
            decisionId: z.uuid().nullable(),
            reviewRequired: z.boolean(),
          })
          .strict(),
      ),
      candidates: z.array(
        z.object({ studentUid: studentUidV1, name: z.string(), classLabel: z.string() }).strict(),
      ),
      history: z.array(
        z
          .object({
            id: z.uuid(),
            action: z.string(),
            at: z.string(),
            reason: z.string(),
            version: revision,
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      state: z.literal('committed'),
      context: reconciliationContextV1,
      operationId: z.string(),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      state: z.literal('validation-failed'),
      errors: z.array(
        z
          .object({
            sourceRow: z.number().int(),
            name: z.string(),
            classLabel: z.string(),
            field: z.enum(['birthDate', 'inep', 'enrolledAt', 'transferredAt', 'class']),
            reason: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      state: z.enum(['conflict', 'invalid-request', 'not-authorized', 'unavailable', 'expired']),
      reason: z.string().optional(),
    })
    .strict(),
]);

/** Internal consumer: a UID is returned only for an unambiguous central decision. */
export type ReconciliationSourceEvidenceV1 = {
  academicYear: 2026;
  sourceSnapshotRef: string;
  sourceRecordRef: string;
  name: string;
  classLabel: string;
  inep?: string;
  birthDate?: string;
  filiation1?: string;
};
export type ReconciliationSourceResolutionV1 =
  | {
      state: 'resolved';
      studentUid: string;
      sourceIds: string[];
      decisionVersion: number;
      observationIds: string[];
    }
  | { state: 'ambiguous' | 'not_found'; decisionVersion: number };
