import { describe, expect, it } from 'vitest';
import {
  accessOpenAtV1,
  accessScheduleV1,
  anticipateAccessV1,
  combineAccessPlansV1,
  legacyAccessPlanV1,
  nextAccessChangeV1,
  settleAccessPlanV1,
  type AccessPlanV1,
} from '../../../shared/student-portal-contracts/access-schedule-v1';
import { initialPolicyDefaultsV1 } from '../../../server/student-portal/policies/defaults-v1';
import { enforceSchoolAccessV1 } from '../../../server/student-portal/policies/school-access-v1';
import {
  accessEndV1,
  accessGateV1,
  periodDisclosureV1,
  portalNoticesForPolicyV1,
  sessionExpiryV1,
} from '../../../server/student-portal/policies/calendar-v1';
import { resolvePolicySnapshotRowsV1 } from '../../../server/student-portal/policies/policy-service-v1';

const t = (iso: string) => Date.parse(iso);
const OPEN = '2026-09-29T10:00:00.000Z';
const CLOSE = '2026-10-03T21:00:00.000Z';
const REOPEN = '2026-10-13T10:00:00.000Z';
const scheduled = (enabled: boolean, ...events: [string, 'open' | 'close'][]): AccessPlanV1 => ({
  enabled,
  schedule: events.map(([at, action]) => ({ at, action })),
});

describe('access plan', () => {
  it('follows the agenda: opposite before each action, as the last one left it afterwards', () => {
    const plan = scheduled(false, [OPEN, 'open'], [CLOSE, 'close'], [REOPEN, 'open']);
    expect(accessOpenAtV1(plan, t(OPEN) - 1)).toBe(false);
    expect(accessOpenAtV1(plan, t(OPEN))).toBe(true); // an action applies from its own instant
    expect(accessOpenAtV1(plan, t(CLOSE) - 1)).toBe(true);
    expect(accessOpenAtV1(plan, t(CLOSE))).toBe(false);
    expect(accessOpenAtV1(plan, t(REOPEN))).toBe(true);
  });

  it('finds the next real change, skipping an Abrir while already open', () => {
    const plan = scheduled(true, [OPEN, 'open'], [CLOSE, 'close']);
    expect(nextAccessChangeV1(plan, t('2026-09-28T00:00:00Z'), false)).toBe(t(CLOSE));
    expect(nextAccessChangeV1(plan, t(CLOSE), true)).toBeNull();
    const closed = scheduled(false, [CLOSE, 'close'], [REOPEN, 'open']);
    expect(nextAccessChangeV1(closed, t('2026-09-28T00:00:00Z'), true)).toBe(t(REOPEN));
  });

  it('closes now for an Abrir later, and opens now for a Fechar later (owner rule)', () => {
    const now = t('2026-09-28T12:00:00Z');
    const openedLater = scheduled(true, [OPEN, 'open']);
    expect(accessOpenAtV1(openedLater, now)).toBe(false);
    expect(nextAccessChangeV1(openedLater, now, true)).toBe(t(OPEN));
    const closedLater = scheduled(false, [OPEN, 'close']);
    expect(accessOpenAtV1(closedLater, now)).toBe(true);
    expect(accessOpenAtV1(closedLater, t(OPEN))).toBe(false);
    // With nothing scheduled, the switch decides.
    expect(accessOpenAtV1(scheduled(true), now)).toBe(true);
  });

  it('brings the next action forward when the switch is used', () => {
    const now = t('2026-09-28T12:00:00Z');
    const plan = scheduled(true, [OPEN, 'open'], [CLOSE, 'close']);
    // Closed now, waiting for the Abrir: opening by the switch replaces it; the Fechar stays.
    expect(anticipateAccessV1(plan, now, true)).toEqual(scheduled(true, [CLOSE, 'close']));
    const onlyClose = scheduled(false, [CLOSE, 'close']);
    expect(anticipateAccessV1(onlyClose, now, false)).toEqual(scheduled(false));
  });

  it('opens both-or-nothing when combining the school with a class', () => {
    const school = scheduled(false, [OPEN, 'open']);
    const klass = scheduled(true, [CLOSE, 'close']);
    const both = combineAccessPlansV1(school, klass);
    expect(accessOpenAtV1(both, t(OPEN) - 1)).toBe(false); // school still closed
    expect(accessOpenAtV1(both, t(OPEN))).toBe(true);
    expect(accessOpenAtV1(both, t(CLOSE))).toBe(false); // class closes on its own
  });

  it('reads the old Calendário window exactly as before', () => {
    const plan = legacyAccessPlanV1(true, OPEN, CLOSE);
    expect(accessOpenAtV1(plan, t(OPEN) - 1)).toBe(false);
    expect(accessOpenAtV1(plan, t(OPEN))).toBe(true);
    expect(accessOpenAtV1(plan, t(CLOSE))).toBe(false);
    expect(legacyAccessPlanV1(false, OPEN, CLOSE)).toEqual({ enabled: false, schedule: [] });
    expect(legacyAccessPlanV1(true, OPEN, null)).toEqual({ enabled: false, schedule: [] });
  });

  it('settles into the state now plus the actions still ahead', () => {
    const plan = scheduled(false, [OPEN, 'open'], [CLOSE, 'close']);
    expect(settleAccessPlanV1(plan, t('2026-10-01T00:00:00Z'))).toEqual(
      scheduled(true, [CLOSE, 'close']),
    );
  });

  it('accepts only time-ordered schedules without repeated times', () => {
    expect(
      accessScheduleV1.safeParse([
        { at: CLOSE, action: 'close' },
        { at: OPEN, action: 'open' },
      ]).success,
    ).toBe(false);
    expect(
      accessScheduleV1.safeParse([
        { at: OPEN, action: 'open' },
        { at: OPEN, action: 'close' },
      ]).success,
    ).toBe(false);
    expect(accessScheduleV1.safeParse([{ at: OPEN, action: 'open' }]).success).toBe(true);
  });
});

