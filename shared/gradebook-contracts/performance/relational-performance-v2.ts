import { z } from 'zod';
import {
  GRADEBOOK_ACADEMIC_YEAR_MAX_V2,
  GRADEBOOK_ACADEMIC_YEAR_MIN_V2,
} from '../academic-year-v2';
import {
  SIMPLIFIED_ENGINE_WARNING_CODES_V1,
  SIMPLIFIED_INSTRUMENT_SLOTS_V1,
} from '../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';
import { SIMPLIFIED_VISIBLE_ANNUAL_RESULTS_V1 } from '../../../src/gradebook-domain/calculations/simplified/resolve-simplified-annual-outcome-v1';

/** Calculated read preview, not an authorization to emit official results. */
/** BN-DEC-042: a result with blank instruments is final as it stands and counts in every
 * indicator; "partial" only marks that something was left blank. */
export const performanceResultCountsV2 = (state: string): boolean =>
  state === 'complete' || state === 'partial';

export const PERFORMANCE_LIMITS_V2 = Object.freeze({
  students: 150,
  offers: 40,
  pairs: 1000,
  classesPage: 100,
});
const id = z.number().int().min(1).max(2_147_483_647);
const year = z
  .number()
  .int()
  .min(GRADEBOOK_ACADEMIC_YEAR_MIN_V2)
  .max(GRADEBOOK_ACADEMIC_YEAR_MAX_V2);
const milli = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const label = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !value.includes('\0'));
const status = z.union([
  z.null(),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(7),
]);
const period = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal('annual')]);
const mode = z.enum(['regular', 'recovery']);
const scope = { transportVersion: z.literal(2), year, classId: id, period, mode };
export const performanceRequestSchemaV2 = z.discriminatedUnion('operation', [
  z
    .object({
      transportVersion: z.literal(2),
      operation: z.literal('classes'),
      year,
      offset: z.number().int().min(0).max(100_000),
      limit: z.number().int().min(1).max(PERFORMANCE_LIMITS_V2.classesPage),
    })
    .strict(),
  z
    .object({
      ...scope,
      operation: z.literal('matrix'),
      statuses: z
        .array(status)
        .min(1)
        .max(7)
        .refine((values) => new Set(values).size === values.length),
    })
    .strict(),
  z.object({ ...scope, operation: z.literal('student-detail'), studentId: id }).strict(),
  z
    .object({
      ...scope,
      operation: z.literal('cell-detail'),
      studentId: id,
      offerId: id,
      includeRawSum: z.literal(true).optional(),
    })
    .strict(),
]);
export type PerformanceRequestV2 = z.infer<typeof performanceRequestSchemaV2>;
export type PerformancePeriodV2 = z.infer<typeof period>;
export type PerformanceModeV2 = z.infer<typeof mode>;
export type PerformanceStatusV2 = z.infer<typeof status>;

const reference = z.object({ id, label }).strict();
const offer = z
  .object({
    id,
    subject: reference.extend({
      abbreviation: z.string().trim().min(1).max(16).nullable().optional(),
    }),
    teacher: reference,
  })
  .strict();
const context = z
  .object({
    year,
    minimumApprovalMilli: milli.positive(),
    maxCouncilComponents: z.number().int().min(0).max(32767),
  })
  .strict();
