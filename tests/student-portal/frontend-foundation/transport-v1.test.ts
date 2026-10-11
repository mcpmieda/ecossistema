import { expect, it, vi } from 'vitest';
import { createPortalSelfClientV1 } from '../../../src/features/student-portal/shared/self-client-v1';
import { createPortalAdminClientV1 } from '../../../src/features/student-portal-admin/shared/admin-client-v1';
import {
  createLatestPortalRequestV1,
  type PortalLoadStateV1,
} from '../../../src/features/student-portal/shared/latest-request-v1';
import {
  createPortalTransportV1,
  type PortalFetchV1,
} from '../../../src/features/student-portal/shared/transport-v1';
import { sessionResponseV1 } from '../../../shared/student-portal-contracts/auth-v1';
import { ACCESS_CLOSED_ACCEPT_HEADER_V1 } from '../../../shared/student-portal-contracts/auth-v1';
import { SYNTHETIC_QR_V1 } from '../../../shared/student-portal-contracts/fixtures-v1';

const id = '11111111-1111-4111-8111-111111111111';
const session = {
  contractVersion: 1,
  requestId: id,
  state: 'authenticated',
  expiresAt: '2026-09-13T15:00:00Z',
  persistent: false,
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

it('uses fixed same-origin paths and rejects unexpected versions, fields and response kinds', async () => {
  const fetch = vi.fn<PortalFetchV1>(async () => json(session));
  const client = createPortalSelfClientV1({ fetch });
  expect((await client.session()).state).toBe('authenticated');
  expect(fetch).toHaveBeenCalledWith(
    '/api/student/session',
    expect.objectContaining({
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      method: 'GET',
    }),
  );
  expect((fetch.mock.calls[0]?.[1]?.headers as Record<string, string>)[ACCESS_CLOSED_ACCEPT_HEADER_V1]).toBe('v1');
  for (const body of [
    { ...session, contractVersion: 2 },
    { ...session, secret: 'synthetic' },
    { ...session, state: 'ready' },
  ]) {
    fetch.mockResolvedValueOnce(json(body));
    await expect(client.session()).rejects.toMatchObject({ state: 'invalid-response' });
  }
  await expect(
    createPortalTransportV1({ fetch })('https://invalid.example/api/student/me', sessionResponseV1),
  ).rejects.toMatchObject({ state: 'invalid-request' });
});

it('honors 401/403/429 and Retry-After without logging payloads or automatically retrying', async () => {
  const unauthorized = vi.fn();
  const fetch = vi.fn<PortalFetchV1>(async () =>
    json({ contractVersion: 1, requestId: id, state: 'unauthenticated' }, 401),
  );
  const client = createPortalSelfClientV1({ fetch, onUnauthorized: unauthorized });
  await expect(client.session()).rejects.toMatchObject({ state: 'unauthenticated', status: 401 });
  expect(unauthorized).toHaveBeenCalledOnce();
  fetch.mockResolvedValueOnce(json({ contractVersion: 1, requestId: id, state: 'forbidden' }, 403));
  await expect(client.session()).rejects.toMatchObject({ state: 'forbidden' });
  fetch.mockResolvedValueOnce(json({ contractVersion: 1, requestId: id, state: 'access-closed' }, 403));
  await expect(client.session()).rejects.toMatchObject({ state: 'access-closed' });
  fetch.mockResolvedValueOnce(
    json({ contractVersion: 1, requestId: id, state: 'rate-limited', retryAfterSeconds: 10 }, 429, {
      'Retry-After': '30',
    }),
  );
  await expect(client.session()).rejects.toMatchObject({
    state: 'rate-limited',
    retryAfterSeconds: 30,
  });
  expect(fetch).toHaveBeenCalledTimes(4);
  await expect(client.session()).rejects.toMatchObject({ state: 'rate-limited' });
  expect(fetch).toHaveBeenCalledTimes(4);
  fetch.mockResolvedValueOnce(new Response('<html>sign in</html>', { status: 401 }));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001);
  try {
    await expect(client.session()).rejects.toMatchObject({ state: 'invalid-response', status: 401 });
    expect(unauthorized).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});

it('preserves command bytes, CAS and idempotency when resuming prepared QR batches', async () => {
  const input = {
    contractVersion: 1 as const,
    operation: 'qr-batch' as const,
    classId: 970744,
    expectedVersion: 3,
    idempotencyKey: id,
    confirmed: true as const,
    accountIds: [id],
    mode: 'qr-only' as const,
  };
  const fetch = vi.fn<PortalFetchV1>(async () =>
    json({
      contractVersion: 1,
      requestId: id,
      state: 'qr',
      version: 3,
      cards: [{ accountId: id, mode: 'qr-only', qr: SYNTHETIC_QR_V1 }],
    }),
  );
  const operation = createPortalAdminClientV1({ fetch }).prepareCommand(input);
  await operation.execute();
  input.expectedVersion = 100;
  input.accountIds[0] = '22222222-2222-4222-8222-222222222222';
  await operation.execute();
  expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
    expectedVersion: 3,
    idempotencyKey: id,
    accountIds: [id],
  });
  fetch
    .mockResolvedValueOnce(
      json({ contractVersion: 1, requestId: id, state: 'health', status: 'normal' }),
    )
    .mockResolvedValueOnce(
      json({ contractVersion: 1, requestId: id, state: 'health', status: 'normal' }),
    );
  await expect(operation.execute()).rejects.toMatchObject({ state: 'invalid-response' });
});

