import {
  TERM_CLOSING_CATALOG_V1,
  type TermClosingCodeV1,
  type TermClosingModeV1,
  type TermClosingPeriodV1,
  type TermClosingSummaryV1,
  type TermClosingV1,
} from '../../../shared/student-portal-contracts/term-closing-v1';
import {
  SIMPLIFIED_TERM_MAXIMUM_MILLI_V1,
  type SimplifiedTermOutcomeV1,
} from '../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';

/*
 * Fechamento do trimestre engine (#1132, docs/student-portal/TRIMESTER_CLOSING_SPEC.md).
 * Reads the official term outcome of the BN engine and the term's recorded facts, and returns
 * message codes only (never values, R1). Thresholds were calibrated on the 2026 T1 distribution
 * (4,307 student×subject pairs with both assessments): total below the minimum 4.4%; up to ten
 * points above it 18.7%; assessments below the minimum ratio 27%; qualitative below it 5.8%;
 * a blank ("não fez") 11.6%; clean good closings 62.5%. Qualitative work sits near 90% for almost
 * everyone, so its strength needs a contrast within the student (median gap 12 points).
 */
const ANNUAL_MAXIMUM_MILLI = 100_000;
/** "Logo acima do mínimo" (D14, R10): within ten percentage points of the minimum ratio. */
const POINT_BAND_MARGIN = 0.1;
/** A recognized qualitative strength is high and clearly above the student's own assessments. */
const STRONG_RATIO = 0.8;
const STRENGTH_CONTRAST = 0.15;

export interface TermClosingInstrumentV1 {
  readonly slot: number;
  readonly value: number | null;
  readonly observed: boolean;
  /** Recorded maximum; used only by the in-progress reading (progress mode). */
  readonly maximum?: number | null;
}
export interface TermClosingInputV1 {
  readonly term: 1 | 2 | 3;
  readonly outcome: SimplifiedTermOutcomeV1;
  /** Official closure total of the term (am1/am2/am3) when recorded. */
  readonly officialTotalMilli: number | null;
  readonly instruments: readonly TermClosingInstrumentV1[];
  readonly minimumApprovalMilli: number;
  /** The component's official classification is recovery-pending (only used for T3). */
  readonly recoveryPending: boolean;
}
/** Codes without variants; variants are assigned per student by `assignTermClosingVariantsV1`. */
export interface TermClosingEvaluationV1 {
  readonly period: TermClosingPeriodV1;
  readonly mode: TermClosingModeV1;
  readonly level: TermClosingV1['level'];
  readonly conclusion: TermClosingCodeV1;
  readonly weight?: TermClosingCodeV1;
  readonly strength?: TermClosingCodeV1;
  readonly action?: TermClosingCodeV1;
}

const ratio = (value: number, maximum: number) => (maximum > 0 ? value / maximum : null);

/** Below the minimum needs attention; near it, or with something not done or weak, has a point. */
function closingLevelV1(totalRatio: number, minimumRatio: number, hasPoint: boolean): TermClosingV1['level'] {
  if (totalRatio < minimumRatio) return 'attention';
  if (totalRatio < minimumRatio + POINT_BAND_MARGIN || hasPoint) return 'point';
  return 'good';
}

/** Returns null when the term has too little data for a fair reading (spec decision 12). */
export function evaluateTermClosingV1(input: TermClosingInputV1): TermClosingEvaluationV1 | null {
  const { term, outcome } = input;
  const period = `T${term}` as TermClosingPeriodV1;
  const bySlot = new Map(input.instruments.map((item) => [item.slot, item]));
  const assessmentsRecorded = [1, 2].every((slot) => bySlot.get(slot)?.value !== null && bySlot.has(slot));
  const total =
    input.officialTotalMilli ?? (outcome.coverage.complete ? outcome.roundedMilli : null);
  if (!assessmentsRecorded || total === null) return null;

  const minimumRatio = input.minimumApprovalMilli / ANNUAL_MAXIMUM_MILLI;
  const totalRatio = total / SIMPLIFIED_TERM_MAXIMUM_MILLI_V1[term];
  const assessmentRatio = ratio(outcome.quantitativeOriginalMilli, outcome.quantitativeMaximumMilli) ?? 0;
  const hasQualitative = input.instruments.some((item) => item.slot >= 11);
  const qualitativeRatio = hasQualitative
    ? ratio(outcome.qualitativeOperationalMilli, outcome.expectedQualitativeMaximumMilli)
    : null;
  // D1: an observed blank is "não fez"; a blank parallel exam never generates a message.
  const notDoneCount = notDoneCountV1(input.instruments);
  const notDone = notDoneCount > 0;
  const parallelDone = bySlot.get(3)?.value !== null && bySlot.get(3)?.value !== undefined;
  const weakAssessments = assessmentRatio < minimumRatio;
  const weakActivities = qualitativeRatio !== null && qualitativeRatio < minimumRatio;

  const level = closingLevelV1(totalRatio, minimumRatio, notDone || weakAssessments || weakActivities);

  if (term === 3 && input.recoveryPending)
    return {
      period,
      mode: 'conclusion',
      level: 'attention',
      conclusion: 'conclusion.recovery',
      weight: weightV1(notDoneCount, weakAssessments, weakActivities, assessmentRatio, qualitativeRatio),
      ...strengthV1(parallelDone, notDone, hasQualitative, assessmentRatio, qualitativeRatio, weakAssessments, weakActivities),
      action: 'action.recovery',
    };
  if (level === 'good') return { period, mode: 'conclusion', level, conclusion: term === 3 ? 'line.year-good' : 'line.good' };

  const weight = weightV1(notDoneCount, weakAssessments, weakActivities, assessmentRatio, qualitativeRatio);
  return {
    period,
    mode: 'conclusion',
    level,
    conclusion: level === 'attention' ? 'conclusion.attention' : 'conclusion.good-with-point',
    weight,
    ...strengthV1(parallelDone, notDone, hasQualitative, assessmentRatio, qualitativeRatio, weakAssessments, weakActivities),
    // No "next assessments" after T3 (spec decision 15); recovery is handled above.
    ...(term === 3 ? {} : { action: weight === 'weight.assessments' ? 'action.assessments' : 'action.catch-up' }),
  } as TermClosingEvaluationV1;
}

