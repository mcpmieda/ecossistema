import { describe, expect, it, vi } from 'vitest';

import { onRequest } from '../../../functions/[[path]]';
import { SESSION_COOKIE } from '../../../server/auth/session';
import { seal } from '../../../server/auth/sealed';
import type { RuntimeEnv } from '../../../server/env';
import { GRADEBOOK_OPERATIONAL_WORKSPACE_ROUTE_V1 } from '../../../server/gradebook/http/operational-workspace-routes-v1';
import { testEnv } from '../../fixtures';

type TestRole = 'ADMINISTRADOR' | 'PROFESSOR';

async function headers(role?: TestRole): Promise<Headers> {
  const value = new Headers({ Origin: testEnv.OFFICIAL_ORIGIN, 'Content-Type': 'application/json' });
  if (!role) return value;
  const session = await seal({
    oid: '44444444-4444-4444-8444-444444444444',
    name: 'Administrador Sintético F5',
    username: 'synthetic-f5@example.test',
    roles: [role],
    exp: Math.floor(Date.now() / 1000) + 600,
  }, testEnv.SESSION_SECRET);
  value.set('Cookie', `${SESSION_COOKIE}=${session}`);
  return value;
}

async function invoke(body: unknown, env: RuntimeEnv, role?: TestRole): Promise<Response> {
  const request = new Request(`${testEnv.OFFICIAL_ORIGIN}${GRADEBOOK_OPERATIONAL_WORKSPACE_ROUTE_V1}`, {
    method: 'POST', headers: await headers(role), body: JSON.stringify(body),
  });
  return onRequest({ request, env } as never);
}

const maintenancePayload = {
  maintenanceVersion: 1,
  operation: 'teacher-state',
  academicYearId: 'academic-year:legacy:2026',
  teacherReference: 'teacher:legacy:1',
} as const;

describe('retired teacher-assignment maintenance transport', () => {
  it('preserves opaque authentication and role checks before inspecting storage', async () => {
    const prepare = vi.fn(() => { throw new Error('sensitive-legacy-binding'); });
    const env = {...testEnv, GRADEBOOK_D1:{prepare,exec:vi.fn()}} satisfies RuntimeEnv;
    const unauthenticated = await invoke(maintenancePayload, env);
    const forbidden = await invoke(maintenancePayload, env, 'PROFESSOR');
    expect(unauthenticated.status).toBe(401);
    expect(forbidden.status).toBe(403);
    expect(unauthenticated.headers.get('Cache-Control')).toContain('no-store');
    expect(forbidden.headers.get('Cache-Control')).toContain('no-store');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects every former maintenance operation before the legacy runtime or binding', async () => {
    for (const operation of ['teacher-state','teacher-register','teacher-confirm-source-name','assignment-register','assignment-confirm']) {
      const prepare = vi.fn(() => { throw new Error('legacy-runtime-must-not-run'); });
      const response = await invoke({...maintenancePayload,operation}, {
        ...testEnv,
        RUNTIME_ENVIRONMENT:'production',
        GRADEBOOK_PRODUCTION_ENABLED:'true',
        GRADEBOOK_D1:{prepare,exec:vi.fn()},
      }, 'ADMINISTRADOR');
      expect(response.status).toBe(410);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(await response.json()).toEqual({state:'retired'});
      expect(prepare).not.toHaveBeenCalled();
    }
  });

  it('does not accept browser claims as a substitute for the relational read-only contract', async () => {
    const prepare = vi.fn(() => { throw new Error('legacy-runtime-must-not-run'); });
    const response = await invoke({...maintenancePayload,actorId:'browser',capability:'gradebook.persistence.admin'}, {
      ...testEnv,GRADEBOOK_D1:{prepare,exec:vi.fn()},
    }, 'ADMINISTRADOR');
    expect(response.status).toBe(410);
    expect(prepare).not.toHaveBeenCalled();
  });
});