it('confirms an ambiguous admin command once with the exact same bytes', async () => {
  const input = {
    contractVersion: 1 as const,
    operation: 'qr-batch' as const,
    classId: 970744,
    expectedVersion: 3,
    idempotencyKey: id,
    confirmed: true as const,
    accountIds: [id],
    mode: 'qr-only' as const,
  };
  const response = {
    contractVersion: 1,
    requestId: id,
    state: 'qr',
    version: 3,
    cards: [{ accountId: id, mode: 'qr-only', qr: SYNTHETIC_QR_V1 }],
  } as const;
  const fetch = vi
    .fn<PortalFetchV1>()
    .mockRejectedValueOnce(new Error('synthetic-lost-response'))
    .mockResolvedValueOnce(json(response));
  const operation = createPortalAdminClientV1({ fetch }).prepareCommand(input);
  await expect(operation.execute()).resolves.toMatchObject({ state: 'qr' });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);

  const invalid = vi
    .fn<PortalFetchV1>()
    .mockResolvedValueOnce(
      json({ contractVersion: 1, requestId: id, state: 'health', status: 'normal' }),
    )
    .mockResolvedValueOnce(json(response));
  await expect(
    createPortalAdminClientV1({ fetch: invalid }).prepareCommand(input).execute(),
  ).resolves.toMatchObject({ state: 'qr' });
  expect(invalid).toHaveBeenCalledTimes(2);

  const unavailable = vi
    .fn<PortalFetchV1>()
    .mockResolvedValueOnce(json({ contractVersion: 1, requestId: id, state: 'unavailable' }, 503))
    .mockResolvedValueOnce(json(response));
  await expect(
    createPortalAdminClientV1({ fetch: unavailable }).prepareCommand(input).execute(),
  ).resolves.toMatchObject({ state: 'qr' });
  expect(unavailable).toHaveBeenCalledTimes(2);
});

