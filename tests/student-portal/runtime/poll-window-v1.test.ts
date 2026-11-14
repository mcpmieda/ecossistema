import { describe, expect, it } from 'vitest';
import { schoolDayWindowV1 } from '../../../server/student-portal/composition/poll-window-v1';

const day = (start: string, end: string) => [{ kind: 'aula', slot: 1, start, end }];
const week = (start: string, end: string) => ({ 1: day(start, end), 2: day(start, end), 3: day(start, end), 4: day(start, end), 5: day(start, end) });

describe('schoolDayWindowV1 (issue #1426, 29)', () => {
  const bells = { matutino: { ...week('07:20', '11:40'), 3: day('07:00', '11:40') }, vespertino: week('13:10', '17:30') };

  it('uses the first lesson and the last one of the weekday', () => {
    // 2026-11-11 is a Wednesday.
    expect(schoolDayWindowV1('2026-11-11', [{ date: '2026-11-11', kind: 'letivo' }], bells))
      .toEqual({ schoolDay: true, starts: '07:00', ends: '17:30', source: 'calendar' });
    expect(schoolDayWindowV1('2026-11-12', [{ date: '2026-11-12', kind: 'letivo' }], bells).starts).toBe('07:20');
  });

  it('a holiday or an unmarked day is not a school day; a school Saturday takes the widest span', () => {
    const calendar = [{ date: '2026-11-13', kind: 'feriado' }, { date: '2026-11-14', kind: 'sabado-letivo' }];
    expect(schoolDayWindowV1('2026-11-13', calendar, bells).schoolDay).toBe(false);
    expect(schoolDayWindowV1('2026-11-16', calendar, bells).schoolDay).toBe(false);
    expect(schoolDayWindowV1('2026-11-14', calendar, bells)).toMatchObject({ schoolDay: true, starts: '07:00', ends: '17:30' });
  });

  it('without calendar or bells falls back to weekdays from 07:00 to 18:00', () => {
    expect(schoolDayWindowV1('2026-11-16', null, null)).toEqual({ schoolDay: true, starts: '07:00', ends: '18:00', source: 'weekday-fallback' });
    expect(schoolDayWindowV1('2026-11-15', [], 'bad')).toMatchObject({ schoolDay: false, source: 'weekday-fallback' });
  });
});
