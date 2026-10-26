import { z } from 'zod';

const count = z.number().int().nonnegative().max(100_000);
const id = z.number().int().positive().max(2_147_483_647);
const metric = z.number().finite().nullable();
const term = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const participation = z.object({
  percent: metric,
  deltaPP: metric,
  components: count,
  comparedComponents: count,
  recorded: count,
  expected: count,
  unscaled: count,
}).strict();
/** Original quantitative and qualitative percentages over exactly the same components.
 * Optional on the wire for already-open clients; only returned on explicit request. */
const studentDimensions = z.object({
  quantitativePercent: z.number().finite().nonnegative().nullable(),
  qualitativePercent: z.number().finite().nonnegative().nullable(),
  gapPP: metric,
  components: z.number().int().nonnegative().max(40),
}).strict().superRefine((value, ctx) => {
  const { quantitativePercent: q, qualitativePercent: a, gapPP, components } = value;
  if (components === 0
    ? q !== null || a !== null || gapPP !== null
    : q === null || a === null || gapPP === null || gapPP !== a - q)
    ctx.addIssue({ code: 'custom', message: 'inconsistent student dimension comparison' });
});
export const performanceLearningSchemaV1 = z.object({
  version: z.literal(1),
  students: z.array(z.object({
    studentId: id,
    recurrenceAssessed: z.boolean(),
    recurring: z.array(z.object({
      offerId: id,
      instrumentTerms: z.array(term).max(3),
      consecutiveTerms: z.array(term).max(2),
    }).strict()).max(40),
    participation,
    parallelImprovements: count,
    dimensions: studentDimensions.optional(),
  }).strict()).max(150),
  participation: z.object({
    percent: metric,
    deltaPP: metric,
    students: count,
    comparedStudents: count,
    recorded: count,
    expected: count,
    unscaled: count,
  }).strict(),
  dimensions: z.object({
    quantitativePercent: metric,
    qualitativePercent: metric,
    gapPP: metric,
    students: count,
    components: count,
  }).strict(),
  parallel: z.object({ students: count, improvements: count, meanGainPP: metric }).strict(),
  // At most 40 offers * 3 terms * 10 qualitative instruments, independent of pupil count.
  activitiesToReview: z.array(z.string().regex(/^\d+:[123]:\d+$/u)).max(1200),
}).strict().superRefine((value, ctx) => {
  const invalid = value.students.some((student) => {
    const p = student.participation;
    return p.recorded > p.expected || p.unscaled > p.expected ||
      p.comparedComponents > p.components ||
      (p.percent === null) !== (p.components === 0) ||
      (p.deltaPP === null) !== (p.comparedComponents === 0) ||
      (!student.recurrenceAssessed && student.recurring.length > 0) ||
      new Set(student.recurring.map((item) => item.offerId)).size !== student.recurring.length ||
      student.recurring.some((item) =>
        item.instrumentTerms.length + item.consecutiveTerms.length === 0 ||
        new Set(item.instrumentTerms).size !== item.instrumentTerms.length ||
        new Set(item.consecutiveTerms).size !== item.consecutiveTerms.length ||
        item.consecutiveTerms.includes(1));
  });
  const p = value.participation;
  const extended = value.students.some((student) => student.dimensions !== undefined);
  const dimensionsInvalid = extended && (
    value.students.some((student) => student.dimensions === undefined) ||
    value.dimensions.components !== value.students.reduce((sum, student) => sum + (student.dimensions?.components ?? 0), 0) ||
    value.dimensions.students !== value.students.filter((student) => (student.dimensions?.components ?? 0) > 0).length
  );
  if (invalid || dimensionsInvalid || new Set(value.students.map((item) => item.studentId)).size !== value.students.length ||
    new Set(value.activitiesToReview).size !== value.activitiesToReview.length ||
    p.students !== value.students.filter((item) => item.participation.percent !== null).length ||
    p.comparedStudents !== value.students.filter((item) => item.participation.deltaPP !== null).length ||
    p.recorded !== value.students.reduce((sum, item) => sum + item.participation.recorded, 0) ||
    p.expected !== value.students.reduce((sum, item) => sum + item.participation.expected, 0) ||
    p.unscaled !== value.students.reduce((sum, item) => sum + item.participation.unscaled, 0) ||
    value.dimensions.students > value.students.length || value.parallel.students > value.students.length)
    ctx.addIssue({ code: 'custom', message: 'inconsistent learning evidence' });
});
export type PerformanceLearningV1 = z.infer<typeof performanceLearningSchemaV1>;

const ordinal = '(?:0?[1-9]|1[0-9]|20|i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx)';
const participationName = '(?:participacao|participacoes|particip|participac|partic|partc|part)';
const participationPattern = new RegExp(String.raw`^(?:${participationName}|${ordinal}\s*${participationName}|${participationName}\s*${ordinal})$`, 'u');
/** Category recognition only. Identity remains offer/term/slot; never merge similarly named rows.
 * Keep the grammar anchored: "parte", "partido" and compound activity names are not participation.
 * Apply this only to qualitative slots. Unknown descriptions remain ordinary qualitative work. */
export function isParticipationLabelV1(label: string): boolean {
  const normalized = label.replaceAll(/[ºª°]/gu, '').normalize('NFD')
    .replaceAll(/\p{M}/gu, '').toLocaleLowerCase('pt-BR')
    .replaceAll(/[._():-]/gu, ' ').replaceAll(/\s+/gu, ' ').trim();
  return participationPattern.test(normalized);
}
