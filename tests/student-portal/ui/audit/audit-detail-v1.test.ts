// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuditDetailV1,
  type AuditDetailStateV1,
} from '../../../../src/features/student-portal-admin/audit/audit-detail-v1';
import {
  operationsMockV1,
  opIdV1,
  opJsonV1,
  OP_META_V1,
  OP_ACCOUNT_V1,
} from '../overview/fixtures-v1';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('audit detail permission, clock and retention', () => {
  it('uses the event response clock without requesting account data', async () => {
    const server = Date.parse('2026-10-01T15:00:00Z');
    const source = operationsMockV1({ now: () => server });
    const mock = operationsMockV1({
      query: (query) =>
        query.operation === 'audit-detail'
          ? source.client
              .query(query)
              .then((response) =>
                opJsonV1({ ...response, observedAt: new Date(server).toISOString() }),
              )
          : undefined,
    });
    const states: AuditDetailStateV1[] = [];
    const reader = createAuditDetailV1(
      mock.props,
      (state) => states.push(state),
      () => 0,
    );
    await reader.open(OP_ACCOUNT_V1, opIdV1(300));
    expect(states.at(-1)).toMatchObject({ state: 'ready', detail: { ip: '192.0.2.42' } });
    expect(mock.queries.map((query) => query.operation)).toEqual(['audit-detail']);
    reader.clear();
  });
  it('caps a returned raw IP at 90 days and rejects metadata at 12 months', async () => {
    const server = Date.parse('2027-02-28T12:00:00Z');
    const source = operationsMockV1({ now: () => server });
    let occurred = server - 90 * 86400_000;
    const mock = operationsMockV1({
      now: () => server,
      query: (query) =>
        query.operation === 'audit-detail'
          ? source.client.query(query).then((response) => {
              if (response.state !== 'audit-detail')
                throw new Error('Synthetic detail unavailable');
              return opJsonV1({
                ...response,
                event: { ...response.event, at: new Date(occurred).toISOString() },
                ipExpiresAt: new Date(server + 86400_000).toISOString(),
              });
            })
          : undefined,
    });
    const states: AuditDetailStateV1[] = [];
    const reader = createAuditDetailV1(
      mock.props,
      (state) => states.push(state),
      () => 0,
    );
    await reader.open(OP_ACCOUNT_V1, opIdV1(300));
    expect(states.at(-1)).toMatchObject({ state: 'ready', detail: { ip: null } });
    occurred = Date.parse('2026-02-28T12:00:00Z');
    await reader.open(OP_ACCOUNT_V1, opIdV1(300));
    expect(states.at(-1)).toEqual({ state: 'expired' });
    reader.clear();
  });
  it('preserves Retry-After when a detail is closed and opened again', async () => {
    vi.useFakeTimers();
    const mock = operationsMockV1({
      query: (query) =>
        query.operation === 'audit-detail'
          ? Promise.resolve(
              opJsonV1({ ...OP_META_V1, state: 'rate-limited' }, 429, { 'Retry-After': '30' }),
            )
          : undefined,
    });
    const states: AuditDetailStateV1[] = [],
      reader = createAuditDetailV1(mock.props, (state) => states.push(state));
    await reader.open(OP_ACCOUNT_V1, opIdV1(300));
    const count = mock.queries.length;
    reader.clear();
    await reader.open(OP_ACCOUNT_V1, opIdV1(301));
    expect(mock.queries).toHaveLength(count);
    expect(states.at(-1)).toMatchObject({ state: 'error' });
    await vi.advanceTimersByTimeAsync(30_000);
    await reader.open(OP_ACCOUNT_V1, opIdV1(301));
    expect(mock.queries.length).toBeGreaterThan(count);
    reader.clear();
  });
  it('removes IP at the exact server deadline even with an unrelated workstation clock', async () => {
    vi.useFakeTimers();
    const server = Date.parse('2026-09-13T12:00:00Z');
    const mock = operationsMockV1({ now: () => server, ipExpiry: 1000 });
    const states: AuditDetailStateV1[] = [];
    const detail = createAuditDetailV1(
      mock.props,
      (s) => states.push(s),
      () => 0,
    );
    await detail.open(OP_ACCOUNT_V1, opIdV1(300));
    expect(states.at(-1)).toMatchObject({ state: 'ready', detail: { ip: '192.0.2.42' } });
    await vi.advanceTimersByTimeAsync(999);
    expect(states.at(-1)).toMatchObject({ detail: { ip: '192.0.2.42' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(states.at(-1)).toMatchObject({
      state: 'ready',
      detail: { ip: null, ipExpiresAt: null },
    });
    await vi.advanceTimersByTimeAsync(299_000);
    expect(states.at(-1)).toEqual({ state: 'expired' });
  });
  it('fails closed without the server clock and never requests raw detail with read-only permission', async () => {
    const mock = operationsMockV1({
      query: (q) =>
        q.operation === 'accounts-read'
          ? Promise.resolve(opJsonV1({ ...OP_META_V1, state: 'unavailable' }, 503))
          : undefined,
    });
    const states: AuditDetailStateV1[] = [];
    const detail = createAuditDetailV1(mock.props, (s) => states.push(s));
    await detail.open(OP_ACCOUNT_V1, opIdV1(300));
    expect(states.at(-1)?.state).toBe('error');
    expect(JSON.stringify(states)).not.toContain('192.0.2.42');
    const count = mock.queries.length;
    await createAuditDetailV1({ ...mock.props, canWrite: false }, () => {}).open(
      OP_ACCOUNT_V1,
      opIdV1(300),
    );
    expect(mock.queries).toHaveLength(count);
  });
  it('subtracts request elapsed time, rejects expiry at the boundary and clears late details', async () => {
    const mock = operationsMockV1({ ipExpiry: 1000 });
    let tick = 0;
    const states: AuditDetailStateV1[] = [];
    const detail = createAuditDetailV1(
      mock.props,
      (s) => states.push(s),
      () => {
        tick += 1500;
        return tick;
      },
    );
    await detail.open(OP_ACCOUNT_V1, opIdV1(300));
    expect(states.at(-1)).toMatchObject({ state: 'ready', detail: { ip: null } });
    detail.clear();
    expect(states.at(-1)).toEqual({ state: 'idle' });
    let resolve: ((value: Response) => void) | undefined;
    const slow = operationsMockV1({
      query: (q) =>
        q.operation === 'audit-detail'
          ? new Promise((r) => {
              resolve = r;
            })
          : undefined,
    });
    const late = createAuditDetailV1(slow.props, (s) => states.push(s));
    const pending = late.open(OP_ACCOUNT_V1, opIdV1(300));
    late.clear();
    resolve!(opJsonV1({ ...OP_META_V1, state: 'forbidden' }, 403));
    await pending;
    expect(states.at(-1)).toEqual({ state: 'idle' });
  });
});
