// @vitest-environment node
import { expect, it } from 'vitest';
import { enforceSchoolAccessV1 } from '../../../server/student-portal/policies/school-access-v1';
import { initialPolicyDefaultsV1 } from '../../../server/student-portal/policies/defaults-v1';
import { sessionExpiryV1 } from '../../../server/student-portal/policies/calendar-v1';
import { resolvePolicySnapshotRowsV1 } from '../../../server/student-portal/policies/policy-service-v1';

const school = { kind: 'school', academicYear: 2026 } as const;
const klass = { kind: 'class', academicYear: 2026, classId: 110201 } as const;
const base = () => {
  const p = initialPolicyDefaultsV1();
  return {
    ...p,
    accessEnabled: true,
    calendar: {
      ...p.calendar,
      yearStartsAt: '2026-01-01T00:00:00Z',
      yearEndsAt: '2027-01-01T00:00:00Z',
      accessStartsAt: '2026-03-01T00:00:00Z',
      accessEndsAt: '2026-11-01T00:00:00Z',
    },
  };
};
it('keeps stored overrides/provenance while school closure dominates runtime', async () => {
  const value = base();
  const records = Object.entries(value).map(([field_key, value_json]) => ({
    scope_key: 'school:2026',
    field_key,
    value_json: field_key === 'accessEnabled' ? false : value_json,
    source_scope_json: school,
    version: 1,
  }));
  records.push({
    scope_key: 'class:2026:110201',
    field_key: 'accessEnabled',
    value_json: true,
    source_scope_json: klass as unknown as typeof school,
    version: 1,
  });
  const snapshot = await resolvePolicySnapshotRowsV1(klass, [
    { resolved: true, class_id: 110201, account_version: 0, settings_rows: records },
  ]);
  expect(snapshot.settings.value.accessEnabled).toBe(true);
  expect(snapshot.settings.sources.accessEnabled).toEqual(klass);
  expect(snapshot.enforcedValue.accessEnabled).toBe(false);
  records[0]!.value_json = true;
  expect(
    (
      await resolvePolicySnapshotRowsV1(klass, [
        { resolved: true, class_id: 110201, account_version: 0, settings_rows: records },
      ])
    ).enforcedValue.accessEnabled,
  ).toBe(true);
});
it('intersects local and school bounds, includes start and excludes end', () => {
  const local = base();
  local.calendar.accessStartsAt = '2026-02-01T00:00:00Z';
  local.calendar.accessEndsAt = '2026-12-01T00:00:00Z';
  const guarded = enforceSchoolAccessV1(local, base());
  expect(sessionExpiryV1(guarded, new Date('2026-02-28T23:59:59Z'), false)).toBeNull();
  expect(sessionExpiryV1(guarded, new Date('2026-03-01T00:00:00Z'), false)).not.toBeNull();
  expect(sessionExpiryV1(guarded, new Date('2026-11-01T00:00:00Z'), false)).toBeNull();
  expect(local.calendar.accessStartsAt).toBe('2026-02-01T00:00:00Z');
});
it('fails closed for missing or disjoint school access without inventing invalid calendar', () => {
  const missing = initialPolicyDefaultsV1();
  expect(enforceSchoolAccessV1(base(), { ...missing, accessEnabled: true }).accessEnabled).toBe(
    false,
  );
  const local = base();
  local.calendar.accessStartsAt = '2026-11-01T00:00:00Z';
  local.calendar.accessEndsAt = '2026-12-01T00:00:00Z';
  expect(enforceSchoolAccessV1(local, base()).accessEnabled).toBe(false);
});
