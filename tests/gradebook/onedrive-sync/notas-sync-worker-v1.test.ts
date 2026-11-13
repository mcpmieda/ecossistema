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

const { default: worker, handleNotificationV1, parseControlV1, sameSecretV1 } = await import('../../../workers/notas-onedrive-sync/index');
type Env = Parameters<typeof handleNotificationV1>[1];

function coordinatorMock() {
  const stub = {
    notify: vi.fn(async () => undefined),
    tick: vi.fn(async () => undefined),
    status: vi.fn(async () => ({ files: [] })),
    control: vi.fn(async () => ({ files: [] })),
  };
  const namespace = { idFromName: vi.fn(() => 'id'), get: vi.fn(() => stub) };
  return { stub, namespace };
}

function envV1(extra: Partial<Env> = {}): Env {
  return {
    TENANT_ID: '00000000-0000-4000-8000-000000000001',
    GRAPH_CLIENT_ID: '00000000-0000-4000-8000-000000000002',
    NOTAS_SITE_ID: 'synthetic-site',
    NOTAS_FOLDER_PATH: 'PASTA SINTÉTICA',
    NOTAS_SYNC_CLIENT_STATE: 'synthetic-client-state',
    NOTAS_SYNC_PROBE_TOKEN: 'synthetic-probe-token',
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
const bearer = { Authorization: 'Bearer synthetic-probe-token' };

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

  it('refuses probe, status and control without the bearer token', async () => {
    for (const [method, path] of [['POST', '/sonda'], ['GET', '/status'], ['POST', '/controle']] as const) {
      for (const authorization of [undefined, 'Bearer wrong', 'synthetic-probe-token']) {
        const headers = authorization ? { Authorization: authorization } : undefined;
        const response = await call(new Request(`${origin}${path}`, { method, headers }), envV1());
        expect(response.status, `${method} ${path}`).toBe(401);
      }
    }
  });

  it('serves status and validated control commands to the operator', async () => {
    const { stub, namespace } = coordinatorMock();
    const env = envV1({ NOTAS_SYNC: namespace as never });
    expect((await call(new Request(`${origin}/status`, { headers: bearer }), env)).status).toBe(200);
    const ok = await call(new Request(`${origin}/controle`, { method: 'POST', headers: bearer, body: JSON.stringify({ action: 'pause' }) }), env);
    expect(ok.status).toBe(200);
    expect(stub.control).toHaveBeenCalledWith({ action: 'pause' }, 'token-de-operacao');
    const bad = await call(new Request(`${origin}/controle`, { method: 'POST', headers: bearer, body: JSON.stringify({ action: 'drop' }) }), env);
    expect(bad.status).toBe(400);
  });

  it('parses only known commands with valid arguments', () => {
    expect(parseControlV1({ action: 'enable' })).toEqual({ action: 'enable' });
    expect(parseControlV1({ action: 'set-wait', seconds: 10 })).toEqual({ action: 'set-wait', seconds: 10 });
    expect(parseControlV1({ action: 'set-wait' })).toBeNull();
    expect(parseControlV1({ action: 'read-now', fileId: '' })).toBeNull();
    expect(parseControlV1(null)).toBeNull();
  });

  it('runs the coordinator tick on the cron', async () => {
    const { stub, namespace } = coordinatorMock();
    const { ctx, work } = context();
    await worker.scheduled({} as ScheduledController, envV1({ NOTAS_SYNC: namespace as never }), ctx);
    await Promise.all(work);
    expect(stub.tick).toHaveBeenCalledOnce();
  });

  it('serves nothing else', async () => {
    expect((await call(new Request(`${origin}/`), envV1())).status).toBe(404);
    expect((await call(new Request(`${origin}/sonda`), envV1())).status).toBe(404);
  });

  it('compares secrets without accepting an empty expected value', () => {
    expect(sameSecretV1('a', 'a')).toBe(true);
    expect(sameSecretV1('a', 'b')).toBe(false);
    expect(sameSecretV1('ab', 'a')).toBe(false);
    expect(sameSecretV1('', '')).toBe(false);
  });
});