it('does not automatically repeat reads, refusals, rate limits or more than one ambiguous command response', async () => {
  const input = {
    contractVersion: 1 as const,
    operation: 'qr-batch' as const,
    classId: 970744,
    expectedVersion: 3,
    idempotencyKey: id,
    confirmed: true as const,
    accountIds: [id],
    mode: 'qr-only' as const,
  };
  const lost = vi.fn<PortalFetchV1>(async () => {
    throw new Error('synthetic-offline');
  });
  await expect(
    createPortalAdminClientV1({ fetch: lost }).prepareCommand(input).execute(),
  ).rejects.toMatchObject({ state: 'network-error' });
  expect(lost).toHaveBeenCalledTimes(2);

  const refused = vi.fn<PortalFetchV1>(async () =>
    json({ contractVersion: 1, requestId: id, state: 'forbidden' }, 403),
  );
  await expect(
    createPortalAdminClientV1({ fetch: refused }).prepareCommand(input).execute(),
  ).rejects.toMatchObject({ state: 'forbidden' });
  expect(refused).toHaveBeenCalledOnce();

  const limited = vi.fn<PortalFetchV1>(async () =>
    json({ contractVersion: 1, requestId: id, state: 'rate-limited', retryAfterSeconds: 10 }, 429),
  );
  await expect(
    createPortalAdminClientV1({ fetch: limited }).prepareCommand(input).execute(),
  ).rejects.toMatchObject({ state: 'rate-limited' });
  expect(limited).toHaveBeenCalledOnce();

  const read = vi.fn<PortalFetchV1>(async () => {
    throw new Error('synthetic-offline');
  });
  await expect(createPortalSelfClientV1({ fetch: read }).session()).rejects.toMatchObject({
    state: 'network-error',
  });
  expect(read).toHaveBeenCalledOnce();
});

it('confirms ambiguous student challenge, login and logout responses once with the exact bytes', async () => {
  const required = {
    contractVersion: 1,
    requestId: id,
    state: 'credential-required',
    next: 'pin',
  } as const;
  const challengeFetch = vi
    .fn<PortalFetchV1>()
    .mockRejectedValueOnce(new Error('synthetic-lost-challenge'))
    .mockResolvedValueOnce(json(required));
  await expect(
    createPortalSelfClientV1({ fetch: challengeFetch }).challenge({
      contractVersion: 1,
      qr: SYNTHETIC_QR_V1,
      pin: '2001',
    }),
  ).resolves.toMatchObject(required);
  expect(challengeFetch).toHaveBeenCalledTimes(2);
  expect(challengeFetch.mock.calls[0]?.[1].body).toBe(challengeFetch.mock.calls[1]?.[1].body);

  const loginFetch = vi.fn<PortalFetchV1>(async (path) => {
    if (path.endsWith('/login')) throw new Error('synthetic-lost-login-response');
    if (path.endsWith('/session')) return json(session);
    throw new Error('synthetic-unexpected-path');
  });
  await expect(
    createPortalSelfClientV1({ fetch: loginFetch }).login({
      contractVersion: 1,
      qr: SYNTHETIC_QR_V1,
      password: '482913',
      keepConnected: false,
    }),
  ).resolves.toMatchObject(session);
  expect(loginFetch.mock.calls.map(([path]) => path)).toEqual([
    '/api/student/auth/login',
    '/api/student/session',
  ]);

  let loginAttempts = 0;
  const retryFetch = vi.fn<PortalFetchV1>(async (path) => {
    if (path.endsWith('/session'))
      return json({ contractVersion: 1, requestId: id, state: 'unauthenticated' }, 401);
    if (path.endsWith('/login') && loginAttempts++ === 0)
      return json({ contractVersion: 1, requestId: id, state: 'unavailable' }, 503);
    if (path.endsWith('/login')) return json(session);
    throw new Error('synthetic-unexpected-path');
  });
  await expect(
    createPortalSelfClientV1({ fetch: retryFetch }).login({
      contractVersion: 1,
      qr: SYNTHETIC_QR_V1,
      password: '482913',
      keepConnected: false,
    }),
  ).resolves.toMatchObject(session);
  expect(retryFetch.mock.calls.map(([path]) => path)).toEqual([
    '/api/student/auth/login',
    '/api/student/session',
    '/api/student/auth/login',
  ]);
  const repeatedLogin = retryFetch.mock.calls.filter(([path]) => path.endsWith('/login'));
  expect(repeatedLogin[0]?.[1].body).toBe(repeatedLogin[1]?.[1].body);

  const loggedOut = { contractVersion: 1, requestId: id, state: 'logged-out' } as const;
  const logoutFetch = vi
    .fn<PortalFetchV1>()
    .mockResolvedValueOnce(json({ contractVersion: 1, requestId: id, state: 'invalid-response' }))
    .mockResolvedValueOnce(json(loggedOut));
  await expect(createPortalSelfClientV1({ fetch: logoutFetch }).logout()).resolves.toEqual(
    loggedOut,
  );
  expect(logoutFetch).toHaveBeenCalledTimes(2);
  expect(logoutFetch.mock.calls[0]?.[1].body).toBe(logoutFetch.mock.calls[1]?.[1].body);
});

