import type { SelfResponseV1 } from './self-v1';

type SubjectV1 = SelfResponseV1['subjects'][number];
type MarkV1 = SubjectV1['periods'][number]['final'];

/*
 * Selos brilhantes (owner idea 27/09/2026): a trimester mark of 90% or more (lowered from 95% on
 * 28/09/2026), reached the minimum,
 * earns the student a seal in that subject — something to collect across the year. The same rule
 * as the Brilhante band of the trimester header; recoveries never earn seals themselves.
 *
 * A red trimester mark in ANY subject means no seal in that trimester (owner decision 27/09/2026).
 * Only earned seals are ever shown: nothing locked, nothing "almost" — a missing seal is simply
 * not there. A closed trimester cannot be recovered: the year-end recovery (REC1–REC3) does not
 * count. Only a teacher correcting the mark changes it, and the rule always reads current marks.
 *
 * Seals from assessments (owner decision 28/09/2026): each of the trimester's two assessments
 * (AV1 and AV2, never activities or the parallel exam) that is Brilhante also earns a seal, so a
 * subject can hold up to three per trimester. They count only once the trimester has ended by the
 * calendar and the subject's trimester mark is out, and never in a trimester with a red mark in any
 * subject. The assessment's Brilhante tag still shows; it just does not count. The gold row of the
 * subject list stays for the trimester's own seal.
 */
const SEAL_PERIODS_V1 = ['T1', 'T2', 'T3'] as const;
type SealPeriodV1 = (typeof SEAL_PERIODS_V1)[number];

const isSealPeriodV1 = (period: string): period is SealPeriodV1 =>
  (SEAL_PERIODS_V1 as readonly string[]).includes(period);
const markOf = (subject: SubjectV1, period: string) => subject.periods.find((item) => item.period === period)?.final;

export function isBrilliantMarkV1(mark: MarkV1 | undefined): boolean {
  if (mark?.kind !== 'score' || mark.meetsMinimum !== true || !mark.maximum) return false;
  // ≥ 90% ⇔ 10·value ≥ 9·maximum, in milli units to stay exact.
  return Math.round(mark.value * 1000) * 10 >= Math.round(mark.maximum * 1000) * 9;
}

/** Some subject is red (below the minimum) in the trimester. */
function hasRedMarkV1(subjects: readonly SubjectV1[], period: SealPeriodV1): boolean {
  return subjects.some((subject) => {
    const mark = markOf(subject, period);
    return mark?.kind === 'score' && mark.meetsMinimum === false;
  });
}

/** Whether the subject holds a seal in the trimester. */
export function earnsSealV1(subjects: readonly SubjectV1[], subject: SubjectV1, period: string): boolean {
  return isSealPeriodV1(period) && isBrilliantMarkV1(markOf(subject, period)) && !hasRedMarkV1(subjects, period);
}

type PartialV1 = NonNullable<SubjectV1['periods'][number]['partials']>[number];

/**
 * Whether one activity of the subject earned a seal: a Brilhante AV1/AV2 the student did, in an
 * ended trimester whose mark is out, with no red mark in any subject. The same rule counts the
 * seals and labels the activity "selo Brilhante" (owner request 20/10/2026), so they never disagree.
 */
export function earnsAssessmentSealV1(
  subjects: readonly SubjectV1[],
  subject: SubjectV1,
  period: string,
  partial: PartialV1,
  endedPeriods: readonly string[] = [],
): boolean {
  // Only AV1/AV2, never the parallel exam: a partial flagged as both is not trusted as an AV.
  if (
    !isSealPeriodV1(period) ||
    partial.assessment !== true ||
    partial.parallel === true ||
    partial.notDone ||
    !isBrilliantMarkV1(partial.mark)
  )
    return false;
  const term = subject.periods.find((item) => item.period === period);
  return endedPeriods.includes(period) && term?.final.kind === 'score' && !hasRedMarkV1(subjects, period);
}

/** Seals from the subject's Brilhante assessments in an ended trimester whose mark is out. */
function assessmentSealsV1(
  subjects: readonly SubjectV1[],
  subject: SubjectV1,
  period: SealPeriodV1,
  endedPeriods: readonly string[],
): number {
  const term = subject.periods.find((item) => item.period === period);
  return (term?.partials ?? []).filter((partial) =>
    earnsAssessmentSealV1(subjects, subject, period, partial, endedPeriods),
  ).length;
}

/** Seals the student holds this year: per subject and trimester, the trimester's own seal and
 * one per Brilhante assessment (the latter only for `endedPeriods`). */
export function brilliantSealCountV1(
  subjects: readonly SubjectV1[],
  endedPeriods: readonly string[] = [],
): number {
  return SEAL_PERIODS_V1.reduce(
    (total, period) =>
      total +
      subjects.reduce(
        (count, subject) =>
          count +
          (earnsSealV1(subjects, subject, period) ? 1 : 0) +
          assessmentSealsV1(subjects, subject, period, endedPeriods),
        0,
      ),
    0,
  );
}
