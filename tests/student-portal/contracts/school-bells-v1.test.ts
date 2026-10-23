import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bellDayV1,
  bellMomentV1,
  bellShiftOfLabelV1,
  officialBells2026V1,
  schoolBellsDaysV1,
} from '../../../shared/student-portal-contracts/school-bells-v1';
import { officialCalendar2026V1 } from '../../../shared/student-portal-contracts/school-calendar-2026-start-v1';
import { schoolDayOffLabelV1, schoolDaysOffOfV1 } from '../../../shared/student-portal-contracts/school-calendar-v1';

const at = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const line = (day: ReturnType<typeof officialBells2026V1>['matutino'][1]) =>
  day.map((item) => `${item.kind === 'aula' ? item.slot : 'I'} ${item.start}-${item.end}`);

describe('school bells (owner decision 23/10/2026)', () => {
  it('starts 2026 from the sheets "Horário Matutino / Vespertino 2026 — 22/06"', () => {
    const bells = officialBells2026V1();
    expect(schoolBellsDaysV1.safeParse(bells).success).toBe(true);
    expect(line(bells.matutino[1])).toEqual([
      '1 07:00-07:55', '2 07:55-08:50', '3 08:50-09:45', 'I 09:45-10:00', '4 10:00-10:55', '5 10:55-11:45',
    ]);
    expect(line(bells.matutino[4])).toEqual([
      '1 07:00-07:45', '2 07:45-08:30', '3 08:30-09:15', '4 09:15-10:00', 'I 10:00-10:15', '5 10:15-11:00', '6 11:00-11:45',
    ]);
    expect(line(bells.matutino[5])).toEqual([
      '1 07:45-08:30', '2 08:30-09:15', '3 09:15-10:00', 'I 10:00-10:15', '4 10:15-11:00', '5 11:00-11:45',
    ]);
    expect(line(bells.vespertino[3])).toEqual([
      '1 13:15-14:10', '2 14:10-15:05', 'I 15:05-15:20', '3 15:20-16:15', '4 16:15-17:10', '5 17:10-18:00',
    ]);
    expect(line(bells.vespertino[2])).toEqual([
      '1 13:15-14:00', '2 14:00-14:45', '3 14:45-15:30', 'I 15:30-15:45', '4 15:45-16:30', '5 16:30-17:15', '6 17:15-18:00',
    ]);
    expect(line(bells.vespertino[5])).toEqual([
      '1 13:15-14:00', '2 14:00-14:45', '3 14:45-15:30', 'I 15:30-15:45', '4 15:45-16:30', '5 16:30-17:15',
    ]);
    // Only Tuesday and Thursday have a 6th lesson.
    for (const shift of ['matutino', 'vespertino'] as const)
      expect([1, 2, 3, 4, 5].map((day) => bells[shift][day as 1].filter((item) => item.kind === 'aula').length)).toEqual([5, 6, 5, 6, 5]);
  });

  it('is saved by migration 0030 exactly as the sheets (no drift)', () => {
    const sql = readFileSync('migrations/student-portal/0030_school_bells_v1.sql', 'utf8');
    const saved = /VALUES\(2026,'(.+)'::jsonb,1,/u.exec(sql)?.[1];
    expect(saved && JSON.parse(saved)).toEqual(officialBells2026V1());
  });

  it('refuses a day out of order, overlapping, with lessons skipped or two breaks', () => {
    const lesson = (slot: number, start: string, end: string) => ({ kind: 'aula' as const, slot, start, end });
    const pause = (start: string, end: string) => ({ kind: 'intervalo' as const, start, end });
    expect(bellDayV1.safeParse([lesson(1, '07:00', '07:50'), lesson(2, '07:50', '08:40')]).success).toBe(true);
    expect(bellDayV1.safeParse([lesson(1, '07:50', '08:40'), lesson(2, '07:00', '07:50')]).success).toBe(false);
    expect(bellDayV1.safeParse([lesson(1, '07:00', '08:00'), lesson(2, '07:50', '08:40')]).success).toBe(false);
    expect(bellDayV1.safeParse([lesson(1, '07:00', '07:50'), lesson(3, '07:50', '08:40')]).success).toBe(false);
    expect(bellDayV1.safeParse([lesson(1, '08:00', '07:50')]).success).toBe(false);
    expect(
      bellDayV1.safeParse([lesson(1, '07:00', '07:50'), pause('07:50', '08:00'), lesson(2, '08:00', '08:50'), pause('08:50', '09:00')]).success,
    ).toBe(false);
    expect(bellDayV1.safeParse([lesson(1, '7:00', '07:50')]).success).toBe(false);
  });

  it("finds a class's shift in its Smecel label", () => {
    expect(bellShiftOfLabelV1('6º ANO A - MATUTINO')).toBe('matutino');
    expect(bellShiftOfLabelV1('9º ANO B - VESPERTINO (ANOS FINAIS)')).toBe('vespertino');
    expect(bellShiftOfLabelV1('AEE')).toBeNull();
  });

  it('says where a day is at a moment: before, in a lesson or the break, over', () => {
    const monday = officialBells2026V1().matutino[1];
    expect(bellMomentV1(monday, at('06:30'))).toMatchObject({ state: 'before', next: { slot: 1 } });
    expect(bellMomentV1(monday, at('09:00'))).toMatchObject({ state: 'in', current: { slot: 3 }, next: { kind: 'intervalo' } });
    expect(bellMomentV1(monday, at('09:50'))).toMatchObject({ state: 'in', current: { kind: 'intervalo' }, next: { slot: 4 } });
    expect(bellMomentV1(monday, at('11:00'))).toMatchObject({ state: 'in', current: { slot: 5 }, next: null });
    expect(bellMomentV1(monday, at('11:45'))).toEqual({ state: 'over' });
  });

  it('names the weekdays without school of the calendar, with their description', () => {
    const off = schoolDaysOffOfV1(officialCalendar2026V1());
    const october = off.filter((day) => day.date.startsWith('2026-10'));
    expect(october.map((day) => [day.date, schoolDayOffLabelV1(day)])).toEqual([
      ['2026-10-12', 'Feriado · Nossa Senhora Aparecida'],
      ['2026-10-13', 'Feriado · Antecipação do dia 15'],
      ['2026-10-14', 'Feriado · Antecipação do dia 28'],
    ]);
    // Never a weekend, never a school day.
    for (const day of off) expect([0, 6]).not.toContain(new Date(`${day.date}T12:00:00Z`).getUTCDay());
  });
});