const comparison = z.enum(['match', 'mismatch', 'unavailable']);
const cell = z
  .object({
    offerId: id,
    valueMilli: milli.nullable(),
    rawMilli: milli.optional(),
    maximumMilli: milli.positive(),
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
    level: z.enum(['at-or-above', 'below', 'not-classified']),
    sourceReferenceMilli: milli.nullable(),
    sourceComparison: comparison,
    recoveryApplicable: z.boolean().nullable(),
    warningCodes: z.array(z.enum(SIMPLIFIED_ENGINE_WARNING_CODES_V1)).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    const numeric = value.state === 'complete' || value.state === 'partial';
    const classified = numeric || value.state === 'repeat-failure';
    if (numeric !== (value.valueMilli !== null))
      ctx.addIssue({ code: 'custom', message: 'cell value/state mismatch' });
    if (value.rawMilli !== undefined && !numeric)
      ctx.addIssue({ code: 'custom', message: 'raw sum requires a numeric result' });
    if (classified === (value.level === 'not-classified'))
      ctx.addIssue({ code: 'custom', message: 'cell classification mismatch' });
    if (value.state === 'repeat-failure' && value.level !== 'below')
      ctx.addIssue({ code: 'custom', message: 'repeat failure must be below' });
    if (
      value.sourceComparison !== 'unavailable' &&
      (!numeric || value.sourceReferenceMilli === null)
    )
      ctx.addIssue({ code: 'custom', message: 'unavailable comparison' });
  });
export type PerformanceCellV2 = z.infer<typeof cell>;
const annual = z
  .object({
    state: z.enum(['no-result', 'in-progress', 'recovery', 'final', 'council-eligible']),
    label: z.enum(SIMPLIFIED_VISIBLE_ANNUAL_RESULTS_V1).nullable(),
    councilEligibility: z.enum(['not-applicable', 'eligible', 'not-eligible']),
  })
  .strict();
const formalDecision = z
  .object({ code: z.union([z.literal(1), z.literal(2), z.literal(3)]), label })
  .strict();
const student = z
  .object({
    id,
    name: label,
    number: z.number().int().min(1).max(32767),
    status,
    statusLabel: label,
    indicatorEligible: z.boolean(),
  })
  .strict();
const row = z
  .object({
    student,
    calculatedAnnual: annual.nullable(),
    formalCouncilDecision: formalDecision.nullable(),
    cells: z.array(cell).max(PERFORMANCE_LIMITS_V2.offers),
  })
  .strict();
export type PerformanceRowV2 = z.infer<typeof row>;
export type PerformanceOfferV2 = z.infer<typeof offer>;
const count = z.number().int().min(0).max(100_000);
const statistics = z
  .object({
    classRows: count,
    visibleRows: count,
    eligibleRows: count,
    recoveryUnknownRows: count,
    consideredCells: count,
    completeCells: count,
    noShowCells: count,
    incompleteCells: count,
    attentionRows: count,
  })
  .strict();
const ready = {
  transportVersion: z.literal(2),
  state: z.literal('ready'),
  context,
  readAt: z.string().datetime({ offset: true }),
  authority: z.literal('calculated-preview'),
};
const selected = { classGroup: reference.extend({ name: label.optional() }), period, mode };
const termDetail = z
  .object({
    term: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    regular: cell,
    recovery: cell,
    hasGrades: z.boolean().optional(),
    showParallel: z.boolean().optional(),
    showRecovery: z.boolean().optional(),
    quantitativeOriginalMilli: milli.nullable(),
    quantitativeConsideredMilli: milli.nullable(),
    qualitativeMilli: milli.nullable(),
    parallelMilli: milli.nullable(),
    parallelApplicable: z.boolean().nullable(),
    instruments: z
      .array(
        z
          .object({
            slot: z.union(SIMPLIFIED_INSTRUMENT_SLOTS_V1.map((value) => z.literal(value))),
            label,
            maximumMilli: milli.nullable(),
            valueMilli: milli.nullable(),
            notDone: z.literal(true).optional(),
          })
          .strict()
          .refine(
            (value) => !value.notDone || value.valueMilli === null,
            'Observation/value mismatch',
          ),
      )
      .max(13),
  })
  .strict();
const failure = z
  .object({
    transportVersion: z.literal(2),
    state: z.enum([
      'not-found',
      'invalid-request',
      'unavailable',
      'not-authorized',
      'scope-too-large',
      'ambiguous-offers',
    ]),
  })
  .strict();
