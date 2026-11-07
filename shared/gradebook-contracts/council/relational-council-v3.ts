import { z } from 'zod';
import { GRADEBOOK_ACADEMIC_YEAR_MAX_V2, GRADEBOOK_ACADEMIC_YEAR_MIN_V2 } from '../academic-year-v2';
export const RELATIONAL_COUNCIL_LIMITS_V3 = Object.freeze({
  classes: 100,
  students: 150,
  offers: 40,
  pairs: 1_000,
  timeline: 500,
  closures: 100,
});

export const RELATIONAL_COUNCIL_DECISIONS_V3 = Object.freeze({
  1: 'APROVADO PELO CONSELHO',
  2: 'REPROVADO PELO CONSELHO',
  3: 'REPROVADO POR FALTA',
} as const);

const id = z.number().int().min(1).max(2_147_483_647);
const count = z.number().int().min(0).max(100_000);
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const milli = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const year = z.number().int().min(GRADEBOOK_ACADEMIC_YEAR_MIN_V2).max(GRADEBOOK_ACADEMIC_YEAR_MAX_V2);
const label = z.string().trim().min(1).max(500).refine((value) => !value.includes('\0'));
const justification = z.string().trim().min(3).max(2_000).refine((value) => !value.includes('\0'));
const idempotencyKey = z.string().trim().min(8).max(120)
  .regex(/^[A-Za-z0-9._:-]+$/u, 'invalid idempotency key');
const decisionCode = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const command = { year, classId: id, expectedVersion: version, idempotencyKey, justification };

export const relationalCouncilRequestSchemaV3 = z.discriminatedUnion('operation', [
  z.object({ contractVersion: z.literal(3), operation: z.literal('classes'), year,
    offset: z.number().int().min(0).max(100_000), limit: z.number().int().min(1).max(RELATIONAL_COUNCIL_LIMITS_V3.classes) }).strict(),
  z.object({ contractVersion: z.literal(3), operation: z.literal('workspace'), year, classId: id }).strict(),
  z.object({ contractVersion: z.literal(3), operation: z.literal('open'), ...command }).strict(),
  z.object({ contractVersion: z.literal(3), operation: z.literal('decision'), ...command,
    studentId: id, decision: decisionCode }).strict(),
  z.object({ contractVersion: z.literal(3), operation: z.literal('vote'), ...command,
    studentId: id, favoraveis: count, contrarios: count }).strict(),
  z.object({ contractVersion: z.literal(3), operation: z.literal('close'), ...command,
    reviewReference: z.string().trim().min(8).max(200) }).strict(),
  z.object({ contractVersion: z.literal(3), operation: z.literal('reopen'), ...command }).strict(),
]);
export type RelationalCouncilRequestV3 = z.infer<typeof relationalCouncilRequestSchemaV3>;
export type RelationalCouncilDecisionV3 = z.infer<typeof decisionCode>;

