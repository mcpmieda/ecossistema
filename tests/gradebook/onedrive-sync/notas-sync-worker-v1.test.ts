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

const { default: worker, handleAdminV1, handleNotificationV1, handleReadRequestV1, sameSecretV1 } = await import('../../../workers/notas-onedrive-sync/index');
const { readFileForTestsV1 } = await import('../../../server/gradebook/onedrive-sync/sync-coordinator-v1');
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

describe('read through the public address (next to the database)', () => {
  const token = 'r'.repeat(40);
  const input = { driveId: 'd', itemId: 'i', name: 'synthetic.xlsb', hash: null, modifiedAt: '2026-11-14T10:00:00Z',
    maxBytes: 1, expectedYear: 2026 };
  const result = { outcome: 'applied', code: null, readHash: null, readMs: 1, savedToWrittenMs: 1 } as const;
  const post = (auth: string | null, body: unknown = input) => new Request(`${origin}/ler`, {
    method: 'POST', body: JSON.stringify(body), headers: auth === null ? {} : { Authorization: `Bearer ${auth}` },
  });

  it('refuses without the secret, with a wrong one or when the Worker has none', async () => {
    const read = vi.fn(async () => result);
    expect((await handleReadRequestV1(post(null), envV1({ NOTAS_SYNC_READ_TOKEN: token }), read)).status).toBe(401);
    expect((await handleReadRequestV1(post('x'.repeat(40)), envV1({ NOTAS_SYNC_READ_TOKEN: token }), read)).status).toBe(401);
    expect((await handleReadRequestV1(post(''), envV1(), read)).status).toBe(401);
    expect((await handleReadRequestV1(post('short'), envV1({ NOTAS_SYNC_READ_TOKEN: 'short' }), read)).status).toBe(401);
    expect((await handleReadRequestV1(post(token, { name: 1 }), envV1({ NOTAS_SYNC_READ_TOKEN: token }), read)).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads with the secret', async () => {
    const read = vi.fn(async () => result);
    const response = await handleReadRequestV1(post(token), envV1({ NOTAS_SYNC_READ_TOKEN: token }), read);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(read).toHaveBeenCalledWith(input);
  });

  const self = () => ({ fetch: vi.fn(async () => Response.json({ ...result, code: 'SELF' })) });
  const env = (reader: ReturnType<typeof self>) => ({ SELF: reader, NOTAS_SYNC_PUBLIC_URL: origin, NOTAS_SYNC_READ_TOKEN: token });

  it('the coordinator reads through the public address when it can', async () => {
    const reader = self();
    const publicFetch = vi.fn(async () => Response.json(result));
    expect(await readFileForTestsV1(env(reader), input, publicFetch as unknown as typeof fetch)).toEqual(result);
    expect(publicFetch).toHaveBeenCalledWith(`${origin}/ler`, expect.objectContaining({ method: 'POST' }));
    expect(reader.fetch).not.toHaveBeenCalled();
  });

  it('falls back to SELF only when the public read was refused before reading', async () => {
    const reader = self();
    const refused = vi.fn(async () => new Response(null, { status: 401 }));
    expect((await readFileForTestsV1(env(reader), input, refused as unknown as typeof fetch)).code).toBe('SELF');
    const failed = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(readFileForTestsV1(env(self()), input, failed as unknown as typeof fetch)).rejects.toThrow('http-500');
    const noToken = self();
    expect((await readFileForTestsV1({ SELF: noToken }, input, refused as unknown as typeof fetch)).code).toBe('SELF');
  });
});
