import { expect, it } from 'vitest';
import { adminCommandV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { officialCalendar2026V1 } from '../../../shared/student-portal-contracts/school-calendar-2026-start-v1';
import {
  schoolCalendarDaysInputV1,
  schoolCalendarDaysV1,
  schoolDayFitsWeekdayV1,
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