export type PerformanceFailureV2 = z.infer<typeof failure>['state'];
export const performanceResponseSchemaV2 = z.union([
  failure,
  z
    .object({
      ...ready,
      operation: z.literal('classes'),
      statusOptions: z
        .array(z.object({ value: status, label }).strict())
        .min(1)
        .max(7),
      classes: z.array(reference).max(PERFORMANCE_LIMITS_V2.classesPage),
      nextOffset: z.number().int().min(1).max(100_000).nullable(),
    })
    .strict(),
  z
    .object({
      ...ready,
      ...selected,
      operation: z.literal('matrix'),
      offers: z.array(offer).max(PERFORMANCE_LIMITS_V2.offers),
      rows: z.array(row).max(PERFORMANCE_LIMITS_V2.students),
      statistics,
      comparison: z
        .object({ available: z.literal(false), reason: z.literal('comparability-not-contracted') })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ready,
      ...selected,
      operation: z.literal('student-detail'),
      row,
      offers: z.array(offer).max(PERFORMANCE_LIMITS_V2.offers),
      trajectory: z
        .array(z.object({ offerId: id, terms: z.tuple([cell, cell, cell]) }).strict())
        .max(PERFORMANCE_LIMITS_V2.offers),
    })
    .strict(),
  z
    .object({
      ...ready,
      ...selected,
      operation: z.literal('cell-detail'),
      student,
      offer,
      terms: z.tuple([termDetail, termDetail, termDetail]),
    })
    .strict(),
]);
export type PerformanceResponseV2 = z.infer<typeof performanceResponseSchemaV2>;
export type PerformanceReadyV2 = Extract<PerformanceResponseV2, { state: 'ready' }>;
export type PerformanceMatrixV2 = Extract<PerformanceReadyV2, { operation: 'matrix' }>;

export function performanceResponseMatchesV2(
  request: PerformanceRequestV2,
  response: PerformanceResponseV2,
): boolean {
  if (response.state !== 'ready') return true;
  if (response.operation !== request.operation || response.context.year !== request.year)
    return false;
  if (request.operation === 'classes')
    return (
      response.operation === 'classes' &&
      response.classes.length <= request.limit &&
      new Set(response.classes.map((value) => value.id)).size === response.classes.length &&
      (response.nextOffset === null || response.nextOffset === request.offset + request.limit)
    );
  if (
    !('classGroup' in response) ||
    response.classGroup.id !== request.classId ||
    response.period !== request.period ||
    response.mode !== request.mode
  )
    return false;
  if (response.operation === 'cell-detail')
    return (
      request.operation === 'cell-detail' &&
      response.student.id === request.studentId &&
      response.offer.id === request.offerId &&
      response.terms.every(
        (term, index) =>
          term.term === index + 1 &&
          term.regular.offerId === request.offerId &&
          term.recovery.offerId === request.offerId,
      )
    );
  const offerIds = response.offers.map((value) => value.id);
  if (new Set(offerIds).size !== offerIds.length) return false;
  const rows = response.operation === 'matrix' ? response.rows : [response.row];
  if (new Set(rows.map((value) => value.student.id)).size !== rows.length) return false;
  if (
    !rows.every(
      (value) =>
        value.cells.length === offerIds.length &&
        value.cells.every((item, index) => item.offerId === offerIds[index]),
    )
  )
    return false;
  if (response.operation === 'student-detail')
    return (
      request.operation === 'student-detail' &&
      response.row.student.id === request.studentId &&
      response.trajectory.length === offerIds.length &&
      response.trajectory.every(
        (value, index) =>
          value.offerId === offerIds[index] &&
          value.terms.every((item) => item.offerId === value.offerId),
      )
    );
  return (
    request.operation === 'matrix' &&
    rows.every((value) => request.statuses.includes(value.student.status)) &&
    response.statistics.visibleRows === rows.length &&
    rows.length * offerIds.length <= PERFORMANCE_LIMITS_V2.pairs
  );
}
