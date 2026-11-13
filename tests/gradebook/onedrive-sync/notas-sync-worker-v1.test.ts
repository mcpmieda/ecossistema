// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  },
  DurableObject: class {},
}));

const { default: worker, handleAdminV1, handleNotificationV1, sameSecretV1 } = await import('../../../workers/notas-onedrive-sync/index');
type Env = Parameters<typeof handleNotificationV1>[1];

function coordinatorMock() {
  const status = { settings: { enabled: false, paused: false, waitSeconds: 0, maxParallel: 6 }, activeYear: null, folders: [],
    breakerUntil: null, webhook: { active: false, expiresAt: null }, lastDeltaAt: null, files: [], events: [] };
  const stub = {
    notify: vi.fn(async () => undefined),
    tick: vi.fn(async () => undefined),
    status: vi.fn(async () => status),
    control: vi.fn(async () => status),
  };
  const namespace = { idFromName: vi.fn(() => 'id'), get: vi.fn(() => stub) };
  return { stub, namespace };
}

function envV1(extra: Partial<Env> = {}): Env {
  return {
    TENANT_ID: '00000000-0000-4000-8000-000000000001',
    GRAPH_CLIENT_ID: '00000000-0000-4000-8000-000000000002',
    NOTAS_SITE_ID: 'synthetic-site',
    NOTAS_SYNC_CLIENT_STATE: 'synthetic-client-state',
    ...extra,
  };
}
const origin = 'https://notas-onedrive-sync.example.test';
const context = () => {
  const work: Promise<unknown>[] = [];
  return { work, ctx: { waitUntil: (promise: Promise<unknown>) => work.push(promise) } as unknown as ExecutionContext };
};
const call = (request: Request, env: Env, ctx = context().ctx) =>
  worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, env, ctx);
const admin = { id: '00000000-0000-4000-8000-000000000003', name: 'Administração Sintética' };

describe('Notas OneDrive sync Worker', () => {
  it('answers the Graph validation handshake with the token as plain text', async () => {
    const response = await handleNotificationV1(
      new Request(`${origin}/graph/notificacoes?validationToken=abc%20123`, { method: 'POST' }), envV1());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/plain');
    expect(await response.text()).toBe('abc 123');
  });

  it('wakes the coordinator only for notifications with the right client state', async () => {
    for (const [clientState, wakes] of [['synthetic-client-state', true], ['forged', false]] as const) {
      const { stub, namespace } = coordinatorMock();
      const { ctx, work } = context();
      const response = await call(new Request(`${origin}/graph/notificacoes`, {
        method: 'POST', body: JSON.stringify({ value: [{ clientState, subscriptionId: 's' }] }),
      }), envV1({ NOTAS_SYNC: namespace as never }), ctx);
      await Promise.all(work);
      expect(response.status).toBe(202);
      expect(stub.notify).toHaveBeenCalledTimes(wakes ? 1 : 0);
    }
  });

  it('has no public route to operate the sync', async () => {
    for (const [method, path] of [['POST', '/sonda'], ['GET', '/status'], ['POST', '/controle'], ['GET', '/']] as const) {
      expect((await call(new Request(`${origin}${path}`, { method }), envV1())).status, `${method} ${path}`).toBe(404);
    }
  });

  it('admin entry: validates the request and records who changed what', async () => {
    const { stub, namespace } = coordinatorMock();
    const env = envV1({ NOTAS_SYNC: namespace as never });
    expect(await handleAdminV1(env, admin, { action: 'status' })).toMatchObject({ state: 'status' });
    expect(await handleAdminV1(env, admin, { action: 'pause' })).toMatchObject({ state: 'status' });
    expect(stub.control).toHaveBeenCalledWith({ action: 'pause' }, admin);
    expect(await handleAdminV1(env, admin, { action: 'drop' })).toMatchObject({ state: 'invalid-request' });
    expect(await handleAdminV1(env, admin, { action: 'set-wait', seconds: 9999 })).toMatchObject({ state: 'invalid-request' });
    expect(await handleAdminV1(env, { id: '', name: '' }, { action: 'status' })).toMatchObject({ state: 'invalid-request' });
  });

  it('admin entry: a coordinator failure is reported as unavailable', async () => {
    const { stub, namespace } = coordinatorMock();
    stub.status.mockRejectedValueOnce(new Error('down'));
    expect(await handleAdminV1(envV1({ NOTAS_SYNC: namespace as never }), admin, { action: 'status' })).toMatchObject({ state: 'unavailable' });
  });

  it('runs the coordinator tick on the cron', async () => {
    const { stub, namespace } = coordinatorMock();
    const { ctx, work } = context();
    await worker.scheduled({} as ScheduledController, envV1({ NOTAS_SYNC: namespace as never }), ctx);
    await Promise.all(work);
    expect(stub.tick).toHaveBeenCalledOnce();
  });

  it('compares secrets without accepting an empty expected value', () => {
    expect(sameSecretV1('a', 'a')).toBe(true);
    expect(sameSecretV1('a', 'b')).toBe(false);
    expect(sameSecretV1('ab', 'a')).toBe(false);
    expect(sameSecretV1('', '')).toBe(false);
  });
});
