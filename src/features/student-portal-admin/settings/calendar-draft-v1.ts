import { calendarV1 } from '../../../../shared/student-portal-contracts/policy-v1';
import {
  CALENDAR_LABELS_V1,
  PERIODS_V1,
  calendarInputV1,
  calendarInstantV1,
  type CalendarV1,
} from './settings-values-v1';

export type CalendarDateKeyV1 = keyof typeof CALENDAR_LABELS_V1;
export type CalendarPeriodV1 = (typeof PERIODS_V1)[number];
export interface CalendarDraftV1 {
  dates: Record<CalendarDateKeyV1, string>;
  mode: 'single' | 'per-period';
  singleAt: string;
  singleUntil?: string;
  singlePeriods: CalendarPeriodV1[];
  periodAt: Record<CalendarPeriodV1, string>;
  periodUntil?: Record<CalendarPeriodV1, string>;
  /** Agendas edited on the Notas tab: carried through untouched when the Calendário is saved. */
  agenda?: {
    disclosure?: Extract<CalendarV1['disclosure'], { mode: 'agenda' }>;
    finalAgenda?: CalendarV1['finalAgenda'];
  };
}
const emptyPeriodDates = (): Record<CalendarPeriodV1, string> => ({
  T1: '',
  T2: '',
  T3: '',
  REC1: '',
  REC2: '',
  REC3: '',
});
export function calendarDraftV1(value: CalendarV1): CalendarDraftV1 {
  return {
    dates: Object.fromEntries(
      Object.entries(CALENDAR_LABELS_V1).map(([key]) => [
        key,
        calendarInputV1(value[key as CalendarDateKeyV1] ?? null),
      ]),
    ) as CalendarDraftV1['dates'],
    mode: value.disclosure.mode === 'agenda' ? 'single' : value.disclosure.mode,
    agenda: {
      ...(value.disclosure.mode === 'agenda' ? { disclosure: value.disclosure } : {}),
      ...(value.finalAgenda ? { finalAgenda: value.finalAgenda } : {}),
    },
    singleUntil:
      value.disclosure.mode === 'single' ? calendarInputV1(value.disclosure.endsAt ?? null) : '',
    periodUntil: Object.fromEntries(
      PERIODS_V1.map((period) => [
        period,
        calendarInputV1(
          value.disclosure.mode === 'per-period'
            ? (value.disclosure.endsAt?.[period] ?? null)
            : null,
        ),
      ]),
    ) as Record<CalendarPeriodV1, string>,
    singleAt: value.disclosure.mode === 'single' ? calendarInputV1(value.disclosure.at) : '',
    singlePeriods:
      value.disclosure.mode === 'single' ? [...value.disclosure.periods] : [...PERIODS_V1],
    periodAt:
      value.disclosure.mode === 'per-period'
        ? (Object.fromEntries(
            PERIODS_V1.map((period) => [
              period,
              calendarInputV1(
                value.disclosure.mode === 'per-period' ? value.disclosure.at[period] : null,
              ),
            ]),
          ) as CalendarDraftV1['periodAt'])
        : emptyPeriodDates(),
  };
}
export function calendarDraftModeV1(
  draft: CalendarDraftV1,
  mode: CalendarDraftV1['mode'],
): CalendarDraftV1 {
  if (mode === draft.mode) return draft;
  // A mode change never copies one date into six dates or silently schedules periods.
  return {
    ...draft,
    mode,
    singleAt: '',
    singleUntil: '',
    periodUntil: emptyPeriodDates(),
    singlePeriods: [...PERIODS_V1],
    periodAt: emptyPeriodDates(),
  };
}
/** The draft's disclosure: the agenda when there is one, else the single date or one per period. */
function draftDisclosureV1(draft: CalendarDraftV1) {
  if (draft.agenda?.disclosure) return draft.agenda.disclosure;
  if (draft.mode === 'single')
    return {
      mode: 'single',
      at: calendarInstantV1(draft.singleAt),
      periods: draft.singlePeriods,
      ...(draft.singleUntil ? { endsAt: calendarInstantV1(draft.singleUntil) } : {}),
    };
  return {
    mode: 'per-period',
    ...(PERIODS_V1.some((period) => draft.periodUntil?.[period])
      ? {
          endsAt: Object.fromEntries(
            PERIODS_V1.map((period) => [
              period,
              calendarInstantV1(draft.periodUntil?.[period] ?? ''),
            ]),
          ),
        }
      : {}),
    at: Object.fromEntries(
      PERIODS_V1.map((period) => [period, calendarInstantV1(draft.periodAt[period])]),
    ),
  };
}

export function parseCalendarDraftV1(draft: CalendarDraftV1): CalendarV1 {
  const dates = Object.fromEntries(
    Object.keys(CALENDAR_LABELS_V1).map((key) => [
      key,
      calendarInstantV1(draft.dates[key as CalendarDateKeyV1]),
    ]),
  );
  // Absent optional bounds remain absent, preserving old calendars byte-for-byte when untouched.
  for (const key of ['accessStartsAt', 'accessEndsAt', 'finalDisclosureEndsAt']) {
    if (dates[key] === null) delete dates[key];
  }
  return calendarV1.parse({
    timezone: 'America/Sao_Paulo',
    ...dates,
    ...(draft.agenda?.finalAgenda ? { finalAgenda: draft.agenda.finalAgenda } : {}),
    disclosure: draftDisclosureV1(draft),
  });
}
