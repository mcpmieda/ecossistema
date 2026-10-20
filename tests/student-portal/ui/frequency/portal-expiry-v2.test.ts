// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { servePortalFrequencyV2 } from '../../../../server/student-portal/composition/frequency-v2';
import type { PortalCompositionEnvV1 } from '../../../../server/student-portal/composition/config-v1';

const mocks = vi.hoisted(() => ({
  unsafe:
    vi.fn<(query: string, values?: readonly unknown[]) => Promise<Record<string, unknown>[]>>(),
  effectiveExpiry: '2026-10-14T13:00:00.000Z',
  showFrequency: true,
}));
const accountId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
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
    async withAuthorized<T>(
      _token: string,
      operation: (
        context: { account: { id: string }; policy: { enforcedValue: { showFrequency: boolean } } },
        tx: { unsafe: typeof mocks.unsafe },
        session: { id: string; expiresAt: string; persistent: boolean },
      ) => Promise<T>,
    ) {
      return operation(
        { account: { id: accountId }, policy: { enforcedValue: { showFrequency: mocks.showFrequency } } },
        { unsafe: mocks.unsafe },
        { id: sessionId, expiresAt: mocks.effectiveExpiry, persistent: false },
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
const request = () => new Request(env.PORTAL_ORIGIN + '/api/student/frequency?month=2026-10');
beforeEach(() => {
  mocks.unsafe.mockReset();
  mocks.showFrequency = true;
});

it('refuses the read without touching attendance data when the Frequência policy is off', async () => {
  mocks.showFrequency = false;
  const response = await servePortalFrequencyV2(request(), env);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ contractVersion: 2, state: 'forbidden' });
  expect(mocks.unsafe).not.toHaveBeenCalled();
});

it('checks the effective policy/session expiration with database time after reading origins and suppresses an expired result', async () => {
  mocks.unsafe
    .mockResolvedValueOnce([
      {
        origins: [
          {
            occurrence_id: '33333333-3333-4333-8333-333333333333',
            date: '2026-10-01',
            slot: 1,
            shift: 'matutino',
            mark: 'X',
            conflict_id: null,
            source_class_label: 'PRIVATE_SYNTHETIC_CLASS',
            observed_at: '2026-10-14T12:00:00Z',
            received_at: '2026-10-14T12:01:00Z',
            mapping_valid: true,
          },
        ],
      },
    ])
    .mockResolvedValueOnce([{ active: false }]);
  const result = await servePortalFrequencyV2(request(), env);
  expect(mocks.unsafe.mock.calls[0]?.[1]).toEqual([accountId, sessionId, '2026-10']);
  expect(mocks.unsafe.mock.calls[1]?.[0]).toContain('clock_timestamp()');
  expect(mocks.unsafe.mock.calls[1]?.[1]).toEqual([mocks.effectiveExpiry]);
  expect(result.status).toBe(401);
  expect(await result.text()).not.toContain('PRIVATE_SYNTHETIC_CLASS');
  expect(result.headers.get('Cache-Control')).toContain('no-store');
});

it('returns a private incomplete summary only while the effective session remains live', async () => {
  mocks.unsafe.mockResolvedValueOnce([{ origins: [] }]).mockResolvedValueOnce([{ active: true }]);
  const result = await servePortalFrequencyV2(request(), env);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    contractVersion: 2,
    state: 'ready',
    coverage: 'unavailable',
    denominator: null,
    percentage: null,
    marks: [],
  });
});

it('rejects a caller-provided student UID before reading any private origins', async () => {
  const result = await servePortalFrequencyV2(
    new Request(env.PORTAL_ORIGIN + '/api/student/frequency?month=2026-10&studentUid=' + accountId),
    env,
  );
  expect(result.status).toBe(403);
  expect(mocks.unsafe).not.toHaveBeenCalled();
});
