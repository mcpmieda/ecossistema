// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  assignTermClosingVariantsV1,
  evaluateTermClosingV1,
  evaluateTermProgressV1,
  termClosingSummaryV1,
  type TermClosingEvaluationV1,
} from '../../../server/student-portal/academic/term-closing-v1';
import {
  resolveSimplifiedTermV1,
  type SimplifiedInstrumentSlotV1,
} from '../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';
import {
  renderTermClosingMessageV1,
  subjectSentenceLabelV1,
  TERM_CLOSING_CATALOG_V1,
  termClosingV1,
} from '../../../shared/student-portal-contracts/term-closing-v1';

// Synthetic T1 shaped like production: AV1 8.5 + AV2 5 (45%) and qualitative 16.5 (55%).
type FactV1 = readonly [
  slot: number,
  maximum: number | null,
  value: number | null,
  observed?: boolean,
];
function term1(
  facts: readonly FactV1[],
  extra: { official?: number | null; recoveryPending?: boolean; term?: 1 | 3 } = {},
) {
  const term = extra.term ?? 1;
  const outcome = resolveSimplifiedTermV1({
    term,
    instruments: facts.map(([slot, maximum, value]) => ({
      slot: slot as SimplifiedInstrumentSlotV1,
      maximumMilli: maximum,
      valueMilli: value,
    })),
  });
  return evaluateTermClosingV1({
    term,
    outcome,
    officialTotalMilli: extra.official === undefined ? null : extra.official,
    instruments: facts.map(([slot, , value, observed]) => ({
      slot,
      value,
      observed: observed ?? true,
    })),
    minimumApprovalMilli: 60_000,
    recoveryPending: extra.recoveryPending ?? false,
  });
}
const qualitative = (values: readonly (number | null)[]): FactV1[] =>
  [4500, 3000, 6000, 3000].map(
    (maximum, index) => [11 + index, maximum, values[index] ?? null] as const,
  );

