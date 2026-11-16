import { z } from 'zod';
import { performanceLearningSchemaV1 } from './performance-learning-v1';
import {
  performanceRequestSchemaV2,
  performanceResponseSchemaV2,
} from './relational-performance-v2';

const matrix = performanceResponseSchemaV2.options[2];
const count = z.number().int().nonnegative().max(100_000);
const finite = z.number().finite();
const metric = finite.nullable();
const id = z.number().int().positive().max(2_147_483_647);
const term = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const stats = z
  .object({ n: count, mean: metric, median: metric, deviation: metric, min: metric, max: metric })
  .strict();
const coverage = z
  .object({ expected: count, recorded: count, missing: count, zeros: count, percent: metric })
  .strict();
const recovery = z
  .object({
    applicable: count,
    recorded: count,
    pending: count,
    noShow: count,
    repeatFailure: count,
    unknown: count,
    changed: count,
    meanGainMilli: metric,
  })
  .strict();
const movement = z
  .object({
    reference: term.nullable(),
    n: count,
    increased: count,
    decreased: count,
    unchanged: count,
    meanDeltaPP: metric,
  })
  .strict();
export const performanceAnalyticsSummarySchemaV6 = z
  .object({
    students: count,
    readings: count,
    complete: count,
    partial: count,
    missing: count,
    unavailable: count,
    above: count,
    below: count,
    studentsBelow: count,
    studentsAtOrAbove: count,
    studentsPending: count,
    result: stats,
    quantitative: stats,
    qualitative: stats,
    dimensionGap: z.object({ n: count, meanPP: metric }).strict(),
    composition: z
      .object({ n: count, quantitativeShare: metric, qualitativeShare: metric })
      .strict(),
    coverage,
    recovery,
    parallel: z.object({ applicable: count, applied: count, meanGainMilli: metric }).strict(),
    movement,
    timeline: z.array(stats.extend({ term }).strict()).length(3),
    distribution: z.array(z.object({ label: z.string().max(40), count }).strict()).length(6),
    source: z.object({ recorded: count, comparable: count, different: count }).strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.complete + value.partial + value.missing + value.unavailable !== value.readings ||
      value.above + value.below !== value.complete ||
      value.result.n !== value.complete ||
      value.studentsAtOrAbove + value.studentsBelow + value.studentsPending !== value.students ||
      value.coverage.recorded + value.coverage.missing !== value.coverage.expected ||
      value.coverage.zeros > value.coverage.recorded ||
      value.distribution.reduce((sum, bin) => sum + bin.count, 0) !== value.complete ||
      value.movement.n !==
        value.movement.increased + value.movement.decreased + value.movement.unchanged ||
      value.timeline.some((item, index) => item.term !== index + 1)
    ) {
      ctx.addIssue({ code: 'custom', message: 'inconsistent analytics summary' });
    }
  });
export type PerformanceAnalyticsSummaryV6 = z.infer<typeof performanceAnalyticsSummarySchemaV6>;
export type PerformanceAnalyticsStatsV6 = z.infer<typeof stats>;

