import type { z } from 'zod';
import {
  calendarV1,
  settingsValueV1,
  type AgendaPlanV1,
} from '../../../shared/student-portal-contracts/policy-v1';
import { periodV1 } from '../../../shared/student-portal-contracts/core-v1';
import {
  selfResponseV1,
  type SelfResponseV1,
} from '../../../shared/student-portal-contracts/self-v1';
import {
  portalNoticesV1,
  type PortalNoticesV1,
} from '../../../shared/student-portal-contracts/notices-v1';
import {
  accessOpenAtV1,
  nextAccessChangeV1,
  type AccessPlanV1,
} from '../../../shared/student-portal-contracts/access-schedule-v1';

export type CalendarV1 = z.infer<typeof calendarV1>;
export type PolicyValueV1 = z.infer<typeof settingsValueV1>;
type PeriodV1 = z.infer<typeof periodV1>;

function timestamp(value: string | null): number | null {
  return value === null ? null : Date.parse(value);
}

const instant = (value: string | null): string | null => {
  if (value === null) return null;
  const date = new Date(value);
  // A fraction of a second with any digit other than zero ("…:00.500Z") is refused.
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/u.exec(value)?.[1];
  if ((fraction !== undefined && /[1-9]/u.test(fraction)) || date.getUTCMilliseconds() !== 0)
    throw new Error('student-portal-calendar-second-precision');
  return date.toISOString().replace('.000Z', 'Z');
};
const agendaInstantsV1 = (plan: AgendaPlanV1): AgendaPlanV1 => ({
  enabled: plan.enabled,
  schedule: plan.schedule.map((event) => ({ at: instant(event.at)!, action: event.action })),
});

/** The grade disclosure with its instants in UTC, second precision, kept in its own mode. */
function disclosureInstantsV1(disclosure: CalendarV1['disclosure']) {
  if (disclosure.mode === 'agenda')
    return {
      mode: 'agenda',
      periods: Object.fromEntries(
        Object.entries(disclosure.periods).map(([key, plan]) => [key, agendaInstantsV1(plan)]),
      ),
    };
  if (disclosure.mode === 'single')
    return {
      ...disclosure,
      at: instant(disclosure.at),
      ...(disclosure.endsAt === undefined ? {} : { endsAt: instant(disclosure.endsAt) }),
    };
  return {
    mode: 'per-period',
    at: Object.fromEntries(Object.entries(disclosure.at).map(([key, value]) => [key, instant(value)])),
    ...(disclosure.endsAt === undefined
      ? {}
      : {
          endsAt: Object.fromEntries(
            Object.entries(disclosure.endsAt).map(([key, value]) => [key, instant(value)]),
          ),
        }),
  };
}

/** UTC persistence with second precision; dates are never filled from the current year. */
export function normalizeCalendarV1(input: unknown): CalendarV1 {
  const parsed = calendarV1.parse(input);
  return calendarV1.parse({
    ...parsed,
    ...(parsed.accessStartsAt === undefined
      ? {}
      : { accessStartsAt: instant(parsed.accessStartsAt) }),
    ...(parsed.accessEndsAt === undefined ? {} : { accessEndsAt: instant(parsed.accessEndsAt) }),
    ...(parsed.finalDisclosureEndsAt === undefined
      ? {}
      : { finalDisclosureEndsAt: instant(parsed.finalDisclosureEndsAt) }),
    enrollmentStartsAt: instant(parsed.enrollmentStartsAt),
    yearStartsAt: instant(parsed.yearStartsAt),
    t1EndsAt: instant(parsed.t1EndsAt),
    t2StartsAt: instant(parsed.t2StartsAt),
    t2EndsAt: instant(parsed.t2EndsAt),
    t3StartsAt: instant(parsed.t3StartsAt),
    t3EndsAt: instant(parsed.t3EndsAt),
    recoveriesStartAt: instant(parsed.recoveriesStartAt),
    yearEndsAt: instant(parsed.yearEndsAt),
    finalDisclosureAt: instant(parsed.finalDisclosureAt),
    ...(parsed.finalAgenda === undefined ? {} : { finalAgenda: agendaInstantsV1(parsed.finalAgenda) }),
    disclosure: disclosureInstantsV1(parsed.disclosure),
  });
}

/** The enforced plan when schedules are in use (school-access-v1); null on the Calendário window. */
function enforcedPlanV1(value: PolicyValueV1): AccessPlanV1 | null {
  return value.accessSchedule === null
    ? null
    : { enabled: value.accessEnabled, schedule: value.accessSchedule };
}

