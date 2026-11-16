// @vitest-environment node
import { expect, it } from 'vitest';
import {
  emitPortalOperationBurstMetricV1,
  portalOperationBurstMetricV1,
  emitPortalAuthBurstMetricV1,
  emitPortalAuthResultMetricV1,
  emitPortalDbLifecycleMetricV1,
  emitPortalEdgeResultMetricV1,
  emitPortalLiveCloseMetricV1,
  emitPortalMetricV1,
  measurePortalSqlV1,
  portalAuthBurstMetricV1,
  portalAuthResultMetricV1,
  portalDbLifecycleMetricV1,
  portalEdgeResultMetricV1,
  portalLiveCloseMetricV1,
  portalMetricV1,
} from '../../../server/student-portal/observability/metrics-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';

it('exports only numeric aggregates and never serializes driver data or parameters', async () => {
  const sql: StudentPortalPostgresSqlV1 = { unsafe: async () => { throw { code: '55P03', message: 'SYNTHETIC_SECRET', query: 'SYNTHETIC_SQL' }; }, begin: (op) => op(sql) };
  const measured = measurePortalSqlV1(sql);
  await expect(measured.sql.begin((tx) => Promise.resolve(tx.unsafe('SYNTHETIC_SQL', ['SYNTHETIC_VALUE'])))).rejects.toMatchObject({ code: '55P03' });
  const metric = measured.snapshot('admin-command', 'unavailable');
  expect(metric).toMatchObject({ queries: 1, rows: 0, lockTimeouts: 1, statementTimeouts: 0 });
  expect(JSON.stringify(metric)).not.toContain('SYNTHETIC');
  for (const extra of ['url', 'query', 'accountId', 'token', 'birthYear', 'ip', 'name']) {
    expect(portalMetricV1.safeParse({ ...metric, [extra]: 'SYNTHETIC_SECRET' }).success).toBe(false);
  }
  expect(() => emitPortalMetricV1(metric, () => { throw new Error('sink-unavailable'); })).not.toThrow();
  const emitted: unknown[] = [];
  emitPortalMetricV1(metric, (value) => emitted.push(value));
  expect(emitted).toEqual([metric]);
});


it('accepts only bounded auth-burst and DB lifecycle aggregates', () => {
  const burst = { event: 'student-portal-auth-burst-v1', outcome: 'global-limited' } as const;
  expect(portalAuthBurstMetricV1.parse(burst)).toEqual(burst);
  expect(
    portalAuthBurstMetricV1.safeParse({ ...burst, subject: 'SYNTHETIC_SECRET' }).success,
  ).toBe(false);

  const lifecycle = {
    event: 'student-portal-db-lifecycle-v1',
    operation: 'auth',
    outcome: 'ok',
    openRoleMs: 12,
    applicationMs: 34,
    attempts: 1,
  } as const;
  expect(portalDbLifecycleMetricV1.parse(lifecycle)).toEqual(lifecycle);
  expect(
    portalDbLifecycleMetricV1.safeParse({ ...lifecycle, role: 'student_portal_app' }).success,
  ).toBe(false);

  const emitted: unknown[] = [];
  emitPortalAuthBurstMetricV1(burst, (value) => emitted.push(value));
  emitPortalDbLifecycleMetricV1(lifecycle, (value) => emitted.push(value));
  expect(emitted).toEqual([burst, lifecycle]);
});

