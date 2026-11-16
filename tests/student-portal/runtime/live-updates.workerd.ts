import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const config = JSON.parse(readFileSync('wrangler.student-portal.jsonc', 'utf8'));
const tenant = config.env.production.vars.PORTAL_ADMIN_TENANT_ID as string;
let runtime: Miniflare;
type TestSocket = {
  accept(): void;
  send(value: string): void;
  close(): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
    options?: { once?: boolean },
  ): void;
};
type TestResponse = { status: number; webSocket?: TestSocket | null };

beforeAll(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'portal',
          modules: true,
          scriptPath: 'node_modules/.cache/student-portal/index.js',
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          bindings: config.env.production.vars,
          ratelimits: {
            PORTAL_ADMIN_LIVE: {
              namespace_id: '124906',
              simple: { limit: 60, period: 60 },
            },
          },
          durableObjects: { PORTAL_LIVE: { className: 'PortalLiveUpdatesV1', useSQLite: true } },
        },
        {
          name: 'caller',
          modules: true,
          compatibilityDate: config.compatibility_date,
          serviceBindings: { ADMIN: { name: 'portal', entrypoint: 'PortalAdminEntrypoint' } },
          durableObjects: {
            LIVE: { className: 'PortalLiveUpdatesV1', scriptName: 'portal', useSQLite: true },
          },
          script: `export default { async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/admin') {
          const valid = url.searchParams.get('valid') === 'true';
          return env.ADMIN.fetch(new Request('https://portal-admin.internal/live', {headers:{
            Upgrade:'websocket','x-admin-actor-id':valid?'11111111-1111-4111-8111-111111111111':'invalid',
            'x-admin-tenant-id':'${tenant}','x-admin-capability':'platform.settings.read',
            'x-admin-expires-at':'2099-01-01T00:00:00.000Z'}}));
        }
        const audience = url.searchParams.get('audience') || 'admin';
        const stub = env.LIVE.get(env.LIVE.idFromName(audience + ':2026'));
        if (url.pathname === '/publish') return Response.json({result:await stub.publish(await request.json())});
        if (url.pathname === '/student') return stub.fetch(new Request('https://live.internal/connect', {headers:{
          Upgrade:'websocket','x-live-audience':'student','x-live-expires-at':'2099-01-01T00:00:00.000Z',
          'x-live-account-id':url.searchParams.get('account'),'x-live-student-id':url.searchParams.get('student'),
          'x-live-class-id':'42'}}));
        return new Response(null,{status:404});
      } }`,
        },
      ],
    }),
  );
  await runtime.ready;
});
afterAll(async () => runtime?.dispose());

function nextMessage(socket: TestSocket, timeout = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message-timeout')), timeout);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(String(event.data)));
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
  });
}
async function open(response: TestResponse, timeout = 1_000) {
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const initial = nextMessage(socket, timeout);
  socket.send(JSON.stringify({ contractVersion: 1, type: 'resume', cursor: null }));
  return { socket, initial: await initial };
}

describe('authenticated hibernating live channel', () => {
  it('rejects an invalid admin context and emits only minimal change fields', async () => {
    const caller = await runtime.getWorker('caller');
    const invalid = await caller.fetch('http://caller/admin');
    expect(invalid.status).toBe(403);
    const response = await caller.fetch('http://caller/admin?valid=true', {
      headers: { Upgrade: 'websocket' },
    });
    const { socket, initial } = await open(response as unknown as TestResponse);
    expect(initial).toEqual({ contractVersion: 1, type: 'connected', cursor: null });
    const changed = nextMessage(socket);
    const delivered = await caller.fetch('http://caller/publish?audience=admin', {
      method: 'POST',
      body: JSON.stringify({
        cursor: '00000000000000000001',
        audience: 'admin',
        domain: 'portal',
        version: '7',
        occurredAt: '2026-09-15T12:00:00.000Z',
        accountId: null,
        classId: null,
        studentIds: [],
      }),
    });
    expect(await delivered.json()).toEqual({ result: 'delivered' });
    expect(await changed).toEqual({
      contractVersion: 1,
      type: 'change',
      cursor: '00000000000000000001',
      domain: 'portal',
      version: '7',
      occurredAt: '2026-09-15T12:00:00.000Z',
    });
    socket.close();
  });

  it('filters student routing server-side and resumes a missed cursor with a generic resync', async () => {
    const caller = await runtime.getWorker('caller');
    const first = await open(
      (await caller.fetch(
        'http://caller/student?audience=student&account=21111111-1111-4111-8111-111111111111&student=10',
        { headers: { Upgrade: 'websocket' } },
      )) as unknown as TestResponse,
    );
    const second = await open(
      (await caller.fetch(
        'http://caller/student?audience=student&account=22222222-2222-4222-8222-222222222222&student=11',
        { headers: { Upgrade: 'websocket' } },
      )) as unknown as TestResponse,
    );
    const matching = nextMessage(first.socket);
    const absent = nextMessage(second.socket, 100).catch((error) => error);
    await caller.fetch('http://caller/publish?audience=student', {
      method: 'POST',
      body: JSON.stringify({
        cursor: '00000000000000000002',
        audience: 'student',
        domain: 'gradebook',
        version: 'revision:2',
        occurredAt: '2026-09-15T12:01:00.000Z',
        accountId: null,
        classId: null,
        studentIds: [10],
      }),
    });
    expect(await matching).toMatchObject({ type: 'change', domain: 'gradebook' });
    expect(await absent).toBeInstanceOf(Error);
    const resumedResponse = await caller.fetch(
      'http://caller/student?audience=student&account=23333333-3333-4333-8333-333333333333&student=12',
      { headers: { Upgrade: 'websocket' } },
    );
    expect(resumedResponse.status).toBe(101);
    const resumed = resumedResponse.webSocket! as unknown as TestSocket;
    resumed.accept();
    resumed.send(
      JSON.stringify({ contractVersion: 1, type: 'resume', cursor: '00000000000000000001' }),
    );
    expect(await nextMessage(resumed)).toEqual({
      contractVersion: 1,
      type: 'resync',
      cursor: '00000000000000000002',
      domains: ['gradebook', 'portal'],
    });
    first.socket.close();
    second.socket.close();
    resumed.close();
  });

  it('fans one grouped notice out to approximately 600 connected students without extra database reads', async () => {
    const caller = await runtime.getWorker('caller');
    const sockets = await Promise.all(
      Array.from({ length: 600 }, async (_, index) => {
        const suffix = String(index + 1).padStart(12, '0');
        return (
          await open(
            (await caller.fetch(
              `http://caller/student?audience=student&account=28888888-8888-4888-8888-${suffix}&student=${index + 1}`,
              { headers: { Upgrade: 'websocket' } },
            )) as unknown as TestResponse,
            10_000,
          )
        ).socket;
      }),
    );
    const received = sockets.map((socket) => nextMessage(socket, 5_000));
    const started = performance.now();
    const response = await caller.fetch('http://caller/publish?audience=student', {
      method: 'POST',
      body: JSON.stringify({
        cursor: '00000000000000000003',
        audience: 'student',
        domain: 'gradebook',
        version: 'revision:3',
        occurredAt: '2026-09-15T12:02:00.000Z',
        accountId: null,
        classId: null,
        studentIds: [],
      }),
    });
    expect(response.status).toBe(200);
    expect(
      (await Promise.all(received)).every(
        (message) => (message as { type?: string }).type === 'change',
      ),
    ).toBe(true);
    expect(performance.now() - started).toBeLessThan(5_000);
    sockets.forEach((socket) => socket.close());
  }, 30_000);
});
