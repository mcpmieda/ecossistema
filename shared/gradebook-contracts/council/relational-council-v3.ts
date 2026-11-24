import { z } from 'zod';
import {
  GRADEBOOK_ACADEMIC_YEAR_MAX_V2,
  GRADEBOOK_ACADEMIC_YEAR_MIN_V2,
} from '../academic-year-v2';
export const RELATIONAL_COUNCIL_LIMITS_V3 = Object.freeze({
  classes: 100,
  students: 150,
  offers: 40,
});

const id = z.number().int().min(1).max(2_147_483_647);
const count = z.number().int().min(0).max(100_000);
const milli = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const year = z
  .number()
  .int()
  .min(GRADEBOOK_ACADEMIC_YEAR_MIN_V2)
  .max(GRADEBOOK_ACADEMIC_YEAR_MAX_V2);
const label = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !value.includes('\0'));
const decisionCode = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const relationalCouncilRequestSchemaV3 = z.discriminatedUnion('operation', [
  // Every class of the year, each with where it stands: one whole reading for each class.
  z.object({ contractVersion: z.literal(3), operation: z.literal('classes'), year }).strict(),
  z
    .object({ contractVersion: z.literal(3), operation: z.literal('workspace'), year, classId: id })
    .strict(),
  // The only write: the meeting of a class opens once and stays open (BN-DEC-049). Recording a
  // decision is being redone and has no command for now.
  z
    .object({ contractVersion: z.literal(3), operation: z.literal('open'), year, classId: id })
    .strict(),
]);
export type RelationalCouncilRequestV3 = z.infer<typeof relationalCouncilRequestSchemaV3>;
export type RelationalCouncilDecisionV3 = z.infer<typeof decisionCode>;

const reference = z.object({ id, label }).strict();
const grade = z
  .object({
    valueMilli: milli.nullable(),
    state: z.enum([
      'complete',
      'partial',
      'not-recorded',
      'unavailable',
      'not-applicable',
      'recovery-pending',
      'no-show',
      'repeat-failure',
    ]),
    // Whether the mark reaches the year's minimum, in proportion to its own maximum.
    level: z.enum(['at-or-above', 'below', 'not-classified']),
  })
  .strict();
const component = z
  .object({
    offerId: id,
    subject: label,
    terms: z.tuple([grade, grade, grade]),
    // The REC of each term, the year's total before recovery and the total after it.
    termRecoveries: z.tuple([grade, grade, grade]),
    annual: grade,
    recovery: grade,
    result: z.enum([
      'in-progress',
      'approved-direct',
      'recovery-pending',
      'approved-after-recovery',
      'not-approved',
      'failed-no-show',
      'failed-repeat',
      'unavailable',
    ]),
  })
  .strict();
const eligibility = z
  .object({
    eligible: z.boolean(),
    // Why the student is before the Conselho; the other students of the class are not sent.
    code: z.enum(['eligible', 'recovery-pending', 'failed-no-show', 'failed-repeat']),
    failedComponentCount: count,
  })
  .strict();
type EligibilityOfV3 = {
  readonly eligibility: { readonly eligible: boolean; readonly code: string };
};
/** Students the Conselho deliberates on: the eligible ones and the ones whose recovery is still
 * to be recorded, since the sheet cannot always say they missed it and the Conselho then does. */
export const relationalCouncilVotableV3 = (student: EligibilityOfV3): boolean =>
  student.eligibility.eligible || student.eligibility.code === 'recovery-pending';
/** Students the Conselho only takes notice of: the ones the sheet already fails, for missing a
 * recovery (N/C) or by the school's rules (R/R). The Conselho sees their year to confirm it;
 * they are not deliberated on and do not enter the counts of the class. */
export const relationalCouncilInformedV3 = (student: EligibilityOfV3): boolean =>
  student.eligibility.code === 'failed-no-show' || student.eligibility.code === 'failed-repeat';

