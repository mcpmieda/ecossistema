import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { officialCalendar2026V1 } from '../../../shared/student-portal-contracts/school-calendar-2026-start-v1';
import {
  schoolCalendarDaysV1,
  schoolDaysOfV1,
  schoolYearProgressOfV1,
} from '../../../shared/student-portal-contracts/school-calendar-v1';

describe('school calendar (owner decision 22/10/2026)', () => {
  it('starts 2026 from the official calendar, month by month: 200 school days', () => {
    const days = officialCalendar2026V1();
    expect(schoolCalendarDaysV1.safeParse(days).success).toBe(true);
    const school = schoolDaysOfV1(days);
    expect(school).toHaveLength(200);
    const perMonth = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => {
        const month = String(index + 1).padStart(2, '0');
        return [month, school.filter((date) => date.slice(5, 7) === month).length];
      }),
    );
    // As printed on the official calendar ("(xx DIAS LETIVOS)" under each month).
    expect(perMonth).toEqual({
      '01': 0, '02': 6, '03': 23, '04': 20, '05': 21, '06': 22,
      '07': 13, '08': 22, '09': 22, '10': 20, '11': 20, '12': 11,
    });
    // Its trimesters: 59, 68 and 73 days.
    const between = (from: string, to: string) => school.filter((date) => date >= from && date <= to).length;
    expect([between('2026-02-23', '2026-05-15'), between('2026-05-18', '2026-08-31'), between('2026-09-01', '2026-12-15')]).toEqual([59, 68, 73]);
    expect(schoolYearProgressOfV1(days, '2026-10-22')).toEqual({
      schoolDays: 200,
      remaining: 39,
      firstDay: '2026-02-23',
      lastDay: '2026-12-15',
    });
    // The six Saturdays the Smecel had and the official calendar does not.
    for (const date of ['2026-04-18', '2026-05-09', '2026-05-16', '2026-06-27', '2026-07-04', '2026-07-18'])
      expect(school).not.toContain(date);
  });

  it('is saved by migration 0029 exactly as the official calendar (no drift)', () => {
    const sql = readFileSync('migrations/student-portal/0029_school_calendar_v1.sql', 'utf8');
    const saved = /VALUES\(2026,'(.+)'::jsonb,1,/u.exec(sql)?.[1];
    expect(saved && JSON.parse(saved)).toEqual(officialCalendar2026V1());
  });

  it('never takes more than 200 school days', () => {
    const days = officialCalendar2026V1();
    const one = [...days, { date: '2026-12-19', kind: 'sabado-letivo' as const }];
    expect(schoolCalendarDaysV1.safeParse(one).success).toBe(false);
  });

  it('refuses a day outside the year or marked twice', () => {
    expect(schoolCalendarDaysV1.safeParse([{ date: '2027-01-04', kind: 'letivo' }]).success).toBe(false);
    expect(
      schoolCalendarDaysV1.safeParse([
        { date: '2026-03-02', kind: 'letivo' },
        { date: '2026-03-02', kind: 'feriado' },
      ]).success,
    ).toBe(false);
  });
});
