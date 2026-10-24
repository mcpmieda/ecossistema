import { z } from 'zod';
import { performanceRequestSchemaV2, performanceResponseSchemaV2 } from './relational-performance-v2';
import {
  performanceAnalysisRequestSchemaV3,
  performanceAnalysisResponseSchemaV3,
  performanceAnalysisMatchesV3,
} from './performance-analysis-v3';

const matrixRequest = performanceRequestSchemaV2.options[1];
const currentPeriod = z.union([z.literal(2), z.literal(3)]);
const referencePeriod = z.union([z.literal(1), z.literal(2)]);
const lens = z.enum(['result', 'quantitative', 'qualitative']);
const id = z.number().int().positive().max(2_147_483_647);
const percent = z.number().finite().nonnegative();

/** Explicit, same-year, same-population descriptive comparison. It never compares assessment slots. */
export const performanceTermComparisonRequestSchemaV4 = matrixRequest.extend({
  transportVersion: z.literal(4),
  operation: z.literal('term-comparison'),
  period: currentPeriod,
  referencePeriod,
  lens,
  offerId: z.null(),
}).strict().refine((value) => value.referencePeriod < value.period, {
  message: 'reference trimester must precede current trimester',
  path: ['referencePeriod'],
});
export type PerformanceTermComparisonRequestV4 = z.infer<typeof performanceTermComparisonRequestSchemaV4>;
export type PerformanceTermRelationV4 = 'higher' | 'equal' | 'lower';
export type PerformanceReferencePeriodV4 = 1 | 2;

const reason = z.enum([
  'current-excluded', 'reference-excluded',
  'current-incomplete', 'reference-incomplete',
  'current-no-positive-maximum', 'reference-no-positive-maximum',
]);
const comparisonValue = z.discriminatedUnion('state', [
  z.object({
    key: z.string().regex(/^\d+$/u), state: z.literal('comparable'),
    currentPercent: percent, referencePercent: percent,
    deltaPercentagePoints: z.number().finite(), relation: z.enum(['higher', 'equal', 'lower']), reason: z.null(),
  }).strict(),
  z.object({
    key: z.string().regex(/^\d+$/u), state: z.literal('unavailable'),
    currentPercent: percent.nullable(), referencePercent: percent.nullable(),
    deltaPercentagePoints: z.null(), relation: z.null(), reason,
  }).strict(),
]);
export type PerformanceTermComparisonValueV4 = z.infer<typeof comparisonValue>;
const members = z.array(id).max(150).refine((values) => new Set(values).size === values.length);
const groups = z.object({ higher: members, equal: members, lower: members, unavailable: members }).strict();
const summary = z.object({ comparable: z.number().int().min(0).max(150), unavailable: z.number().int().min(0).max(150), groups }).strict();
const column = z.object({ key: z.string().regex(/^\d+$/u), offerId: id, label: z.string().trim().min(1).max(600), summary }).strict();
const analysis = performanceAnalysisResponseSchemaV3.options[0];
const ready = z.object({
  transportVersion: z.literal(4), operation: z.literal('term-comparison'), state: z.literal('ready'),
  authority: z.literal('descriptive-observation'), basis: z.literal('percentage-points-of-official-maximum'),
  referencePeriod, analysis,
  columns: z.array(column).max(40),
  rows: z.array(z.object({ studentId: id, values: z.array(comparisonValue).max(40) }).strict()).max(150),
}).strict().superRefine((value, ctx) => {
  const fail = () => ctx.addIssue({ code: 'custom', message: 'inconsistent term comparison' });
  const keys = value.analysis.columns.map((item) => item.key);
  if (value.analysis.lens === 'assessments' || value.analysis.offerId !== null || value.analysis.matrix.period === 'annual' || value.analysis.matrix.period <= value.referencePeriod ||
      value.columns.length !== keys.length || value.rows.length !== value.analysis.rows.length) { fail(); return; }
  if (value.columns.some((item, index) => item.key !== keys[index] || item.offerId !== value.analysis.columns[index]?.offerId || item.label !== value.analysis.columns[index]?.label)) fail();
  if (value.rows.some((row, index) => row.studentId !== value.analysis.rows[index]?.studentId || row.values.length !== keys.length || row.values.some((item, i) => item.key !== keys[i]))) fail();
  value.columns.forEach((item, index) => {
    const all = [...item.summary.groups.higher, ...item.summary.groups.equal, ...item.summary.groups.lower, ...item.summary.groups.unavailable];
    if (new Set(all).size !== all.length || all.length !== value.rows.length || item.summary.comparable !== item.summary.groups.higher.length + item.summary.groups.equal.length + item.summary.groups.lower.length || item.summary.unavailable !== item.summary.groups.unavailable.length) fail();
    for (const relation of ['higher', 'equal', 'lower'] as const) {
      const expected = value.rows.filter((row) => row.values[index]?.relation === relation).map((row) => row.studentId);
      if (expected.length !== item.summary.groups[relation].length || expected.some((studentId, i) => studentId !== item.summary.groups[relation][i])) fail();
    }
    const unavailable = value.rows.filter((row) => row.values[index]?.state === 'unavailable').map((row) => row.studentId);
    if (unavailable.length !== item.summary.groups.unavailable.length || unavailable.some((studentId, i) => studentId !== item.summary.groups.unavailable[i])) fail();
  });
  for (const row of value.rows) for (const item of row.values) {
    if (item.state !== 'comparable') continue;
    const delta = item.currentPercent - item.referencePercent;
    let relationContradictsDelta;
    if (item.relation === 'equal') {
      relationContradictsDelta = item.deltaPercentagePoints !== 0;
    } else if (item.relation === 'higher') {
      relationContradictsDelta = item.deltaPercentagePoints < 0;
    } else {
      relationContradictsDelta = item.deltaPercentagePoints > 0;
    }
    if (Math.abs(delta - item.deltaPercentagePoints) > 1e-9 || relationContradictsDelta) fail();
  }
});
const failure = z.object({ transportVersion: z.literal(4), state: performanceResponseSchemaV2.options[0].shape.state }).strict();
export const performanceTermComparisonResponseSchemaV4 = z.union([ready, failure]);
export type PerformanceTermComparisonV4 = z.infer<typeof ready>;
export type PerformanceTermComparisonResponseV4 = z.infer<typeof performanceTermComparisonResponseSchemaV4>;

export function termComparisonAnalysisRequestV3(request: PerformanceTermComparisonRequestV4) {
  return performanceAnalysisRequestSchemaV3.parse({
    transportVersion: 3, operation: 'analysis', year: request.year, classId: request.classId,
    period: request.period, mode: request.mode, statuses: request.statuses, lens: request.lens, offerId: null,
  });
}

export function performanceTermComparisonMatchesV4(request: PerformanceTermComparisonRequestV4, response: PerformanceTermComparisonResponseV4): boolean {
  if (response.state !== 'ready') return true;
  const parsed = performanceTermComparisonRequestSchemaV4.safeParse(request);
  return parsed.success && response.referencePeriod === parsed.data.referencePeriod && response.analysis.matrix.period === parsed.data.period &&
    performanceAnalysisMatchesV3(termComparisonAnalysisRequestV3(parsed.data), response.analysis);
}
