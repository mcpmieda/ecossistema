import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dispatchPortalLiveEventsV1 } from '../../../server/student-portal/live/live-outbox-v1';
import { portalScheduledV1 } from '../../../server/student-portal/composition/scheduled-v1';
import { allowPortalLiveDrainV1 } from '../../../server/student-portal/composition/live-drain-v1';
import type { PortalCompositionEnvV1 } from '../../../server/student-portal/composition/config-v1';

const mocks = vi.hoisted(() => ({ database: vi.fn(), publish: vi.fn() }));
vi.mock('../../../server/student-portal/composition/database-v1', () => ({ portalDatabaseV1: mocks.database }));
vi.mock('../../../server/student-portal/live/live-connect-v1', () => ({ portalLiveStubV1: () => ({ publish: mocks.publish }) }));
const env = { PORTAL_ENVIRONMENT: 'production', PORTAL_SERVING_ENABLED: 'true',
  PORTAL_ADMIN_TENANT_ID: '11111111-1111-4111-8111-111111111111', PORTAL_LIVE: {},
} as unknown as PortalCompositionEnvV1;
const context = () => ({ actorId: crypto.randomUUID(), requestId: crypto.randomUUID(),
  tenantId: env.PORTAL_ADMIN_TENANT_ID, capability: 'gradebook.persistence.admin', authenticatedAt: new Date().toISOString() });
const event = (id: number, security = false) => ({ id: String(id), audience: 'student', domain: 'portal',
  version: 'revision:1', account_id: null, class_id: null, student_ids: [], security_relevant: security,
  occurred_at: new Date().toISOString() });
let pending: ReturnType<typeof event>[];
let statements: { query: string; values: unknown[] }[];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  pending = []; statements = [];
  mocks.publish.mockReset().mockResolvedValue('delivered');
  const sql = {
    begin: async (run: (tx: unknown) => unknown): Promise<unknown> => run(sql),
    unsafe: async (query: string, values: unknown[] = []) => {
      statements.push({ query, values });
      if (query.includes('WITH pending AS')) return pending.splice(0, Number(values[0]));
      if (query.includes('RETURNING id::text')) return JSON.parse(String(values[1])).map((id: string) => ({ id }));
      return [];
    },
  };
  mocks.database.mockReset().mockImplementation(async (_env, _operation, run) => run(sql));
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('delivers security events first and continues full batches up to a fixed bound', async () => {
  pending = Array.from({ length: 9 }, (_, i) => event(i + 1, i === 1));
  expect(await dispatchPortalLiveEventsV1(env, 2)).toBe(8);
  expect(mocks.publish.mock.calls.slice(0, 2).map(([value]) => value.cursor)).toEqual([
    '00000000000000000002', '00000000000000000001',
  ]);
  expect(pending).toHaveLength(1);
  expect(statements.filter(({ query }) => query.includes('WITH pending AS'))).toHaveLength(4);
});

it('times out a stalled publication, backs off the attempted row, and releases unattempted claims', async () => {
  pending = [event(1), event(2)];
  mocks.publish.mockImplementation(() => new Promise(() => undefined));
  const result = dispatchPortalLiveEventsV1(env);
  const rejected = expect(result).rejects.toThrow('student-portal-live-delivery-unavailable');
  await vi.advanceTimersByTimeAsync(20_000);
  await rejected;
  expect(mocks.publish).toHaveBeenCalledTimes(1);
  expect(statements.find(({ query }) => query.includes('next_attempt_at=statement_timestamp()+'))?.values[1]).toBe('["1"]');
  expect(statements.find(({ query }) => query.includes('attempts=GREATEST'))?.values[1]).toBe('["2"]');
  expect(statements.filter(({ query }) => query.includes('WITH pending AS'))).toHaveLength(1);
});

it('does not publish a claim whose database wait already consumed the budget', async () => {
  pending = [event(1)];
  const original = mocks.database.getMockImplementation()!;
  mocks.database.mockImplementationOnce(async (...args) => {
    const value = await original(...args); vi.setSystemTime(Date.now() + 21_000); return value;
  });
  expect(await dispatchPortalLiveEventsV1(env)).toBe(0);
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(statements.some(({ query }) => query.includes('attempts=GREATEST'))).toBe(true);
});

