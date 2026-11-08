import { describe, expect, it, vi } from 'vitest';
import { PLATFORM_CAPABILITIES } from '../shared/platform-contract';
import { onRequest } from '../functions/[[path]]';
import { AUTH_COOKIE, SESSION_COOKIE } from '../server/auth/session';
import { seal, unseal } from '../server/auth/sealed';
import { testEnv } from './fixtures';

type TestRole = 'ADMINISTRADOR' | 'PROFESSOR';

function logoutRequest(origin?: string): Request {
  const headers = new Headers();
  if (origin) headers.set('Origin', origin);
  return new Request(`${testEnv.OFFICIAL_ORIGIN}/auth/logout`, {
    method: 'POST',
    headers,
  });
}

async function invoke(request: Request): Promise<Response> {
  return await onRequest({ request, env: testEnv } as never);
}

function responseCookie(response: Response, name: string): string {
  const header = response.headers.get('Set-Cookie') ?? '';
  const match = header.match(new RegExp(`${name}=([^;,]*)`, 'u'));
  if (!match?.[1]) throw new Error(`Missing ${name} response cookie`);
  return match[1];
}

function loginRequest(cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', `${AUTH_COOKIE}=${cookie}`);
  return new Request(`${testEnv.OFFICIAL_ORIGIN}/auth/login`, { headers });
}

async function sessionHeaders(roles?: TestRole[]): Promise<Headers> {
  const headers = new Headers();
  if (!roles) return headers;
  const session = await seal(
    {
      oid: '11111111-1111-4111-8111-111111111111',
      name: 'Usuário de teste',
      username: 'teste@escolaieda.com',
      roles,
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    testEnv.SESSION_SECRET,
  );
  headers.set('Cookie', `${SESSION_COOKIE}=${session}`);
  return headers;
}

async function authenticatedRequest(path: string, roles?: TestRole[]): Promise<Request> {
  return new Request(`${testEnv.OFFICIAL_ORIGIN}${path}`, {
    method: 'GET',
    headers: await sessionHeaders(roles),
  });
}

describe('logout route', () => {
  it('clears the session and redirects to a fresh public shell for an exact same-origin POST', async () => {
    const response = await invoke(logoutRequest(testEnv.OFFICIAL_ORIGIN));

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(testEnv.OFFICIAL_ORIGIN);
    expect(response.headers.get('Set-Cookie')).toContain('__Host-ecossistema_session=');
    expect(response.headers.get('Set-Cookie')).toContain('__Host-ecossistema_auth=');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Expires')).toBe('0');
    expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
  });

  it.each([undefined, 'null', 'https://evil.test'])(
    'rejects an untrusted write Origin: %s',
    async (origin) => {
      const response = await invoke(logoutRequest(origin));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: 'Invalid origin' });
    },
  );
});

describe('browser-facing authentication recovery', () => {
  it('starts every login at the authorize endpoint with a fresh parallel-safe transaction', async () => {
    const first = await invoke(loginRequest());
    const firstCookie = responseCookie(first, AUTH_COOKIE);
    const second = await invoke(loginRequest(firstCookie));
    const secondCookie = responseCookie(second, AUTH_COOKIE);
    const envelope = await unseal<{
      transactions: Array<{ state: string; nonce: string; verifier: string; exp: number }>;
    }>(secondCookie, testEnv.SESSION_SECRET);

    expect(first.status).toBe(302);
    expect(new URL(first.headers.get('Location')!).pathname).toContain('/oauth2/v2.0/authorize');
    expect(first.headers.get('Location')).not.toContain('/oauth2/v2.0/token');
    expect(envelope?.transactions).toHaveLength(2);
    expect(envelope?.transactions[0]?.state).not.toBe(envelope?.transactions[1]?.state);
    expect(second.headers.get('Cache-Control')).toContain('no-store');
  });

  it('keeps at most four live authentication transactions', async () => {
    let cookie: string | undefined;

    for (let index = 0; index < 6; index += 1) {
      const response = await invoke(loginRequest(cookie));
      cookie = responseCookie(response, AUTH_COOKIE);
    }

    const envelope = await unseal<{
      transactions: Array<{ state: string; nonce: string; verifier: string; exp: number }>;
    }>(cookie!, testEnv.SESSION_SECRET);

    expect(envelope?.transactions).toHaveLength(4);
    expect(new Set(envelope?.transactions.map((transaction) => transaction.state)).size).toBe(4);
  });

  it('prunes expired authentication transactions before storing a new login attempt', async () => {
    const now = Math.floor(Date.now() / 1000);

    const existing = await seal(
      {
        transactions: [
          {
            state: 'expired-state',
            nonce: 'expired-nonce',
            verifier: 'expired-verifier',
            exp: now - 1,
          },
          {
            state: 'live-state',
            nonce: 'live-nonce',
            verifier: 'live-verifier',
            exp: now + 300,
          },
        ],
      },
      testEnv.SESSION_SECRET,
    );

    const response = await invoke(loginRequest(existing));
    const envelope = await unseal<{
      transactions: Array<{ state: string; exp: number }>;
    }>(responseCookie(response, AUTH_COOKIE), testEnv.SESSION_SECRET);

    expect(envelope?.transactions).toHaveLength(2);
    expect(
      envelope?.transactions.some((transaction) => transaction.state === 'expired-state'),
    ).toBe(false);
    expect(envelope?.transactions.some((transaction) => transaction.state === 'live-state')).toBe(
      true,
    );
    expect(envelope?.transactions.every((transaction) => transaction.exp > now)).toBe(true);
  });

  it('recovers an incomplete callback without JSON and preserves an independent live transaction', async () => {
    const first = await invoke(loginRequest());
    const second = await invoke(loginRequest(responseCookie(first, AUTH_COOKIE)));
    const envelope = await unseal<{
      transactions: Array<{ state: string; nonce: string; verifier: string; exp: number }>;
    }>(responseCookie(second, AUTH_COOKIE), testEnv.SESSION_SECRET);
    const [interrupted, independent] = envelope?.transactions ?? [];
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const response = await invoke(
      new Request(
        `${testEnv.OFFICIAL_ORIGIN}/auth/callback?state=${encodeURIComponent(interrupted!.state)}`,
        { headers: { Cookie: `${AUTH_COOKIE}=${responseCookie(second, AUTH_COOKIE)}` } },
      ),
    );
    const remaining = await unseal<{
      transactions: Array<{ state: string }>;
    }>(responseCookie(response, AUTH_COOKIE), testEnv.SESSION_SECRET);

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('Location')!);
    expect(location.origin).toBe(testEnv.OFFICIAL_ORIGIN);
    expect(location.searchParams.get('authError')).toBe('1');
    expect(location.searchParams.get('correlationId')).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await response.text()).toBe('');
    expect(remaining?.transactions.map((transaction) => transaction.state)).toEqual([
      independent!.state,
    ]);
    expect(warning).toHaveBeenCalledWith(
      expect.not.stringMatching(/state|nonce|verifier|authorization.?code|token|cookie|secret/iu),
    );
    warning.mockRestore();
  });

  it('recovers a provider rejection with a clean retry screen redirect', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await invoke(
      new Request(`${testEnv.OFFICIAL_ORIGIN}/auth/callback?error=access_denied`),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('authError=1');
    expect(response.headers.get('Set-Cookie')).toContain(`${AUTH_COOKIE}=`);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(response.headers.get('Content-Type')).toBeNull();
    warning.mockRestore();
  });
});

