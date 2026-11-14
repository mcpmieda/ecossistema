import { SCHOOL_DAY_COUNTS_V1, type SchoolDayKindV1 } from '../../../shared/student-portal-contracts/school-calendar-v1';
import type { PortalCompositionEnvV1 } from './config-v1';
import { portalDatabaseV1 } from './database-v1';

/**
 * A day's school hours for the OneDrive reading (owner decision 14/11/2026, issue #1426, 29): the
 * 10 s poll runs only on school days, around the lessons. The Portal owns the calendar and the
 * bells, so it answers; the notes Worker's database role does not read those tables.
 */
export type SchoolDayWindowV1 = {
  readonly schoolDay: boolean;
  /** "HH:MM", local time (America/Bahia). */
  readonly starts: string;
  readonly ends: string;
  readonly source: 'calendar' | 'weekday-fallback';
};

const DEFAULT_STARTS_V1 = '07:00';
const DEFAULT_ENDS_V1 = '18:00';
const HHMM_V1 = /^([01]\d|2[0-3]):[0-5]\d$/u;

type BellItemShapeV1 = { readonly kind?: unknown; readonly start?: unknown; readonly end?: unknown };

/** Monday = 1 … Sunday = 7, of a "YYYY-MM-DD" day. */
function isoWeekdayV1(day: string): number {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** The first lesson start and the last lesson end of the weekday (a school Saturday uses the widest of the week). */
function lessonSpanV1(bells: unknown, weekday: number): { starts: string; ends: string } {
  let starts: string | null = null;
  let ends: string | null = null;
  const shifts = bells && typeof bells === 'object' ? Object.values(bells as Record<string, unknown>) : [];
  for (const days of shifts) {
    if (!days || typeof days !== 'object') continue;
    for (const [key, items] of Object.entries(days as Record<string, unknown>)) {
      if (weekday !== 6 && key !== String(weekday)) continue;
      for (const item of Array.isArray(items) ? (items as BellItemShapeV1[]) : []) {
        if (item?.kind !== 'aula' || typeof item.start !== 'string' || typeof item.end !== 'string') continue;
        if (!HHMM_V1.test(item.start) || !HHMM_V1.test(item.end)) continue;
        if (starts === null || item.start < starts) starts = item.start;
        if (ends === null || item.end > ends) ends = item.end;
      }
    }
  }
  return { starts: starts ?? DEFAULT_STARTS_V1, ends: ends ?? DEFAULT_ENDS_V1 };
}

/** The window of `day` from the calendar days and the bells as stored (either may be missing). */
export function schoolDayWindowV1(day: string, calendarDays: unknown, bells: unknown): SchoolDayWindowV1 {
  const weekday = isoWeekdayV1(day);
  const span = lessonSpanV1(bells, weekday);
  if (!Array.isArray(calendarDays) || calendarDays.length === 0) {
    return { schoolDay: weekday >= 1 && weekday <= 5, ...span, source: 'weekday-fallback' };
  }
  const entry = (calendarDays as Array<{ date?: unknown; kind?: unknown }>).find((item) => item?.date === day);
  const kind = typeof entry?.kind === 'string' ? (entry.kind as SchoolDayKindV1) : null;
  return { schoolDay: kind !== null && SCHOOL_DAY_COUNTS_V1[kind] === true, ...span, source: 'calendar' };
}

const DAY_V1 = /^\d{4}-\d{2}-\d{2}$/u;

/** jsonb may come back as text, depending on the driver's parsing. */
function jsonValueV1(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function readSchoolDayWindowV1(env: PortalCompositionEnvV1, day: string): Promise<SchoolDayWindowV1 | null> {
  if (!DAY_V1.test(day)) return null;
  const year = Number(day.slice(0, 4));
  return portalDatabaseV1(env, 'cleanup', async (sql) => {
    const [calendar] = await sql.unsafe('SELECT days_json FROM student_portal.school_calendar_v1 WHERE academic_year=$1', [year]);
    const [bells] = await sql.unsafe('SELECT bells_json FROM student_portal.school_bells_v1 WHERE academic_year=$1', [year]);
    return schoolDayWindowV1(day, jsonValueV1((calendar as { days_json?: unknown } | undefined)?.days_json),
      jsonValueV1((bells as { bells_json?: unknown } | undefined)?.bells_json));
  });
}