const reference = z.object({ id, label }).strict();
const grade = z.object({
  valueMilli: milli.nullable(),
  maximumMilli: milli.positive(),
  state: z.enum(['complete', 'partial', 'not-recorded', 'unavailable', 'not-applicable', 'recovery-pending', 'no-show', 'repeat-failure']),
}).strict();
const component = z.object({
  offerId: id,
  subject: reference.extend({ abbreviation: z.string().trim().min(1).max(16).nullable() }),
  terms: z.tuple([grade, grade, grade]),
  recovery: grade,
  result: z.enum(['in-progress', 'approved-direct', 'recovery-pending', 'approved-after-recovery', 'not-approved', 'failed-no-show', 'failed-repeat', 'unavailable']),
}).strict();
const decision = z.object({
  code: decisionCode,
  label,
  justification,
  version,
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
const vote = z.object({
  favoraveis: count,
  contrarios: count,
  presentes: count,
  comparison: z.enum(['favoraveis', 'contrarios', 'empate']),
  justification,
  version: version.positive(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, ctx) => {
  if (value.presentes !== value.favoraveis + value.contrarios) {
    ctx.addIssue({ code: 'custom', message: 'presentes must be derived from votes' });
  }
});
const eligibility = z.object({
  eligible: z.boolean(),
  code: z.enum(['eligible', 'status', 'in-progress', 'recovery-pending', 'failed-no-show', 'failed-repeat', 'above-limit', 'approved', 'definitions-unavailable']),
  label,
  failedComponentCount: count,
}).strict();
const student = z.object({
  id,
  name: label,
  number: z.number().int().min(1).max(32767),
  statusLabel: label,
  eligibility,
  calculatedResult: label.nullable(),
  decision: decision.nullable(),
  vote: vote.nullable(),
  components: z.array(component).max(RELATIONAL_COUNCIL_LIMITS_V3.offers),
}).strict();
const session = z.object({
  state: z.enum(['not-opened', 'open', 'closed']),
  version,
  reviewReference: z.string().trim().min(8).max(200),
  closedAt: z.string().datetime({ offset: true }).nullable(),
  snapshotCount: z.number().int().min(0).max(RELATIONAL_COUNCIL_LIMITS_V3.closures),
}).strict();
const timeline = z.object({
  id: z.string().trim().min(1).max(100),
  action: z.enum(['opened', 'decision-recorded', 'vote-recorded', 'closed', 'reopened']),
  version: version.positive(),
  studentId: id.nullable(),
  studentLabel: label.nullable(),
  justification,
  occurredAt: z.string().datetime({ offset: true }),
}).strict();
const closure = z.object({
  id,
  sequence: z.number().int().min(1).max(32767),
  version: version.positive(),
  closedAt: z.string().datetime({ offset: true }),
  summary: z.object({ total: count, eligible: count, approved: count, rejected: count, absence: count, notEligible: count }).strict(),
}).strict();
const summary = z.object({
  total: count,
  eligible: count,
  decided: count,
  pending: count,
  approved: count,
  rejected: count,
  absence: count,
  notEligible: count,
}).strict();
const workspace = z.object({
  context: z.object({ year, minimumApprovalMilli: milli.positive(), maxCouncilComponents: count }).strict(),
  classGroup: reference.extend({ name: label }),
  readAt: z.string().datetime({ offset: true }),
  authority: z.literal('calculated-eligibility-explicit-human-decision'),
  session,
  summary,
  students: z.array(student).max(RELATIONAL_COUNCIL_LIMITS_V3.students),
  timeline: z.array(timeline).max(RELATIONAL_COUNCIL_LIMITS_V3.timeline),
  closures: z.array(closure).max(RELATIONAL_COUNCIL_LIMITS_V3.closures),
}).strict().superRefine((value, ctx) => {
  const eligible = value.students.filter((item) => item.eligibility.eligible);
  if (value.summary.total !== value.students.length || value.summary.eligible !== eligible.length ||
      value.summary.decided !== eligible.filter((item) => item.decision !== null).length ||
      value.summary.pending !== eligible.filter((item) => item.decision === null).length ||
      value.summary.notEligible !== value.students.length - eligible.length) {
    ctx.addIssue({ code: 'custom', message: 'workspace summary mismatch' });
  }
});
export type RelationalCouncilWorkspaceV3 = z.infer<typeof workspace>;
export type RelationalCouncilStudentV3 = RelationalCouncilWorkspaceV3['students'][number];

const failureState = z.enum([
  'invalid-request', 'not-authorized', 'not-found', 'unavailable', 'scope-too-large',
  'version-conflict', 'idempotency-conflict', 'session-not-open', 'session-already-open',
  'session-closed', 'closure-blocked', 'review-conflict', 'student-not-eligible',
]);
export type RelationalCouncilFailureV3 = z.infer<typeof failureState>;
export const relationalCouncilResponseSchemaV3 = z.union([
  z.object({ contractVersion: z.literal(3), state: failureState, currentVersion: version.nullable().optional() }).strict(),
  z.object({ contractVersion: z.literal(3), state: z.literal('ready'), operation: z.literal('classes'), year,
    classes: z.array(reference.extend({ name: label, sessionState: z.enum(['not-opened', 'open', 'closed']), sessionVersion: version }))
      .max(RELATIONAL_COUNCIL_LIMITS_V3.classes),
    nextOffset: z.number().int().min(1).max(100_000).nullable() }).strict(),
  z.object({ contractVersion: z.literal(3), state: z.literal('ready'),
    operation: z.enum(['workspace', 'open', 'decision', 'vote', 'close', 'reopen']), workspace }).strict(),
]);
export type RelationalCouncilResponseV3 = z.infer<typeof relationalCouncilResponseSchemaV3>;

export function relationalCouncilResponseMatchesV3(
  request: RelationalCouncilRequestV3,
  response: RelationalCouncilResponseV3,
): boolean {
  if (response.state !== 'ready') return true;
  if (response.operation !== request.operation) return false;
  if (request.operation === 'classes') {
    return response.operation === 'classes' && response.year === request.year &&
      response.classes.length <= request.limit &&
      (response.nextOffset === null || response.nextOffset === request.offset + request.limit);
  }
  return response.operation !== 'classes' && response.workspace.context.year === request.year &&
    response.workspace.classGroup.id === request.classId;
}
