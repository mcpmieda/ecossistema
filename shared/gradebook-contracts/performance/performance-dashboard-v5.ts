import { z } from 'zod';
import {
  performanceAnalysisResponseSchemaV3,
  performanceAnalysisRequestSchemaV3,
  type PerformanceAnalysisV3,
  type PerformanceLensV3,
} from './performance-analysis-v3';
import {
  performanceTermComparisonResponseSchemaV4,
  type PerformanceReferencePeriodV4,
  type PerformanceTermComparisonV4,
} from './performance-term-comparison-v4';
import {
  performanceRequestSchemaV2,
  performanceResponseSchemaV2,
} from './relational-performance-v2';

const matrixRequest = performanceRequestSchemaV2.options[1];
const lens = z.enum(['result', 'quantitative', 'qualitative', 'assessments']);
const id = z.number().int().positive().max(2_147_483_647);
const count = z.number().int().min(0).max(100_000);
const milli = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const members = z
  .array(id)
  .max(150)
  .refine((values) => new Set(values).size === values.length);

export const performanceDashboardRequestSchemaV5 = matrixRequest
  .extend({
    transportVersion: z.literal(5),
    operation: z.literal('dashboard'),
    lens,
    offerId: id.nullable(),
    referencePeriod: z.union([z.literal(1), z.literal(2)]).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.lens === 'assessments') !== (value.offerId !== null)) {
      ctx.addIssue({ code: 'custom', message: 'assessment lens requires one offer' });
    }
    if (
      value.referencePeriod !== null &&
      (value.lens === 'assessments' ||
        value.period === 'annual' ||
        value.period === 1 ||
        value.referencePeriod >= value.period)
    ) {
      ctx.addIssue({ code: 'custom', message: 'invalid trimester comparison' });
    }
  });

export type PerformanceDashboardRequestV5 = z.infer<typeof performanceDashboardRequestSchemaV5>;

const column = z
  .object({
    key: z.string().regex(/^\d+(?::[123]:\d+)?$/u),
    offerId: id,
    label: z.string().trim().min(1).max(600),
    considered: count.max(150),
    atOrAbove: count.max(150),
    below: count.max(150),
    incomplete: count.max(150),
    noShow: count.max(150),
    unscaled: count.max(150),
  })
  .strict();

const overview = z
  .object({
    denominator: z.literal('eligible-students-in-current-scope'),
    students: z
      .object({
        eligible: count.max(150),
        classified: count.max(150),
        allAtOrAbove: count.max(150),
        withBelow: count.max(150),
        pending: count.max(150),
      })
      .strict(),
    groups: z
      .object({
        allAtOrAbove: members,
        withBelow: members,
        pending: members,
      })
      .strict(),
    ranking: z
      .array(
        z
          .object({
            studentId: id,
            totalMilli: milli,
            partial: z.boolean(),
          })
          .strict(),
      )
      .max(10),
    columns: z.array(column).max(40),
  })
  .strict();

const analysisReady = performanceAnalysisResponseSchemaV3.options[0];
const comparisonReady = performanceTermComparisonResponseSchemaV4.options[0];

