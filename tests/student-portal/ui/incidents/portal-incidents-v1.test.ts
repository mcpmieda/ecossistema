// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { servePortalIncidentsV1 } from '../../../../server/student-portal/composition/incidents-v1';
import type { PortalCompositionEnvV1 } from '../../../../server/student-portal/composition/config-v1';

const mocks = vi.hoisted(() => ({
  unsafe:
    vi.fn<(query: string, values?: readonly unknown[]) => Promise<Record<string, unknown>[]>>(),
  showIncidents: true,
  // The SessionServiceV1 snapshot flag: a read is read-only, a confirmation is not.
  snapshots: [] as boolean[],
}));
const accountId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const versionId = '33333333-3333-4333-8333-333333333333';
vi.mock('../../../../server/student-portal/composition/config-v1', () => ({
  portalKeysV1: () => ({ cryptoPort: {} }),
}));
vi.mock('../../../../server/student-portal/composition/database-v1', () => ({
  portalDatabaseV1: async (
    _env: unknown,
    _operation: unknown,
    run: (sql: unknown) => Promise<unknown>,
  ) => run({}),
}));
vi.mock('../../../../server/student-portal/http/auth/handler-v1', () => ({
  sessionCookieTokenV1: () => 'a'.repeat(43),
}));
vi.mock(
  '../../../../server/student-portal/observability/operation-burst-v1',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../server/student-portal/observability/operation-burst-v1')
      >();
    return { ...actual, checkPortalOperationV1: async () => {} };
  },
);
vi.mock('../../../../server/student-portal/auth/session-service-v1', () => ({
  SessionServiceV1: class {
    constructor(_sql: unknown, _crypto: unknown, _ip: unknown, snapshot: boolean) {
      mocks.snapshots.push(snapshot);
    }
    async withAuthorized<T>(
      _token: string,
      operation: (
        context: { account: { id: string }; policy: { enforcedValue: { showIncidents: boolean } } },
        tx: { unsafe: typeof mocks.unsafe },
        session: { id: string; expiresAt: string; persistent: boolean },
      ) => Promise<T>,
    ) {
      return operation(
        { account: { id: accountId }, policy: { enforcedValue: { showIncidents: mocks.showIncidents } } },
        { unsafe: mocks.unsafe },
        { id: sessionId, expiresAt: '2026-10-29T13:00:00.000Z', persistent: false },
      );
    }
  },
}));
const env = {
  PORTAL_ENVIRONMENT: 'production',
  PORTAL_ORIGIN: 'https://aluno.escolaieda.com',
  PORTAL_ADMIN_TENANT_ID: accountId,
  PORTAL_SERVING_ENABLED: 'true',
} satisfies PortalCompositionEnvV1;
const read = (query = '') => new Request(env.PORTAL_ORIGIN + '/api/student/incidents' + query);
const acknowledge = (body: unknown = { id: versionId }, type = 'application/json') =>
  new Request(env.PORTAL_ORIGIN + '/api/student/incidents/acknowledge', {
    method: 'POST',
    headers: { 'Content-Type': type, Origin: env.PORTAL_ORIGIN },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const stored = (fields: Record<string, unknown> = {}) => ({
  id: versionId,
  kind: 'SUSPENSÃO',
  date: '2026-10-22',
  classLabel: '6º ANO A - MATUTINO',
  leaveFrom: '2026-10-22',
  leaveTo: '2026-10-28',
  leaveDays: 3,
  description: 'No dia 22/10/2026 o(a) aluno(a) recebeu 3 dias de suspensão.',
  acknowledgedAt: null,
  ...fields,
});
beforeEach(() => {
  mocks.unsafe.mockReset();
  mocks.showIncidents = true;
  mocks.snapshots = [];
});

it('refuses the read and the confirmation without touching the records when the Ocorrências policy is off', async () => {
  mocks.showIncidents = false;
  for (const request of [read(), acknowledge()]) {
    const response = await servePortalIncidentsV1(request, env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ contractVersion: 1, state: 'forbidden' });
  }
  expect(mocks.unsafe).not.toHaveBeenCalled();
});

it("returns the student's own records, read with its account and session only, in a read-only snapshot", async () => {
  mocks.unsafe
    .mockResolvedValueOnce([
      {
        incidents: {
          incidents: [
            stored(),
            stored({
              id: '44444444-4444-4444-8444-444444444444',
              kind: 'ADVERTÊNCIA',
              date: '2026-09-29',
              leaveFrom: null,
              leaveTo: null,
              leaveDays: null,
              acknowledgedAt: '2026-09-30T10:15:00+00:00',
            }),
          ],
        },
      },
    ])
    .mockResolvedValueOnce([{ active: true }]);
  const response = await servePortalIncidentsV1(read(), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(await response.json()).toEqual({
    contractVersion: 1,
    state: 'ready',
    incidents: [
      {
        id: versionId,
        kind: 'SUSPENSÃO',
        date: '2026-10-22',
        classLabel: '6º ANO A - MATUTINO',
        leave: { from: '2026-10-22', to: '2026-10-28', days: 3 },
        description: 'No dia 22/10/2026 o(a) aluno(a) recebeu 3 dias de suspensão.',
        acknowledgedAt: null,
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        kind: 'ADVERTÊNCIA',
        date: '2026-09-29',
        classLabel: '6º ANO A - MATUTINO',
        // No leave at all: null, never three blank parts.
        leave: null,
        description: 'No dia 22/10/2026 o(a) aluno(a) recebeu 3 dias de suspensão.',
        acknowledgedAt: '2026-09-30T10:15:00.000Z',
      },
    ],
  });
  expect(mocks.unsafe.mock.calls[0]?.[0]).toContain('attendance.read_portal_incidents_v1');
  expect(mocks.unsafe.mock.calls[0]?.[1]).toEqual([accountId, sessionId]);
  expect(mocks.snapshots).toEqual([true]);
});

it('keeps a leave part the Smecel left blank as null', async () => {
  mocks.unsafe
    .mockResolvedValueOnce([{ incidents: { incidents: [stored({ leaveFrom: null })] } }])
    .mockResolvedValueOnce([{ active: true }]);
  const body = (await (await servePortalIncidentsV1(read(), env)).json()) as {
    incidents: { leave: unknown }[];
  };
  expect(body.incidents[0]?.leave).toEqual({ from: null, to: '2026-10-28', days: 3 });
});

it('suppresses a list read past the session expiry, or one the database no longer accepts', async () => {
  mocks.unsafe
    .mockResolvedValueOnce([{ incidents: { incidents: [] } }])
    .mockResolvedValueOnce([{ active: false }]);
  expect((await servePortalIncidentsV1(read(), env)).status).toBe(401);
  mocks.unsafe.mockReset();
  mocks.unsafe.mockResolvedValueOnce([{ incidents: null }]);
  expect((await servePortalIncidentsV1(read(), env)).status).toBe(401);
});

it('rejects a query string, another method and anything outside the recognized records', async () => {
  // The request guard refuses any query on this path (no student can be asked for).
  expect((await servePortalIncidentsV1(read('?studentId=1'), env)).status).toBe(403);
  expect(
    (await servePortalIncidentsV1(new Request(env.PORTAL_ORIGIN + '/api/student/incidents', { method: 'POST' }), env))
      .status,
  ).toBe(405);
  expect(mocks.unsafe).not.toHaveBeenCalled();
  for (const incident of [
    stored({ id: 'not-a-uuid' }),
    stored({ description: '' }),
    stored({ leaveDays: 400 }),
    stored({ author: 'Coordenação' }),
  ]) {
    mocks.unsafe.mockReset();
    mocks.unsafe.mockResolvedValueOnce([{ incidents: { incidents: [incident] } }]);
    expect((await servePortalIncidentsV1(read(), env)).status).toBe(503);
  }
});

it('confirms the version read for the signed-in account, in a locked (writing) transaction', async () => {
  mocks.unsafe.mockResolvedValueOnce([
    { ack: { state: 'acknowledged', acknowledgedAt: '2026-10-29T12:40:00.123456+00:00' } },
  ]);
  const response = await servePortalIncidentsV1(acknowledge(), env);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    contractVersion: 1,
    state: 'ready',
    acknowledgedAt: '2026-10-29T12:40:00.123Z',
  });
  expect(mocks.unsafe.mock.calls[0]?.[0]).toContain('attendance.acknowledge_portal_incident_v1');
  expect(mocks.unsafe.mock.calls[0]?.[1]).toEqual([accountId, sessionId, versionId]);
  expect(mocks.snapshots).toEqual([false]);
});