describe('Fechamento do trimestre engine (#1132)', () => {
  it('reads a clean, clearly-above-minimum term as a recognition line only (D5, D14)', () => {
    expect(
      term1([[1, 8500, 7500], [2, 5000, 4500], ...qualitative([4500, 3000, 5500, 3000])]),
    ).toEqual({
      period: 'T1',
      mode: 'conclusion',
      level: 'good',
      conclusion: 'line.good',
    });
  });

  it('marks a total just above the minimum as a point to care, always with a weight (R10)', () => {
    const result = term1([
      [1, 8500, 5500],
      [2, 5000, 3000],
      ...qualitative([2500, 2000, 3000, 2000]),
    ]);
    expect(result?.level).toBe('point');
    expect(result?.conclusion).toBe('conclusion.good-with-point');
    expect(result?.weight).toBeDefined();
  });

  it('puts a blank ("não fez") above weak assessments and points to the next activities (D1, R4)', () => {
    // Production always records the official term total (am1) alongside a blank.
    const result = term1(
      [[1, 8500, 3000], [2, 5000, 2000], ...qualitative([4500, 3000, null, 3000])],
      { official: 15_500 },
    );
    expect(result).toMatchObject({
      level: 'attention',
      conclusion: 'conclusion.attention',
      weight: 'weight.not-done-one',
      action: 'action.catch-up',
    });
  });

  it('reads one missing activity in the singular and several in the plural (owner, 2026-09-24)', () => {
    const one = term1(
      [[1, 8500, 3000], [2, 5000, 2000], ...qualitative([4500, 3000, null, 3000])],
      { official: 15_500 },
    );
    const two = term1(
      [[1, 8500, 3000], [2, 5000, 2000], ...qualitative([null, 3000, null, 3000])],
      { official: 11_000 },
    );
    expect(one?.weight).toBe('weight.not-done-one');
    expect(two?.weight).toBe('weight.not-done');
    for (const text of TERM_CLOSING_CATALOG_V1['weight.not-done-one'])
      expect(text).toMatch(/^(Uma|Houve uma) atividade/u);
    for (const text of TERM_CLOSING_CATALOG_V1['progress.weight.not-done-one'])
      expect(text).not.toMatch(/atividades/u);
  });

  it("recognizes activities only with a real contrast to the student's own assessments", () => {
    const result = term1([
      [1, 8500, 3500],
      [2, 5000, 2000],
      ...qualitative([4500, 3000, 6000, 3000]),
    ]);
    expect(result).toMatchObject({
      weight: 'weight.assessments',
      strength: 'strength.activities',
      action: 'action.assessments',
    });
  });

  it('recognizes a parallel exam that was taken, never invites to take one, and ignores a blank one', () => {
    const took = term1([
      [1, 8500, 2000],
      [2, 5000, 1000],
      [3, null, 7000],
      ...qualitative([2000, 1500, 3000, 1500]),
    ]);
    expect(took?.strength).toBe('strength.parallel-done');
    const blank = term1([
      [1, 8500, 2000],
      [2, 5000, 1000],
      [3, null, null],
      ...qualitative([2000, 1500, 3000, 1500]),
    ]);
    expect(blank?.strength).not.toBe('strength.parallel-done');
    expect(blank?.weight ?? '').not.toMatch(/^weight\.not-done/u);
    for (const code of Object.keys(TERM_CLOSING_CATALOG_V1))
      expect(code).not.toMatch(/action\.parallel/);
  });

  it('gives no reading without both assessments or a term total (decision 12)', () => {
    expect(
      term1([[1, 8500, 7000], [2, 5000, null], ...qualitative([4500, 3000, 6000, 3000])]),
    ).toBeNull();
  });

  it('closes T3 toward recovery or the end of the year, with no "next assessments" (decision 15)', () => {
    const t3 = (values: number[], recoveryPending: boolean) =>
      term1(
        [
          [1, 13000, values[0]!],
          [2, 5000, values[1]!],
          ...[6000, 4000, 12000].map((max, i) => [11 + i, max, values[2 + i]!] as const),
        ],
        { term: 3, recoveryPending },
      );
    expect(t3([4000, 2000, 3000, 2000, 5000], true)).toMatchObject({
      conclusion: 'conclusion.recovery',
      action: 'action.recovery',
    });
    expect(t3([12000, 4500, 6000, 4000, 11000], false)).toEqual({
      period: 'T3',
      mode: 'conclusion',
      level: 'good',
      conclusion: 'line.year-good',
    });
    const weak = t3([6000, 3000, 6000, 4000, 12000], false);
    expect(weak?.level).not.toBe('good');
    expect(weak?.action).toBeUndefined();
  });

  it('never carries numbers in the catalog, and renders only names and the trimester (R1)', () => {
    for (const variants of Object.values(TERM_CLOSING_CATALOG_V1)) {
      expect(variants.length).toBeGreaterThanOrEqual(3);
      for (const text of variants) expect(text.replace(/\{[a-z]+\}/g, '')).not.toMatch(/\d|%/);
    }
    expect(TERM_CLOSING_CATALOG_V1['line.good'].length).toBeGreaterThanOrEqual(6);
    expect(
      renderTermClosingMessageV1(
        { code: 'summary.few-attention', variant: 0 },
        { period: 'T1', subjects: ['PORTUGUÊS', 'ED. FÍSICA'] },
      ),
    ).toBe(
      'Você fechou bem o 1º trimestre na maior parte das disciplinas. Português e Ed. Física pedem sua atenção.',
    );
    expect(subjectSentenceLabelV1('COMPUTAÇÃO')).toBe('Computação');
  });
});