const policy = (accessEnabled: boolean, accessSchedule: [string, 'open' | 'close'][] | null) => {
  const value = initialPolicyDefaultsV1();
  return {
    ...value,
    accessEnabled,
    accessSchedule: accessSchedule && accessSchedule.map(([at, action]) => ({ at, action })),
    calendar: {
      ...value.calendar,
      yearStartsAt: '2026-02-23T03:00:00Z',
      yearEndsAt: '2026-12-18T21:00:00Z',
    },
  };
};

describe('enforced access with schedules', () => {
  it('counts down to a scheduled opening even with the switch off (owner case, 27/09/2026)', () => {
    const school = policy(false, [[OPEN, 'open']]);
    const enforced = enforceSchoolAccessV1(school, school);
    const before = new Date('2026-09-28T12:00:00Z');
    expect(sessionExpiryV1(enforced, before, false)).toBeNull();
    expect(portalNoticesForPolicyV1(enforced, before)).toMatchObject({
      access: 'closed',
      accessOpensAt: OPEN,
    });
    expect(sessionExpiryV1(enforced, new Date(OPEN), false)).not.toBeNull();
  });

  it('ends sessions at the scheduled close and keeps them uncapped without one', () => {
    const school = policy(true, [[CLOSE, 'close']]);
    const enforced = enforceSchoolAccessV1(school, school);
    const now = new Date('2026-10-03T20:00:00Z');
    expect(sessionExpiryV1(enforced, now, true)).toBe(CLOSE);
    expect(accessEndV1(enforced, now)).toBe(t(CLOSE));
    const open = enforceSchoolAccessV1(policy(true, []), policy(true, []));
    expect(accessEndV1(open, now)).toBe(Number.POSITIVE_INFINITY);
    expect(accessGateV1(open, now)).toBe(true);
  });

  it('keeps the school barrier: a class schedule never opens a closed school', () => {
    const school = policy(false, []);
    const klass = policy(true, [[OPEN, 'open']]);
    const enforced = enforceSchoolAccessV1(klass, school);
    expect(accessGateV1(enforced, new Date(REOPEN))).toBe(false);
    expect(
      portalNoticesForPolicyV1(enforced, new Date('2026-09-28T12:00:00Z')).accessOpensAt,
    ).toBeNull();
  });

  it('lets a class stay closed while the school opens on schedule', () => {
    const school = policy(false, [[OPEN, 'open']]);
    const klass = policy(false, []);
    const enforced = enforceSchoolAccessV1(klass, school);
    expect(accessGateV1(enforced, new Date(REOPEN))).toBe(false);
  });

  it('never applies a schedule inherited from another level than the switch', async () => {
    const school = { kind: 'school', academicYear: 2026 } as const;
    const klass = { kind: 'class', academicYear: 2026, classId: 110201 } as const;
    const schoolValue = policy(false, [[OPEN, 'open']]);
    const records = Object.entries(schoolValue).map(([field_key, value_json]) => ({
      scope_key: 'school:2026',
      field_key,
      value_json,
      source_scope_json: school,
      version: 1,
    }));
    // A class closed by its own switch, from before schedules: the school's Abrir is not its own.
    records.push({
      scope_key: 'class:2026:110201',
      field_key: 'accessEnabled',
      value_json: false,
      source_scope_json: klass as unknown as typeof school,
      version: 1,
    });
    const snapshot = await resolvePolicySnapshotRowsV1(klass, [
      { resolved: true, class_id: 110201, account_version: 0, settings_rows: records },
    ]);
    expect(accessGateV1(snapshot.enforcedValue, new Date(REOPEN))).toBe(false);
    expect(snapshot.settings.sources.accessSchedule).toEqual(school);
  });

  it('leaves policies without any schedule on the original Calendário rule', () => {
    const value = policy(true, null);
    const enforced = enforceSchoolAccessV1(value, value);
    expect(enforced.accessSchedule).toBeNull();
    expect(accessGateV1(enforced, new Date('2026-10-01T00:00:00Z'))).toBe(true);
    expect(sessionExpiryV1(enforced, new Date('2026-12-18T21:00:00Z'), false)).toBeNull();
  });
});