/** Whether the Portal is open for this enforced policy at `now` (the switch alone without schedules). */
export function accessGateV1(input: PolicyValueV1, now: Date): boolean {
  const value = settingsValueV1.parse(input);
  const plan = enforcedPlanV1(value);
  return plan ? accessOpenAtV1(plan, now.getTime()) : value.accessEnabled;
}

/** When the current access ends (ms): the next scheduled close, the Calendário end, or Infinity. */
export function accessEndV1(input: PolicyValueV1, now: Date): number {
  const value = settingsValueV1.parse(input);
  const plan = enforcedPlanV1(value);
  if (plan) return nextAccessChangeV1(plan, now.getTime(), false) ?? Number.POSITIVE_INFINITY;
  const end = value.calendar.accessEndsAt ?? value.calendar.yearEndsAt;
  return end ? Date.parse(end) : Number.NEGATIVE_INFINITY;
}

export function sessionExpiryV1(
  input: PolicyValueV1,
  now: Date,
  persistent: boolean,
): string | null {
  const value = settingsValueV1.parse(input);
  const current = now.getTime();
  const plan = enforcedPlanV1(value);
  if (plan) {
    if (!Number.isFinite(current) || !accessOpenAtV1(plan, current)) return null;
    const ttl = (persistent ? value.risk.persistentSeconds : value.risk.shortSeconds) * 1000;
    return new Date(Math.min(current + ttl, accessEndV1(value, now))).toISOString();
  }
  const start = timestamp(value.calendar.accessStartsAt ?? value.calendar.yearStartsAt);
  const end = timestamp(value.calendar.accessEndsAt ?? value.calendar.yearEndsAt);
  if (
    !Number.isFinite(current) ||
    !value.accessEnabled ||
    start === null ||
    end === null ||
    current < start ||
    current >= end
  )
    return null;
  const seconds = persistent ? value.risk.persistentSeconds : value.risk.shortSeconds;
  return new Date(Math.min(current + seconds * 1000, end)).toISOString();
}

function periodStartV1(calendar: CalendarV1, period: PeriodV1): string | null {
  if (period === 'T1') {
    return calendar.yearStartsAt;
  }
  if (period === 'T2') {
    return calendar.t2StartsAt ?? calendar.t1EndsAt;
  }
  if (period === 'T3') {
    return calendar.t3StartsAt ?? calendar.t2EndsAt;
  }
  return calendar.recoveriesStartAt;
}

type DatedDisclosureV1 = Exclude<PolicyValueV1['calendar']['disclosure'], { mode: 'agenda' }>;

/** A period's "Liberar" and "Ocultar" instants: the single dates, or the period's own. */
function disclosureDatesV1(disclosure: DatedDisclosureV1, period: PeriodV1) {
  const single = disclosure.mode === 'single';
  return {
    at: timestamp(single ? disclosure.at : disclosure.at[period]),
    until: timestamp((single ? disclosure.endsAt : disclosure.endsAt?.[period]) ?? null),
  };
}

/** Joint publication window: inclusive start, exclusive end; never grants academic authority. */
export function publicationWindowV1(
  input: PolicyValueV1,
  periods: readonly PeriodV1[],
): { start: Date; end: Date } | null {
  const value = settingsValueV1.parse(input);
  const calendar = value.calendar;
  let start = timestamp(calendar.accessStartsAt ?? calendar.yearStartsAt);
  let end = timestamp(calendar.accessEndsAt ?? calendar.yearEndsAt);
  if (!value.accessEnabled || start === null || end === null || periods.length === 0) return null;
  const disclosure = calendar.disclosure;
  // An agenda is not a single window: there is no joint publication window to offer.
  if (disclosure.mode === 'agenda') return null;
  for (const period of periods) {
    periodV1.parse(period);
    if (!value.allowedPeriods.includes(period)) return null;
    if (disclosure.mode === 'single' && !disclosure.periods.includes(period)) return null;
    const periodStart = timestamp(periodStartV1(calendar, period));
    if (periodStart === null) return null;
    const { at, until } = disclosureDatesV1(disclosure, period);
    start = Math.max(start, periodStart, at ?? periodStart);
    if (until !== null) end = Math.min(end, until);
  }
  return start < end ? { start: new Date(start), end: new Date(end) } : null;
}