describe('Acompanhamento: the trimester in progress (termClosingConclusive off)', () => {
  const progress = (facts: readonly FactV1[]) => {
    const outcome = resolveSimplifiedTermV1({
      term: 2,
      instruments: facts.map(([slot, maximum, value]) => ({
        slot: slot as SimplifiedInstrumentSlotV1,
        maximumMilli: maximum,
        valueMilli: value,
      })),
    });
    return evaluateTermProgressV1({
      term: 2,
      outcome,
      officialTotalMilli: null,
      instruments: facts.map(([slot, maximum, value, observed]) => ({
        slot,
        maximum,
        value,
        observed: observed ?? value !== null,
      })),
      minimumApprovalMilli: 60_000,
      recoveryPending: false,
    });
  };

  it('reads only what is recorded so far, in present tense, with a forward action', () => {
    const early = progress([
      [1, 8500, 3000],
      [2, 5000, null, false],
      [11, 4500, 4000],
      [12, 3000, null, false],
    ]);
    expect(early).toMatchObject({
      period: 'T2',
      mode: 'progress',
      level: 'attention',
      conclusion: 'progress.conclusion.attention',
      weight: 'progress.weight.assessments',
      action: 'progress.action.assessments',
    });
    expect(early?.strength).toBe('progress.strength.activities');
    const asMessages = Object.fromEntries(
      Object.entries(early!).map(([key, value]) =>
        ['conclusion', 'weight', 'strength', 'action'].includes(key)
          ? [key, { code: value, variant: 0 }]
          : [key, value],
      ),
    );
    expect(termClosingV1.safeParse(asMessages).success).toBe(true);
  });

  it('says "até aqui, tudo certo" for a good start and waits for a first assessment', () => {
    expect(
      progress([
        [1, 8500, 8000],
        [2, 5000, null, false],
        [11, 4500, 4500],
      ]),
    ).toEqual({
      period: 'T2',
      mode: 'progress',
      level: 'good',
      conclusion: 'progress.line.good',
    });
    expect(
      progress([
        [1, 8500, null, false],
        [2, 5000, null, false],
        [11, 4500, 4500],
      ]),
    ).toBeNull();
  });

  it('keeps every progress phrase in present or future tense and never mixes modes', () => {
    for (const [code, variants] of Object.entries(TERM_CLOSING_CATALOG_V1))
      if (code.startsWith('progress.'))
        for (const text of variants) expect(text).not.toMatch(/foram|fechou|fechamento/iu);
    expect(
      termClosingV1.safeParse({
        period: 'T1',
        mode: 'progress',
        level: 'good',
        conclusion: { code: 'line.good', variant: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('variants and summary (decision 7, D4)', () => {
  const evaluation = (level: TermClosingEvaluationV1['level']): TermClosingEvaluationV1 =>
    level === 'good'
      ? { period: 'T1', mode: 'conclusion', level, conclusion: 'line.good' }
      : {
          period: 'T1',
          mode: 'conclusion',
          level,
          conclusion: 'conclusion.attention',
          weight: 'weight.assessments',
          action: 'action.assessments',
        };
  const subjects = (level: TermClosingEvaluationV1['level'], count = 12) =>
    new Map(Array.from({ length: count }, (_, index) => [900 + index, [evaluation(level)]]));

  it('is stable for one student and valid for the contract', () => {
    const first = assignTermClosingVariantsV1('uid-a', subjects('good'));
    expect(assignTermClosingVariantsV1('uid-a', subjects('good'))).toEqual(first);
    for (const list of first.values())
      for (const closing of list) expect(termClosingV1.parse(closing)).toEqual(closing);
  });

  it("does not repeat a recognition line on one student's page while alternatives exist", () => {
    const lines = [...assignTermClosingVariantsV1('uid-b', subjects('good', 6)).values()].map(
      (list) => list[0]!.conclusion.variant,
    );
    expect(new Set(lines).size).toBe(6);
  });

  it('spreads variants roughly evenly across a synthetic class', () => {
    const counts = [0, 0, 0];
    for (let student = 0; student < 300; student++) {
      const assigned = assignTermClosingVariantsV1(`uid-${student}`, subjects('attention', 1));
      counts[assigned.get(900)![0]!.weight!.variant]! += 1;
    }
    for (const count of counts) expect(count).toBeGreaterThan(60);
  });

  it('summarizes the trimester by the subjects below the minimum', () => {
    const closings = assignTermClosingVariantsV1(
      'uid-c',
      new Map([
        [1, [evaluation('good')]],
        [2, [evaluation('attention')]],
        [3, [evaluation('point')]],
      ]),
    );
    expect(termClosingSummaryV1('uid-c', 'T1', closings)).toMatchObject({
      message: { code: 'summary.few-attention' },
      attentionSubjectIds: [2],
    });
    expect(termClosingSummaryV1('uid-c', 'T2', closings)).toBeUndefined();
  });
});

describe('Self display rules (D2, D8, D9, R2, R3)', async () => {
  const { attachTermClosingsV1, endedPeriodsV1, termClosingTargetsV1 } =
    await import('../../../server/student-portal/publication/term-closing-self-v1');
  const { initialPolicyDefaultsV1 } =
    await import('../../../server/student-portal/policies/defaults-v1');
  const { SYNTHETIC_SELF_V1 } =
    await import('../../../shared/student-portal-contracts/fixtures-v1');
  const now = new Date('2026-06-01T12:00:00Z');
  const policy = (patch: Record<string, unknown> = {}, calendar: Record<string, unknown> = {}) => {
    const value = initialPolicyDefaultsV1();
    return {
      ...value,
      accessEnabled: true,
      showTermClosing: true,
      termClosingConclusive: true,
      allowedPeriods: ['T1', 'T2', 'T3'],
      ...patch,
      calendar: {
        ...value.calendar,
        yearStartsAt: '2026-02-23T03:00:00.000Z',
        t2StartsAt: '2026-05-18T03:00:00.000Z',
        t3StartsAt: '2026-09-01T03:00:00.000Z',
        t1EndsAt: '2026-05-15T03:00:00.000Z',
        disclosure: {
          mode: 'single',
          at: '2026-02-23T03:00:00.000Z',
          periods: ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'],
        },
        ...calendar,
      },
    };
  };

  it('opens only closed trimesters, and only with the policy, access and a regular student', () => {
    const periods = (...args: Parameters<typeof termClosingTargetsV1>) =>
      termClosingTargetsV1(...args).periods;
    expect(periods(policy(), 'regular', now)).toEqual(['T1']);
    expect(periods(policy({ showTermClosing: false }), 'regular', now)).toEqual([]);
    expect(periods(policy({ accessEnabled: false }), 'regular', now)).toEqual([]);
    expect(periods(policy(), 'special', now)).toEqual([]);
    expect(periods(policy(), 'assisted', now)).toEqual([]);
    expect(periods(policy({}, { t1EndsAt: null }), 'regular', now)).toEqual([]);
    expect(
      periods(
        policy(
          {},
          { t1EndsAt: '2026-07-01T03:00:00.000Z', t2StartsAt: '2026-07-02T03:00:00.000Z' },
        ),
        'regular',
        now,
      ),
    ).toEqual([]);
  });

  it('reads only trimesters whose marks are released for the class (owner, 2026-09-24)', () => {
    const ended = { t2EndsAt: '2026-05-30T03:00:00.000Z' };
    expect(termClosingTargetsV1(policy({}, ended), 'regular', now).periods).toEqual(['T1', 'T2']);
    // 8A-like: only T1 allowed; T2 has ended but its marks are not released, so no T2 reading.
    expect(
      termClosingTargetsV1(policy({ allowedPeriods: ['T1'] }, ended), 'regular', now).periods,
    ).toEqual(['T1']);
    // Marks released later than today: no reading yet either.
    const later = {
      disclosure: { mode: 'single', at: '2026-07-01T03:00:00.000Z', periods: ['T1', 'T2'] },
    };
    expect(
      termClosingTargetsV1(policy({}, { ...ended, ...later }), 'regular', now).periods,
    ).toEqual([]);
    const progress = policy(
      { termClosingConclusive: false, allowedPeriods: ['T1'] },
      { t2EndsAt: '2026-09-01T03:00:00.000Z' },
    );
    expect(termClosingTargetsV1(progress, 'regular', now)).toEqual({
      mode: 'progress',
      periods: [],
    });
  });

  it('lists trimesters ended by the calendar for assessment seals, whatever the closing switches', () => {
    expect(endedPeriodsV1(policy(), now)).toEqual(['T1']);
    expect(endedPeriodsV1(policy({ showTermClosing: false, accessEnabled: false }), now)).toEqual([
      'T1',
    ]);
    expect(endedPeriodsV1(policy({}, { t2EndsAt: '2026-05-30T03:00:00.000Z' }), now)).toEqual([
      'T1',
      'T2',
    ]);
    expect(endedPeriodsV1(policy({}, { t1EndsAt: null }), now)).toEqual([]);
    expect(endedPeriodsV1(policy(), new Date('2026-05-15T03:00:00.000Z'))).toEqual(['T1']);
    expect(endedPeriodsV1(policy(), new Date('2026-05-15T02:59:59.999Z'))).toEqual([]);
  });

  it('with conclusive terms off, reads only the trimester in progress', () => {
    const progress = policy(
      { termClosingConclusive: false },
      { t2EndsAt: '2026-09-01T03:00:00.000Z' },
    );
    expect(termClosingTargetsV1(progress, 'regular', now)).toEqual({
      mode: 'progress',
      periods: ['T2'],
    });
    expect(termClosingTargetsV1(progress, 'regular', new Date('2026-04-01T12:00:00Z'))).toEqual({
      mode: 'progress',
      periods: ['T1'],
    });
    expect(termClosingTargetsV1(progress, 'regular', new Date('2026-10-01T12:00:00Z'))).toEqual({
      mode: 'progress',
      periods: [],
    });
  });

  it('attaches closings to subjects, adding one the projection lacks', () => {
    const projection = { ...SYNTHETIC_SELF_V1, state: 'no-publication' as const, subjects: [] };
    const result = attachTermClosingsV1({
      projection,
      targets: { mode: 'conclusion', periods: ['T1'] },
      evaluations: new Map([
        [
          77,
          [
            {
              period: 'T1' as const,
              mode: 'conclusion' as const,
              level: 'good' as const,
              conclusion: 'line.good' as const,
            },
          ],
        ],
      ]),
      sourceSubjects: [{ subjectId: 77, label: 'MATEMÁTICA' }],
      studentKey: 'uid-r2',
    });
    expect(result.state).toBe('ready');
    expect(result.subjects).toEqual([
      expect.objectContaining({
        subjectId: 77,
        periods: [],
        closings: [expect.objectContaining({ period: 'T1', level: 'good' })],
      }),
    ]);
    expect(result.closingSummary).toMatchObject({
      period: 'T1',
      message: { code: 'summary.all-good' },
    });
    expect(result.closingSummaries).toEqual([result.closingSummary]);
  });

  it('sends one summary per closed trimester, each about its own closings (owner, 2026-09-24)', () => {
    const projection = { ...SYNTHETIC_SELF_V1, state: 'no-publication' as const, subjects: [] };
    const good = {
      mode: 'conclusion' as const,
      level: 'good' as const,
      conclusion: 'line.good' as const,
    };
    const attention = {
      mode: 'conclusion' as const,
      level: 'attention' as const,
      conclusion: 'conclusion.attention' as const,
      weight: 'weight.assessments' as const,
      action: 'action.assessments' as const,
    };
    const result = attachTermClosingsV1({
      projection,
      targets: { mode: 'conclusion', periods: ['T1', 'T2'] },
      evaluations: new Map([
        [
          77,
          [
            { period: 'T1' as const, ...attention },
            { period: 'T2' as const, ...good },
          ],
        ],
      ]),
      sourceSubjects: [{ subjectId: 77, label: 'MATEMÁTICA' }],
      studentKey: 'uid-per-term',
    });
    expect(
      result.closingSummaries?.map((summary) => [summary.period, summary.message.code]),
    ).toEqual([
      ['T1', 'summary.few-attention'],
      ['T2', 'summary.all-good'],
    ]);
    expect(result.closingSummaries?.[0]?.attentionSubjectIds).toEqual([77]);
    // The single field keeps the most recent one for pages that only know it.
    expect(result.closingSummary).toEqual(result.closingSummaries?.[1]);
  });
});