const student = z
  .object({
    id,
    name: label,
    number: z.number().int().min(1).max(32767),
    eligibility,
    // The decision of the Conselho that is in force for the student, if any.
    decision: z.object({ code: decisionCode }).strict().nullable(),
    components: z.array(component).max(RELATIONAL_COUNCIL_LIMITS_V3.offers),
  })
  .strict();
// `total` counts the whole class; `students` brings only who is before the Conselho. The other
// counts are of the students it deliberates on, except `forInformation`.
const summary = z
  .object({
    total: count,
    decided: count,
    pending: count,
    approved: count,
    rejected: count,
    absence: count,
    forInformation: count,
  })
  .strict();
const workspace = z
  .object({
    context: z.object({ year }).strict(),
    classGroup: reference,
    session: z.object({ state: z.enum(['not-opened', 'open']) }).strict(),
    summary,
    students: z.array(student).max(RELATIONAL_COUNCIL_LIMITS_V3.students),
  })
  .strict()
  .superRefine((value, ctx) => {
    const votable = value.students.filter(relationalCouncilVotableV3);
    if (
      value.summary.total < value.students.length ||
      value.students.some(
        (item) => !relationalCouncilVotableV3(item) && !relationalCouncilInformedV3(item),
      ) ||
      value.summary.decided !== votable.filter((item) => item.decision !== null).length ||
      value.summary.pending !== votable.filter((item) => item.decision === null).length ||
      value.summary.forInformation !== value.students.filter(relationalCouncilInformedV3).length
    ) {
      ctx.addIssue({ code: 'custom', message: 'workspace summary mismatch' });
    }
  });
export type RelationalCouncilWorkspaceV3 = z.infer<typeof workspace>;
export type RelationalCouncilStudentV3 = RelationalCouncilWorkspaceV3['students'][number];

const failureState = z.enum([
  'invalid-request',
  'not-authorized',
  'not-found',
  'unavailable',
  'scope-too-large',
]);
export type RelationalCouncilFailureV3 = z.infer<typeof failureState>;
/** Where a class stands: the students it deliberates on, approved, rejected (by the Conselho or
 * for absence) and still without a decision, and the students it only takes notice of. */
const tally = z
  .object({ approved: count, rejected: count, pending: count, forInformation: count })
  .strict();
export type RelationalCouncilTallyV3 = z.infer<typeof tally>;
export const relationalCouncilTallyV3 = (
  summary: RelationalCouncilWorkspaceV3['summary'],
): RelationalCouncilTallyV3 => ({
  approved: summary.approved,
  rejected: summary.rejected + summary.absence,
  pending: summary.pending,
  forInformation: summary.forInformation,
});

export const relationalCouncilResponseSchemaV3 = z.union([
  z.object({ contractVersion: z.literal(3), state: failureState }).strict(),
  z
    .object({
      contractVersion: z.literal(3),
      state: z.literal('ready'),
      operation: z.literal('classes'),
      year,
      classes: z
        // `tally` is absent only when the class could not be read.
        .array(reference.extend({ tally: tally.optional() }))
        .max(RELATIONAL_COUNCIL_LIMITS_V3.classes),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(3),
      state: z.literal('ready'),
      operation: z.enum(['workspace', 'open']),
      workspace,
    })
    .strict(),
]);
export type RelationalCouncilResponseV3 = z.infer<typeof relationalCouncilResponseSchemaV3>;

export function relationalCouncilResponseMatchesV3(
  request: RelationalCouncilRequestV3,
  response: RelationalCouncilResponseV3,
): boolean {
  if (response.state !== 'ready') return true;
  if (response.operation !== request.operation) return false;
  if (request.operation === 'classes')
    return response.operation === 'classes' && response.year === request.year;
  return (
    response.operation !== 'classes' &&
    response.workspace.context.year === request.year &&
    response.workspace.classGroup.id === request.classId
  );
}
