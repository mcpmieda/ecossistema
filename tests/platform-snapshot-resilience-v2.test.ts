// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_CAPABILITIES } from '../shared/platform-contract';
import { platformSnapshotSchemaV2 } from '../shared/platform-snapshot-v2';
import { buildPlatformSnapshot } from '../server/platform/snapshot';
import { onRequest as bootstrap } from '../functions/api/platform/bootstrap';
import { SESSION_COOKIE } from '../server/auth/session';
import { seal } from '../server/auth/sealed';
import { testEnv } from './fixtures';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('platform snapshot contract', () => {
  it('rejects malformed nested data before rendering', () => {
    const snapshot = buildPlatformSnapshot({ correlationId: 'synthetic' }, PLATFORM_CAPABILITIES);
    expect(platformSnapshotSchemaV2.safeParse(snapshot).success).toBe(true);
    expect(platformSnapshotSchemaV2.safeParse({ ...snapshot, coreModules: [{}] }).success).toBe(false);
    expect(platformSnapshotSchemaV2.safeParse({ ...snapshot, releaseState: 'candidate' }).success).toBe(false);
  });
});

async function request(path: string, roles?: string[], origin = testEnv.OFFICIAL_ORIGIN) {
  const headers = new Headers();
  if (roles) headers.set('Cookie', `${SESSION_COOKIE}=${await seal({
    oid: '11111111-1111-4111-8111-111111111111', name: 'SYNTHETIC USER', username: 'synthetic@example.invalid',
    roles, exp: Math.floor(Date.now() / 1000) + 600,
  }, testEnv.SESSION_SECRET, 'admin-session')}`);
  return new Request(`${origin}${path}`, { headers });
}
describe('native bootstrap HTTP boundaries', () => {
  it('opens only the authorized native catalogue with zero Microsoft or database requests', async () => {
    const network = vi.fn(async () => { throw new Error('External access is not allowed in bootstrap'); });
    vi.stubGlobal('fetch', network);
    const response = await bootstrap({ env: testEnv, request: await request('/api/platform/bootstrap', ['ADMINISTRADOR']) } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    const body = await response.json();
    const parsed = platformSnapshotSchemaV2.parse(body);
    expect(parsed.coreModules.length).toBeGreaterThan(0);
    expect(body).not.toHaveProperty('registeredModules');
    expect(network).not.toHaveBeenCalled();
  });
  it('rejects anonymous, wrong-role and cross-origin requests before external reads', async () => {
    const network = vi.fn(); vi.stubGlobal('fetch', network);
    expect((await bootstrap({ env: testEnv, request: await request('/api/platform/bootstrap') } as never)).status).toBe(401);
    expect((await bootstrap({ env: testEnv, request: await request('/api/platform/bootstrap', ['PROFESSOR']) } as never)).status).toBe(403);
    // A request addressed to another host is misdirected (421), not an authenticated role denial.
    expect((await bootstrap({ env: testEnv, request: await request('/api/platform/bootstrap', ['ADMINISTRADOR'], 'https://untrusted.invalid') } as never)).status).toBe(421);
    expect(network).not.toHaveBeenCalled();
  });
});