export const performanceAnalyticsRequestSchemaV6 = performanceRequestSchemaV2.options[1]
  .pick({ year: true, classId: true, period: true })
  .extend({
    transportVersion: z.literal(6),
    operation: z.literal('analytics'),
    // Opt-in preserves the strict response accepted by already-open older browser clients.
    includeLearning: z.literal(true).optional(),
    includeStudentDimensions: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => !value.includeStudentDimensions || value.includeLearning === true, {
    message: 'student dimensions require learning evidence',
  });
export type PerformanceAnalyticsRequestV6 = z.infer<typeof performanceAnalyticsRequestSchemaV6>;

const dimension = z
  .object({ valueMilli: metric, maximumMilli: metric, percent: metric, complete: z.boolean() })
  .strict();
const analyticsCell = z
  .object({
    offerId: id,
    result: matrix.shape.rows.element.shape.cells.element,
    percent: metric,
    gapMilli: metric,
    deltaPP: metric,
    quantitative: dimension,
    qualitative: dimension,
    recoveryState: z.enum([
      'complete',
      'pending',
      'no-show',
      'repeat-failure',
      'not-applicable',
      'unknown',
    ]),
  })
  .strict();
const student = z
  .object({
    student: matrix.shape.rows.element.shape.student,
    annualResult: matrix.shape.rows.element.shape.calculatedAnnual,
    councilDecision: matrix.shape.rows.element.shape.formalCouncilDecision,
    summary: performanceAnalyticsSummarySchemaV6,
    cells: z.array(analyticsCell).max(40),
  })
  .strict();
const instrument = z
  .object({
    key: z.string().regex(/^\d+:[123]:\d+$/u),
    term,
    slot: z.number().int().min(1).max(20),
    label: z.string().min(1).max(500),
    maximumMilli: metric,
    stats,
    coverage,
    below: count,
    notApplicable: count,
  })
  .strict();
const component = z
  .object({
    offer: matrix.shape.offers.element,
    summary: performanceAnalyticsSummarySchemaV6,
    instruments: z.array(instrument).max(39),
  })
  .strict();
const teacher = z
  .object({
    id,
    label: z.string().min(1).max(500),
    offerIds: z.array(id).max(40),
    students: z
      .array(
        z
          .object({
            studentId: id,
            meanPercent: metric,
            below: count,
            complete: count,
            partial: count,
            deltaPP: metric,
          })
          .strict(),
      )
      .max(150),
    summary: performanceAnalyticsSummarySchemaV6,
  })
  .strict();
const ready = z
  .object({
    transportVersion: z.literal(6),
    state: z.literal('ready'),
    operation: z.literal('analytics'),
    authority: z.literal('calculated-preview'),
    context: matrix.shape.context,
    classGroup: matrix.shape.classGroup,
    period: matrix.shape.period,
    readAt: matrix.shape.readAt,
    minimumPercent: finite.positive(),
    classStudents: count,
    summary: performanceAnalyticsSummarySchemaV6,
    students: z.array(student).max(150),
    components: z.array(component).max(40),
    teachers: z.array(teacher).max(40),
    learning: performanceLearningSchemaV1.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = () => ctx.addIssue({ code: 'custom', message: 'inconsistent analytics scope' });
    const offerIds = value.components.map((item) => item.offer.id);
    const studentIds = value.students.map((item) => item.student.id);
    if (
      new Set(offerIds).size !== offerIds.length ||
      new Set(studentIds).size !== studentIds.length ||
      offerIds.length * studentIds.length > 1000 ||
      value.summary.students !== studentIds.length ||
      value.classStudents < studentIds.length ||
      value.summary.readings !== offerIds.length * studentIds.length ||
      value.students.some(
        (item) =>
          !item.student.indicatorEligible ||
          ![null, 7].includes(item.student.status) ||
          item.cells.length !== offerIds.length ||
          item.cells.some(
            (cell, index) =>
              cell.offerId !== offerIds[index] || cell.result.offerId !== cell.offerId,
          ),
      )
    )
      fail();
    const teacherIds = value.teachers.map((item) => item.id);
    if (
      new Set(teacherIds).size !== teacherIds.length ||
      value.teachers.some(
        (item) =>
          new Set(item.offerIds).size !== item.offerIds.length ||
          item.students.length !== studentIds.length ||
          item.summary.students !== studentIds.length ||
          item.summary.readings !== studentIds.length * item.offerIds.length ||
          new Set(item.students.map((student) => student.studentId)).size !==
            item.students.length ||
          item.students.some((student) => !studentIds.includes(student.studentId)) ||
          item.offerIds.some(
            (offerId) =>
              !value.components.some(
                (component) =>
                  component.offer.id === offerId && component.offer.teacher.id === item.id,
              ),
          ),
      ) ||
      value.components.some(
        (item) =>
          !value.teachers.some(
            (teacher) =>
              teacher.id === item.offer.teacher.id && teacher.offerIds.includes(item.offer.id),
          ),
      )
    )
      fail();
    if (
      value.components.some(
        (item) =>
          new Set(item.instruments.map((instrument) => instrument.key)).size !==
            item.instruments.length ||
          item.instruments.some(
            (instrument) =>
              instrument.key !== `${item.offer.id}:${instrument.term}:${instrument.slot}` ||
              (value.period !== 'annual' && instrument.term !== value.period),
          ),
      )
    )
      fail();
    if (value.learning) {
      const learning = value.learning;
      const instrumentKeys = new Set(
        value.components.flatMap((item) => item.instruments.map((entry) => entry.key)),
      );
      if (
        learning.students.length !== studentIds.length ||
        learning.students.some(
          (item, index) =>
            item.studentId !== studentIds[index] ||
            (item.dimensions !== undefined &&
              item.dimensions.components !== value.students[index]?.summary.dimensionGap.n) ||
            item.recurring.some(
              (entry) =>
                !offerIds.includes(entry.offerId) ||
                [...entry.instrumentTerms, ...entry.consecutiveTerms].some(
                  (term) => value.period !== 'annual' && term !== value.period,
                ),
            ),
        ) ||
        learning.activitiesToReview.some((key) => !instrumentKeys.has(key))
      )
        fail();
    }
  });
const failure = performanceResponseSchemaV2.options[0]
  .extend({ transportVersion: z.literal(6) })
  .strict();
export const performanceAnalyticsResponseSchemaV6 = z.union([ready, failure]);
export type PerformanceAnalyticsV6 = z.infer<typeof ready>;
export type PerformanceAnalyticsResponseV6 = z.infer<typeof performanceAnalyticsResponseSchemaV6>;
export function performanceAnalyticsMatchesV6(
  request: PerformanceAnalyticsRequestV6,
  response: PerformanceAnalyticsResponseV6,
): boolean {
  return (
    response.state !== 'ready' ||
    (response.context.year === request.year &&
      response.classGroup.id === request.classId &&
      response.period === request.period &&
      (!request.includeLearning || response.learning?.version === 1) &&
      (!request.includeStudentDimensions ||
        response.learning?.students.every((student) => student.dimensions !== undefined) === true))
  );
}
