// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_CAPABILITIES } from '../shared/platform-contract';
import { platformSnapshotSchemaV2, platformRouteUnavailableV2, platformRouteNeedsMicrosoftV2, PLATFORM_SOURCE_SECTIONS_V2 } from '../shared/platform-snapshot-v2';
import { buildPlatformSnapshot, EXPECTED_PLATFORM_LISTS, getPlatformSnapshotV2, type PlatformSnapshotDependenciesV2 } from '../server/platform/snapshot';
import { GraphError, GraphTokenError } from '../server/graph/client';
import { onRequest as bootstrap } from '../functions/api/platform/bootstrap';
import { onRequest as auxiliary } from '../functions/api/platform/snapshot-v2';
import { SESSION_COOKIE } from '../server/auth/session';
import { seal } from '../server/auth/sealed';
import { testEnv } from './fixtures';

const lists = EXPECTED_PLATFORM_LISTS.map((displayName, index) => ({ id: String(index), displayName }));
function dependencies(fail?: string) {
  const token = vi.fn(async () => 'synthetic-private-token');
  const pages = vi.fn<PlatformSnapshotDependenciesV2['pages']>(async (_env, path, supplied) => {
    expect(supplied).toBe('synthetic-private-token');
    if (path.includes('?$select=id,displayName')) return lists;
    const item = lists.find((list) => path.includes(`/lists/${list.id}/items`));
    if (item?.displayName === fail) throw new GraphError(429, 'synthetic', 90);
    return [];
  });
  return { token, pages };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('section-aware Microsoft snapshot', () => {
  it('does not let a module list failure close any page or the native application access', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = dependencies('PLATAFORMA_MODULOS');
    const snapshot = await getPlatformSnapshotV2(testEnv, PLATFORM_CAPABILITIES, source);
    expect(snapshot.unavailableSections).toEqual(['modules']);
    expect(snapshot.retryAfterSeconds).toBe(90);
    expect(platformSnapshotSchemaV2.safeParse(snapshot).success).toBe(true);
    expect(platformRouteUnavailableV2('operacao', snapshot)).toBe(false);
    expect(platformRouteUnavailableV2('configuracoes', snapshot)).toBe(false);
    expect(platformRouteUnavailableV2('banco-de-notas', snapshot)).toBe(false);
    expect(platformRouteUnavailableV2('painel-do-aluno', snapshot)).toBe(false);
    expect(source.token).toHaveBeenCalledOnce();
    // The list catalogue and the module list: the settings, audit and migration lists are no longer read (#1473).
    expect(source.pages).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toMatchObject({
      message: 'platform_microsoft_source_unavailable', stage: 'section', section: 'modules',
      failureKind: 'graph-response', providerStatus: 429, providerCorrelationId: 'synthetic',
      correlationId: snapshot.correlationId,
    });
  });
  it('identifies a root outage explicitly and does not include raw provider errors or credentials', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = dependencies();
    source.token.mockRejectedValue(new Error('synthetic-sensitive-provider-error'));
    const snapshot = await getPlatformSnapshotV2(testEnv, PLATFORM_CAPABILITIES, source);
    expect(snapshot.unavailableSections).toEqual([...PLATFORM_SOURCE_SECTIONS_V2]);
    expect(snapshot.retryAfterSeconds).toBe(30);
    expect(platformRouteUnavailableV2('configuracoes', snapshot)).toBe(false);
    expect(snapshot.coreModules.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-sensitive');
    expect(source.pages).not.toHaveBeenCalled();
    const recorded = String(warning.mock.calls[0]?.[0]);
    expect(JSON.parse(recorded)).toMatchObject({
      message: 'platform_microsoft_source_unavailable', stage: 'token', failureKind: 'runtime', correlationId: snapshot.correlationId,
    });
    expect(recorded).not.toContain('synthetic-sensitive');
    expect(recorded).not.toContain('synthetic-private-token');
  });
  it('distinguishes a list catalogue failure from token and section failures', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = dependencies();
    source.pages.mockRejectedValueOnce(new GraphError(403, 'provider-correlation'));
    const snapshot = await getPlatformSnapshotV2(testEnv, PLATFORM_CAPABILITIES, source);
    expect(snapshot.unavailableSections).toEqual([...PLATFORM_SOURCE_SECTIONS_V2]);
    expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toMatchObject({
      message: 'platform_microsoft_source_unavailable', stage: 'list-catalogue', failureKind: 'graph-response',
      providerStatus: 403, providerCorrelationId: 'provider-correlation', correlationId: snapshot.correlationId,
    });
  });
  it('reports a sanitized token preparation stage without its exception message', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = dependencies();
    source.token.mockRejectedValue(new GraphTokenError('assertion', 'A'));
    const snapshot = await getPlatformSnapshotV2(testEnv, PLATFORM_CAPABILITIES, source);
    const recorded = String(warning.mock.calls[0]?.[0]);
    expect(JSON.parse(recorded)).toMatchObject({
      message: 'platform_microsoft_source_unavailable', stage: 'token', failureKind: 'token-assertion',
      tokenStage: 'assertion', credentialSlot: 'A', correlationId: snapshot.correlationId,
    });
    expect(recorded).not.toContain('Graph token preparation failed');
  });
  it('does not request sources without the current capability and never calls Microsoft before authorization', async () => {
    const source = dependencies();
    await expect(getPlatformSnapshotV2(testEnv, [], source)).rejects.toThrow();
    expect(source.token).not.toHaveBeenCalled();
    const snapshot = await getPlatformSnapshotV2(testEnv, ['platform.snapshot.read'], source);
    expect(source.token).toHaveBeenCalledOnce(); expect(source.pages).toHaveBeenCalledOnce();
    expect(snapshot.registeredModules).toEqual([]); expect(snapshot.operational).toBeNull();
  });
  it('distinguishes missing lists from an unreadable list catalogue', async () => {
    const source = dependencies();
    source.pages.mockResolvedValue([]);
    const snapshot = await getPlatformSnapshotV2(testEnv, PLATFORM_CAPABILITIES, source);
    expect(snapshot.unavailableSections).toEqual([]);
    expect(snapshot.foundation).toMatchObject({ status: 'degraded', missingPlatformLists: EXPECTED_PLATFORM_LISTS });
  });
  it('rejects malformed nested data before rendering and keeps static planned pages independent', () => {
    const snapshot = buildPlatformSnapshot({ lists: [], moduleItems: [], correlationId: 'synthetic' }, PLATFORM_CAPABILITIES);
    expect(platformSnapshotSchemaV2.safeParse({ ...snapshot, registeredModules: [{}] }).success).toBe(false);
    expect(platformSnapshotSchemaV2.safeParse({ ...snapshot, unavailableSections: ['untrusted'] }).success).toBe(false);
    expect(platformRouteNeedsMicrosoftV2('banco-de-notas')).toBe(false);
    expect(platformRouteNeedsMicrosoftV2('painel-do-aluno')).toBe(false);
    expect(platformRouteNeedsMicrosoftV2('configuracoes')).toBe(false);
    expect(platformRouteNeedsMicrosoftV2('operacao')).toBe(false);
    expect(platformRouteUnavailableV2('operacao', { ...snapshot, unavailableSections: [...PLATFORM_SOURCE_SECTIONS_V2] })).toBe(false);
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
    expect(body).toMatchObject({ auxiliaryState: 'not-loaded' });
    const parsed = platformSnapshotSchemaV2.parse(body);
    expect(parsed.coreModules.length).toBeGreaterThan(0);
    expect(network).not.toHaveBeenCalled();
  });
  it.each([bootstrap, auxiliary])('rejects anonymous, wrong-role and cross-origin requests before external reads', async (handler) => {
    const network = vi.fn(); vi.stubGlobal('fetch', network);
    expect((await handler({ env: testEnv, request: await request('/api/platform/bootstrap') } as never)).status).toBe(401);
    expect((await handler({ env: testEnv, request: await request('/api/platform/bootstrap', ['PROFESSOR']) } as never)).status).toBe(403);
    // A request addressed to another host is misdirected (421), not an authenticated role denial.
    expect((await handler({ env: testEnv, request: await request('/api/platform/bootstrap', ['ADMINISTRADOR'], 'https://untrusted.invalid') } as never)).status).toBe(421);
    expect(network).not.toHaveBeenCalled();
  });
});

describe('platform snapshot cache (issue #1426, 20)', () => {
  it('reuses a complete answer for 5 min, shares simultaneous reads and never keeps a partial one', async () => {
    const { forgetPlatformSnapshotsV2, getPlatformSnapshotCachedV2, PLATFORM_SNAPSHOT_CACHE_MS_V2 } = await import('../server/platform/snapshot');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    forgetPlatformSnapshotsV2();
    let clock = 1_000_000;
    const partial = dependencies('PLATAFORMA_MODULOS');
    const read = (source: PlatformSnapshotDependenciesV2) => getPlatformSnapshotCachedV2(testEnv, PLATFORM_CAPABILITIES, source, () => clock);
    expect((await read(partial)).unavailableSections).toContain('modules');
    await read(partial);
    expect(partial.token).toHaveBeenCalledTimes(2);
    const healthy = dependencies();
    await Promise.all([read(healthy), read(healthy), read(healthy)]);
    await read(healthy);
    expect(healthy.token).toHaveBeenCalledTimes(1);
    clock += PLATFORM_SNAPSHOT_CACHE_MS_V2 + 1;
    await read(healthy);
    expect(healthy.token).toHaveBeenCalledTimes(2);
    forgetPlatformSnapshotsV2();
  });
});
