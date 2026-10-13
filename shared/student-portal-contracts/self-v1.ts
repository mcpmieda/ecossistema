import { z } from 'zod';
import { STUDENT_NAME_MAX_LENGTH_V1 } from '../student-identity/student-identity-v1';
import { academicLinkV1, instantV1, periodV1, portalIdV1, revisionsV1 } from './core-v1';
import { termClosingSummaryV1, termClosingV1 } from './term-closing-v1';

export const markV1 = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('score'),
      value: z.number().finite().nonnegative(),
      maximum: z.number().finite().nonnegative().nullable(),
      meetsMinimum: z.boolean().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('nc') }).strict(),
  z.object({ kind: z.literal('absent') }).strict(),
  z.object({ kind: z.literal('rr') }).strict(),
  z.object({ kind: z.literal('recovery-pending') }).strict(),
]);
export const subjectV1 = z
  .object({
    subjectId: z.number().int().positive(),
    label: z.string().min(1).max(120),
    order: z.number().int().nonnegative(),
    periods: z
      .array(
        z
          .object({
            period: periodV1,
            final: markV1,
            // AV1, AV2, parallel recovery and ten qualitative activities are all legitimate.
            partials: z
              .array(
                z
                  .object({
                    assessmentId: z.number().int().positive(),
                    label: z.string().min(1).max(120),
                    mark: markV1,
                    notDone: z.literal(true).optional(),
                    // The parallel exam (slot 3), whatever the teacher named it.
                    parallel: z.literal(true).optional(),
                    // The trimester's two assessments (columns R and S, slots 1 and 2), whatever
                    // names the Banco de Notas settings give them.
                    assessment: z.literal(true).optional(),
                  })
                  .strict()
                  .refine(
                    (value) => !value.notDone || value.mark.kind === 'absent',
                    'Observation/value mismatch',
                  ),
              )
              .max(13)
              .optional(),
          })
          .strict(),
      )
      .max(6)
      .refine((v) => new Set(v.map((p) => p.period)).size === v.length, 'Duplicate period'),
    officialOutcome: z.enum(['approved', 'failed', 'failed-attendance']).optional(),
    // Official per-subject classification. Before the final disclosure only
    // `recovery-pending` may be present (released together with T3).
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
    // Fechamento do trimestre (#1132): codes only, one per closed trimester. A closed but not yet
    // released trimester may carry a closing without periods (spec R2).
    closings: z
      .array(termClosingV1)
      .max(3)
      .refine((v) => new Set(v.map((c) => c.period)).size === v.length, 'Duplicate closing')
      .optional(),
  })
  .strict();
export const selfResponseV1 = z
  .object({
    contractVersion: z.literal(1),
    requestId: portalIdV1,
    state: z.enum(['ready', 'no-publication']),
    profile: z
      .object({
        accountId: portalIdV1,
        link: academicLinkV1,
        name: z.string().min(1).max(STUDENT_NAME_MAX_LENGTH_V1),
        classLabel: z.string().min(1).max(80),
        academicState: z.enum(['regular', 'special', 'assisted']),
        result: z.enum([
          'in-progress',
          'approved',
          'failed',
          'failed-attendance',
          'not-applicable',
        ]),
        // Official annual situation with its exact institutional wording. Optional so legacy
        // projections stay valid; before the final disclosure only `in-recovery` may appear.
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
    revisions: revisionsV1,
    generatedAt: instantV1,
    subjects: z.array(subjectV1).max(100),
    closingSummary: termClosingSummaryV1.optional(),
    // One summary per closed trimester (#1132 follow-up). Accepted first, emitted by the server in
    // a later deploy, so a page still open with the previous bundle never sees an unknown key.
    closingSummaries: z.array(termClosingSummaryV1).max(3).optional(),
    // Trimesters whose end date in the calendar has passed (owner decision 28/09/2026: seals from
    // assessments count only then). Accepted first, emitted by the server in a later deploy.
    endedPeriods: z
      .array(z.enum(['T1', 'T2', 'T3']))
      .max(3)
      .refine((v) => new Set(v).size === v.length, 'Duplicate ended period')
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.state === 'no-publication' && v.subjects.length)
      ctx.addIssue({ code: 'custom', path: ['subjects'], message: 'Unpublished data' });
    if (v.profile.academicState === 'assisted' && v.profile.result !== 'not-applicable')
      ctx.addIssue({
        code: 'custom',
        path: ['profile', 'result'],
        message: 'No global outcome for assisted student',
      });
    if (v.profile.academicState === 'assisted' && v.profile.annualSituation !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['profile', 'annualSituation'],
        message: 'No annual situation for assisted student',
      });
  });
export type SelfResponseV1 = z.infer<typeof selfResponseV1>;