it('never retries student refusals, rate limits or activation automatically', async () => {
  const refused = vi.fn<PortalFetchV1>(async () =>
    json({ contractVersion: 1, requestId: id, state: 'unauthenticated' }, 401),
  );
  await expect(
    createPortalSelfClientV1({ fetch: refused }).login({
      contractVersion: 1,
      qr: SYNTHETIC_QR_V1,
      password: '482913',
      keepConnected: false,
    }),
  ).rejects.toMatchObject({ state: 'unauthenticated' });
  expect(refused).toHaveBeenCalledOnce();

  const activateFetch = vi.fn<PortalFetchV1>(async () => {
    throw new Error('synthetic-lost-activation');
  });
  await expect(
    createPortalSelfClientV1({ fetch: activateFetch }).activate({
      contractVersion: 1,
      challenge: 'synthetic_activation_proof_'.repeat(2),
      password: '482913',
      confirmation: '482913',
      keepConnected: false,
    }),
  ).rejects.toMatchObject({ state: 'network-error' });
  expect(activateFetch).toHaveBeenCalledOnce();
});

it('clears old data synchronously and never publishes stale completions after a scope change or logout', async () => {
  const states: PortalLoadStateV1<string>[] = [];
  const latest = createLatestPortalRequestV1<string>((state) => states.push(state));
  let resolveOld!: (value: string) => void;
  let oldSignal!: AbortSignal;
  const old = latest.run((signal) => {
    oldSignal = signal;
    return new Promise((resolve) => {
      resolveOld = resolve;
    });
  });
  await latest.run(async () => 'current');
  expect(oldSignal.aborted).toBe(true);
  resolveOld('stale');
  await old;
  expect(states.at(-1)).toEqual({ state: 'ready', data: 'current' });
  latest.clear();
  expect(states.at(-1)).toEqual({ state: 'idle' });
  expect(states.some((state) => state.state === 'ready' && state.data === 'stale')).toBe(false);
});

it('aborts before networking and rejects missing no-store on success', async () => {
  const fetch = vi.fn<PortalFetchV1>(async () => Response.json(session));
  const client = createPortalSelfClientV1({ fetch });
  const controller = new AbortController();
  controller.abort();
  await expect(client.session(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).not.toHaveBeenCalled();
  await expect(client.session()).rejects.toMatchObject({ state: 'invalid-response' });
});


it('keeps session cooldown across reconnection IDs without applying it to another account', async () => {
  const fetch = vi.fn<PortalFetchV1>(async () => json({ contractVersion: 1, requestId: id,
    state: 'rate-limited', retryAfterSeconds: 60 }, 429, { 'Retry-After': '60' }));
  const client = createPortalSelfClientV1({ fetch });
  await expect(client.session(undefined, id, crypto.randomUUID())).rejects.toMatchObject({ state: 'rate-limited' });
  await expect(client.session(undefined, id, crypto.randomUUID())).rejects.toMatchObject({ state: 'rate-limited' });
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(client.session(undefined, crypto.randomUUID(), crypto.randomUUID())).rejects.toMatchObject({ state: 'rate-limited' });
  expect(fetch).toHaveBeenCalledTimes(2);
});
