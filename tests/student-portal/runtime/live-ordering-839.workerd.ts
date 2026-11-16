import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const config = JSON.parse(readFileSync('wrangler.student-portal.jsonc', 'utf8'));
const tenant = config.env.production.vars.PORTAL_ADMIN_TENANT_ID as string;
let runtime: Miniflare;
type Socket = {
  accept(): void;
  send(value: string): void;
  close(): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
    options?: { once?: boolean },
  ): void;
};
type SocketResponse = { status: number; webSocket?: Socket | null };
const sockets = new Set<Socket>();
function close(socket: Socket) {
  // Each test releases its sockets; teardown releases only those left by a failed test.
  if (sockets.delete(socket)) socket.close();
}
beforeAll(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'portal839',
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
          name: 'caller839',
          modules: true,
          compatibilityDate: config.compatibility_date,
          serviceBindings: { ADMIN: { name: 'portal839', entrypoint: 'PortalAdminEntrypoint' } },
          durableObjects: {
            LIVE: { className: 'PortalLiveUpdatesV1', scriptName: 'portal839', useSQLite: true },
          },
          script: `export default { async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/admin') return env.ADMIN.fetch(new Request('https://portal-admin.internal/live', {headers:{
          Upgrade:'websocket','x-admin-actor-id':url.searchParams.get('actor'),
          'x-admin-tenant-id':'${tenant}','x-admin-capability':'platform.settings.read',
          'x-admin-expires-at':'2099-01-01T00:00:00.000Z'}}));
        const audience = url.searchParams.get('audience') || 'admin';
        const stub = env.LIVE.get(env.LIVE.idFromName(audience + ':2026'));
        if (url.pathname === '/publish') return Response.json({ result: await stub.publish(await request.json()) });
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
afterAll(async () => {
  try {
    sockets.forEach(close);
  } finally {
    await runtime?.dispose();
  }
});

function next(socket: Socket, timeout = 2_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synthetic-message-timeout')), timeout);
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
async function open(path: string, cursor: string | null = null) {
  const caller = await runtime.getWorker('caller839');
  const response = (await caller.fetch(`http://caller839${path}`, {
    headers: { Upgrade: 'websocket' },
  })) as unknown as SocketResponse;
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  sockets.add(socket);
  socket.accept();
  const received = next(socket);
  socket.send(JSON.stringify({ contractVersion: 1, type: 'resume', cursor }));
  return { socket, initial: await received };
}
async function publish(
  cursor: number,
  domain: 'gradebook' | 'portal',
  audience: 'admin' | 'student' = 'admin',
  studentIds: number[] = [],
) {
  const caller = await runtime.getWorker('caller839');
  const response = await caller.fetch(`http://caller839/publish?audience=${audience}`, {
    method: 'POST',
    body: JSON.stringify({
      cursor: String(cursor).padStart(20, '0'),
      audience,
      domain,
      version: `revision:${cursor}`,
      occurredAt: '2026-09-17T15:54:00.000Z',
      accountId: null,
      classId: null,
      studentIds,
    }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

it('does not lose a late committed domain across two independent administrative contexts', async () => {
  const a = await open('/admin?actor=11111111-1111-4111-8111-111111111111');
  const b = await open('/admin?actor=22222222-2222-4222-8222-222222222222');
  let pair = Promise.all([next(a.socket), next(b.socket)]);
  await publish(100, 'portal');
  expect((await pair).every((message) => (message as { type: string }).type === 'change')).toBe(
    true,
  );
  pair = Promise.all([next(a.socket), next(b.socket)]);
  expect(await publish(99, 'gradebook')).toEqual({ result: 'duplicate' });
  expect(await pair).toEqual(
    Array(2).fill({
      contractVersion: 1,
      type: 'resync',
      cursor: '00000000000000000100',
      domains: ['gradebook'],
    }),
  );
  close(a.socket);
  close(b.socket);
});

it('revalidates on reconnect even with an equal high-water cursor or a cursor ahead of the server', async () => {
  await publish(200, 'portal');
  const equal = await open(
    '/admin?actor=33333333-3333-4333-8333-333333333333',
    '00000000000000000200',
  );
  expect(equal.initial).toEqual({
    contractVersion: 1,
    type: 'resync',
    cursor: '00000000000000000200',
    domains: ['gradebook', 'portal'],
  });
  const ahead = await open(
    '/admin?actor=44444444-4444-4444-8444-444444444444',
    '00000000000000000999',
  );
  expect(ahead.initial).toEqual(equal.initial);
  close(equal.socket);
  close(ahead.socket);
});

it('filters late events before a resync and keeps student routing out of the browser message', async () => {
  const a = await open(
    '/student?audience=student&account=51111111-1111-4111-8111-111111111111&student=10',
  );
  const b = await open(
    '/student?audience=student&account=52222222-2222-4222-8222-222222222222&student=11',
  );
  let changed = next(a.socket);
  await publish(300, 'gradebook', 'student', [10]);
  await changed;
  const absent = next(b.socket, 150).catch((error) => error);
  changed = next(a.socket);
  await publish(299, 'portal', 'student', [10]);
  const message = await changed;
  expect(message).toEqual({
    contractVersion: 1,
    type: 'resync',
    cursor: '00000000000000000300',
    domains: ['portal'],
  });
  expect(await absent).toBeInstanceOf(Error);
  expect(JSON.stringify(message)).not.toContain('account');
  expect(JSON.stringify(message)).not.toContain('student');
  close(a.socket);
  close(b.socket);
});
