// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { capacitySampleFreshV1, emptyPortalCapacityV1, isPortalCapacitySampleV1, type PortalCapacitySampleV1 } from '../../shared/portal-capacity-v1';
import { createCapacityCacheV1 } from '../../server/student-portal/composition/capacity-v1';
import { readPortalCapacityV1 } from '../../server/student-portal/observability/capacity-v1';
import type { StudentPortalPostgresSqlV1 } from '../../server/student-portal/persistence/postgres-persistence-v1';
const instant = Date.parse('2026-09-22T02:00:00.000Z');
const fixture = (now = instant): PortalCapacitySampleV1 => ({ version: 1, source: 'postgresql', state: 'ok', observedAt: new Date(now).toISOString(),
  metrics: { databaseBytes: 123_450_000, portalConnections: 3, portalActive: 1, portalWaiting: 0,
    portalConnectionLimit: 10, serverMaxConnections: 60, serverReservedConnections: 3 } });
describe('capacity contract', () => {
  it('accepts bounded native observations without estimating a plan quota or online students', () => {
    expect(isPortalCapacitySampleV1(fixture())).toBe(true);
    for (const state of ['unconfigured', 'unavailable'] as const) {
      const sample = emptyPortalCapacityV1(state, instant);
      expect(isPortalCapacitySampleV1(sample)).toBe(true); expect(sample.metrics).toBeNull();
      expect(isPortalCapacitySampleV1({ ...sample, metrics: fixture().metrics })).toBe(false);
    }
  });
  it.each(['name', 'email', 'ip', 'query', 'connectionString', 'host', 'token', 'database', 'planQuota', 'onlineStudents'])('rejects extra %s fields at both boundaries', (key) => {
    const sample = fixture();
    expect(isPortalCapacitySampleV1({ ...sample, [key]: 'SYNTHETIC-PRIVATE' })).toBe(false);
    expect(isPortalCapacitySampleV1({ ...sample, metrics: { ...sample.metrics, [key]: 'SYNTHETIC-PRIVATE' } })).toBe(false);
  });
  it('rejects unsafe and inconsistent numbers, but permits observations above a lowered configured limit', () => {
    const sample = fixture();
    for (const patch of [{ databaseBytes: Number.MAX_SAFE_INTEGER + 1 }, { databaseBytes: '123' }, { portalConnections: -1 },
      { portalWaiting: 4 }, { portalActive: 4 }, { serverReservedConnections: 60 }, { serverMaxConnections: 0 }, { portalConnectionLimit: -1 }])
      expect(isPortalCapacitySampleV1({ ...sample, metrics: { ...sample.metrics, ...patch } })).toBe(false);
    for (const portalConnectionLimit of [null, 0, 2])
      expect(isPortalCapacitySampleV1({ ...sample, metrics: { ...sample.metrics, portalConnectionLimit } })).toBe(true);
    expect(isPortalCapacitySampleV1({ ...sample, state: 'ok', metrics: null })).toBe(false);
  });
  it('expires observations and rejects clocks from the future without extrapolation', () => {
    expect(capacitySampleFreshV1(fixture(), instant + 120_000)).toBe(true);
    expect(capacitySampleFreshV1(fixture(), instant + 120_001)).toBe(false);
    expect(capacitySampleFreshV1(fixture(), instant - 5001)).toBe(false);
    expect(capacitySampleFreshV1(fixture(), NaN)).toBe(false);
  });
});
describe('capacity cache', () => {
  it('coalesces parallel reads, preserves observation time and expires at sixty seconds', async () => {
    let now = instant; const cache = createCapacityCacheV1(() => now);
    const load = vi.fn(async () => fixture(now));
    const results = await Promise.all([cache(load), cache(load), cache(load)]);
    expect(load).toHaveBeenCalledTimes(1); expect(results[0]).toEqual(results[2]);
    now += 59_999; expect((await cache(load)).observedAt).toBe(new Date(instant).toISOString());
    expect(load).toHaveBeenCalledTimes(1);
    now += 2; await cache(load); expect(load).toHaveBeenCalledTimes(2);
    now -= 70_000; await cache(load); expect(load).toHaveBeenCalledTimes(3);
  });
  it('does not retain unavailable, rejected, stale or malformed observations', async () => {
    const cache = createCapacityCacheV1(() => instant);
    await expect(cache(async () => { throw Error('SYNTHETIC-PRIVATE'); })).rejects.toThrow();
    const absent = vi.fn(async () => emptyPortalCapacityV1('unavailable', instant));
    await cache(absent); await cache(absent); expect(absent).toHaveBeenCalledTimes(2);
    const stale = vi.fn(async () => fixture(instant - 120_000));
    await cache(stale); await cache(stale); expect(stale).toHaveBeenCalledTimes(2);
    await expect(cache(async () => ({ ...fixture(), raw: 'private' }) as unknown as PortalCapacitySampleV1)).rejects.toThrow('capacity-invalid-sample');
    expect(await cache(async () => fixture())).toEqual(fixture());
  });
});
describe('capacity SQL', () => {
  const row = { observed_at: new Date(instant).toISOString(), database_bytes: '123450000', portal_connections: 3,
    portal_active: 1, portal_waiting: 0, portal_connection_limit: 10, server_max_connections: 60, server_reserved_connections: 3, activity_visible: true };
  function sql(input: unknown = row) {
    const unsafe = vi.fn(async (query: string) => query.startsWith('WITH connections') ? [input] : []);
    return { unsafe, client: { unsafe, begin: async (run: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => run({ unsafe }) } as unknown as StudentPortalPostgresSqlV1 };
  }
  it('uses one catalog read in a bounded read-only transaction and never serializes other columns', async () => {
    const { client, unsafe } = sql({ ...row, query: 'SYNTHETIC-PRIVATE' });
    const data = await readPortalCapacityV1(client);
    expect(data).toEqual(fixture()); expect(JSON.stringify(data)).not.toContain('SYNTHETIC-PRIVATE');
    expect(unsafe.mock.calls.map(([query]) => query).slice(0, 3)).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', "SET LOCAL statement_timeout = '1500ms'", "SET LOCAL lock_timeout = '250ms'",
    ]);
    expect(unsafe).toHaveBeenCalledTimes(4);
    const query = unsafe.mock.calls[3]![0];
    expect(query).toContain('pg_database_size(current_database())'); expect(query).toContain('usename=current_user');
    expect(query).toContain("backend_type='client backend'");
    expect(query).toContain("state IS NULL OR state='disabled'");
    expect(query).not.toMatch(/FROM\s+(?:gradebook|student_portal)\./iu);
    expect(query).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/u);
  });
  it.each([false, null, undefined])('refuses missing activity visibility %s rather than reporting zero activity', async (activity_visible) => {
    await expect(readPortalCapacityV1(sql({ ...row, activity_visible }).client)).rejects.toThrow('capacity-invalid-sample');
  });
  it.each(['', '-1', 'Infinity', '1e3', '9007199254740992', 'private'])('rejects malformed size %s instead of converting it to zero', async (database_bytes) => {
    await expect(readPortalCapacityV1(sql({ ...row, database_bytes }).client)).rejects.toThrow('capacity-invalid-sample');
  });
});
