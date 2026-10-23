// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SelfResponseV1 } from '../../../../shared/student-portal-contracts/self-v1';
import {
  brilliantSealCountV1,
  earnsSealV1,
  isBrilliantMarkV1,
} from '../../../../src/features/student-portal/grades/brilliant-seal-v1';
import { score } from './fixtures-v1';

type SubjectV1 = SelfResponseV1['subjects'][number];
type PeriodV1 = SubjectV1['periods'][number];

let nextId = 1;
const subject = (...periods: PeriodV1[]): SubjectV1 => ({
  subjectId: nextId,
  label: `Disciplina sintética ${nextId++}`,
  order: nextId,
  periods,
});
// Max 30, minimum 18 (60%), Brilhante from 27 (90%, owner decision 28/09/2026).
const t = (period: PeriodV1['period'], value: number, maximum = 30): PeriodV1 => ({
  period,
  final: score(value, maximum, value * 5 >= maximum * 3),
});

describe('selos brilhantes (owner rules 27/09/2026)', () => {
  it('Brilhante is 90% or more of a mark that reached the minimum, exactly', () => {
    expect(isBrilliantMarkV1(score(27, 30, true))).toBe(true);
    expect(isBrilliantMarkV1(score(26.999, 30, true))).toBe(false);
    expect(isBrilliantMarkV1(score(36, 40, true))).toBe(true);
    expect(isBrilliantMarkV1(score(35.9, 40, true))).toBe(false);
    expect(isBrilliantMarkV1(score(9, 10, true))).toBe(true);
    expect(isBrilliantMarkV1(score(30, 30, null))).toBe(false);
    expect(isBrilliantMarkV1(score(30, null, true))).toBe(false);
    expect(isBrilliantMarkV1({ kind: 'absent' })).toBe(false);
  });

  it('earns a seal when no subject is red in the trimester', () => {
    const star = subject(t('T1', 29.5));
    const subjects = [star, subject(t('T1', 18)), subject(t('T1', 25))];
    expect(earnsSealV1(subjects, star, 'T1')).toBe(true);
    expect(brilliantSealCountV1(subjects)).toBe(1);
  });

  it('a red mark in any subject of the trimester means no seal, and nothing else is counted', () => {
    const star = subject(t('T1', 29.5));
    const subjects = [star, subject(t('T1', 17.9))];
    expect(earnsSealV1(subjects, star, 'T1')).toBe(false);
    expect(brilliantSealCountV1(subjects)).toBe(0);
  });

  it('a closed trimester is never recovered: a passing year-end REC does not bring the seal', () => {
    const star = subject(t('T1', 29.5));
    const red = subject(t('T1', 14), { period: 'REC1', final: score(25, 30, true) });
    expect(earnsSealV1([star, red], star, 'T1')).toBe(false);
    expect(brilliantSealCountV1([star, red])).toBe(0);
  });

  it('a teacher correcting the red mark brings the seal, since the rule reads current marks', () => {
    const star = subject(t('T1', 29.5));
    expect(brilliantSealCountV1([star, subject(t('T1', 14))])).toBe(0);
    expect(brilliantSealCountV1([star, subject(t('T1', 18.5))])).toBe(1);
  });

  it('each trimester stands alone: a red T1 does not touch T2 seals', () => {
    const star = subject(t('T1', 29), t('T2', 29));
    const other = subject(t('T1', 10), t('T2', 20));
    expect(earnsSealV1([star, other], star, 'T1')).toBe(false);
    expect(earnsSealV1([star, other], star, 'T2')).toBe(true);
    expect(brilliantSealCountV1([star, other])).toBe(1);
  });

  it('counts one seal per subject and trimester, T3 included (max 40)', () => {
    const a = subject(t('T1', 29), t('T2', 30), t('T3', 38, 40));
    const b = subject(t('T1', 28.5), t('T2', 20), t('T3', 39, 40));
    expect(brilliantSealCountV1([a, b])).toBe(5);
  });

  it('recoveries never earn seals and unpublished or non-score marks are neither seals nor red', () => {
    const rec = subject(t('T1', 20), { period: 'REC1', final: score(30, 30, true) });
    const absent = subject({ period: 'T1', final: { kind: 'absent' } });
    const nc = subject({ period: 'T1', final: { kind: 'nc' } });
    const star = subject(t('T1', 29.5));
    const all = [rec, absent, nc, star];
    expect(earnsSealV1(all, rec, 'REC1')).toBe(false);
    expect(earnsSealV1(all, star, 'T1')).toBe(true);
    expect(brilliantSealCountV1(all)).toBe(1);
  });
});

describe('selos das avaliações (owner rules 28/09/2026)', () => {
  // AV1/AV2 worth 10 each; Brilhante from 9.
  const av = (id: number, value: number, extra: Partial<NonNullable<PeriodV1['partials']>[number]> = {}) => ({
    assessmentId: id,
    label: `Avaliação sintética ${id}`,
    mark: score(value, 10, value * 5 >= 10 * 3),
    assessment: true as const,
    ...extra,
  });
  const term = (period: PeriodV1['period'], value: number, partials: NonNullable<PeriodV1['partials']>): PeriodV1 => ({
    ...t(period, value),
    partials,
  });

  it('each Brilhante AV1/AV2 of an ended trimester is a seal, besides the trimester one', () => {
    const math = subject(term('T2', 29, [av(1, 9.7), av(2, 8.9)]));
    expect(brilliantSealCountV1([math], ['T1', 'T2'])).toBe(2);
    expect(earnsSealV1([math], math, 'T2')).toBe(true);
  });

  it('up to three seals per subject and trimester', () => {
    const math = subject(term('T1', 30, [av(1, 10), av(2, 9)]));
    expect(brilliantSealCountV1([math], ['T1'])).toBe(3);
  });

  it('counts only once the trimester has ended by the calendar', () => {
    const math = subject(term('T3', 20, [av(1, 10), av(2, 10)]));
    expect(brilliantSealCountV1([math], ['T1', 'T2'])).toBe(0);
    expect(brilliantSealCountV1([math])).toBe(0);
    expect(brilliantSealCountV1([math], ['T3'])).toBe(2);
  });

  it("waits for the subject's trimester mark to be out", () => {
    const math = subject({ period: 'T2', final: { kind: 'absent' }, partials: [av(1, 10)] });
    expect(brilliantSealCountV1([math], ['T2'])).toBe(0);
  });

  it('a red mark in any subject of the trimester cancels assessment seals too', () => {
    const math = subject(term('T2', 25, [av(1, 10), av(2, 10)]));
    expect(brilliantSealCountV1([math, subject(t('T2', 17))], ['T2'])).toBe(0);
    expect(brilliantSealCountV1([math, subject(t('T2', 18))], ['T2'])).toBe(2);
  });

  it('activities, the parallel exam and not-done assessments never count', () => {
    const activity = { assessmentId: 10, label: 'Atividade sintética', mark: score(2, 2, true) };
    const parallel = { assessmentId: 11, label: 'Paralela sintética', mark: score(10, 10, true), parallel: true as const };
    const notDone = av(12, 0, { mark: { kind: 'absent' }, notDone: true });
    const math = subject(term('T1', 20, [activity, parallel, notDone, av(13, 8.99)]));
    expect(brilliantSealCountV1([math], ['T1'])).toBe(0);
  });

  it('a partial flagged both AV and parallel is never trusted as an AV (PR 1317 review)', () => {
    const both = av(14, 10, { parallel: true });
    const math = subject(term('T1', 20, [both]));
    expect(brilliantSealCountV1([math], ['T1'])).toBe(0);
  });
});
