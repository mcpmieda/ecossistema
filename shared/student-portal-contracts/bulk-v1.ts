import { z } from 'zod';
import { STUDENT_NAME_MAX_LENGTH_V1 } from '../student-identity/student-identity-v1';
import { instantV1, portalIdV1, versionV1 } from './core-v1';

export const BULK_REQUEST_MAX_BYTES_V1 = 65_536;
export const bulkActionV1 = z.enum(['qr-regenerate', 'password-reset', 'account-reset', 'block']);
export const bulkScopeV1 = z
  .object({
    kind: z.literal('class'),
    academicYear: z.literal(2026),
    classId: z.number().int().positive().safe(),
  })
  .strict();
const token = (max: number) =>
  z
    .string()
    .min(32)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/u);
export const bulkProofTokenV1 = token(32_768);
export const bulkCursorV1 = token(4_096);
export const bulkPreviewQueryV1 = z
  .object({
    contractVersion: z.literal(1),
    operation: z.literal('bulk-preview'),
    action: bulkActionV1,
    scope: bulkScopeV1,
    page: z
      .object({
        limit: z.number().int().min(1).max(100).default(100),
        cursor: bulkCursorV1.optional(),
      })
      .strict(),
  })
  .strict();
export const bulkPreviewItemV1 = z
  .object({
    accountId: portalIdV1,
    version: versionV1,
    classId: z.number().int().positive().safe(),
    name: z.string().max(STUDENT_NAME_MAX_LENGTH_V1),
    classLabel: z.string().max(80),
    ineligibility: z.enum(['recovery-unavailable', 'already-blocked']).nullable(),
  })
  .strict();
export const bulkPreviewResponseV1 = z
  .object({
    contractVersion: z.literal(1),
    state: z.literal('bulk-preview'),
    requestId: portalIdV1,
    action: bulkActionV1,
    scope: bulkScopeV1,
    scopeVersion: versionV1,
    totalCount: z.number().int().nonnegative().safe(),
    items: z.array(bulkPreviewItemV1).max(100),
    proof: bulkProofTokenV1,
    createdAt: instantV1,
    expiresAt: instantV1,
    nextCursor: bulkCursorV1.nullable(),
  })
  .strict();
export const bulkExecuteCommandV1 = z
  .object({
    contractVersion: z.literal(1),
    operation: z.literal('bulk-execute'),
    action: bulkActionV1,
    proof: bulkProofTokenV1,
    accountId: portalIdV1,
    expectedVersion: versionV1,
    idempotencyKey: portalIdV1,
    confirmed: z.literal(true),
  })
  .strict();
export const bulkExecuteResponseV1 = z
  .object({
    contractVersion: z.literal(1),
    state: z.literal('committed'),
    requestId: portalIdV1,
    operationId: portalIdV1,
    version: versionV1,
  })
  .strict();
export type BulkPreviewQueryV1 = z.infer<typeof bulkPreviewQueryV1>;
export type BulkExecuteCommandV1 = z.infer<typeof bulkExecuteCommandV1>;