const ready = z
  .object({
    transportVersion: z.literal(5),
    operation: z.literal('dashboard'),
    state: z.literal('ready'),
    view: z.union([analysisReady, comparisonReady]),
    overview,
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const analysis = value.view.operation === 'analysis' ? value.view : value.view.analysis;
    const ids = analysis.matrix.rows
      .filter((row) => row.student.indicatorEligible)
      .map((row) => row.student.id);
    const groups = value.overview.groups;
    const grouped = [...groups.allAtOrAbove, ...groups.withBelow, ...groups.pending];
    if (
      new Set(grouped).size !== grouped.length ||
      grouped.length !== ids.length ||
      grouped.some((studentId) => !ids.includes(studentId))
    )
      fail('inconsistent overview population');
    const stats = value.overview.students;
    if (
      stats.eligible !== ids.length ||
      stats.allAtOrAbove !== groups.allAtOrAbove.length ||
      stats.withBelow !== groups.withBelow.length ||
      stats.pending !== groups.pending.length ||
      stats.classified !== stats.allAtOrAbove + stats.withBelow ||
      stats.eligible !== stats.classified + stats.pending
    )
      fail('inconsistent overview totals');
    const expectedRanking = analysis.matrix.rows
      .filter((row) => row.student.indicatorEligible && row.cells.length > 0 && row.cells.every((cell) => cell.valueMilli !== null))
      .map((row) => ({
        studentId: row.student.id,
        total: row.cells.reduce((total, cell) => total + BigInt(cell.valueMilli!), 0n),
        partial: row.cells.some((cell) => cell.state === 'partial'),
        number: row.student.number,
      }))
      .sort((left, right) => {
        if (left.total === right.total) {
          return left.number - right.number || left.studentId - right.studentId;
        }
        if (left.total > right.total) {
          return -1;
        }
        return 1;
      })
      .slice(0, 10);
    if (
      expectedRanking.some((entry) => entry.total > BigInt(Number.MAX_SAFE_INTEGER)) ||
      expectedRanking.length !== value.overview.ranking.length ||
      expectedRanking.some((entry, index) => {
        const actual = value.overview.ranking[index];
        return actual === undefined || actual.studentId !== entry.studentId || actual.totalMilli !== Number(entry.total) || actual.partial !== entry.partial;
      })
    ) fail('inconsistent overview ranking');
    if (
      value.overview.columns.length !== analysis.columns.length ||
      value.overview.columns.some((item, index) => {
        const source = analysis.columns[index];
        return (
          source === undefined ||
          item.key !== source.key ||
          item.offerId !== source.offerId ||
          item.label !== source.label ||
          item.considered !== source.summary.considered ||
          item.atOrAbove !== source.summary.groups.above.length ||
          item.below !== source.summary.groups.below.length ||
          item.incomplete !== source.summary.groups.incomplete.length ||
          item.noShow !== source.summary.groups['no-show'].length ||
          item.unscaled !== source.summary.groups.unscaled.length
        );
      })
    )
      fail('inconsistent overview columns');
  });

const failure = z
  .object({
    transportVersion: z.literal(5),
    state: performanceResponseSchemaV2.options[0].shape.state,
  })
  .strict();

export const performanceDashboardResponseSchemaV5 = z.union([ready, failure]);
export type PerformanceDashboardV5 = z.infer<typeof ready>;
export type PerformanceDashboardResponseV5 = z.infer<typeof performanceDashboardResponseSchemaV5>;

export function dashboardAnalysisV5(value: PerformanceDashboardV5): PerformanceAnalysisV3 {
  return value.view.operation === 'analysis' ? value.view : value.view.analysis;
}

export function dashboardComparisonV5(
  value: PerformanceDashboardV5,
): PerformanceTermComparisonV4 | null {
  return value.view.operation === 'term-comparison' ? value.view : null;
}

export function dashboardAnalysisRequestV3(request: PerformanceDashboardRequestV5) {
  return performanceAnalysisRequestSchemaV3.parse({
    transportVersion: 3,
    operation: 'analysis',
    year: request.year,
    classId: request.classId,
    period: request.period,
    mode: request.mode,
    statuses: request.statuses,
    lens: request.lens,
    offerId: request.offerId,
  });
}

export function dashboardReferencePeriodV5(
  request: PerformanceDashboardRequestV5,
): PerformanceReferencePeriodV4 | null {
  return request.referencePeriod;
}

export function performanceDashboardMatchesV5(
  request: PerformanceDashboardRequestV5,
  response: PerformanceDashboardResponseV5,
): boolean {
  if (response.state !== 'ready') return true;
  const parsed = performanceDashboardRequestSchemaV5.safeParse(request);
  if (!parsed.success) return false;
  const analysis = dashboardAnalysisV5(response);
  const comparison = dashboardComparisonV5(response);
  return (
    analysis.lens === parsed.data.lens &&
    analysis.offerId === parsed.data.offerId &&
    analysis.matrix.context.year === parsed.data.year &&
    analysis.matrix.classGroup.id === parsed.data.classId &&
    analysis.matrix.period === parsed.data.period &&
    analysis.matrix.mode === parsed.data.mode &&
    (parsed.data.referencePeriod === null
      ? comparison === null
      : comparison?.referencePeriod === parsed.data.referencePeriod)
  );
}

export type PerformanceDashboardLensV5 = PerformanceLensV3;