it('answers 409 when the school edited or removed the record since it was read', async () => {
  mocks.unsafe.mockResolvedValueOnce([{ ack: { state: 'changed' } }]);
  const response = await servePortalIncidentsV1(acknowledge(), env);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ contractVersion: 1, state: 'changed' });
});

it('refuses a confirmation the database no longer accepts as unauthenticated', async () => {
  mocks.unsafe.mockResolvedValueOnce([{ ack: null }]);
  expect((await servePortalIncidentsV1(acknowledge(), env)).status).toBe(401);
});

it('rejects a confirmation body that is not exactly one version id, before any database work', async () => {
  for (const request of [
    acknowledge({ id: 'demo-1' }),
    acknowledge({ id: versionId, studentId: 1 }),
    acknowledge({}),
    acknowledge('{"id":', 'application/json'),
    acknowledge({ id: versionId }, 'text/plain'),
    acknowledge({ id: versionId, padding: 'x'.repeat(300) }),
  ])
    expect((await servePortalIncidentsV1(request, env)).status).toBe(400);
  expect(
    (
      await servePortalIncidentsV1(
        new Request(env.PORTAL_ORIGIN + '/api/student/incidents/acknowledge'),
        env,
      )
    ).status,
  ).toBe(405);
  expect(mocks.unsafe).not.toHaveBeenCalled();
});
