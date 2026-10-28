import { describe, expect, it } from 'vitest';
import { annualGoalV1 } from '../../../../src/features/student-portal/workspace/annual-goal-v1';
import type { SelfResponseV1 } from '../../../../shared/student-portal-contracts/self-v1';

type SubjectV1 = SelfResponseV1['subjects'][number];
const scoreOf = (value: number, maximum: number | null) =>
  ({ kind: 'score', value, maximum, meetsMinimum: null }) as const;
function subjectOf(periods: SubjectV1['periods'], extra: Partial<SubjectV1> = {}): SubjectV1 {
  return { subjectId: 1, label: 'MATEMÁTICA', order: 1, periods, ...extra };
}

describe('Meta do ano (2º trimestre)', () => {
  it('asks the 3º tri for what is left of 60, in exact milli points', () => {
    const goal = annualGoalV1(
      subjectOf([
        { period: 'T1', final: scoreOf(16.5, 30) },
        { period: 'T2', final: scoreOf(19.8, 30) },
        { period: 'T3', final: { kind: 'absent' } },
      ]),
      'regular',
    );
    expect(goal).toEqual({ state: 'reachable', soFarMilli: 36_300, t1Milli: 16_500, t2Milli: 19_800, neededMilli: 23_700 });
  });

  it('says the goal is reached at exactly 60 and beyond when more than 40 is missing', () => {
    const at = (t1: number, t2: number) =>
      annualGoalV1(subjectOf([{ period: 'T1', final: scoreOf(t1, 30) }, { period: 'T2', final: scoreOf(t2, 30) }]), 'regular');
    expect(at(30, 30)?.state).toBe('reached');
    expect(at(10, 10)?.state).toBe('reachable'); // exactly 40 needed
    expect(at(10, 9.9)?.state).toBe('beyond');
  });

  it('stays silent when the reading would not be exact or does not apply', () => {
    const base = [
      { period: 'T1' as const, final: scoreOf(15, 30) },
      { period: 'T2' as const, final: scoreOf(15, 30) },
    ];
    expect(annualGoalV1(subjectOf([base[0]!]), 'regular')).toBeNull();
    expect(annualGoalV1(subjectOf([base[0]!, { period: 'T2', final: scoreOf(15, 25) }]), 'regular')).toBeNull();
    expect(annualGoalV1(subjectOf([base[0]!, { period: 'T2', final: scoreOf(15, null) }]), 'regular')).toBeNull();
    expect(annualGoalV1(subjectOf([base[0]!, { period: 'T2', final: { kind: 'nc' } }]), 'regular')).toBeNull();
    expect(annualGoalV1(subjectOf(base), 'assisted')).toBeNull();
    expect(annualGoalV1(subjectOf(base), 'special')).toBeNull();
    expect(annualGoalV1(subjectOf(base, { officialOutcome: 'approved' }), 'regular')).toBeNull();
  });

  it("hides the goal when the school's minimum is not 60% (owner request 27/10/2026)", () => {
    const marked = (value: number, meetsMinimum: boolean) => ({ kind: 'score', value, maximum: 30, meetsMinimum }) as const;
    const goal = (t1: ReturnType<typeof marked>) =>
      annualGoalV1(subjectOf([{ period: 'T1', final: t1 }, { period: 'T2', final: marked(20, true) }]), 'regular');
    // 18 of 30 is 60%: the gradebook agrees, the goal shows.
    expect(goal(marked(18, true))).not.toBeNull();
    // 19 of 30 is above 60%, yet the gradebook says below its minimum: another minimum, no goal.
    expect(goal(marked(19, false))).toBeNull();
  });

  it.each([0, 20, 40])('preserves the T2 target when T3 already has %s points', (t3) => {
    const base = [
      { period: 'T1' as const, final: scoreOf(15, 30) },
      { period: 'T2' as const, final: scoreOf(15, 30) },
    ];
    const withThird = [...base, { period: 'T3' as const, final: scoreOf(t3, 40) }];
    expect(annualGoalV1(subjectOf(withThird), 'regular')).toEqual(
      annualGoalV1(subjectOf(base), 'regular'),
    );
    expect(annualGoalV1(subjectOf(withThird, { officialOutcome: 'approved' }), 'regular')).toBeNull();
    expect(annualGoalV1(subjectOf(withThird, { annualSituation: 'approved-direct' }), 'regular')).toBeNull();
  });
});

describe('subject name inside the Meta do ano sentence', () => {
  it('turns published capitals into a readable name and keeps mixed case', async () => {
    const { subjectInSentenceV1 } = await import('../../../../src/features/student-portal/workspace/annual-goal-v1');
    expect(subjectInSentenceV1('MATEMÁTICA')).toBe('Matemática');
    expect(subjectInSentenceV1('ED. FÍSICA')).toBe('Ed. Física');
    expect(subjectInSentenceV1('PORTUGUÊS')).toBe('Português');
    expect(subjectInSentenceV1('Língua Portuguesa')).toBe('Língua Portuguesa');
  });
});
