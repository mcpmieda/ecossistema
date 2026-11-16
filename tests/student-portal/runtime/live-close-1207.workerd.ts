import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// #1207 L-01: the hibernating close callback must finish every handshake without throwing.
const config = JSON.parse(readFileSync('wrangler.student-portal.jsonc', 'utf8'));
let runtime: Miniflare;
type TestSocket = {
  accept(): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  addEventListener(
    type: 'message' | 'close',
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
    options?: { once?: boolean },
  ): void;
};
type TailRecord = { exceptions: string[]; logs: string[] };

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
          durableObjects: { PORTAL_LIVE: { className: 'PortalLiveUpdatesV1', useSQLite: true } },
          tails: [{ name: 'tail' }],
        },
        {
          name: 'tail',
          modules: true,
          compatibilityDate: config.compatibility_date,
          durableObjects: { STORE: { className: 'TailStore', useSQLite: true } },
          script: `import { DurableObject } from 'cloudflare:workers';
          export class TailStore extends DurableObject {
            async fetch(request) {
              if (request.method === 'POST') {
                const add = await request.json();
                const current = (await this.ctx.storage.get('r')) ?? { exceptions: [], logs: [] };
                current.exceptions.push(...add.exceptions);
                current.logs.push(...add.logs);
                await this.ctx.storage.put('r', current);
                return new Response(null, { status: 204 });
              }
              const current = (await this.ctx.storage.get('r')) ?? { exceptions: [], logs: [] };
              if (request.method === 'DELETE') await this.ctx.storage.delete('r');
              return Response.json(current);
            }
          }
          export default {
            async tail(events, env) {
              const exceptions = [], logs = [];
              for (const event of events) {
                for (const item of event.exceptions ?? []) exceptions.push(item.name + ': ' + item.message);
                for (const item of event.logs ?? []) logs.push(item.message.map((part) => typeof part === 'string' ? part : JSON.stringify(part)).join(' '));
              }
              const stub = env.STORE.get(env.STORE.idFromName('tail'));
              await stub.fetch('http://tail/', { method: 'POST', body: JSON.stringify({ exceptions, logs }) });
            },
            fetch(request, env) { return env.STORE.get(env.STORE.idFromName('tail')).fetch(request); },
          };`,
        },
        {
          name: 'caller',
          modules: true,
          compatibilityDate: config.compatibility_date,
          durableObjects: {
            LIVE: { className: 'PortalLiveUpdatesV1', scriptName: 'portal', useSQLite: true },
          },
          script: `export default { fetch(request, env) {
            const stub = env.LIVE.get(env.LIVE.idFromName('student:2026'));
            return stub.fetch(new Request('https://live.internal/connect', { headers: {
              Upgrade: 'websocket', 'x-live-audience': 'student', 'x-live-purpose': 'security',
              'x-live-expires-at': '2099-01-01T00:00:00.000Z',
              'x-live-effective-expires-at': '2099-01-01T00:00:00.000Z',
              'x-live-account-id': '11111111-1111-4111-8111-111111111111',
              'x-live-student-id': '7', 'x-live-class-id': '42' } }));
          } }`,
        },
      ],
    }),
  );
  await runtime.ready;
});
afterAll(async () => runtime?.dispose());

async function tail(clear = false): Promise<TailRecord> {
  const worker = await runtime.getWorker('tail');
  const response = await worker.fetch('http://tail/', { method: clear ? 'DELETE' : 'GET' });
  return (await response.json()) as TailRecord;
}

async function open(): Promise<TestSocket> {
  const caller = await runtime.getWorker('caller');
  const response = await caller.fetch('http://caller/', { headers: { Upgrade: 'websocket' } });
  expect(response.status).toBe(101);
  const socket = response.webSocket as unknown as TestSocket;
  const connected = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect-timeout')), 1000);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)));
      },
      { once: true },
    );
  });
  socket.accept();
  expect(await connected).toMatchObject({ type: 'security-connected' });
  return socket;
}

/** Captures the handshake result before the runtime is disposed. */
async function closeAndObserve(socket: TestSocket, code?: number) {
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener(
      'close',
      (event) => resolve({ code: event.code ?? -1, reason: event.reason ?? '' }),
      {
        once: true,
      },
    ),
  );
  if (code === undefined) socket.close();
  else socket.close(code, 'test');
  const result = await Promise.race([
    closed,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 1500)),
  ]);
  return { result, readyState: socket.readyState };
}

async function settledTail(expectedLogs: number): Promise<TailRecord> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const record = await tail();
    const closeLogs = record.logs.filter((line) => line.includes('student-portal-live-close-v1'));
    if (closeLogs.length >= expectedLogs) return record;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return tail();
}

it.each([
  ['a close without status (1005, the client rotation path)', undefined, 1000, '', 'no-status'],
  ['a normal close', 1000, 1000, 'test', 'normal'],
  ['an authorization close', 4401, 4401, 'test', 'auth-expired'],
  ['another sendable code', 3000, 3000, 'test', 'other-sendable'],
] as const)(
  'completes the handshake after %s without a runtime exception',
  async (_label, code, echoed, reason, codeClass) => {
    await tail(true);
    const socket = await open();
    expect(await closeAndObserve(socket, code)).toEqual({
      result: { code: echoed, reason },
      readyState: 3,
    });
    const record = await settledTail(1);
    expect(record.exceptions).toEqual([]);
    const events = record.logs
      .filter((line) => line.includes('student-portal-live-close-v1'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([
      {
        event: 'student-portal-live-close-v1',
        callback: 'close',
        codeClass,
        readyState: expect.any(Number),
      },
    ]);
  },
);

it('accepts a new security connection after repeated rotations and closes', async () => {
  await tail(true);
  for (const code of [undefined, 1000, undefined]) {
    const socket = await open();
    expect((await closeAndObserve(socket, code)).readyState).toBe(3);
  }
  const socket = await open();
  expect((await closeAndObserve(socket)).readyState).toBe(3);
  expect((await settledTail(4)).exceptions).toEqual([]);
});
