import { compareSourceSubjectPresentationV1 } from '../../../shared/gradebook-contracts/source/subject-abbreviations-v1';
import { settingsValueV1 } from '../../../shared/student-portal-contracts/policy-v1';
import { accessGateV1, periodDisclosureV1 } from '../policies/calendar-v1';
import { selfResponseV1, type SelfResponseV1 } from '../../../shared/student-portal-contracts/self-v1';
import {
  TERM_CLOSING_PERIODS_V1,
  type TermClosingModeV1,
  type TermClosingPeriodV1,
} from '../../../shared/student-portal-contracts/term-closing-v1';
import {
  assignTermClosingVariantsV1,
  termClosingSummaryV1,
  type TermClosingEvaluationV1,
} from '../academic/term-closing-v1';

type PolicyValueV1 = Parameters<typeof settingsValueV1.parse>[0];
const END_FIELD_V1 = { T1: 't1EndsAt', T2: 't2EndsAt', T3: 't3EndsAt' } as const;

const START_FIELD_V1 = { T1: 'yearStartsAt', T2: 't2StartsAt', T3: 't3StartsAt' } as const;
const PREVIOUS_V1: Partial<Record<TermClosingPeriodV1, TermClosingPeriodV1>> = { T2: 'T1', T3: 'T2' };
interface TermClosingTargetsV1 {
  readonly mode: TermClosingModeV1;
  readonly periods: readonly TermClosingPeriodV1[];
}

/**
 * Which trimesters get a reading. Nothing when the feature is off, access is closed, or the
 * student is assisted/special (D9). `termClosingConclusive` on: every trimester whose official end
 * date has passed (D2, R3; retroactive, D15). Off: only the trimester in progress (its end date not
 * reached, its start reached or the previous trimester ended).
 * Owner decision 2026-09-24 (replaces R2): a trimester whose marks are not released for the class
 * (allowed periods + disclosure dates, the same rule as the marks) gets no reading at all, so an
 * unreleased trimester never shows up as a tab of its own.
 */
export function termClosingTargetsV1(
  policy: PolicyValueV1,
  academicState: SelfResponseV1['profile']['academicState'],
  now: Date,
): TermClosingTargetsV1 {
  const value = settingsValueV1.parse(policy);
  const mode: TermClosingModeV1 = value.termClosingConclusive ? 'conclusion' : 'progress';
  if (!value.showTermClosing || !accessGateV1(value, now) || academicState !== 'regular') return { mode, periods: [] };
  const at = (raw: string | null | undefined) => (raw && Number.isFinite(Date.parse(raw)) ? Date.parse(raw) : null);
  const ended = (period: TermClosingPeriodV1) => {
    const end = at(value.calendar[END_FIELD_V1[period]]);
    return end !== null && now.getTime() >= end;
  };
  const released = (period: TermClosingPeriodV1) => periodDisclosureV1(value, period, now) === 'allowed';
  if (mode === 'conclusion')
    return { mode, periods: TERM_CLOSING_PERIODS_V1.filter((period) => ended(period) && released(period)) };
  const current = TERM_CLOSING_PERIODS_V1.find((period) => {
    if (at(value.calendar[END_FIELD_V1[period]]) === null || ended(period)) return false;
    const start = at(value.calendar[START_FIELD_V1[period]]);
    const previous = PREVIOUS_V1[period];
    return start !== null ? now.getTime() >= start : previous === undefined || ended(previous);
  });
  return { mode, periods: current && released(current) ? [current] : [] };
}

/**
 * Trimesters whose end date in the student's calendar has passed (owner decision 28/09/2026):
 * seals from Brilhante assessments count only for these. Dates only, no marks or other students.
 */
export function endedPeriodsV1(policy: PolicyValueV1, now: Date): TermClosingPeriodV1[] {
  const value = settingsValueV1.parse(policy);
  return TERM_CLOSING_PERIODS_V1.filter((period) => {
    const raw = value.calendar[END_FIELD_V1[period]];
    const end = raw ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(end) && now.getTime() >= end;
  });
}

/** Shared by the student page and the admin preview so both show the same codes and variants. */
export function buildTermClosingsV1(input: {
  targets: TermClosingTargetsV1;
  evaluations: ReadonlyMap<number, readonly TermClosingEvaluationV1[]>;
  studentKey: string;
}) {
  const { mode, periods } = input.targets;
  const inScope = new Map<number, TermClosingEvaluationV1[]>();
  for (const [subjectId, list] of input.evaluations) {
    const kept = list.filter((evaluation) => evaluation.mode === mode && periods.includes(evaluation.period));
    if (kept.length) inScope.set(subjectId, kept);
  }
  const closings = assignTermClosingVariantsV1(input.studentKey, inScope);
  // One summary per trimester that has closings, oldest first; `summary` stays the most recent
  // for pages that only know the single field.
  const summaries = periods
    .map((period) => termClosingSummaryV1(input.studentKey, period, closings, mode))
    .filter((summary): summary is NonNullable<typeof summary> => summary !== undefined);
  return { closings, summary: summaries.at(-1), summaries };
}

/**
 * Adds closings after the published-visibility filter. A closed trimester that is not released
 * yet still gets its closing, shown without marks (R2): its subject is added with no periods.
 */
export function attachTermClosingsV1(input: {
  projection: SelfResponseV1;
  targets: TermClosingTargetsV1;
  evaluations: ReadonlyMap<number, readonly TermClosingEvaluationV1[]>;
  sourceSubjects: readonly { subjectId: number; label: string }[];
  studentKey: string;
}): SelfResponseV1 {
  const { projection } = input;
  if (input.targets.periods.length === 0) return projection;
  const { closings, summary, summaries } = buildTermClosingsV1(input);
  if (closings.size === 0) return projection;

  const bySubject = new Map(projection.subjects.map((subject) => [subject.subjectId, subject]));
  for (const source of input.sourceSubjects)
    if (!bySubject.has(source.subjectId) && closings.has(source.subjectId))
      bySubject.set(source.subjectId, { subjectId: source.subjectId, label: source.label, order: 0, periods: [] });
  const subjects = [...bySubject.values()]
    .sort((a, b) => compareSourceSubjectPresentationV1(a.label, b.label) || a.subjectId - b.subjectId)
    .map((subject, order) => {
      const list = closings.get(subject.subjectId);
      return { ...subject, order, ...(list ? { closings: list } : {}) };
    });
  return selfResponseV1.parse({
    ...projection,
    state: subjects.length ? 'ready' : 'no-publication',
    subjects,
    ...(summary ? { closingSummary: summary } : {}),
    ...(summaries.length ? { closingSummaries: summaries } : {}),
  });
}
