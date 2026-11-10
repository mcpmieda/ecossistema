// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { servePortalFrequencyV2 } from '../../../server/student-portal/composition/frequency-v2';
import { servePortalIncidentsV1 } from '../../../server/student-portal/composition/incidents-v1';
import { servePortalScheduleV1 } from '../../../server/student-portal/composition/schedule-v1';
import type { PortalCompositionEnvV1 } from '../../../server/student-portal/composition/config-v1';
import { portalOperationBurstMetricV1 } from '../../../server/student-portal/observability/metrics-v1';

const mocks = vi.hoisted(() => ({ operations: [] as string[], database: vi.fn() }));
vi.mock('../../../server/student-portal/http/auth/handler-v1', () => ({
  sessionCookieTokenV1: () => 'a'.repeat(43),
}));
vi.mock('../../../server/student-portal/composition/database-v1', () => ({
  portalDatabaseV1: mocks.database,
}));
vi.mock('../../../server/student-portal/observability/operation-burst-v1', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../server/student-portal/observability/operation-burst-v1')>();
  return {
    ...actual,
    // The entry budget is spent: the read must stop here, before the database.
    checkPortalOperationV1: async (_binding: unknown, operation: string) => {
      mocks.operations.push(operation);
      throw new actual.PortalRateLimitErrorV1('rate-limited');
    },
  };
});
const env = {
  PORTAL_ENVIRONMENT: 'production',
  PORTAL_ORIGIN: 'https://aluno.escolaieda.com',
  PORTAL_ADMIN_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  PORTAL_SERVING_ENABLED: 'true',
} satisfies PortalCompositionEnvV1;
const get = (path: string) => new Request(env.PORTAL_ORIGIN + path);
beforeEach(() => {
  mocks.operations.length = 0;
  mocks.database.mockReset();
});

// One shared key made a busy minute of one page refuse the others and the session check itself.
it.each([
  ['frequency-entry', () => servePortalFrequencyV2(get('/api/student/frequency?year=2026'), env)],
  ['schedule-entry', () => servePortalScheduleV1(get('/api/student/schedule'), env)],
  ['incidents-entry', () => servePortalIncidentsV1(get('/api/student/incidents'), env)],
] as const)('spends its own entry budget, never the session one: %s', async (operation, serve) => {
  const response = await serve();
  expect(response.status).toBe(429);
  expect(mocks.operations).toEqual([operation]);
  expect(mocks.database).not.toHaveBeenCalled();
  expect(portalOperationBurstMetricV1.shape.operation.options).toContain(operation);
});