it('accepts only the fixed live close classification (#1207)', () => {
  const metric = {
    event: 'student-portal-live-close-v1',
    callback: 'close',
    codeClass: 'no-status',
    readyState: 2,
  } as const;
  expect(portalLiveCloseMetricV1.parse(metric)).toEqual(metric);
  expect(portalLiveCloseMetricV1.parse({ ...metric, readyState: 'unknown' })).toMatchObject({ readyState: 'unknown' });
  for (const extra of ['reason', 'code', 'accountId', 'studentId', 'url', 'message', 'stack']) {
    expect(portalLiveCloseMetricV1.safeParse({ ...metric, [extra]: 'SYNTHETIC_SECRET' }).success).toBe(false);
  }
  for (const invalid of [
    { ...metric, codeClass: 'SYNTHETIC_SECRET' },
    { ...metric, callback: 'message' },
    { ...metric, readyState: 4 },
    { ...metric, readyState: 1.5 },
  ]) expect(portalLiveCloseMetricV1.safeParse(invalid).success).toBe(false);
  expect(() => emitPortalLiveCloseMetricV1(metric, () => { throw new Error('sink-unavailable'); })).not.toThrow();
  const emitted: unknown[] = [];
  emitPortalLiveCloseMetricV1({ ...metric, reason: 'SYNTHETIC_SECRET' } as never, (value) => emitted.push(value));
  emitPortalLiveCloseMetricV1(metric, (value) => emitted.push(value));
  expect(emitted).toEqual([metric]);
});

it('accepts only the fixed edge result classification (#1207)', () => {
  const metric = { event: 'student-portal-edge-result-v1', family: 'asset', result: 'asset-miss', status: 404 } as const;
  expect(portalEdgeResultMetricV1.parse(metric)).toEqual(metric);
  for (const extra of ['path', 'url', 'query', 'userAgent', 'ip', 'accountId']) {
    expect(portalEdgeResultMetricV1.safeParse({ ...metric, [extra]: '/assets/SYNTHETIC_SECRET' }).success).toBe(false);
  }
  for (const invalid of [
    { ...metric, family: '/assets/x.js' },
    { ...metric, result: 'asset-stale' },
    { ...metric, status: 99 },
    { ...metric, status: 600 },
  ]) expect(portalEdgeResultMetricV1.safeParse(invalid).success).toBe(false);
  expect(() => emitPortalEdgeResultMetricV1(metric, () => { throw new Error('sink-unavailable'); })).not.toThrow();
});

it('accepts only a terminal auth result without reasons; next only with required (#1207)', () => {
  const base = { event: 'student-portal-auth-result-v1', step: 'login' } as const;
  expect(portalAuthResultMetricV1.parse({ ...base, outcome: 'denied' })).toEqual({ ...base, outcome: 'denied' });
  expect(portalAuthResultMetricV1.parse({ ...base, outcome: 'required', next: 'risk' })).toMatchObject({ next: 'risk' });
  for (const invalid of [
    { ...base, outcome: 'required' },
    { ...base, outcome: 'denied', next: 'pin' },
    { ...base, outcome: 'denied', reason: 'retry-needed' },
    { ...base, outcome: 'denied', auditReason: 'retry-needed' },
    { ...base, outcome: 'issued', accountId: 'SYNTHETIC_SECRET' },
    { ...base, outcome: 'issued', device: { platform: 'ios' } },
    { ...base, step: 'session', outcome: 'issued' },
    { ...base, outcome: 'SYNTHETIC_SECRET' },
  ]) expect(portalAuthResultMetricV1.safeParse(invalid).success).toBe(false);
  expect(() => emitPortalAuthResultMetricV1({ ...base, outcome: 'issued' }, () => { throw new Error('sink'); })).not.toThrow();
});


it('limits operation metrics to fixed family/result/duration and ignores failing sinks', () => {
  const metric = { event: 'student-portal-operation-burst-v1', operation: 'photo', outcome: 'limited', elapsedMs: 2 };
  expect(portalOperationBurstMetricV1.safeParse(metric).success).toBe(true);
  for (const field of ['accountId', 'key', 'ip', 'sql', 'token', 'cookie', 'payload'])
    expect(portalOperationBurstMetricV1.safeParse({ ...metric, [field]: 'SYNTHETIC' }).success).toBe(false);
  expect(portalOperationBurstMetricV1.safeParse({ ...metric, operation: 'unbounded-input' }).success).toBe(false);
  expect(() => emitPortalOperationBurstMetricV1(metric, () => { throw new Error('sink'); })).not.toThrow();
});
