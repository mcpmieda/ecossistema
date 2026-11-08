import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../../server/auth/session';
import { seal } from '../../../server/auth/sealed';
import type { RuntimeEnv } from '../../../server/env';
import {
  GRADEBOOK_BULLETIN_ROUTE_V1,
  handleBulletinRequestV1,
} from '../../../server/gradebook/http/bulletin-routes-v1';
import { testEnv } from '../../fixtures';

const LOCAL_ORIGIN = 'http://localhost:8788';
const SESSION_OID = '22222222-2222-4222-8222-222222222222';
type TestRole = 'ADMINISTRADOR' | 'PROFESSOR';

function localEnv(binding: unknown): RuntimeEnv {
  return {
    ...testEnv,
    RUNTIME_ENVIRONMENT: 'local',
    OFFICIAL_ORIGIN: LOCAL_ORIGIN,
    GRADEBOOK_D1: binding,
  };
}

async function headers(role?: TestRole, origin = LOCAL_ORIGIN): Promise<Headers> {
  const result = new Headers({ Origin: origin, 'Content-Type': 'application/json' });
  if (!role) return result;
  const session = await seal(
    {
      oid: SESSION_OID,
      name: 'Administrador Sintético',
      username: 'synthetic-bulletin@example.test',
      roles: [role],
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    testEnv.SESSION_SECRET,
  );
  result.set('Cookie', `${SESSION_COOKIE}=${session}`);
  return result;
}

async function bulletinRequest(body: unknown, role?: TestRole, base = LOCAL_ORIGIN): Promise<Request> {
  return new Request(`${base}${GRADEBOOK_BULLETIN_ROUTE_V1}`, {
    method: 'POST',
    headers: await headers(role, base),
    body: JSON.stringify(body),
  });
}

describe('Boletins HTTP V1', () => {
  it('rejeita sessão ausente ou capability ausente antes de tocar no binding e sempre usa no-store', async () => {
    const prepare = vi.fn(() => {
      throw new Error('sensitive-binding');
    });
    const env = localEnv({ prepare, exec: vi.fn() });
    const body = { contractVersion: 1, operation: 'bootstrap' };

    const unauthenticated = await handleBulletinRequestV1(await bulletinRequest(body), env);
    expect(unauthenticated?.status).toBe(401);
    expect(unauthenticated?.headers.get('Cache-Control')).toContain('no-store');

    const forbidden = await handleBulletinRequestV1(
      await bulletinRequest(body, 'PROFESSOR'),
      env,
    );
    expect(forbidden?.status).toBe(403);
    expect(forbidden?.headers.get('Cache-Control')).toContain('no-store');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('mantém produção fail-closed antes de inspecionar GRADEBOOK_D1', async () => {
    const prepare = vi.fn(() => {
      throw new Error('production-sensitive-binding');
    });
    const env = {
      ...testEnv,
      RUNTIME_ENVIRONMENT: 'production',
      GRADEBOOK_D1: { prepare, exec: vi.fn() },
    } satisfies RuntimeEnv;
    const response = await handleBulletinRequestV1(
      await bulletinRequest(
        { contractVersion: 1, operation: 'bootstrap' },
        'ADMINISTRADOR',
        testEnv.OFFICIAL_ORIGIN,
      ),
      env,
    );
    expect(response?.status).toBe(410);
    expect(response?.headers.get('Cache-Control')).toContain('no-store');
    await expect(response?.json()).resolves.toEqual({ state: 'retired' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejeita actor/role/capability no payload antes do runtime', async () => {
    const prepare = vi.fn(() => {
      throw new Error('payload-must-not-touch-binding');
    });
    const env = localEnv({ prepare, exec: vi.fn() });
    for (const forbiddenField of ['actorId', 'role', 'capability', 'authorization']) {
      const response = await handleBulletinRequestV1(
        await bulletinRequest(
          { contractVersion: 1, operation: 'bootstrap', [forbiddenField]: 'synthetic' },
          'ADMINISTRADOR',
        ),
        env,
      );
      expect(response?.status).toBe(410);
      expect(response?.headers.get('Cache-Control')).toContain('no-store');
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('é um handler dedicado e isolado até o wiring central da #328', async () => {
    const response = await handleBulletinRequestV1(
      new Request(`${LOCAL_ORIGIN}/api/gradebook/outro`, { method: 'POST' }),
      localEnv(null),
    );
    expect(response).toBeNull();
  });
});
