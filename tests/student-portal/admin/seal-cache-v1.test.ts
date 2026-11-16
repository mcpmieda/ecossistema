// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  readSealCacheV1,
  saveSealCacheV1,
  sealCacheFingerprintV1,
  sealCacheTemporalV1,
  type SealCacheWriteV1,
} from '../../../server/student-portal/admin/seal-cache-v1';
import { initialPolicyDefaultsV1 } from '../../../server/student-portal/policies/defaults-v1';
import { SYNTHETIC_SELF_V1 } from '../../../shared/student-portal-contracts/fixtures-v1';

const accountId = '75600000-0000-4000-8000-000000009901';
const global = {
  academicGeneration: '8'.repeat(32),
  academicCounter: '1',
  linkGeneration: '9'.repeat(32),
  linkCounter: '1',
  sourceGeneration: '8'.repeat(32),
  sourceRevision: '1',
  controlVersion: '1',
  enabled: true as const,
  policyEpoch: '1',
};
function context() {
  const defaults = initialPolicyDefaultsV1();
  return {
    account: {
      id: accountId,
      version: 1,
      link: { academicYear: 2026, studentId: 9901 },
      state: 'active',
      eligibility: 'eligible',
      blocked: false,
      closedAt: null,
    },
    eligibility: {
      dataVersion: `${'8'.repeat(32)}:1`,
      current: { academicYear: 2026, studentId: 9901, classId: 3, status: null },
    },
    profile: {
      ...SYNTHETIC_SELF_V1.profile,
      accountId,
      academicState: 'regular',
      result: 'in-progress',
    },
    policy: {
      classId: 3,
      policyVersion: 'policy:synthetic',
      enforcedValue: {
        ...defaults,
        accessEnabled: true,
        showPartials: true,
        allowedPeriods: ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'],
        calendar: {
          ...defaults.calendar,
          yearStartsAt: '2026-01-01T00:00:00Z',
          t1EndsAt: '2026-04-01T00:00:00Z',
          t2StartsAt: '2026-04-02T00:00:00Z',
          t2EndsAt: '2026-07-01T00:00:00Z',
          t3StartsAt: '2026-07-02T00:00:00Z',
          t3EndsAt: '2026-11-01T00:00:00Z',
          recoveriesStartAt: '2026-11-02T00:00:00Z',
          disclosure: {
            mode: 'single',
            at: null,
            periods: ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'],
          },
        },
      },
    },
    now: new Date('2026-03-31T23:59:59Z'),
  } as Parameters<typeof sealCacheFingerprintV1>[1];
}
function database(
  saved: Record<string, unknown>[] = [],
  revisions: unknown = global,
  cacheTable: string | null = 'student_portal.seal_count_cache_v1',
) {
  const unsafe = vi.fn(async (sql: string) =>
    sql.includes('to_regclass') ? [{ cache_table: cacheTable, revisions }] : saved,
  );
  return { unsafe };
}
const row = (value: ReturnType<typeof context>, seals: number | null) => {
  const plan = sealCacheFingerprintV1(global, value);
  return {
    account_id: accountId,
    ...plan,
    seals,
    computed_at: '2026-03-31 23:59:58+00',
    expires_at: plan.expiresAt,
  };
};

describe('versioned private seal cache', () => {
  it.each([0, null, 9])(
    'accepts %s independently from an absent row and normalizes production PG timestamps',
    async (seals) => {
      const current = context();
      const tx = database([row(current, seals)]);
      const result = await readSealCacheV1(tx as never, [current]);
      expect(result.get(accountId)?.hit).toEqual({ seals });
      expect(tx.unsafe).toHaveBeenCalledTimes(2);
      expect(tx.unsafe.mock.calls.every(([sql]) => !sql.includes('payload_json'))).toBe(true);
    },
  );

  it('invalidates data, source, publication, policy and account changes without decoding marks', async () => {
    const current = context();
    const saved = row(current, 9);
    for (const key of [
      'academicCounter',
      'sourceRevision',
      'controlVersion',
      'policyEpoch',
    ] as const) {
      const result = await readSealCacheV1(database([saved], { ...global, [key]: '2' }) as never, [
        current,
      ]);
      expect(result.get(accountId)?.hit).toBeNull();
    }
    const changedAccount = { ...current, account: { ...current.account, version: 2 } };
    expect(
      (await readSealCacheV1(database([saved]) as never, [changedAccount])).get(accountId)?.hit,
    ).toBeNull();
  });

  it('expires at exact trimester, access, and recovery disclosure boundaries', async () => {
    const current = context();
    expect(sealCacheTemporalV1(current).expiresAt).toBe('2026-04-01T00:00:00.000Z');
    const atEnd = { ...current, now: new Date('2026-04-01T00:00:00Z') };
    expect(
      (await readSealCacheV1(database([row(current, 9)]) as never, [atEnd])).get(accountId)?.hit,
    ).toBeNull();
    const value = context();
    value.policy.enforcedValue.accessSchedule = [{ at: '2026-04-01T00:00:00Z', action: 'close' }];
    value.policy.enforcedValue.calendar.disclosure = {
      mode: 'agenda',
      periods: Object.fromEntries(
        ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'].map((period) => [
          period,
          {
            enabled: true,
            schedule: period === 'REC1' ? [{ at: '2026-03-31T23:59:59Z', action: 'close' }] : [],
          },
        ]),
      ),
    } as never;
    const before = { ...value, now: new Date('2026-03-31T23:59:58Z') };
    expect(sealCacheFingerprintV1(global, before).fingerprint).not.toBe(
      sealCacheFingerprintV1(global, value).fingerprint,
    );
    expect(sealCacheFingerprintV1(global, value).fingerprint).not.toBe(
      sealCacheFingerprintV1(global, { ...value, now: atEnd.now }).fingerprint,
    );
  });

  it('bypasses absent tables and legacy controls; corrupt/future cache rows are misses', async () => {
    const current = context();
    for (const tx of [database([], global, null), database([], { ...global, enabled: false })]) {
      expect(await readSealCacheV1(tx as never, [current])).toEqual(new Map());
      expect(tx.unsafe).toHaveBeenCalledTimes(1);
    }
    for (const changed of [
      { seals: -1 },
      { computed_at: '2030-01-01 00:00:00+00' },
      { computed_at: 'invalid' },
    ])
      expect(
        (
          await readSealCacheV1(database([{ ...row(current, 9), ...changed }]) as never, [current])
        ).get(accountId)?.hit,
      ).toBeNull();
  });

  it('deduplicates writes, fences concurrent stale results, skips identical values, and absorbs persistence errors', async () => {
    const sql = { unsafe: vi.fn(async () => []), begin: vi.fn() };
    const write: SealCacheWriteV1 = {
      accountId,
      fingerprint: 'a'.repeat(64),
      seals: null,
      computedAt: '2026-03-31T23:59:58Z',
      expiresAt: null,
    };
    await saveSealCacheV1(sql, [write, { ...write, seals: 0, computedAt: '2026-03-31T23:59:59Z' }]);
    const [text, values] = sql.unsafe.mock.calls[0] as unknown as [string, string[]];
    expect(text).toContain('computed_at<=EXCLUDED.computed_at');
    expect(text).toContain('IS DISTINCT FROM');
    expect(JSON.parse(values[0]!)).toHaveLength(1);
    expect(JSON.parse(values[0]!)[0].seals).toBe(0);
    sql.unsafe.mockRejectedValueOnce(new Error('synthetic-cache-unavailable'));
    await expect(saveSealCacheV1(sql, [write])).resolves.toBeUndefined();
  });
});