export function periodDisclosureV1(
  input: PolicyValueV1,
  period: PeriodV1,
  now: Date,
): 'allowed' | 'disabled' | 'unavailable' | 'not-yet' {
  const value = settingsValueV1.parse(input);
  periodV1.parse(period);
  if (!Number.isFinite(now.getTime())) throw new Error('student-portal-clock-invalid');
  const calendar = value.calendar;
  const disclosure = calendar.disclosure;
  if (disclosure.mode === 'agenda') {
    // Aba Notas: only the period's own switch and schedule decide.
    const plan = disclosure.periods[period];
    if (accessOpenAtV1(plan, now.getTime())) return 'allowed';
    return nextAccessChangeV1(plan, now.getTime(), true) !== null ? 'not-yet' : 'disabled';
  }
  if (!value.allowedPeriods.includes(period)) return 'disabled';
  const start = timestamp(periodStartV1(calendar, period));
  if (disclosure.mode === 'single' && !disclosure.periods.includes(period)) return 'disabled';
  const { at, until: end } = disclosureDatesV1(disclosure, period);
  if (!disclosureShownAtV1(at, end, now.getTime()))
    return at !== null && at > now.getTime() ? 'not-yet' : 'disabled';
  if (start === null) return 'unavailable';
  return now.getTime() >= start ? 'allowed' : 'not-yet';
}

/**
 * Grades follow their agenda like access (owner decision 2026-09-27): "Liberar notas em" shows and
 * "Ocultar notas em" hides. Before an action the grades are in its opposite state, after the last
 * one they stay as it left them, and with neither they show once the period starts. So a new
 * "Liberar" after an "Ocultar" shows them again at its time.
 */
function disclosureShownAtV1(at: number | null, end: number | null, time: number): boolean {
  const schedule = [
    ...(at === null ? [] : [{ at, action: 'open' as const }]),
    ...(end === null ? [] : [{ at: end, action: 'close' as const }]),
  ]
    .sort((left, right) => left.at - right.at)
    .map((event) => ({ at: new Date(event.at).toISOString(), action: event.action }));
  return accessOpenAtV1({ enabled: true, schedule }, time);
}

/** The earliest grade release still ahead and the latest disclosure end already past. */
type DisclosureNoticeV1 = { release: number | null; ended: { period: PeriodV1 | null; at: number } | null };

function earlierReleaseV1(notice: DisclosureNoticeV1, opens: number) {
  if (notice.release === null || opens < notice.release) notice.release = opens;
}

function laterEndV1(notice: DisclosureNoticeV1, period: PeriodV1 | null, at: number) {
  if (notice.ended === null || at > notice.ended.at) notice.ended = { period, at };
}

/** A period on the Notas agenda: its next "Liberar", or the scheduled "Ocultar" that hid it. */
function agendaNoticeV1(notice: DisclosureNoticeV1, plan: AccessPlanV1, period: PeriodV1, current: number) {
  if (accessOpenAtV1(plan, current)) return;
  const opens = nextAccessChangeV1(plan, current, true);
  if (opens !== null) {
    earlierReleaseV1(notice, opens);
    return;
  }
  // Hidden for good: announce it only when a scheduled Ocultar did it.
  const hidden = [...plan.schedule].reverse().find((event) => Date.parse(event.at) <= current);
  if (hidden?.action === 'close') laterEndV1(notice, period, Date.parse(hidden.at));
}

/** A period released on a date (one for all, or one each): its release ahead, or its end already past. */
function datedNoticeV1(
  notice: DisclosureNoticeV1,
  {
    value,
    disclosure,
    period,
    current,
  }: {
    value: PolicyValueV1;
    disclosure: DatedDisclosureV1;
    period: PeriodV1;
    current: number;
  },
) {
  if (!value.allowedPeriods.includes(period)) return;
  if (disclosure.mode === 'single' && !disclosure.periods.includes(period)) return;
  const { at, until } = disclosureDatesV1(disclosure, period);
  // A later "Liberar" shows the grades again: count down to it instead of announcing an end.
  if (until !== null && until <= current && !(at !== null && at > until)) {
    laterEndV1(notice, disclosure.mode === 'single' ? null : period, until);
    return;
  }
  const periodStart = timestamp(periodStartV1(value.calendar, period));
  if (at === null || periodStart === null) return;
  const opens = Math.max(periodStart, at);
  if (opens > current) earlierReleaseV1(notice, opens);
}

/** Notices for the Portal pages: access state, the next configured grade release and the latest
 * disclosure end already past. A countdown needs an explicit "Liberar notas em" date; a period that
 * simply starts later has no announced release.
 */
