import { describe, expect, it } from 'vitest';
import { frequencyCommentV2 } from '../../shared/attendance-contracts/frequency-comment-v2';
import type { FrequencySummaryV2 } from '../../shared/attendance-contracts/frequency-v2';

/*
 * The sentence about the absences (owner decisions 22/10/2026), on a synthetic year of 5-lesson
 * weekdays: days in "cerca de" from the student's own lessons per day, unjustified absences only,
 * Saturdays never a trend, the first sentence that applies.
 */
type MarkV2 = FrequencySummaryV2['marks'][number];
const TODAY = '2026-10-22';
/** The weekdays before today, most recent last, from 23/02. */
const weekdays = (() => {
  const dates: string[] = [];
  for (let at = Date.parse('2026-02-23T12:00:00Z'); ; at += 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10);
    if (date >= TODAY) break;
    const day = new Date(at).getUTCDay();
    if (day >= 1 && day <= 5) dates.push(date);
  }
  return dates;
})();
const lessonDay = (date: string) => ({ date, shift: 'MATUTINO', slots: [1, 2, 3, 4, 5], complete: true });
const dayAbsent = (date: string, mark: 'X' | 'J' = 'X'): MarkV2[] =>
  [1, 2, 3, 4, 5].map((slot) => ({ date, slot, shift: 'MATUTINO', mark, classLabels: ['TURMA'] }));
const year = (absentDates: readonly string[], extra: { days?: string[]; mark?: 'X' | 'J' } = {}) =>
  frequencyCommentV2({
    months: [{ days: [...weekdays, ...(extra.days ?? [])].map(lessonDay), marks: absentDates.flatMap((date) => dayAbsent(date, extra.mark)) }],
    today: TODAY,
    schoolDays: 200,
    remainingSchoolDays: 39,
  });
const recent = (count: number) => weekdays.slice(-count);
const older = (count: number, step = 3) => weekdays.slice(0, count * step).filter((_, index) => index % step === 0);

describe('frequency comment (owner decisions 22/10/2026)', () => {
  it('more than 50 days: already over the maximum, in days', () => {
    expect(year(older(52, 2))).toEqual({
      kind: 'over-limit',
      tone: 'alert',
      text: 'Já faltou cerca de 52 dias. Pode reprovar por falta.',
    });
  });

  it('missing at this pace until the last school day passes 50: will pass', () => {
    // 30 old days plus 12 of the last 20 weekdays (60%): 42 now, about 23 more in 39 days.
    const comment = year([...older(30, 3).filter((date) => date < weekdays.at(-20)!), ...recent(20).filter((_, index) => index % 5 < 3)]);
    expect(comment?.kind).toBe('will-pass');
    expect(comment?.text).toMatch(/^Já faltou cerca de \d+ dias\. Faltando assim, pode reprovar por falta\.$/u);
  });

  it('from 30 days on: a warning that never names the limit', () => {
    // 31 whole days long ago, none lately: not "will pass", but near the limit.
    expect(year(older(31, 3))).toEqual({
      kind: 'near-limit',
      tone: 'alert',
      text: 'Já faltou cerca de 31 dias. Mais faltas podem reprovar.',
    });
  });

  it('three weekdays in a row without coming, unjustified; a Saturday between never breaks it', () => {
    const lastThree = recent(3);
    expect(year(lastThree)).toEqual({
      kind: 'in-a-row',
      tone: 'alert',
      text: `Não vem à escola desde ${lastThree[0]!.slice(8)}/${lastThree[0]!.slice(5, 7)} (3 dias seguidos).`,
    });
    // Justified days are never "sem vir".
    expect(year(lastThree, { mark: 'J' })?.kind).not.toBe('in-a-row');
    // A symbolic Saturday in the diary (automatic attendance) does not end the streak.
    expect(year(lastThree, { days: ['2026-10-17'] })?.kind).toBe('in-a-row');
  });

  it('missing more in the last four weeks than before', () => {
    const recentDays = recent(20).filter((_, index) => index % 4 === 0 && index < 19);
    expect(year(recentDays)).toEqual({
      kind: 'rising',
      tone: 'alert',
      text: 'Faltou cerca de 5 dias nas últimas 4 semanas. Antes, faltava menos.',
    });
  });

  it('whole days mostly on one weekday', () => {
    const mondays = weekdays.filter((date) => new Date(`${date}T12:00:00Z`).getUTCDay() === 1 && date < weekdays.at(-20)!).slice(0, 9);
    expect(year(mondays)).toEqual({ kind: 'weekday', tone: 'alert', text: 'Falta muito às segundas-feiras.' });
  });

  it('missing much less lately', () => {
    // Two lessons of five on every third old weekday (about 13%, never a whole day), none in the
    // last four weeks: improving wins over "none recently".
    const marks = weekdays
      .slice(0, -20)
      .filter((_, index) => index % 3 === 0)
      .flatMap((date) => [1, 2].map((slot) => ({ date, slot, shift: 'MATUTINO', mark: 'X' as const, classLabels: ['TURMA'] })));
    // About 21 days in all: below the 30 of "perto do limite".
    const comment = frequencyCommentV2({
      months: [{ days: weekdays.map(lessonDay), marks }],
      today: TODAY,
      schoolDays: 200,
      remainingSchoolDays: 39,
    });
    expect(comment).toEqual({ kind: 'improving', tone: 'good', text: 'Está faltando menos dias. Continue assim!' });
  });

  it('good news: no absence this year, or none in the last four weeks', () => {
    expect(year([])).toEqual({ kind: 'none-this-year', tone: 'good', text: 'Nenhuma falta este ano. Parabéns!' });
    expect(year([weekdays[10]!])).toEqual({
      kind: 'none-recently',
      tone: 'good',
      text: 'Nenhuma falta nas últimas 4 semanas. Muito bem!',
    });
    // Justified absences are never counted: still "no absence this year".
    expect(year(recent(5), { mark: 'J' })?.kind).toBe('none-this-year');
  });

  it('nothing to say: no sentence', () => {
    expect(year([weekdays[10]!, recent(10)[0]!])).toBeNull();
  });

  it("takes the limit from the calendar: a quarter of its school days (owner request 27/10/2026)", () => {
    const months = [{ days: weekdays.map(lessonDay), marks: older(35, 2).flatMap((date) => dayAbsent(date)) }];
    // 35 days: near the 50 of a 200-day year, past the 30 of a 120-day one.
    expect(frequencyCommentV2({ months, today: TODAY, schoolDays: 200, remainingSchoolDays: 0 })?.kind).toBe('near-limit');
    expect(frequencyCommentV2({ months, today: TODAY, schoolDays: 120, remainingSchoolDays: 0 })?.kind).toBe('over-limit');
  });
});
