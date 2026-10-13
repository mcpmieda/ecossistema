// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../functions/_middleware';
import {
  classifyAdminOperationV1,
  guardAdminOperationV1,
} from '../server/http/admin-rate-limit-v1';
import { readSession, SESSION_COOKIE } from '../server/auth/session';
import { seal } from '../server/auth/sealed';
import type { RuntimeEnv } from '../server/env';
import { photoAdminResponseV1 } from '../shared/student-photos/admin-http-v1';
import { testEnv } from './fixtures';

const actor = '11111111-1111-4111-8111-111111111111';
const limited = {
  contractVersion: 1,
  state: 'rate-limited',
  requestId: crypto.randomUUID(),
  retryAfterSeconds: 60,
};
async function request(path = '/api/me', method = 'GET', body?: unknown, oid = actor) {
  const token = await seal(
    { oid, name: 'Synthetic', roles: ['ADMINISTRADOR'], exp: Math.floor(Date.now() / 1000) + 60 },
    testEnv.SESSION_SECRET,
  );
  return new Request(testEnv.OFFICIAL_ORIGIN + path, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE}=${token}`,
      origin: testEnv.OFFICIAL_ORIGIN,
      'content-type': 'application/json',
      'cf-connecting-ip': '192.0.2.1',
      'x-admin-actor-id': crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const environment = (limitOperation = vi.fn(async () => null as unknown)): RuntimeEnv => ({
  ...testEnv,
  PORTAL_SERVICE: { limitOperation },
});
afterEach(() => vi.restoreAllMocks());

describe('Pages ADM quota boundary', () => {
  it('uses the verified actor, not public headers, and leaves the handler authorization intact', async () => {
    const limitOperation = vi.fn(async () => null);
    const req = await request();
    await expect(guardAdminOperationV1(req, environment(limitOperation))).resolves.toBeNull();
    expect(limitOperation).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: actor, tenantId: testEnv.TENANT_ID }),
      'read',
    );
    expect((await readSession(req, testEnv))?.roles).toEqual(['ADMINISTRADOR']);
  });
  it('returns 429 + conservative wait and never invokes a downstream provider/effect', async () => {
    const next = vi.fn();
    const response = await onRequest({
      request: await request('/api/gradebook/import-persistence', 'POST', { synthetic: true }),
      env: environment(vi.fn(async () => limited)),
      next,
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(await response.json()).toEqual({ transportVersion: 9, state: 'unavailable' });
    expect(next).not.toHaveBeenCalled();
  });
  it('does not read or clone large import bodies for classification', async () => {
    const req = await request('/api/gradebook/import-persistence', 'POST', {
      synthetic: 'x'.repeat(100000),
    });
    const clone = vi.spyOn(req, 'clone');
    const json = vi.spyOn(req, 'json');
    await guardAdminOperationV1(req, environment(vi.fn(async () => limited)));
    expect(clone).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(req.bodyUsed).toBe(false);
  });
  it.each(['absent', 'throw', 'malformed'] as const)(
    'fails closed with 503 when limiter is %s',
    async (mode) => {
      const env =
        mode === 'absent'
          ? testEnv
          : environment(
              vi.fn(async () => {
                if (mode === 'throw') throw new Error('private');
                return { state: 'allowed' };
              }),
            );
      const response = await guardAdminOperationV1(await request(), env);
      expect(response?.status).toBe(503);
      expect(response?.headers.get('Retry-After')).toBe('60');
    },
  );
  it('preserves versioned read envelopes and original body for the handler', async () => {
    const req = await request('/api/gradebook/performance', 'POST', {
      transportVersion: 6,
      operation: 'synthetic',
    });
    const response = await guardAdminOperationV1(req, environment(vi.fn(async () => limited)));
    expect(await response?.json()).toEqual({ transportVersion: 6, state: 'unavailable' });
    expect(await req.json()).toEqual({ transportVersion: 6, operation: 'synthetic' });
  });
  it('rejects chunked over-limit classification without a tee cancellation deadlock', async () => {
    const req = await request('/api/gradebook/year-reset', 'POST', { synthetic: 'x'.repeat(3000) });
    expect((await guardAdminOperationV1(req, environment()))?.status).toBe(413);
  });
  it('preserves the existing 96000-byte audit payload limit', async () => {
    const req = await request('/api/gradebook/audit-treatment', 'POST', {
      operation: 'record',
      synthetic: 'x'.repeat(20000),
    });
    expect(await guardAdminOperationV1(req, environment())).toBeNull();
  });
  it.each([
    '',
    `${SESSION_COOKIE}=x; ${SESSION_COOKIE}=y`,
    `${SESSION_COOKIE}=!invalid`,
    `${SESSION_COOKIE}=${'x'.repeat(4097)}`,
  ])('rejects invalid session cookies before quota/handler (%s)', async (cookie) => {
    const limitOperation = vi.fn(async () => null);
    const req = new Request(testEnv.OFFICIAL_ORIGIN + '/api/me', { headers: { cookie } });
    expect((await guardAdminOperationV1(req, environment(limitOperation)))?.status).toBe(401);
    expect(limitOperation).not.toHaveBeenCalled();
  });
  it('keeps origin and method checks ahead of the limiter', async () => {
    const limitOperation = vi.fn(async () => null);
    const req = await request('/api/gradebook/import-persistence', 'POST', {});
    req.headers.set('origin', 'https://evil.example');
    expect((await guardAdminOperationV1(req, environment(limitOperation)))?.status).toBe(403);
    expect(
      (await guardAdminOperationV1(await request('/api/me', 'POST'), environment(limitOperation)))
        ?.status,
    ).toBe(405);
    expect(limitOperation).not.toHaveBeenCalled();
  });
  it('does not duplicate Worker quotas or prevent independent cookie-only ADM logout', async () => {
    const limitOperation = vi.fn(async () => limited);
    for (const path of [
      '/auth/logout',
      '/auth/login',
      '/api/student-portal/admin/query',
      '/api/student-portal/admin/command',
      '/api/student-portal/admin/live',
      '/',
    ])
      expect(
        await guardAdminOperationV1(
          new Request(testEnv.OFFICIAL_ORIGIN + path),
          environment(limitOperation),
        ),
      ).toBeNull();
    expect(limitOperation).not.toHaveBeenCalled();
  });
  it('leaves retired compatibility transports with the original handler and no quota dependency', async () => {
    const limitOperation = vi.fn(async () => limited);
    const req = await request('/api/gradebook/operational-workspace', 'POST', {
      contractVersion: 1,
      operation: 'synthetic',
    });
    expect(await guardAdminOperationV1(req, environment(limitOperation))).toBeNull();
    expect(limitOperation).not.toHaveBeenCalled();
  });
  it('counts reconciliation reads apart from writes and leaves the uploaded report unread', async () => {
    const route = '/api/student-reconciliation/v1';
    // The runtime declares the length of a buffered body; a constructed Request cannot carry it.
    const sized = async (body: unknown) => {
      const req = await request(route, 'POST', body);
      const length = String(new TextEncoder().encode(JSON.stringify(body)).length);
      const get = req.headers.get.bind(req.headers);
      vi.spyOn(req.headers, 'get').mockImplementation((name) =>
        name.toLowerCase() === 'content-length' ? length : get(name),
      );
      return req;
    };
    const limitOperation = vi.fn(async () => null);
    for (const operation of ['catalog', 'list', 'detail'])
      await guardAdminOperationV1(await sized({ contractVersion: 1, operation }), environment(limitOperation));
    await guardAdminOperationV1(await sized({ contractVersion: 1, operation: 'apply' }), environment(limitOperation));
    expect(limitOperation.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      'read', 'read', 'read', 'write',
    ]);
    const report = await sized({ contractVersion: 1, operation: 'prepare', rows: 'x'.repeat(100000) });
    const clone = vi.spyOn(report, 'clone');
    await guardAdminOperationV1(report, environment(limitOperation));
    expect(limitOperation).toHaveBeenLastCalledWith(expect.anything(), 'write');
    expect(clone).not.toHaveBeenCalled();
    expect(report.bodyUsed).toBe(false);
    const refused = await guardAdminOperationV1(
      await sized({ contractVersion: 1, operation: 'list' }),
      environment(vi.fn(async () => limited)),
    );
    expect(refused?.status).toBe(429);
    expect(await refused?.json()).toEqual({ contractVersion: 1, state: 'unavailable' });
  });
  it('separates operation families on mixed POST transports', () => {
    expect(
      classifyAdminOperationV1('/api/gradebook/council-workspace', 'POST', {
        operation: 'workspace',
      }),
    ).toBe('read');
    expect(
      classifyAdminOperationV1('/api/gradebook/council-workspace', 'POST', {
        operation: 'decision',
      }),
    ).toBe('write');
    expect(
      classifyAdminOperationV1('/api/gradebook/bulletins', 'POST', { operation: 'emit-batch' }),
    ).toBe('export');
    expect(classifyAdminOperationV1('/api/gradebook/import-diagnostics', 'GET', {})).toBe('read');
    expect(classifyAdminOperationV1('/api/gradebook/import-diagnostics', 'POST', {})).toBe(
      'import',
    );
  });
});

describe('request-scoped Entra seal reuse', () => {
  it('decrypts once per Request and protects cached roles from mutation', async () => {
    const req = await request();
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    const first = await readSession(req, testEnv);
    first!.roles.length = 0;
    expect((await readSession(req, testEnv))?.roles).toEqual(['ADMINISTRADOR']);
    expect(decrypt).toHaveBeenCalledTimes(1);
    await readSession(req.clone() as Request, testEnv);
    expect(decrypt).toHaveBeenCalledTimes(2);
  });
  it('rechecks expiry without extending it or decrypting again', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const req = await request();
    expect(await readSession(req, testEnv)).not.toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61000);
    expect(await readSession(req, testEnv)).toBeNull();
  });
  it('does not reuse a verification for another secret or mutated cookie', async () => {
    const req = await request();
    expect(await readSession(req, testEnv)).not.toBeNull();
    expect(
      await readSession(req, { ...testEnv, SESSION_SECRET: testEnv.SESSION_SECRET + 'other' }),
    ).toBeNull();
    req.headers.set('cookie', `${SESSION_COOKIE}=invalid`);
    expect(await readSession(req, testEnv)).toBeNull();
  });
});

it('shares a seal across real Pages-style clones only within its request scope', async () => {
  const first = await request();
  const other = await request('/api/me', 'GET', undefined, '33333333-3333-4333-8333-333333333333');
  const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
  const execute = async (req: Request, oid: string) => {
    const next = vi.fn(async () => {
      await Promise.resolve();
      const cloned = new Request(req.clone() as Request);
      expect((await readSession(cloned, testEnv))?.oid).toBe(oid);
      return Response.json({ state: 'ok' });
    });
    const response = await onRequest({
      request: req,
      env: environment(),
      next,
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  };
  await Promise.all([
    execute(first, actor),
    execute(other, '33333333-3333-4333-8333-333333333333'),
  ]);
  expect(decrypt).toHaveBeenCalledTimes(2);
  await readSession(new Request(first.clone() as Request), testEnv);
  expect(decrypt).toHaveBeenCalledTimes(3);
});


it.each([401, 403, 429, 503])('preserves the versioned photo-admin failure contract for HTTP %s', async status => {
  const req = await request('/api/student-photos/admin/state', 'POST', {});
  if (status === 401) req.headers.delete('cookie');
  if (status === 403) req.headers.set('origin', 'https://other.invalid');
  const response = await guardAdminOperationV1(req, environment(vi.fn(async () =>
    status === 429 ? limited : { ...limited, state: 'unavailable' })));
  expect(response?.status).toBe(status);
  const body = await response!.json();
  expect(photoAdminResponseV1.safeParse(body).success).toBe(true);
  expect(body).toMatchObject({ version: 1, state: status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : 'unavailable' });
});
