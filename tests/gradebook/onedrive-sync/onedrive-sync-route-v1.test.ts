import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError } from '../../../server/auth/session';
import { handleOneDriveSyncRequestV1 } from '../../../server/gradebook/http/onedrive-sync-routes-v1';
import type { RuntimeEnv } from '../../../server/env';
import { testEnv } from '../../fixtures';

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('../../../server/auth/session', async (original) => ({
  ...await original<typeof import('../../../server/auth/session')>(), requireAuth: mocks.auth,
}));

const session = { oid: '11111111-1111-4111-8111-111111111111', name: 'Administração Sintética', roles: ['ADMINISTRADOR'], exp: 4102444800 };
const statusAnswer = {
  contractVersion: 1, state: 'status',
  status: { settings: { enabled: false, paused: false, waitSeconds: 0, maxParallel: 6 }, activeYear: null, folders: [],
    breakerUntil: null, webhook: { active: false, expiresAt: null }, lastDeltaAt: null, files: [], events: [] },
};
const request = (body: unknown, method = 'POST') => new Request(`${testEnv.OFFICIAL_ORIGIN}/api/gradebook/onedrive-sync`, {
  method, headers: { Origin: testEnv.OFFICIAL_ORIGIN, 'Content-Type': 'application/json' },
  ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
});
function envWith(handle = vi.fn(async () => statusAnswer)) {
  return { env: { ...testEnv, NOTAS_SYNC_SERVICE: { handle } } as unknown as RuntimeEnv, handle };
}
beforeEach(() => { mocks.auth.mockReset().mockResolvedValue(session); });

describe('OneDrive sync admin route', () => {
  it('ignores other paths', async () => {
    const { env } = envWith();
    expect(await handleOneDriveSyncRequestV1(new Request(`${testEnv.OFFICIAL_ORIGIN}/api/gradebook/outra`), env)).toBeNull();
  });

  it('forwards a valid request with the admin as the actor', async () => {
    const { env, handle } = envWith();
    const response = await handleOneDriveSyncRequestV1(request({ action: 'pause' }), env);
    expect(response?.status).toBe(200);
    expect(handle).toHaveBeenCalledWith({ id: session.oid, name: session.name }, { action: 'pause' });
    expect(response?.headers.get('Cache-Control')).toContain('no-store');
  });

  it('requires a signed-in admin', async () => {
    mocks.auth.mockRejectedValueOnce(new AuthenticationError());
    const { env, handle } = envWith();
    expect((await handleOneDriveSyncRequestV1(request({ action: 'status' }), env))?.status).toBe(401);
    mocks.auth.mockResolvedValueOnce({ ...session, roles: ['PROFESSOR'] });
    expect((await handleOneDriveSyncRequestV1(request({ action: 'status' }), env))?.status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
  });

  it('refuses invalid requests before reaching the Worker', async () => {
    const { env, handle } = envWith();
    expect((await handleOneDriveSyncRequestV1(request({ action: 'set-parallel', count: 50 }), env))?.status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
    await expect(handleOneDriveSyncRequestV1(request(null, 'GET'), env)).rejects.toMatchObject({ status: 405 });
  });

  it('is unavailable without the binding or with an unexpected answer', async () => {
    expect((await handleOneDriveSyncRequestV1(request({ action: 'status' }), testEnv as unknown as RuntimeEnv))?.status).toBe(503);
    const { env } = envWith(vi.fn(async () => ({ unexpected: true })) as never);
    expect((await handleOneDriveSyncRequestV1(request({ action: 'status' }), env))?.status).toBe(503);
  });
});
