import { z } from 'zod';
import {
  performanceRequestSchemaV2,
  performanceResponseSchemaV2,
  performanceResponseMatchesV2,
} from './relational-performance-v2';

// Reuse the V2 scope and matrix without changing the responses of existing clients.
const matrixRequest = performanceRequestSchemaV2.options[1];
const matrixResponse = performanceResponseSchemaV2.options[2];
export const PERFORMANCE_LENSES_V3 = [
  'result',
  'quantitative',
  'qualitative',
  'assessments',
] as const;
export const ANALYSIS_BUCKETS_V3 = ['above', 'below', 'incomplete', 'no-show', 'unscaled'] as const;
const id = z.number().int().positive().max(2_147_483_647);
const milli = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const lens = z.enum(PERFORMANCE_LENSES_V3);
export const performanceAnalysisRequestSchemaV3 = matrixRequest
  .extend({
    transportVersion: z.literal(3),
    operation: z.literal('analysis'),
    lens,
    offerId: id.nullable(),
  })
  .strict()
  .refine((value) => (value.lens === 'assessments') === (value.offerId !== null));
export type PerformanceAnalysisRequestV3 = z.infer<typeof performanceAnalysisRequestSchemaV3>;
export type PerformanceLensV3 = z.infer<typeof lens>;
const key = z.string().regex(/^\d+(?::[123]:\d+)?$/u);
const reading = z
  .object({
    key,
    valueMilli: milli.nullable(),
    maximumMilli: milli.positive().nullable(),
    recordedMilli: milli.nullable(),
    notDone: z.literal(true).optional(),
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
    percent: z.number().finite().nonnegative().nullable(),
    bucket: z.enum([...ANALYSIS_BUCKETS_V3, 'excluded']),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.notDone && (value.recordedMilli !== null || value.valueMilli !== null))
      ctx.addIssue({ code: 'custom', message: 'Observation/value mismatch' });
    if ((value.state === 'complete' || value.state === 'partial') !== (value.valueMilli !== null))
      ctx.addIssue({ code: 'custom', message: 'reading value/state mismatch' });
    if (
      value.percent !== null &&
      ((value.state !== 'complete' && value.state !== 'partial') || value.maximumMilli === null)
    )
      ctx.addIssue({ code: 'custom', message: 'unavailable reading percentage' });
    if (
      (value.bucket === 'above' || value.bucket === 'below') &&
      value.percent === null &&
      value.state !== 'repeat-failure'
    )
      ctx.addIssue({ code: 'custom', message: 'unscaled reading classified' });
    if (value.state === 'repeat-failure' && value.bucket !== 'below' && value.bucket !== 'excluded')
      ctx.addIssue({ code: 'custom', message: 'repeat failure must be below or excluded' });
  });
export type AnalysisReadingV3 = z.infer<typeof reading>;
const members = z
  .array(id)
  .max(150)
  .refine((values) => new Set(values).size === values.length);
const summary = z
  .object({
    considered: z.number().int().min(0).max(150),
    scaled: z.number().int().min(0).max(150),
    meanPercent: z.number().finite().nonnegative().nullable(),
    medianPercent: z.number().finite().nonnegative().nullable(),
    groups: z
      .object({
        above: members,
        below: members,
        incomplete: members,
        'no-show': members,
        unscaled: members,
      })
      .strict(),
  })
  .strict();
const column = z
  .object({
    key,
    offerId: id,
    term: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
    slot: z.number().int().min(1).max(20).nullable(),
    label: z.string().trim().min(1).max(600),
    summary,
  })
  .strict();
