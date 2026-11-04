import {
  settingsOverrideV1,
  type AgendaPlanV1,
  type EffectiveSettingsV1,
} from '../../../../shared/student-portal-contracts/policy-v1';
import {
  combineAccessPlansV1,
  legacyAccessPlanV1,
  settleAccessPlanV1,
  type AccessPlanV1,
} from '../../../../shared/student-portal-contracts/access-schedule-v1';
import { PERIODS_V1, type CalendarV1 } from './settings-values-v1';

/*
 * Aba Notas (27/09/2026): each period and the Resultado anual follow an agenda (a switch plus
 * Mostrar/Ocultar), like access. A scope still on the older dates is read as the agenda those dates
 * mean, so the tab opens showing what students see today, and it is saved as an agenda.
 */
export type GradePeriodV1 = (typeof PERIODS_V1)[number];
export type GradeKeyV1 = GradePeriodV1 | 'final';
type ValueV1 = EffectiveSettingsV1['value'];

/** Same period starts as the server (calendar-v1 periodStartV1). */
function periodStartV1(calendar: CalendarV1, period: GradePeriodV1): string | null {
  if (period === 'T1') return calendar.yearStartsAt;
  if (period === 'T2') return calendar.t2StartsAt ?? calendar.t1EndsAt;
  if (period === 'T3') return calendar.t3StartsAt ?? calendar.t2EndsAt;
  return calendar.recoveriesStartAt;
}

/**
 * The older rule for one period — allowed, inside the single schedule, from its start — as a plan.
 * Same as the server (calendar-v1 periodDisclosureV1): the Liberar/Ocultar agenda starting shown,
 * and only from the period's start, so an Ocultar before that start keeps the period hidden.
 */
function legacyPeriodPlanV1(value: ValueV1, period: GradePeriodV1): AccessPlanV1 {
  const { calendar, allowedPeriods } = value;
  const disclosure = calendar.disclosure;
  if (disclosure.mode === 'agenda') return disclosure.periods[period];
  const included = disclosure.mode === 'per-period' || disclosure.periods.includes(period);
  const start = periodStartV1(calendar, period);
  if (!allowedPeriods.includes(period) || !included || start === null)
    return { enabled: false, schedule: [] };
  const at = disclosure.mode === 'single' ? disclosure.at : disclosure.at[period];
  const end = (disclosure.mode === 'single' ? disclosure.endsAt : disclosure.endsAt?.[period]) ?? null;
  const schedule = [
    ...(at === null ? [] : [{ at: Date.parse(at), action: 'open' as const }]),
    ...(end === null ? [] : [{ at: Date.parse(end), action: 'close' as const }]),
  ]
    .sort((left, right) => left.at - right.at)
    .map((event) => ({ at: new Date(event.at).toISOString(), action: event.action }));
  const fromStart: AccessPlanV1 = {
    enabled: false,
    schedule: [{ at: new Date(Date.parse(start)).toISOString(), action: 'open' }],
  };
  return combineAccessPlansV1({ enabled: true, schedule }, fromStart);
}

export function gradePlanOfV1(value: ValueV1, key: GradeKeyV1): AccessPlanV1 {
  if (key !== 'final') return legacyPeriodPlanV1(value, key);
  const calendar = value.calendar;
  if (calendar.finalAgenda) return calendar.finalAgenda;
  // Older rule: switch on and shown from its date, until its optional end.
  const at = calendar.finalDisclosureAt;
  if (!value.showFinalResult || at === null) return { enabled: false, schedule: [] };
  const end = calendar.finalDisclosureEndsAt ?? null;
  return end === null
    ? { enabled: false, schedule: [{ at: new Date(Date.parse(at)).toISOString(), action: 'open' }] }
    : legacyAccessPlanV1(true, at, end);
}

/** Whether the tab still reads the older dates (saving converts them). */
export function gradesFromCalendarV1(value: ValueV1, key: GradeKeyV1) {
  return key === 'final'
    ? value.calendar.finalAgenda === undefined
    : value.calendar.disclosure.mode !== 'agenda';
}

const toSchedule = (plan: AccessPlanV1): AgendaPlanV1 => ({ enabled: plan.enabled, schedule: [...plan.schedule] });

/**
 * The calendar to save with one agenda replaced. Converting the periods converts all six at once
 * (the mode is shared), each settled to what students see now so nothing else changes.
 */
export function calendarWithGradePlanV1(
  value: ValueV1,
  key: GradeKeyV1,
  plan: AccessPlanV1,
  now: number,
) {
  const calendar = value.calendar;
  const next: CalendarV1 =
    key === 'final'
      ? { ...calendar, finalAgenda: toSchedule(plan) }
      : {
          ...calendar,
          disclosure: {
            mode: 'agenda',
            periods: Object.fromEntries(
              PERIODS_V1.map((period) => [
                period,
                period === key
                  ? toSchedule(plan)
                  : toSchedule(settleAccessPlanV1(gradePlanOfV1(value, period), now)),
              ]),
            ) as Extract<CalendarV1['disclosure'], { mode: 'agenda' }>['periods'],
          },
        };
  return settingsOverrideV1.parse({ calendar: next });
}

export const GRADE_LABELS_V1: Record<GradeKeyV1, string> = {
  T1: '1º trimestre',
  T2: '2º trimestre',
  T3: '3º trimestre',
  REC1: 'Recuperação do 1º trimestre',
  REC2: 'Recuperação do 2º trimestre',
  REC3: 'Recuperação do 3º trimestre',
  final: 'Resultado anual',
};

/** "do 1º trimestre", "da recuperação do 1º trimestre", "do resultado anual". */
export function gradeOfV1(key: GradeKeyV1) {
  if (key === 'final') return 'do resultado anual';
  return key.startsWith('REC') ? `da recuperação do ${key.slice(3)}º trimestre` : `do ${key.slice(1)}º trimestre`;
}
