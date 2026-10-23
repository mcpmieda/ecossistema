import { describe, expect, it } from 'vitest';
import { smecelCalendar2026V1 } from '../../../shared/student-portal-contracts/school-calendar-2026-start-v1';
import {
  schoolCalendarDaysV1,
  schoolDaysOfV1,
  schoolYearProgressOfV1,
} from '../../../shared/student-portal-contracts/school-calendar-v1';

describe('school calendar (owner decision 22/10/2026)', () => {
  it('starts 2026 exactly as the Smecel had it: 206 school days, 167 up to 21/10', () => {
    const days = smecelCalendar2026V1();
    // 206 is more than the rule: it can be a draft to cut down, never saved as it is.
    expect(schoolCalendarDaysV1.safeParse(days).success).toBe(false);
    const school = schoolDaysOfV1(days);
    // The Smecel summary: 188 school days + 18 Saturdays (its 185 plain days include no event).
    expect(school).toHaveLength(206);
    expect(days.filter((day) => day.kind === 'sabado-letivo')).toHaveLength(18);
    // Day by day, the same as the diary read by the collector (167 lesson days up to 21/10).
    expect(school.filter((date) => date <= '2026-10-21')).toHaveLength(167);
    expect(schoolYearProgressOfV1(days, '2026-10-22')).toEqual({
      schoolDays: 206,
      remaining: 39,
      firstDay: '2026-02-23',
      lastDay: '2026-12-15',
    });
  });

  it('never takes more than 200 school days (owner decision 22/10/2026)', () => {
    const days = smecelCalendar2026V1();
    const school = days.filter((day) => day.kind === 'letivo');
    const cut = days.filter((day) => !school.slice(0, 6).includes(day));
    expect(schoolCalendarDaysV1.safeParse(cut).success).toBe(true);
    expect(schoolDaysOfV1(cut)).toHaveLength(200);
    const one = [...cut, { date: '2026-12-19', kind: 'sabado-letivo' as const }];
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
