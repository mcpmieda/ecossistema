import { expect, it } from 'vitest';
import { adminCommandV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { officialCalendar2026V1 } from '../../../shared/student-portal-contracts/school-calendar-2026-start-v1';
import {
  schoolCalendarDaysInputV1,
  schoolCalendarDaysV1,
  schoolDayFitsWeekdayV1,
  schoolDaysOfV1,
  schoolYearProgressOfV1,
} from '../../../shared/student-portal-contracts/school-calendar-v1';

/*
 * A22: a "dia letivo" falls Monday to Friday and a "sábado letivo" on a Saturday. The admin's save
 * refuses the others; a calendar saved before still reads.
 */
const command = (days: unknown) => ({
  contractVersion: 1,
  operation: 'school-calendar-set',
  academicYear: 2026,
  expectedVersion: 1,
  idempotencyKey: crypto.randomUUID(),
  days,
});

it('refuses a dia letivo on a weekend and a sábado letivo on a weekday', () => {
  // 07/06/2026 is a Sunday, 13/06 a Saturday, 10/06 a Wednesday.
  expect(schoolCalendarDaysInputV1.safeParse([{ date: '2026-06-07', kind: 'letivo' }]).success).toBe(false);
  expect(schoolCalendarDaysInputV1.safeParse([{ date: '2026-06-13', kind: 'letivo' }]).success).toBe(false);
  expect(schoolCalendarDaysInputV1.safeParse([{ date: '2026-06-10', kind: 'sabado-letivo' }]).success).toBe(false);
  expect(adminCommandV1.safeParse(command([{ date: '2026-06-07', kind: 'letivo' }])).success).toBe(false);
});

it('keeps the right weekdays, an evento com aula on a Saturday and the official calendar', () => {
  expect(schoolCalendarDaysInputV1.safeParse([{ date: '2026-06-10', kind: 'letivo' }]).success).toBe(true);
  expect(schoolCalendarDaysInputV1.safeParse([{ date: '2026-06-13', kind: 'sabado-letivo' }]).success).toBe(true);
  expect(schoolDayFitsWeekdayV1({ date: '2026-06-13', kind: 'evento-letivo' })).toBe(true);
  expect(schoolDayFitsWeekdayV1({ date: '2026-06-07', kind: 'feriado' })).toBe(true);
  expect(adminCommandV1.safeParse(command(officialCalendar2026V1())).success).toBe(true);
});

it('still reads a calendar saved before the rule', () => {
  expect(schoolCalendarDaysV1.safeParse([{ date: '2026-06-07', kind: 'letivo' }]).success).toBe(true);
});

it('refuses an evento com aula on a Sunday', () => {
  expect(schoolDayFitsWeekdayV1({ date: '2026-06-07', kind: 'evento-letivo' })).toBe(false);
  expect(schoolCalendarDaysInputV1.safeParse([{ date: '2026-06-07', kind: 'evento-letivo' }]).success).toBe(false);
  expect(schoolCalendarDaysInputV1.safeParse([{ date: '2026-06-10', kind: 'evento-letivo' }]).success).toBe(true);
});

it('never counts for the Portal a school day saved on the wrong weekday', () => {
  const days = [
    { date: '2026-06-07', kind: 'letivo' as const }, // Sunday
    { date: '2026-06-14', kind: 'evento-letivo' as const }, // Sunday
    { date: '2026-06-10', kind: 'sabado-letivo' as const }, // Wednesday
    { date: '2026-06-13', kind: 'sabado-letivo' as const }, // Saturday
    { date: '2026-06-15', kind: 'letivo' as const }, // Monday
  ];
  expect(schoolDaysOfV1(days)).toEqual(['2026-06-13', '2026-06-15']);
  expect(schoolYearProgressOfV1(days, '2026-06-01')).toEqual({
    schoolDays: 2,
    remaining: 2,
    firstDay: '2026-06-13',
    lastDay: '2026-06-15',
  });
});

it('keeps every day of the official calendar (the demo uses it too) where it is', () => {
  expect(officialCalendar2026V1().every((day) => schoolDayFitsWeekdayV1(day))).toBe(true);
});
