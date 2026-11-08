import { beforeAll, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../../functions/[[path]]';
import { seal } from '../../../server/auth/sealed';
import { SESSION_COOKIE } from '../../../server/auth/session';
import type { RuntimeEnv } from '../../../server/env';
import { handleOperationalWorkspaceRequestV1 } from '../../../server/gradebook/http/operational-workspace-routes-v1';
import { handlePerformanceRequestV1 } from '../../../server/gradebook/http/performance-routes-v1';
import { handleBulletinRequestV1 } from '../../../server/gradebook/http/bulletin-routes-v1';
import { handleCouncilWorkspaceRequestV1 } from '../../../server/gradebook/http/council-routes-v1';
import { testEnv } from '../../fixtures';

const retired = { state: 'retired' };
const cases = [
  { name: 'workspace-v1', path: 'operational-workspace', handler: handleOperationalWorkspaceRequestV1,
    body: { contractVersion: 1, operation: 'bootstrap' }, expected: retired },
  { name: 'performance-v1', path: 'performance', handler: handlePerformanceRequestV1,
    body: { transportVersion: 1, operation: 'matrix' }, expected: retired },
  { name: 'bulletins-v1', path: 'bulletins', handler: handleBulletinRequestV1,
    body: { contractVersion: 1, operation: 'bootstrap' }, expected: retired },
  { name: 'council-v1', path: 'council-workspace', handler: handleCouncilWorkspaceRequestV1,
    body: { contractVersion: 1, operation: 'queue' }, expected: retired },
  { name: 'council-v2', path: 'council-workspace', handler: handleCouncilWorkspaceRequestV1,
    body: { contractVersion: 2, operation: 'closure-review' }, expected: retired },
] as const;
const origins = {
  local: 'http://localhost:8788', preview: 'https://synthetic.pages.dev', production: testEnv.OFFICIAL_ORIGIN,
} as const;
type Role = 'ADMINISTRADOR' | 'PROFESSOR';
const cookies = new Map<Role, string>();
beforeAll(async () => {
  for (const role of ['ADMINISTRADOR', 'PROFESSOR'] as const) {
    const token = await seal({ oid: '11111111-1111-4111-8111-111111111111', name: 'Synthetic',
      username: 'synthetic@example.test', roles: [role], exp: Math.floor(Date.now() / 1000) + 600 }, testEnv.SESSION_SECRET);
    cookies.set(role, `${SESSION_COOKIE}=${token}`);
  }
});
function environment(runtime: keyof typeof origins) {
  const env: RuntimeEnv = { ...testEnv, RUNTIME_ENVIRONMENT: runtime, OFFICIAL_ORIGIN: origins[runtime],
    GRADEBOOK_STORAGE_PROVIDER: 'postgres', GRADEBOOK_PRODUCTION_ENABLED: 'true' };
  const access = vi.fn(() => { throw new Error('retired-storage-access'); });
  for (const key of ['GRADEBOOK_D1', 'GRADEBOOK_DATABASE', 'PROD_DB']) {
    Object.defineProperty(env, key, { get: access, configurable: true, enumerable: true });
  }
  return { env, access };
}
function request(path: string, origin: string, body: unknown, role: Role | null = 'ADMINISTRADOR', method = 'POST') {
  const headers = new Headers({ Origin: origin, 'Content-Type': 'application/json' });
  if (role !== null) headers.set('Cookie', cookies.get(role)!);
  return new Request(`${origin}/api/gradebook/${path}`, { method, headers,
    ...(method === 'POST' && body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

describe.each(cases)('legacy retirement #1079 $name', ({ path, handler, body, expected }) => {
  it.each(['local', 'preview', 'production'] as const)('returns its exact 410 DTO without any storage access in %s', async (runtime) => {
    const { env, access } = environment(runtime);
    const response = await handler(request(path, env.OFFICIAL_ORIGIN, body), env);
    expect(response?.status).toBe(410);
    expect(response?.headers.get('Cache-Control')).toContain('no-store');
    await expect(response?.json()).resolves.toEqual(expected);
    expect(access).not.toHaveBeenCalled();
  });
  it.each([[null, 401], ['PROFESSOR', 403]] as const)('preserves the access guard for %s', async (role, status) => {
    const { env, access } = environment('production');
    const response = await handler(request(path, env.OFFICIAL_ORIGIN, body, role), env);
    expect(response?.status).toBe(status);
    expect(response?.headers.get('Cache-Control')).toContain('no-store');
    expect(access).not.toHaveBeenCalled();
  });
  it('preserves payload, body-size, method and origin guards before retirement', async () => {
    const { env, access } = environment('production');
    const invalid = await handler(request(path, env.OFFICIAL_ORIGIN, [body]), env);
    expect(invalid?.status).toBe(400);
    const valid = request(path, env.OFFICIAL_ORIGIN, body);
    const oversized = await handler(new Request(valid.url, {
      method: valid.method, headers: valid.headers,
      body: JSON.stringify(body) + ' '.repeat(70_000),
    }), env);
    expect([400, 413]).toContain(oversized?.status);
    await expect(handler(request(path, env.OFFICIAL_ORIGIN, undefined, 'ADMINISTRADOR', 'GET'), env)).rejects.toMatchObject({ status: 405 });
    const foreign = request(path, env.OFFICIAL_ORIGIN, body);
    foreign.headers.set('Origin', 'https://foreign.invalid');
    await expect(handler(foreign, env)).rejects.toMatchObject({ status: 403 });
    expect(access).not.toHaveBeenCalled();
  });
  it('keeps the central Functions dispatch retired without opening a connection', async () => {
    const { env, access } = environment('production');
    // validateEnv reads binding fields; trap use of each supplied binding instead.
    const binding = new Proxy({}, { get: access });
    for (const key of ['GRADEBOOK_D1', 'GRADEBOOK_DATABASE', 'PROD_DB']) {
      Object.defineProperty(env, key, { value: binding, configurable: true, enumerable: true });
    }
    const response = await onRequest({ env, request: request(path, env.OFFICIAL_ORIGIN, body) } as never);
    expect(response.status).toBe(410);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    await expect(response.json()).resolves.toEqual(expected);
    expect(access).not.toHaveBeenCalled();
  });
});

