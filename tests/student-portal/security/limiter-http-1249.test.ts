// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { servePortalSelfV1 } from '../../../server/student-portal/composition/self-v1';
import { SessionServiceV1 } from '../../../server/student-portal/auth/session-service-v1';
import { PolicyServiceV1 } from '../../../server/student-portal/policies/policy-service-v1';
import { PortalRateLimitErrorV1 } from '../../../server/student-portal/observability/operation-burst-v1';
import { servePortalPhotoV1 } from '../../../server/student-portal/photos/http-v1';
const database = vi.hoisted(() => vi.fn());
vi.mock('../../../server/student-portal/composition/database-v1', () => ({
  portalDatabaseV1: database,
}));
const origin = 'https://aluno.escolaieda.com';
const key = JSON.stringify({ 1: Buffer.alloc(32, 1).toString('base64') });
const env = {
  PORTAL_ENVIRONMENT: 'production',
  PORTAL_ORIGIN: origin,
  PORTAL_SERVING_ENABLED: 'true',
  PORTAL_ADMIN_TENANT_ID: '50000000-0000-4000-8000-000000000001',
  PASSWORD_PEPPER: key,
  QR_HMAC_KEYS: key,
  PORTAL_AUTH_GLOBAL: { limit: vi.fn().mockResolvedValue({ success: true }) },
  PORTAL_PHOTOS_ENABLED: 'true',
};
const request = (path: string) =>
  new Request(origin + path, {
    headers: { origin, cookie: '__Host-student_portal_session=' + 'a'.repeat(43) },
  });
afterEach(() => vi.restoreAllMocks());
it.each(['rate-limited', 'unavailable'] as const)(
  'does not disguise a %s status guard as a public school response',
  async (state) => {
    database.mockImplementation(async (_env, _operation, run) => run({}));
    vi.spyOn(SessionServiceV1.prototype, 'withAuthorized').mockRejectedValue(
      new PortalRateLimitErrorV1(state),
    );
    const school = vi.spyOn(PolicyServiceV1.prototype, 'readSnapshot');
    const response = await servePortalSelfV1(request('/api/student/status'), env);
    expect(response.status).toBe(state === 'rate-limited' ? 429 : 503);
    expect(await response.json()).toMatchObject({ state });
    expect(school).not.toHaveBeenCalled();
  },
);
it.each(['rate-limited', 'unavailable'] as const)(
  'keeps session %s distinct through the nested HTTP handler',
  async (state) => {
    database.mockImplementation(async (_env, _operation, run) => run({}));
    vi.spyOn(SessionServiceV1.prototype, 'read').mockRejectedValue(
      new PortalRateLimitErrorV1(state),
    );
    const response = await servePortalSelfV1(request('/api/student/session'), env);
    expect(response.status).toBe(state === 'rate-limited' ? 429 : 503);
    expect(response.headers.get('retry-after')).toBe(state === 'rate-limited' ? '60' : null);
  },
);
it('keeps photo throttling private, empty and retryable', async () => {
  const response = await servePortalPhotoV1(request('/api/student/photo'), env, async () => {
    throw new PortalRateLimitErrorV1('rate-limited');
  });
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.text()).toBe('');
});