describe('identity capability resolution', () => {
  it('returns resolved capabilities for an administrator without storing them in the session', async () => {
    const response = await invoke(await authenticatedRequest('/api/me', ['ADMINISTRADOR']));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      roles: ['ADMINISTRADOR'],
      capabilities: PLATFORM_CAPABILITIES,
    });
  });

  it('returns an empty platform capability set for a professor in validation', async () => {
    const response = await invoke(await authenticatedRequest('/api/me', ['PROFESSOR']));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      roles: ['PROFESSOR'],
      capabilities: [],
    });
  });
});

describe('administrative session settings', () => {
  it('returns the server-enforced duration and allowed limits to an administrator', async () => {
    const response = await invoke(
      await authenticatedRequest('/api/platform/settings/session', ['ADMINISTRADOR']),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: 1,
      policy: 'absolute',
      defaultDurationHours: 8,
      allowedDurationsHours: [4, 8, 12],
      currentDurationHours: 8,
      configured: false,
    });
  });

  it('updates the current sealed session and persistent preference with an exact-origin POST', async () => {
    const headers = await sessionHeaders(['ADMINISTRADOR']);
    headers.set('Origin', testEnv.OFFICIAL_ORIGIN);
    headers.set('Content-Type', 'application/json');
    const response = await invoke(
      new Request(`${testEnv.OFFICIAL_ORIGIN}/api/platform/settings/session`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ durationHours: 12 }),
      }),
    );
    const session = await unseal<{
      durationHours: number;
      authenticatedAt: number;
      exp: number;
    }>(responseCookie(response, SESSION_COOKIE), testEnv.SESSION_SECRET);

    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain('__Host-ecossistema_session_policy=');
    expect(session?.durationHours).toBe(12);
    expect(session?.exp).toBe(session!.authenticatedAt + 12 * 60 * 60);
  });

  it('rejects invalid duration, cross-origin writes and non-administrative access', async () => {
    const invalidHeaders = await sessionHeaders(['ADMINISTRADOR']);
    invalidHeaders.set('Origin', testEnv.OFFICIAL_ORIGIN);
    invalidHeaders.set('Content-Type', 'application/json');
    const invalid = await invoke(
      new Request(`${testEnv.OFFICIAL_ORIGIN}/api/platform/settings/session`, {
        method: 'POST',
        headers: invalidHeaders,
        body: JSON.stringify({ durationHours: 24 }),
      }),
    );

    const foreignHeaders = await sessionHeaders(['ADMINISTRADOR']);
    foreignHeaders.set('Origin', 'https://evil.test');
    foreignHeaders.set('Content-Type', 'application/json');
    const foreign = await invoke(
      new Request(`${testEnv.OFFICIAL_ORIGIN}/api/platform/settings/session`, {
        method: 'POST',
        headers: foreignHeaders,
        body: JSON.stringify({ durationHours: 8 }),
      }),
    );

    const professor = await invoke(
      await authenticatedRequest('/api/platform/settings/session', ['PROFESSOR']),
    );

    expect(invalid.status).toBe(400);
    expect(foreign.status).toBe(403);
    expect(professor.status).toBe(403);
  });
});