export function portalNoticesForPolicyV1(input: PolicyValueV1, now: Date): PortalNoticesV1 {
  const value = settingsValueV1.parse(input);
  const current = now.getTime();
  if (!Number.isFinite(current)) throw new Error('student-portal-clock-invalid');
  const calendar = value.calendar;
  const open = sessionExpiryV1(value, now, false) !== null;
  const plan = enforcedPlanV1(value);
  const accessStart = timestamp(calendar.accessStartsAt ?? calendar.yearStartsAt);
  // With schedules: the next "Abrir" that really opens it for this student, whatever the switch.
  const scheduledOpening = plan && !open ? nextAccessChangeV1(plan, current, true) : null;
  const opensLater = plan ? open || scheduledOpening !== null : value.accessEnabled;
  const disclosure = calendar.disclosure;
  const notice: DisclosureNoticeV1 = { release: null, ended: null };
  for (const period of periodV1.options) {
    if (disclosure.mode === 'agenda') agendaNoticeV1(notice, disclosure.periods[period], period, current);
    else datedNoticeV1(notice, { value, disclosure, period, current });
  }
  const { release, ended } = notice;
  const iso = (time: number | null) => (time === null ? null : new Date(time).toISOString());
  // With schedules, the next scheduled opening; without them, the Calendário's start while still ahead.
  let opensAt: number | null = null;
  if (plan) opensAt = scheduledOpening;
  else if (!open && value.accessEnabled && accessStart !== null && accessStart > current) opensAt = accessStart;
  return portalNoticesV1.parse({
    access: open ? 'open' : 'closed',
    accessOpensAt: iso(opensAt),
    gradesReleaseAt: opensLater ? iso(release) : null,
    disclosureEnded: ended === null ? null : { period: ended.period, at: iso(ended.at)! },
  });
}

export function mayDiscloseFinalV1(
  input: PolicyValueV1,
  now: Date,
  officialSourceAuthorized: boolean,
): boolean {
  const value = settingsValueV1.parse(input);
  const agenda = value.calendar.finalAgenda;
  // Aba Notas: the Resultado anual agenda replaces showFinalResult and its two dates.
  if (agenda)
    return officialSourceAuthorized && Number.isFinite(now.getTime()) && accessOpenAtV1(agenda, now.getTime());
  const at = timestamp(value.calendar.finalDisclosureAt);
  const end = timestamp(value.calendar.finalDisclosureEndsAt ?? null);
  return (
    (end === null || now.getTime() < end) &&
    officialSourceAuthorized &&
    value.showFinalResult &&
    at !== null &&
    Number.isFinite(now.getTime()) &&
    now.getTime() >= at
  );
}

/** Filters an already published projection; it never promotes an unpublished academic fact. */
export function applyPublishedVisibilityV1(
  input: SelfResponseV1,
  policy: PolicyValueV1,
  now: Date,
  officialSourceAuthorized: boolean,
): SelfResponseV1 {
  const projection = selfResponseV1.parse(input);
  const value = settingsValueV1.parse(policy);
  const final = mayDiscloseFinalV1(value, now, officialSourceAuthorized);
  // EM RECUPERAÇÃO (and which subjects are pending) follows the T3 disclosure so the student
  // learns it before the recovery week; every other situation waits for the final disclosure.
  // Pending (student-portal): a dedicated admin control replaces this once the branch is merged.
  const recoveryDisclosed = periodDisclosureV1(value, 'T3', now) === 'allowed';
  const situationVisible = (situation: string | undefined, earlyValue: string) =>
    situation !== undefined && (final || (recoveryDisclosed && situation === earlyValue));
  const accessOn = accessGateV1(value, now);
  const subjects = accessOn
    ? projection.subjects
        .map((subject) => {
          const { officialOutcome, annualSituation, ...base } = subject;
          return {
            ...base,
            ...(final && officialOutcome !== undefined ? { officialOutcome } : {}),
            ...(situationVisible(annualSituation, 'recovery-pending') ? { annualSituation } : {}),
            periods: subject.periods
              .filter((period) => periodDisclosureV1(value, period.period, now) === 'allowed')
              .map((period) => {
                const { partials, ...basePeriod } = period;
                return {
                  ...basePeriod,
                  ...(value.showPartials && partials !== undefined ? { partials } : {}),
                };
              }),
          };
        })
        .filter((subject) => subject.periods.length > 0)
    : [];
  const { annualSituation, ...profile } = projection.profile;
  const showSituation =
    accessOn &&
    projection.profile.academicState !== 'assisted' &&
    situationVisible(annualSituation, 'in-recovery');
  let result = projection.profile.result;
  if (projection.profile.academicState === 'assisted') result = 'not-applicable';
  else if (!(final && accessOn)) result = 'in-progress';
  return selfResponseV1.parse({
    ...projection,
    state: subjects.length > 0 ? 'ready' : 'no-publication',
    profile: {
      ...profile,
      ...(showSituation ? { annualSituation } : {}),
      result,
    },
    subjects,
  });
}
