import { describe, expect, it } from 'vitest';
import { frequencyCommentV2 } from '../../shared/attendance-contracts/frequency-comment-v2';

/*
 * A day not read in full (or whose only mark is in conflict, which the server drops) shows as
 * "Leitura incompleta" in the ring and the calendar: the green "sem falta" sentences never count it
 * as a day without absence.
 */
const TODAY = '2026-10-22';
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
const comment = (dates: readonly string[], isComplete: (date: string) => boolean) =>
  frequencyCommentV2({
    months: [{ days: dates.map((date) => ({ date, shift: 'MATUTINO', slots: [1, 2, 3, 4, 5], complete: isComplete(date) })), marks: [] }],
    today: TODAY,
    schoolDays: 200,
    remainingSchoolDays: 39,
  });

describe('frequency comment with a day not read in full', () => {
  it('every day read: "Nenhuma falta este ano"', () => {
    expect(comment(weekdays, () => true)?.kind).toBe('none-this-year');
  });

  it('a day not read in full more than 30 days ago no longer takes the praise away (owner 13/11)', () => {
    expect(comment(weekdays, (date) => date !== weekdays[3])?.kind).toBe('none-this-year');
  });

  it('a day not read in full 29 days ago: no "Nenhuma falta este ano", still "nas últimas 4 semanas"', () => {
    // 2026-09-23 is 29 days before today and not among the twenty most recent weekdays.
    expect(weekdays.slice(-20)).not.toContain('2026-09-23');
    expect(comment(weekdays, (date) => date !== '2026-09-23')?.kind).toBe('none-recently');
  });

  it('a day not read in full 31 days ago does not hold it back', () => {
    expect(comment(weekdays, (date) => date !== '2026-09-21')?.kind).toBe('none-this-year');
  });

  it('a recent day not read in full: no green sentence at all', () => {
    expect(comment(weekdays, (date) => date !== weekdays.at(-2))).toBeNull();
  });

  it('today not read yet never blocks it', () => {
    expect(comment([...weekdays, TODAY], (date) => date !== TODAY)?.kind).toBe('none-this-year');
  });
});