it('scheduled retention deletes only old delivered events even with no socket binding or new event', async () => {
  await portalScheduledV1({ ...env, PORTAL_LIVE: undefined });
  const cleanup = statements.filter(({ query }) => query.includes('DELETE FROM student_portal.live_event_outbox_v1'));
  expect(cleanup).toHaveLength(1);
  expect(cleanup[0]?.query).toContain("delivered_at<statement_timestamp()-interval '7 days'");
  expect(cleanup[0]?.query).toContain('LIMIT 100 FOR UPDATE SKIP LOCKED');
  expect(mocks.publish).not.toHaveBeenCalled();
});

it('does not suppress privacy retention when the independent outbox cleanup fails', async () => {
  const unsafe = vi.fn(async (query: string) => {
    if (query.includes('live_event_outbox_v1')) throw new Error('synthetic-missing-outbox');
    return [];
  });
  const sql = { unsafe, begin: async (run: (tx: { unsafe: typeof unsafe }) => unknown) => run({ unsafe }) };
  let recordedFailure: unknown;
  mocks.database.mockImplementation(async (_env, _operation, run) => {
    try { return await run(sql); } catch (error) { recordedFailure = error; throw error; }
  });
  await portalScheduledV1(env);
  expect(unsafe.mock.calls.some(([query]) => query.includes('DELETE FROM student_portal.operation_receipt'))).toBe(true);
  expect(recordedFailure).toMatchObject({ message: 'student-portal-cleanup-unavailable' });
});

it('prunes unreachable publication editions even when an earlier cleanup fails', async () => {
  vi.setSystemTime(new Date('2026-10-02T03:00:00Z'));
  const unsafe = vi.fn(async (query: string) => {
    if (query.includes('live_event_outbox_v1')) throw new Error('synthetic-missing-outbox');
    return [];
  });
  const sql = { unsafe, begin: async (run: (tx: { unsafe: typeof unsafe }) => unknown) => run({ unsafe }) };
  mocks.database.mockImplementation(async (_env, _operation, run) => run(sql));
  await portalScheduledV1(env).catch(() => undefined);
  expect(unsafe.mock.calls.some(([query]) => query === 'SELECT student_portal.prune_publication_source_v1()')).toBe(true);
});

it('prunes publication editions only at midnight in Brasília', async () => {
  const unsafe = vi.fn(async (_query: string) => []);
  const sql = { unsafe, begin: async (run: (tx: { unsafe: typeof unsafe }) => unknown) => run({ unsafe }) };
  mocks.database.mockImplementation(async (_env, _operation, run) => run(sql));
  const pruned = () => unsafe.mock.calls.filter(([query]) => query === 'SELECT student_portal.prune_publication_source_v1()').length;
  for (const instant of ['2026-10-01T12:00:00Z', '2026-10-02T00:00:00Z', '2026-10-02T03:01:00Z']) {
    vi.setSystemTime(new Date(instant));
    await portalScheduledV1(env);
  }
  expect(pruned()).toBe(0);
  vi.setSystemTime(new Date('2026-10-02T03:00:00Z'));
  await portalScheduledV1(env);
  expect(pruned()).toBe(1);
});

it('the private drain accepts only a fresh same-tenant BN capability in a serving production deployment', () => {
  expect(allowPortalLiveDrainV1(env, context())).toBe(true);
  for (const input of [{}, { ...context(), capability: 'platform.settings.write' },
    { ...context(), tenantId: crypto.randomUUID() },
    { ...context(), authenticatedAt: new Date(Date.now() - 300_001).toISOString() },
    { ...context(), authenticatedAt: new Date(Date.now() + 1).toISOString() }]) {
    expect(allowPortalLiveDrainV1(env, input)).toBe(false);
  }
  expect(allowPortalLiveDrainV1({ ...env, PORTAL_ENVIRONMENT: 'preview' }, context())).toBe(false);
  expect(allowPortalLiveDrainV1({ ...env, PORTAL_SERVING_ENABLED: 'false' }, context())).toBe(false);
});
