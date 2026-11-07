import { z } from 'zod';

export const portalAcademicLinkSchemaV1 = z
  .object({
    academicYear: z.literal(2026),
    studentId: z.number().int().positive().safe(),
  })
  .strict();
// Durable generation + counter: never reset/reuse a version after reset or restore.
export const academicVersionSchemaV1 = z.string().regex(/^[a-f0-9]{32}:[1-9]\d{0,19}$/u);
export const academicRevisionSchemaV1 = z
  .object({
    contractVersion: z.literal(1),
    academicYear: z.literal(2026),
    dataVersion: academicVersionSchemaV1,
  })
  .strict();
export type PortalAcademicLinkV1 = z.infer<typeof portalAcademicLinkSchemaV1>;

export const academicRevisionEventSchemaV1 = z
  .object({
    ...academicRevisionSchemaV1.shape,
    eventId: z.uuid(),
    cause: z.enum(['relation', 'marks', 'council', 'academic-policy']),
    // Year-wide invalidation avoids incomplete affected-student lists.
    scope: z.literal('academic-year'),
  })
  .strict();