/**
 * In-progress reading (policy `termClosingConclusive` off): only what is recorded so far, present
 * tense codes, and always a forward action. Needs at least one assessment with a mark.
 */
export function evaluateTermProgressV1(input: TermClosingInputV1): TermClosingEvaluationV1 | null {
  const period = `T${input.term}` as TermClosingPeriodV1;
  const recorded = input.instruments.filter(
    (item) => item.slot !== 3 && item.value !== null && (item.maximum ?? 0) > 0,
  );
  const sum = (items: readonly TermClosingInstrumentV1[], key: 'value' | 'maximum') =>
    items.reduce((total, item) => total + (item[key] ?? 0), 0);
  const assessments = recorded.filter((item) => item.slot === 1 || item.slot === 2);
  const qualitative = recorded.filter((item) => item.slot >= 11);
  if (assessments.length === 0) return null;
  const minimumRatio = input.minimumApprovalMilli / ANNUAL_MAXIMUM_MILLI;
  const assessmentRatio = sum(assessments, 'value') / sum(assessments, 'maximum');
  const qualitativeRatio = qualitative.length ? sum(qualitative, 'value') / sum(qualitative, 'maximum') : null;
  const totalRatio = sum(recorded, 'value') / sum(recorded, 'maximum');
  const notDoneCount = notDoneCountV1(input.instruments);
  const notDone = notDoneCount > 0;
  const parallelDone = input.instruments.some((item) => item.slot === 3 && item.value !== null);
  const weakAssessments = assessmentRatio < minimumRatio;
  const weakActivities = qualitativeRatio !== null && qualitativeRatio < minimumRatio;
  let level: TermClosingV1['level'];
  if (totalRatio < minimumRatio) {
    level = 'attention';
  } else if (totalRatio < minimumRatio + POINT_BAND_MARGIN || notDone || weakAssessments || weakActivities) {
    level = 'point';
  } else {
    level = 'good';
  }
  if (level === 'good') return { period, mode: 'progress', level, conclusion: 'progress.line.good' };
  const weight = weightV1(notDoneCount, weakAssessments, weakActivities, assessmentRatio, qualitativeRatio);
  const { strength } = strengthV1(
    parallelDone,
    notDone,
    qualitative.length > 0,
    assessmentRatio,
    qualitativeRatio,
    weakAssessments,
    weakActivities,
  );
  const progress = (code: TermClosingCodeV1) => `progress.${code}` as TermClosingCodeV1;
  return {
    period,
    mode: 'progress',
    level,
    conclusion: level === 'attention' ? 'progress.conclusion.attention' : 'progress.conclusion.point',
    weight: progress(weight),
    ...(strength ? { strength: progress(strength) } : {}),
    action: weight === 'weight.assessments' ? 'progress.action.assessments' : 'progress.action.catch-up',
  };
}

/** Observed blanks ("não fez"), never counting the parallel exam (D1). */
function notDoneCountV1(instruments: readonly TermClosingInstrumentV1[]): number {
  return instruments.filter((item) => item.slot !== 3 && item.observed && item.value === null).length;
}

/**
 * Priority: missing work, then assessments, then activities; otherwise the weaker component (R10).
 * A single missing activity reads in the singular (owner decision 2026-09-24).
 */
function weightV1(
  notDoneCount: number,
  weakAssessments: boolean,
  weakActivities: boolean,
  assessmentRatio: number,
  qualitativeRatio: number | null,
): TermClosingCodeV1 {
  if (notDoneCount === 1) return 'weight.not-done-one';
  if (notDoneCount > 1) return 'weight.not-done';
  if (weakAssessments) return 'weight.assessments';
  if (weakActivities) return 'weight.activities';
  return qualitativeRatio !== null && qualitativeRatio < assessmentRatio
    ? 'weight.activities'
    : 'weight.assessments';
}

