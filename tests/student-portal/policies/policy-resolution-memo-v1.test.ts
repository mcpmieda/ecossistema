// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { initialPolicyDefaultsV1 } from '../../../server/student-portal/policies/defaults-v1';
import {
  createPolicyResolutionMemoV1,
  resolvePolicySnapshotRowsV1,
} from '../../../server/student-portal/policies/policy-service-v1';
import { effectiveSettingsV1 } from '../../../shared/student-portal-contracts/policy-v1';
import type { PolicyScopeV1 } from '../../../shared/student-portal-contracts/core-v1';

const SCHOOL = { kind: 'school', academicYear: 2026 } as const;
const account = (n: number) => '77700000-0000-4000-8000-' + String(n).padStart(12, '0');
const accountScope = (n: number): PolicyScopeV1 => ({
  kind: 'account',
  academicYear: 2026,
  accountId: account(n),
});
type Stored = {
  scope_key: string;
  field_key: string;
  value_json: unknown;
  source_scope_json: PolicyScopeV1;
  version: number;
};
function schoolRows(schedule = false): Stored[] {
  const defaults = initialPolicyDefaultsV1();
  const value = {
    ...defaults,
    accessEnabled: true,
    accessSchedule: schedule
      ? [{ at: '2026-05-01T12:00:00Z', action: 'close' as const }]
      : defaults.accessSchedule,
    calendar: {
      ...defaults.calendar,
      yearStartsAt: '2026-02-01T00:00:00Z',
      yearEndsAt: '2026-12-20T00:00:00Z',
      accessStartsAt: '2026-03-01T00:00:00Z',
      accessEndsAt: '2026-11-01T00:00:00Z',
    },
  };
  return Object.entries(value).map(([field_key, value_json]) => ({
    scope_key: 'school:2026',
    field_key,
    value_json,
    source_scope_json: SCHOOL,
    version: 4,
  }));
}
const own = (
  scope: PolicyScopeV1,
  key: string,
  field_key: string,
  value_json: unknown,
): Stored => ({
  scope_key: key,
  field_key,
  value_json,
  source_scope_json: scope,
  version: 4,
});
const classRule = own(
  { kind: 'class', academicYear: 2026, classId: 7 },
  'class:2026:7',
  'showPartials',
  true,
);
const shiftRule = own(
  { kind: 'shift', academicYear: 2026, shift: 'MATUTINO' },
  'shift:2026:MATUTINO',
  'autoUpdate',
  true,
);
const accountRule = (n: number) =>
  own(accountScope(n), 'account:2026:' + account(n), 'accessEnabled', false);
const target = (
  rows: Stored[],
  extra: {
    class_id?: number | null;
    shift?: string | null;
    account_version?: number | string;
  } = {},
) => ({
  resolved: true,
  class_id: 7,
  shift: 'MATUTINO',
  account_version: 0,
  ...extra,
  settings_rows: rows,
});

