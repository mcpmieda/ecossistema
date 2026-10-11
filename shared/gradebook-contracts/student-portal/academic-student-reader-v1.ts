import { z } from 'zod';
import { STUDENT_NAME_MAX_LENGTH_V1 } from '../../student-identity/student-identity-v1';
import { academicMeetsMinimumSchemaV1 } from './academic-presentation-v1';
import {
  academicVersionSchemaV1,
  portalAcademicLinkSchemaV1,
  type PortalAcademicLinkV1,
} from './academic-revision-v1';

const milli = z.number().int().nonnegative().safe();
export const academicMarkSchemaV1 = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('score'),
      valueMilli: milli,
      maximumMilli: milli.positive().nullable(),
      // Supplied by BN presentation; consumers must not recompute a threshold.
      meetsMinimum: academicMeetsMinimumSchemaV1,
    })
    .strict(),
  z.object({ kind: z.literal('absent') }).strict(),
  z.object({ kind: z.literal('nc') }).strict(),
  z.object({ kind: z.literal('rr') }).strict(),
  z.object({ kind: z.literal('recovery-pending') }).strict(),
]);
const id = z.number().int().positive().safe();
const label = z.string().min(1).max(120);
export const academicSubjectSchemaV1 = z
  .object({
    subjectId: id,
    label,
    order: z.number().int().nonnegative().safe(),
    periods: z
      .array(
        z
          .object({
            period: z.enum(['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3']),
            final: academicMarkSchemaV1,
            partials: z
              .array(
                z
                  .object({
                    assessmentId: id,
                    label,
                    mark: academicMarkSchemaV1,
                    notDone: z.literal(true).optional(),
                    parallel: z.literal(true).optional(),
                    assessment: z.literal(true).optional(),
                  })
                  .strict()
                  .refine(
                    (value) => !value.notDone || value.mark.kind === 'absent',
                    'Observation/value mismatch',
                  ),
              )
              // AV1, AV2, parallel recovery and ten qualitative activities.
              .max(13)
              .optional(),
          })
          .strict(),
      )
      .max(6),
    // U is an official fact; never use a computed replacement if missing.
    officialAnnual: academicMarkSchemaV1,
    officialOutcome: z.enum(['approved', 'failed', 'failed-attendance']).optional(),
    // Official per-component classification from the BN engine; absent while in progress.
    annualSituation: z
      .enum([
        'recovery-pending',
        'approved-direct',
        'approved-after-recovery',
        'not-approved',
        'failed-no-show',
        'failed-repeat',
      ])
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.periods.map((p) => p.period)).size !== value.periods.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate period', path: ['periods'] });
    for (const [index, period] of value.periods.entries()) {
      if (
        period.period.startsWith('T') &&
        ['nc', 'rr', 'recovery-pending'].includes(period.final.kind)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Recovery marker outside REC',
          path: ['periods', index, 'final'],
        });
      if (
        period.partials &&
        (new Set(period.partials.map((p) => p.assessmentId)).size !== period.partials.length ||
          period.partials.some((p) => !['score', 'absent'].includes(p.mark.kind)))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid assessment list',
          path: ['periods', index, 'partials'],
        });
    }
  });
export const academicStudentSchemaV1 = z
  .object({
    contractVersion: z.literal(1),
    link: portalAcademicLinkSchemaV1,
    dataVersion: academicVersionSchemaV1,
    profile: z
      .object({
        name: z.string().min(1).max(STUDENT_NAME_MAX_LENGTH_V1),
        classId: id,
        classLabel: z.string().min(1).max(80),
        academicState: z.enum(['regular', 'special', 'assisted']),
        result: z.enum([
          'in-progress',
          'approved',
          'failed',
          'failed-attendance',
          'not-applicable',
        ]),
        // Official annual situation (BN visible result or formal Council decision). `result`
        // stays the coarse summary for existing consumers; this carries the exact wording.
        annualSituation: z
          .enum([
            'in-recovery',
            'awaiting-council',
            'approved-direct',
            'approved-after-recovery',
            'approved-special',
            'approved-by-council',
            'failed-after-recovery',
            'failed-no-show',
            'failed-repeat',
            'failed-by-council',
            'failed-by-absence',
          ])
          .optional(),
      })
      .strict(),
    subjects: z.array(academicSubjectSchemaV1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.profile.academicState === 'assisted' && value.profile.result !== 'not-applicable')
      ctx.addIssue({
        code: 'custom',
        message: 'Assisted student has no global result',
        path: ['profile', 'result'],
      });
    if (value.profile.academicState === 'assisted' && value.profile.annualSituation !== undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'Assisted student has no annual situation',
        path: ['profile', 'annualSituation'],
      });
    if (value.profile.academicState !== 'assisted' && value.profile.result === 'not-applicable')
      ctx.addIssue({
        code: 'custom',
        message: 'Global result required',
        path: ['profile', 'result'],
      });
    if (
      new Set(value.subjects.map((s) => s.subjectId)).size !== value.subjects.length ||
      value.subjects.some((s, i) => s.order !== i)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Expected unique subjects in institutional order',
        path: ['subjects'],
      });
  });
export type AcademicStudentV1 = z.infer<typeof academicStudentSchemaV1>;
/** Trusted server-only reader. Failure/stale/exit/ambiguous binding returns null, never another student's data. */
export interface AcademicStudentReaderV1<TTransaction> {
  readOfficialInTransaction(
    tx: TTransaction,
    link: PortalAcademicLinkV1,
    expectedDataVersion: string,
  ): Promise<AcademicStudentV1 | null>;
}
