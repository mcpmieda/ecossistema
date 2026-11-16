import type { FrequencyReportScheduleV2, FrequencyScheduleV2 } from '../../shared/attendance-contracts/frequency-v2';

/**
 * Away from the agenda the Coletor asks only every 9 minutes (owner request 14/11/2026, issue #1426,
 * 6B); within 10 minutes before a collection or report time until 5 after it, every 30 s. Same numbers
 * as AGENDA_LEAD_SECONDS, AGENDA_TAIL_SECONDS and QUIET_REFRESH_SECONDS in the Coletor's
 * frequency_runtime.py.
 */
export const AGENDA_LEAD_SECONDS_V2 = 600;
export const AGENDA_TAIL_SECONDS_V2 = 300;
// Shorter than the 10 min lead (issue #1450, finding 1): a collection time created or moved in the
// ADM at least 10 min ahead is always seen before its near window starts.
export const QUIET_REFRESH_SECONDS_V2 = 540;
/** A computer is online when seen within this many seconds: 2 min near the agenda, one quiet refresh plus 2 min away from it. */
export const ONLINE_NEAR_SECONDS_V2 = 120;
export const ONLINE_QUIET_SECONDS_V2 = QUIET_REFRESH_SECONDS_V2 + ONLINE_NEAR_SECONDS_V2;

const DAY_MS = 86_400_000;

/** One formatter per zone, built once (issue #1490, finding 1): in practice only the school's zone. */
const OFFSET_FORMAT_V2 = new Map<string, Intl.DateTimeFormat>();
function offsetFormat(zone: string): Intl.DateTimeFormat {
  let format = OFFSET_FORMAT_V2.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    OFFSET_FORMAT_V2.set(zone, format);
  }
  return format;
}

/** The zone's offset from UTC at an instant, in ms. */
function offsetMs(zone: string, at: number): number {
  const parts = Object.fromEntries(
    offsetFormat(zone).formatToParts(at).map((p) => [p.type, p.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(at / 1000) * 1000;
}

function agendaDays(schedule: FrequencyScheduleV2 | null, report: FrequencyReportScheduleV2 | null | undefined) {
  const out: { zone: string; days: Map<number, string[]> }[] = [];
  if (schedule) {
    const days = new Map<number, string[]>();
    for (const r of schedule.rules) {
      if (!r.enabled) continue;
      days.set(r.weekday, [...(days.get(r.weekday) ?? []), ...r.times, ...(r.recheck ? [r.recheck] : [])]);
    }
    out.push({ zone: schedule.timezone, days });
  }
  if (report?.enabled) {
    const minute = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const times: string[] = [];
    for (let m = minute(report.from); m <= minute(report.to); m += report.every)
      times.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    out.push({ zone: report.timezone, days: new Map(report.weekdays.map((d) => [d, times])) });
  }
  return out;
}

/** True from 10 min before a collection or report time until 5 min after it (the Coletor's agenda_near). */
export function agendaNearV2(
  schedule: FrequencyScheduleV2 | null,
  report: FrequencyReportScheduleV2 | null | undefined,
  nowMs: number,
): boolean {
  for (const { zone, days } of agendaDays(schedule, report)) {
    const local = nowMs + offsetMs(zone, nowMs);
    const midnight = Math.floor(local / DAY_MS) * DAY_MS;
    for (const offset of [-1, 0, 1]) {
      const day = midnight + offset * DAY_MS;
      for (const wall of days.get(new Date(day).getUTCDay()) ?? []) {
        const guess = day + (Number(wall.slice(0, 2)) * 60 + Number(wall.slice(3))) * 60_000;
        const at = guess - offsetMs(zone, guess - offsetMs(zone, guess));
        const delta = (at - nowMs) / 1000;
        if (delta >= -AGENDA_TAIL_SECONDS_V2 && delta <= AGENDA_LEAD_SECONDS_V2) return true;
      }
    }
  }
  return false;
}

/** How recently a computer must have been seen to count as online now. */
export function onlineSecondsV2(
  schedule: FrequencyScheduleV2 | null,
  report: FrequencyReportScheduleV2 | null | undefined,
  nowMs: number,
): number {
  return agendaNearV2(schedule, report, nowMs) ? ONLINE_NEAR_SECONDS_V2 : ONLINE_QUIET_SECONDS_V2;
}