const ready = z
  .object({
    transportVersion: z.literal(3),
    operation: z.literal('analysis'),
    state: z.literal('ready'),
    lens,
    offerId: id.nullable(),
    matrix: matrixResponse,
    columns: z.array(column).max(40),
    rows: z.array(z.object({ studentId: id, values: z.array(reading).max(40) }).strict()).max(150),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = () => ctx.addIssue({ code: 'custom', message: 'inconsistent analytical scope' });
    const keys = value.columns.map((item) => item.key);
    if (new Set(keys).size !== keys.length || value.rows.length !== value.matrix.rows.length) {
      fail();
      return;
    }
    if (
      value.rows.some(
        (row, index) =>
          row.studentId !== value.matrix.rows[index]?.student.id ||
          row.values.length !== keys.length ||
          row.values.some((item, i) => item.key !== keys[i]),
      )
    )
      fail();
    if (
      value.columns.some((item) => !value.matrix.offers.some((offer) => offer.id === item.offerId))
    )
      fail();
    if (value.lens === 'assessments') {
      if (
        value.columns.length > 39 ||
        value.offerId === null ||
        value.columns.some(
          (item) =>
            item.offerId !== value.offerId ||
            item.term === null ||
            item.slot === null ||
            item.key !== `${item.offerId}:${item.term}:${item.slot}` ||
            (value.matrix.period !== 'annual' && value.matrix.period !== item.term),
        )
      )
        fail();
    } else if (
      value.offerId !== null ||
      keys.length !== value.matrix.offers.length ||
      value.columns.some(
        (item, i) =>
          item.offerId !== value.matrix.offers[i]?.id ||
          item.key !== String(item.offerId) ||
          item.term !== null ||
          item.slot !== null,
      )
    )
      fail();
    value.columns.forEach((item, i) => {
      const groups = item.summary.groups;
      const count = ANALYSIS_BUCKETS_V3.reduce((n, bucket) => n + groups[bucket].length, 0);
      const scaled = value.rows.filter((row) => {
        const reading = row.values[i];
        return (
          reading?.percent !== null && (reading?.bucket === 'above' || reading?.bucket === 'below')
        );
      }).length;
      if (
        count !== item.summary.considered ||
        item.summary.scaled !== scaled ||
        (item.summary.scaled === 0) !== (item.summary.meanPercent === null) ||
        (item.summary.scaled === 0) !== (item.summary.medianPercent === null)
      )
        fail();
      for (const bucket of ANALYSIS_BUCKETS_V3) {
        const expected = value.rows
          .filter((row) => row.values[i]?.bucket === bucket)
          .map((row) => row.studentId);
        if (
          expected.length !== groups[bucket].length ||
          expected.some((studentId, j) => studentId !== groups[bucket][j])
        )
          fail();
      }
      if (
        value.rows.some(
          (row, j) =>
            !value.matrix.rows[j]!.student.indicatorEligible &&
            row.values[i]?.bucket !== 'excluded',
        )
      )
        fail();
    });
  });
const failure = z
  .object({
    transportVersion: z.literal(3),
    state: performanceResponseSchemaV2.options[0].shape.state,
  })
  .strict();
export const performanceAnalysisResponseSchemaV3 = z.union([ready, failure]);
export type PerformanceAnalysisV3 = z.infer<typeof ready>;
export type PerformanceAnalysisResponseV3 = z.infer<typeof performanceAnalysisResponseSchemaV3>;
export function analysisMatrixRequestV2(request: PerformanceAnalysisRequestV3) {
  return matrixRequest.parse({
    transportVersion: 2,
    operation: 'matrix',
    year: request.year,
    classId: request.classId,
    period: request.period,
    mode: request.mode,
    statuses: request.statuses,
  });
}
export function performanceAnalysisMatchesV3(
  request: PerformanceAnalysisRequestV3,
  response: PerformanceAnalysisResponseV3,
): boolean {
  if (response.state !== 'ready') return true;
  const parsed = performanceAnalysisRequestSchemaV3.safeParse(request);
  return (
    parsed.success &&
    response.lens === parsed.data.lens &&
    response.offerId === parsed.data.offerId &&
    performanceResponseMatchesV2(analysisMatrixRequestV2(parsed.data), response.matrix)
  );
}