describe('grade disclosure follows its agenda', () => {
  const grades = (at: string | null, endsAt: string | null) => {
    const value = initialPolicyDefaultsV1();
    return {
      ...value,
      allowedPeriods: ['T1' as const],
      calendar: {
        ...value.calendar,
        yearStartsAt: '2026-02-23T03:00:00Z',
        yearEndsAt: '2026-12-18T21:00:00Z',
        disclosure: { mode: 'single' as const, at, endsAt, periods: ['T1' as const] },
      },
    };
  };
  const HIDE = '2026-10-10T21:00:00Z';
  const SHOW = '2026-10-20T10:00:00Z';

  it('keeps the usual window: hidden before Liberar, shown until Ocultar', () => {
    const value = grades('2026-10-01T10:00:00Z', HIDE);
    expect(periodDisclosureV1(value, 'T1', new Date('2026-09-30T00:00:00Z'))).toBe('not-yet');
    expect(periodDisclosureV1(value, 'T1', new Date('2026-10-05T00:00:00Z'))).toBe('allowed');
    expect(periodDisclosureV1(value, 'T1', new Date(HIDE))).toBe('disabled');
  });

  it('shows the grades again at a Liberar scheduled after an Ocultar, with its countdown', () => {
    const value = grades(SHOW, HIDE);
    expect(periodDisclosureV1(value, 'T1', new Date('2026-10-05T00:00:00Z'))).toBe('allowed');
    const hidden = new Date('2026-10-15T00:00:00Z');
    expect(periodDisclosureV1(value, 'T1', hidden)).toBe('not-yet');
    expect(portalNoticesForPolicyV1({ ...value, accessEnabled: true }, hidden)).toMatchObject({
      gradesReleaseAt: new Date(SHOW).toISOString(),
      disclosureEnded: null,
    });
    expect(periodDisclosureV1(value, 'T1', new Date(SHOW))).toBe('allowed');
  });
});
