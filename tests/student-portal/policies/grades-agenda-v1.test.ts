// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { initialPolicyDefaultsV1 } from '../../../server/student-portal/policies/defaults-v1';
import {
  mayDiscloseFinalV1,
  normalizeCalendarV1,
  periodDisclosureV1,
  portalNoticesForPolicyV1,
} from '../../../server/student-portal/policies/calendar-v1';
import { accessOpenAtV1 } from '../../../shared/student-portal-contracts/access-schedule-v1';
import {
  calendarWithGradePlanV1,
  gradePlanOfV1,
} from '../../../src/features/student-portal-admin/settings/grades-agenda-v1';

const SHOW = '2026-10-20T13:00:00.000Z';
const HIDE = '2026-12-18T21:00:00.000Z';
const empty = { enabled: false, schedule: [] };
const plan = (enabled: boolean, ...events: [string, 'open' | 'close'][]) => ({
  enabled,
  schedule: events.map(([at, action]) => ({ at, action })),
});
const agenda = (T1: ReturnType<typeof plan>, finalAgenda?: ReturnType<typeof plan>) => {
  const value = initialPolicyDefaultsV1();
  return {
    ...value,
    accessEnabled: true,
    // "Períodos permitidos" is empty on purpose: the agenda alone decides.
    allowedPeriods: [],
    showFinalResult: false,
    calendar: {
      ...value.calendar,
      yearStartsAt: '2026-02-23T03:00:00Z',
      yearEndsAt: '2026-12-23T03:00:00Z',
      ...(finalAgenda ? { finalAgenda } : {}),
      disclosure: {
        mode: 'agenda' as const,
        periods: { T1, T2: empty, T3: empty, REC1: empty, REC2: empty, REC3: empty },
      },
    },
  };
};

describe('Aba Notas agendas on the server', () => {
  it('shows a period by its agenda only, whatever "Períodos permitidos" says', () => {
    const value = agenda(plan(true, [SHOW, 'open'], [HIDE, 'close']));
    // Visible now, but an Abrir later hides it until then (follow the agenda).
    expect(periodDisclosureV1(value, 'T1', new Date('2026-10-01T00:00:00Z'))).toBe('not-yet');
    expect(periodDisclosureV1(value, 'T1', new Date(SHOW))).toBe('allowed');
    expect(periodDisclosureV1(value, 'T1', new Date(HIDE))).toBe('disabled');
    expect(periodDisclosureV1(agenda(plan(true)), 'T1', new Date(SHOW))).toBe('allowed');
    expect(periodDisclosureV1(value, 'T2', new Date(SHOW))).toBe('disabled');
  });

  it('counts down to the next Mostrar and announces a scheduled Ocultar', () => {
    const value = agenda(plan(false, [SHOW, 'open'], [HIDE, 'close']));
    expect(portalNoticesForPolicyV1(value, new Date('2026-10-01T00:00:00Z'))).toMatchObject({
      gradesReleaseAt: SHOW,
      disclosureEnded: null,
    });
    expect(portalNoticesForPolicyV1(value, new Date('2026-12-19T00:00:00Z'))).toMatchObject({
      gradesReleaseAt: null,
      disclosureEnded: { period: 'T1', at: HIDE },
    });
  });

  it('shows the annual result by its own agenda, only with the official source', () => {
    const value = agenda(empty, plan(false, [SHOW, 'open']));
    expect(mayDiscloseFinalV1(value, new Date(SHOW), true)).toBe(true);
    expect(mayDiscloseFinalV1(value, new Date(SHOW), false)).toBe(false);
    expect(mayDiscloseFinalV1(value, new Date('2026-10-01T00:00:00Z'), true)).toBe(false);
  });

  it('stores agenda instants with second precision', () => {
    const value = agenda(plan(false, ['2026-10-20T13:00:00.000Z', 'open']));
    const normalized = normalizeCalendarV1(value.calendar);
    expect(normalized.disclosure).toMatchObject({
      mode: 'agenda',
      periods: { T1: { schedule: [{ at: '2026-10-20T13:00:00Z', action: 'open' }] } },
    });
  });
});

describe('Aba Notas in the admin', () => {
  const legacy = () => {
    const value = initialPolicyDefaultsV1();
    return {
      ...value,
      allowedPeriods: ['T1' as const, 'T2' as const],
      showFinalResult: true,
      calendar: {
        ...value.calendar,
        yearStartsAt: '2026-02-23T03:00:00Z',
        t1EndsAt: '2026-05-30T03:00:00Z',
        finalDisclosureAt: '2026-12-20T13:00:00Z',
        disclosure: {
          mode: 'per-period' as const,
          at: { T1: null, T2: SHOW, T3: null, REC1: null, REC2: null, REC3: null },
        },
      },
    };
  };

  it('reads the older dates as the agenda students see today', () => {
    const value = legacy();
    const now = Date.parse('2026-09-27T12:00:00Z');
    expect(accessOpenAtV1(gradePlanOfV1(value, 'T1'), now)).toBe(true);
    expect(accessOpenAtV1(gradePlanOfV1(value, 'T2'), now)).toBe(false);
    expect(accessOpenAtV1(gradePlanOfV1(value, 'T2'), Date.parse(SHOW))).toBe(true);
    expect(gradePlanOfV1(value, 'T3')).toEqual(empty); // not in "Períodos permitidos"
    expect(accessOpenAtV1(gradePlanOfV1(value, 'final'), Date.parse('2026-12-21T00:00:00Z'))).toBe(true);
  });

  it('converts all six periods at once, keeping what the others show now', () => {
    const value = legacy();
    const now = Date.parse('2026-09-27T12:00:00Z');
    const saved = calendarWithGradePlanV1(value, 'T3', plan(true), now).calendar!;
    expect(saved.disclosure.mode).toBe('agenda');
    if (saved.disclosure.mode !== 'agenda') return;
    expect(saved.disclosure.periods.T3).toEqual(plan(true));
    expect(saved.disclosure.periods.T1).toEqual(plan(true));
    expect(saved.disclosure.periods.T2).toEqual(plan(false, [SHOW, 'open']));
    expect(saved.finalAgenda).toBeUndefined();
  });

  it('keeps hidden a period whose Ocultar came before its start, like the server', () => {
    const base = legacy();
    const value = {
      ...base,
      allowedPeriods: ['T1' as const, 'T2' as const, 'T3' as const],
      calendar: {
        ...base.calendar,
        disclosure: {
          mode: 'single' as const,
          at: '2026-04-01T13:00:00.000Z',
          endsAt: '2026-05-15T03:00:00.000Z',
          periods: ['T1' as const, 'T2' as const, 'T3' as const],
        },
      },
    };
    const now = Date.parse('2026-09-27T12:00:00Z');
    expect(periodDisclosureV1(value, 'T2', new Date(now))).toBe('disabled');
    expect(accessOpenAtV1(gradePlanOfV1(value, 'T2'), now)).toBe(false);
    expect(accessOpenAtV1(gradePlanOfV1(value, 'T1'), Date.parse('2026-04-10T12:00:00Z'))).toBe(true);
    const saved = calendarWithGradePlanV1(value, 'T1', empty, now);
    expect(periodDisclosureV1({ ...value, calendar: saved.calendar! }, 'T2', new Date(now))).toBe('disabled');
  });
});