describe('policy resolution shared by one read', () => {
  it('gives every target the result it has alone, for each scope and rule level', async () => {
    const classmates = [...schoolRows(), classRule, shiftRule];
    const cases: [PolicyScopeV1, ReturnType<typeof target>][] = [
      [accountScope(1), target(classmates, { account_version: 3 })],
      [accountScope(2), target(classmates, { account_version: '9' })],
      [accountScope(3), target([...classmates, accountRule(3)], { account_version: 1 })],
      [accountScope(4), target(classmates)],
      [accountScope(5), target(schoolRows(), { class_id: 8, shift: null })],
      [accountScope(6), target([...schoolRows(true), classRule], { shift: 'NOTURNO' })],
      [accountScope(7), target(schoolRows(true), { class_id: 8, shift: null })],
      [{ kind: 'class', academicYear: 2026, classId: 7 }, target(classmates)],
      [
        { kind: 'shift', academicYear: 2026, shift: 'MATUTINO' },
        target(classmates, { class_id: null, shift: null }),
      ],
      [SCHOOL, target(schoolRows(), { class_id: null, shift: null })],
    ];
    const memo = createPolicyResolutionMemoV1();
    // Twice through the same memory: the first pass fills it, the second only reuses it.
    for (let pass = 0; pass < 2; pass++)
      for (const [scope, row] of cases) {
        const alone = await resolvePolicySnapshotRowsV1(scope, [row]);
        const together = await resolvePolicySnapshotRowsV1(scope, [row], memo);
        expect(together).toEqual(alone);
        // The snapshot is exactly what the complete contract accepts, scope and version included.
        expect(effectiveSettingsV1.parse(together.settings)).toEqual(together.settings);
      }
    const first = await resolvePolicySnapshotRowsV1(accountScope(1), [cases[0]![1]], memo);
    expect(first.settings.scope).toEqual(accountScope(1));
    expect(first.settings.version).toBe(7);
    expect(first.settings.sources.showPartials).toEqual({
      kind: 'class',
      academicYear: 2026,
      classId: 7,
    });
    const ruled = await resolvePolicySnapshotRowsV1(accountScope(3), [cases[2]![1]], memo);
    expect(ruled.settings.value.accessEnabled).toBe(false);
    expect(ruled.settings.sources.accessEnabled).toEqual(accountScope(3));
    expect(ruled.policyVersion).not.toBe(first.policyVersion);
  });

  it('shares only what cannot depend on the account and never an account rule', async () => {
    const classmates = [...schoolRows(), classRule];
    const memo = createPolicyResolutionMemoV1();
    for (const n of [1, 2, 3])
      await resolvePolicySnapshotRowsV1(
        accountScope(n),
        [target(classmates, { account_version: n })],
        memo,
      );
    expect(memo.size).toBe(1);
    await resolvePolicySnapshotRowsV1(
      accountScope(4),
      [target([...classmates, accountRule(4)])],
      memo,
    );
    expect(memo.size).toBe(1);
    // Rows of another account never resolve as this account's own rule, with or without memory.
    const foreign = target([...classmates, accountRule(4)]);
    const alone = await resolvePolicySnapshotRowsV1(accountScope(5), [foreign]);
    expect(alone.settings.value.accessEnabled).toBe(true);
    expect(await resolvePolicySnapshotRowsV1(accountScope(5), [foreign], memo)).toEqual(alone);
    await resolvePolicySnapshotRowsV1(accountScope(6), [target(classmates, { class_id: 8 })], memo);
    expect(memo.size).toBe(2);
  });

  it('hands each target its own objects', async () => {
    const rows = [...schoolRows(), classRule];
    const memo = createPolicyResolutionMemoV1();
    const expected = await resolvePolicySnapshotRowsV1(accountScope(2), [target(rows)]);
    const first = await resolvePolicySnapshotRowsV1(accountScope(1), [target(rows)], memo);
    first.settings.value.accessEnabled = false;
    first.settings.value.calendar.yearEndsAt = '2030-01-01T00:00:00Z';
    first.settings.sources.showPartials = SCHOOL;
    first.enforcedValue.calendar.accessEndsAt = '2030-01-01T00:00:00Z';
    expect(await resolvePolicySnapshotRowsV1(accountScope(2), [target(rows)], memo)).toEqual(
      expected,
    );
  });

  it('keeps refusing invalid or unresolved input and remembers nothing from it', async () => {
    const memo = createPolicyResolutionMemoV1();
    const incomplete = schoolRows().filter((row) => row.field_key !== 'risk');
    await expect(
      resolvePolicySnapshotRowsV1(accountScope(1), [target(incomplete)], memo),
    ).rejects.toThrow('student-portal-policy-defaults-unavailable');
    await expect(
      resolvePolicySnapshotRowsV1(
        accountScope(1),
        [{ ...target(schoolRows()), resolved: false }],
        memo,
      ),
    ).rejects.toThrow('student-portal-policy-target-unresolved');
    expect(memo.size).toBe(0);
    await resolvePolicySnapshotRowsV1(accountScope(1), [target(schoolRows())], memo);
    await expect(
      resolvePolicySnapshotRowsV1(
        accountScope(2),
        [target(schoolRows(), { account_version: -1 })],
        memo,
      ),
    ).rejects.toThrow();
    await expect(
      resolvePolicySnapshotRowsV1(
        accountScope(2),
        [target(schoolRows(), { shift: 'INTEGRAL' })],
        memo,
      ),
    ).rejects.toThrow();
  });
});
