import { describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../../functions/[[path]]';
import { SESSION_COOKIE } from '../../../server/auth/session';
import { seal } from '../../../server/auth/sealed';
import type { RuntimeEnv } from '../../../server/env';
import {
  GRADEBOOK_OPERATIONAL_WORKSPACE_ROUTE_V1,
  handleOperationalWorkspaceRequestV1,
} from '../../../server/gradebook/http/operational-workspace-routes-v1';
import { testEnv } from '../../fixtures';

const LOCAL_ORIGIN = 'http://localhost:8788';
type TestRole = 'ADMINISTRADOR' | 'PROFESSOR';

function localEnv(database: unknown): RuntimeEnv {
  return {
    ...testEnv,
    RUNTIME_ENVIRONMENT: 'local',
    OFFICIAL_ORIGIN: LOCAL_ORIGIN,
    GRADEBOOK_D1: database,
  };
}

async function headers(role?: TestRole, origin = LOCAL_ORIGIN): Promise<Headers> {
  const value = new Headers({
    Origin: origin,
    'Content-Type': 'application/json',
  });
  if (!role) return value;
  const session = await seal(
    {
      oid: '11111111-1111-4111-8111-111111111111',
      name: 'Synthetic Administrator',
      username: 'synthetic@example.test',
      roles: [role],
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    testEnv.SESSION_SECRET,
  );
  value.set('Cookie', `${SESSION_COOKIE}=${session}`);
  return value;
}

async function request(
  body: unknown,
  options: { readonly role?: TestRole; readonly origin?: string; readonly base?: string } = {},
): Promise<Request> {
  const base = options.base ?? LOCAL_ORIGIN;
  return new Request(`${base}${GRADEBOOK_OPERATIONAL_WORKSPACE_ROUTE_V1}`, {
    method: 'POST',
    headers: await headers(options.role, options.origin ?? base),
    body: JSON.stringify(body),
  });
}

async function invoke(requestValue: Request, env: RuntimeEnv): Promise<Response> {
  return await onRequest({ request: requestValue, env } as never);
}

describe('operational workspace HTTP bridge v1', () => {
  it('returns non-disclosing not-authorized states before touching the binding', async () => {
    const prepare = vi.fn(() => {
      throw new Error('synthetic-sensitive-binding');
    });
    const env = localEnv({ prepare, exec: vi.fn() });

    const unauthenticated = await invoke(
      await request({ contractVersion: 1, operation: 'bootstrap' }),
      env,
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('Cache-Control')).toContain('no-store');
    await expect(unauthenticated.json()).resolves.toEqual({
      contractVersion: 1,
      state: 'not-authorized',
    });

    const forbidden = await invoke(
      await request({ contractVersion: 1, operation: 'bootstrap' }, { role: 'PROFESSOR' }),
      env,
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({
      contractVersion: 1,
      state: 'not-authorized',
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('retires V1 in production before inspecting the binding', async () => {
    const prepare = vi.fn(() => {
      throw new Error('production-sensitive-binding');
    });
    const env = {
      ...testEnv,
      RUNTIME_ENVIRONMENT: 'production',
      GRADEBOOK_D1: { prepare, exec: vi.fn() },
    } satisfies RuntimeEnv;

    const response = await invoke(
      await request(
        { contractVersion: 1, operation: 'bootstrap' },
        { role: 'ADMINISTRADOR', base: testEnv.OFFICIAL_ORIGIN, origin: testEnv.OFFICIAL_ORIGIN },
      ),
      env,
    );
    expect(response.status).toBe(410);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    await expect(response.json()).resolves.toEqual({ state: 'retired' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('retires the authorized local bridge with no-store and no binding access', async () => {
    const binding = vi.fn(() => { throw new Error('retired-binding'); });
    const env = localEnv(undefined);
    Object.defineProperty(env, 'GRADEBOOK_D1', { get: binding });
    const handled = await handleOperationalWorkspaceRequestV1(
      await request({ contractVersion: 1, operation: 'bootstrap' }, { role: 'ADMINISTRADOR' }), env,
    );
    expect(handled?.status).toBe(410);
    expect(handled?.headers.get('Cache-Control')).toContain('no-store');
    await expect(handled?.json()).resolves.toEqual({ state: 'retired' });
    expect(binding).not.toHaveBeenCalled();
  });

  it('rejects client authorization and academic claims without touching storage', async () => {
    const prepare = vi.fn(() => {
      throw new Error('synthetic-sensitive-binding');
    });
    const response = await invoke(
      await request(
        { contractVersion: 1, operation: 'bootstrap', authorized: true, grade: 10 },
        { role: 'ADMINISTRADOR' },
      ),
      localEnv({ prepare, exec: vi.fn() }),
    );
    expect(response.status).toBe(410);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    await expect(response.json()).resolves.toEqual({ state: 'retired' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('dispatches the bridge through Functions and rejects non-POST methods', async () => {
    const wrongMethod = new Request(`${LOCAL_ORIGIN}${GRADEBOOK_OPERATIONAL_WORKSPACE_ROUTE_V1}`, {
      method: 'GET',
      headers: await headers('ADMINISTRADOR'),
    });
    const response = await invoke(wrongMethod, localEnv(undefined));
    expect(response.status).toBe(405);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
});