/** At most one recognition, only when it is true for this student (never against the weight). */
function strengthV1(
  parallelDone: boolean,
  notDone: boolean,
  hasQualitative: boolean,
  assessmentRatio: number,
  qualitativeRatio: number | null,
  weakAssessments: boolean,
  weakActivities: boolean,
): { strength?: TermClosingCodeV1 } {
  if (parallelDone) return { strength: 'strength.parallel-done' };
  if (
    qualitativeRatio !== null &&
    !weakActivities &&
    qualitativeRatio >= STRONG_RATIO &&
    qualitativeRatio - assessmentRatio >= STRENGTH_CONTRAST
  )
    return { strength: 'strength.activities' };
  if (!weakAssessments && assessmentRatio >= STRONG_RATIO && (qualitativeRatio === null || assessmentRatio >= qualitativeRatio))
    return { strength: 'strength.assessments' };
  if (!notDone && hasQualitative) return { strength: 'strength.all-done' };
  return {};
}

/** FNV-1a: a stable, dependency-free spread for variant choice (not a security primitive). */
function stableHashV1(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index); // NOSONAR: UTF-16 code units on purpose, so the stored hash stays the same
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

type PieceV1 = 'conclusion' | 'weight' | 'strength' | 'action';
const PIECES_V1: readonly PieceV1[] = ['conclusion', 'weight', 'strength', 'action'];

/**
 * Spec decision 7: variants are random across classmates (seeded by the durable student key) and
 * stable for one student; within one student's page a code shared by several subjects in the same
 * trimester takes distinct variants while alternatives exist.
 */
export function assignTermClosingVariantsV1(
  studentKey: string,
  evaluations: ReadonlyMap<number, readonly TermClosingEvaluationV1[]>,
): Map<number, TermClosingV1[]> {
  const groups = new Map<string, { subjectId: number; period: TermClosingPeriodV1; piece: PieceV1; code: TermClosingCodeV1 }[]>();
  for (const [subjectId, list] of evaluations)
    for (const evaluation of list)
      for (const piece of PIECES_V1) {
        const code = evaluation[piece];
        if (!code) continue;
        const group = `${evaluation.period}|${code}`;
        groups.set(group, [...(groups.get(group) ?? []), { subjectId, period: evaluation.period, piece, code }]);
      }
  const chosen = new Map<string, number>();
  for (const [group, members] of groups) {
    const size = TERM_CLOSING_CATALOG_V1[members[0]!.code].length;
    const base = stableHashV1(`${studentKey}|${group}`) % size;
    [...members]
      .sort(
        (a, b) =>
          stableHashV1(`${studentKey}|${group}|${a.subjectId}`) - stableHashV1(`${studentKey}|${group}|${b.subjectId}`) ||
          a.subjectId - b.subjectId,
      )
      .forEach((member, index) => chosen.set(`${member.subjectId}|${member.period}|${member.piece}`, (base + index) % size));
  }
  const result = new Map<number, TermClosingV1[]>();
  for (const [subjectId, list] of evaluations)
    result.set(
      subjectId,
      list.map((evaluation) => {
        const message = (piece: PieceV1) => {
          const code = evaluation[piece];
          return code ? { code, variant: chosen.get(`${subjectId}|${evaluation.period}|${piece}`)! } : undefined;
        };
        const weight = message('weight');
        const strength = message('strength');
        const action = message('action');
        return {
          period: evaluation.period,
          mode: evaluation.mode,
          level: evaluation.level,
          conclusion: message('conclusion')!,
          ...(weight ? { weight } : {}),
          ...(strength ? { strength } : {}),
          ...(action ? { action } : {}),
        };
      }),
    );
  return result;
}

/** Boletim summary (D4) of the most recent closed trimester; attention = below the minimum. */
export function termClosingSummaryV1(
  studentKey: string,
  period: TermClosingPeriodV1,
  closings: ReadonlyMap<number, readonly TermClosingV1[]>,
  mode: TermClosingModeV1 = 'conclusion',
): TermClosingSummaryV1 | undefined {
  const inPeriod = [...closings].flatMap(([subjectId, list]) =>
    list
      .filter((closing) => closing.period === period && closing.mode === mode)
      .map((closing) => ({ subjectId, closing })),
  );
  if (inPeriod.length === 0) return undefined;
  const attentionSubjectIds = inPeriod
    .filter((item) => item.closing.level === 'attention')
    .map((item) => item.subjectId);
  let base: 'summary.all-good' | 'summary.few-attention' | 'summary.many-attention';
  if (attentionSubjectIds.length === 0) {
    base = 'summary.all-good';
  } else if (attentionSubjectIds.length <= 2) {
    base = 'summary.few-attention';
  } else {
    base = 'summary.many-attention';
  }
  const code = (mode === 'progress' ? `progress.${base}` : base) as TermClosingCodeV1;
  return {
    period,
    mode,
    message: { code, variant: stableHashV1(`${studentKey}|${period}|${code}`) % TERM_CLOSING_CATALOG_V1[code].length },
    attentionSubjectIds,
  };
}
