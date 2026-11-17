// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import type { RuntimeEnv } from '../../server/env';
import {
  collectorSignInReturnV1,
  handleCollectorRequestV1,
} from '../../server/collector/routes-v1';
import {
  createCollectorRuntimeV1,
  type CollectorRuntimeDependenciesV1,
} from '../../server/collector/runtime-v1';
import {
  collectorChallengeBytesV1,
  collectorKeyThumbprintV1,
  type CollectorPublicKeyV1,
  type CollectorChallengeV1,
} from '../../server/collector/device-proof-v1';
import { encodeBase64Url } from '../../server/auth/base64url';
import { seal } from '../../server/auth/sealed';
import type { Role } from '../../server/auth/roles';
import { GraphError } from '../../server/graph/request-policy-v1';
import { SESSION_COOKIE, createApplicationSession } from '../../server/auth/session';
import { onRequest } from '../../functions/[[path]]';
import { withSecurityHeaders, SECURITY_HEADERS } from '../../server/http/security';

const origin = 'https://admin.escolaieda.com',
  prefix = '/api/frequency-collector/';
const tenant = '11111111-1111-4111-8111-111111111111',
  client = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333',
  group = '44444444-4444-4444-8444-444444444444',
  stranger = '77777777-7777-4777-8777-777777777777';
// All UUIDs, credentials and providers in this file are synthetic.
const env = {
  TENANT_ID: tenant,
  WEB_CLIENT_ID: client,
  GRAPH_CLIENT_ID: client,
  GROUP_ADMIN_ID: group,
  GROUP_PROFESSOR_ID: group,
  GROUP_ALUNO_ID: group,
  GROUP_APOIO_ID: group,
  GROUP_VISITANTE_ID: group,
  SESSION_SECRET: 's'.repeat(43),
  OFFICIAL_ORIGIN: origin,
  COLLECTOR_ENABLED: 'true',
  COLLECTOR_DB: { connectionString: 'synthetic-only' },
} as unknown as RuntimeEnv;
let db: PGlite;
beforeAll(async () => {
  vi.stubGlobal('crypto', webcrypto);
  db = new PGlite();
  for (const name of [
    '0001_device_authorization.sql',
    '0002_pending_pairings.sql',
    '0006_pairing_rate_v1.sql',
    '0009_atomic_pairing_admission_v2.sql',
    '0015_session_authorization_v1.sql',
    '0018_drop_delegated_sign_in_columns_v1.sql',
  ])
    await db.exec(
      await readFile(new URL('../../migrations/collector/' + name, import.meta.url), 'utf8'),
    );
}, 60_000);
beforeEach(async () => {
  await db.exec(
    'TRUNCATE collector_auth.pairings,collector_auth.challenges,collector_auth.devices,collector_auth.oauth_grants,collector_auth.pairing_rate_v1',
  );
});
afterAll(async () => {
  await db.close();
});

async function fixture() {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]),
    exported = await crypto.subtle.exportKey('jwk', key.publicKey);
  const publicKey: CollectorPublicKeyV1 = {
    kty: 'EC',
    crv: 'P-256',
    x: exported.x!,
    y: exported.y!,
    ext: true,
  };
  const directory = {
    user: {
      id: actor,
      accountEnabled: true,
      signInSessionsValidFromDateTime: new Date(Date.now() - 3600_000).toISOString(),
    },
    groups: [group],
    down: false,
  };
  const graph = vi.fn(async (input: { path: string; method?: string; body?: unknown }) => {
    if (directory.down) throw new GraphError(503, 'PRIVATE_PROVIDER_ERROR');
    if (input.path.endsWith('/checkMemberGroups')) {
      expect(input.body).toEqual({ groupIds: [group] });
      return { value: directory.groups };
    }
    if (input.path.includes('?$select=')) return directory.user;
    throw new Error('unexpected-synthetic-provider');
  });
  const closed = vi.fn(async () => undefined);
  const dependencies: CollectorRuntimeDependenciesV1 = {
    database: async () => ({
      query: async <T extends Record<string, unknown>>(sql: string, parameters: unknown[]) =>
        (await db.query<T>(sql, parameters)).rows,
      close: closed,
    }),
    graph,
  };
  async function sessionCookie(oid = actor, roles: Role[] = ['ADMINISTRADOR']) {
    return (
      SESSION_COOKIE +
      '=' +
      (await seal(
        createApplicationSession({ oid, name: 'Synthetic <secretary>', roles }),
        env.SESSION_SECRET,
        'admin-session',
      ))
    );
  }
  async function request(path: string, value?: unknown, headers: Record<string, string> = {}) {
    const reply = await handleCollectorRequestV1(
      new Request(origin + path, {
        method: value === undefined ? 'GET' : 'POST',
        headers: {
          ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: value === undefined ? undefined : JSON.stringify(value),
      }),
      env,
      dependencies,
    );
    expect(reply).not.toBeNull();
    return reply!;
  }
  async function sign(body: Uint8Array) {
    const p = new TextEncoder().encode('Ecossistema.Coletor.DeviceProof.v1\0'),
      all = new Uint8Array(p.length + body.length);
    all.set(p);
    all.set(body, p.length);
    return encodeBase64Url(
      new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, all),
      ),
    );
  }
  async function begin() {
    const id = crypto.randomUUID(),
      thumb = await collectorKeyThumbprintV1(publicKey),
      nonce = 'n'.repeat(43),
      issuedAt = Date.now(),
      expiresAt = issuedAt + 120_000;
    const bytes = new TextEncoder().encode(
      JSON.stringify([
        id,
        thumb,
        nonce,
        origin,
        'POST',
        prefix + 'pairings',
        'collector-pairing',
        issuedAt,
        expiresAt,
      ]),
    );
    const response = await request(prefix + 'pairings', {
      id,
      publicKey,
      nonce,
      issuedAt,
      expiresAt,
      signature: await sign(bytes),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      id: string;
      pollToken: string;
      displayCode: string;
      browserUrl: string;
    };
  }
  /** The authorization page as the signed-in person sees it: its form fields and its cookie. */
  async function open(pair: Awaited<ReturnType<typeof begin>>, session?: string) {
    const page = await request('/frequency-collector/connect?pairing=' + pair.id, undefined, {
        Cookie: session ?? (await sessionCookie()),
      }),
      html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Autorizar este computador');
    expect(html).toContain(pair.displayCode);
    expect(html).toContain('Synthetic &lt;secretary&gt;');
    expect(html).not.toContain(pair.pollToken);
    // Nothing to type and nothing to tick: one button.
    expect(html).not.toMatch(/type="(text|checkbox)"/u);
    if (process.env.COLLECTOR_RENDER_QA) {
      const directory = process.env.COLLECTOR_RENDER_QA;
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'confirmation.html'), html, 'utf8');
      await writeFile(
        join(directory, 'style.css'),
        await (await request('/frequency-collector/style.css')).text(),
        'utf8',
      );
    }
    const setCookie = page.headers.get('Set-Cookie')!;
    expect(setCookie).toMatch(
      /^__Host-collector_confirm=[A-Za-z0-9_-]+;.*HttpOnly; Secure; SameSite=Strict; Max-Age=600/u,
    );
    return {
      csrf: html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)![1]!,
      cookie: setCookie.split(';')[0]!,
    };
  }
  /** The click on "Autorizar este computador". */
  async function authorize(
    form: Record<string, string>,
    cookies: string[],
    from = origin,
  ): Promise<Response> {
    const reply = await handleCollectorRequestV1(
      new Request(origin + '/frequency-collector/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookies.join('; '),
          Origin: from,
        },
        body: new URLSearchParams(form),
      }),
      env,
      dependencies,
    );
    expect(reply).not.toBeNull();
    return reply!;
  }
  async function complete(pair: Awaited<ReturnType<typeof begin>>) {
    const session = await sessionCookie(),
      page = await open(pair, session);
    const form = { pairing: pair.id, csrf: page.csrf },
      cookies = [session, page.cookie];
    const secured = withSecurityHeaders(await authorize(form, cookies), true),
      done = await secured.text();
    expect(secured.status).toBe(200);
    expect(secured.headers.get('Location')).toBeNull();
    expect(secured.headers.get('Content-Security-Policy')).toBe(
      SECURITY_HEADERS['Content-Security-Policy'],
    );
    expect(done).toContain('Computador autorizado');
    expect(done).not.toContain(pair.pollToken);
    expect(done).not.toContain('PRIVATE');
    expect(secured.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^__Host-collector_confirm=;.*Max-Age=0/u),
    ]);
    return { form, cookies };
  }
  async function proof(
    deviceId: string,
    purpose: 'collector-access' | 'collector-revoke' = 'collector-access',
  ) {
    const response = await request(prefix + 'challenge', { deviceId, purpose });
    expect(response.status).toBe(200);
    const challenge = (await response.json()) as CollectorChallengeV1;
    return {
      deviceId,
      nonce: challenge.nonce,
      signature: await sign(collectorChallengeBytesV1(challenge)),
    };
  }
  return {
    request,
    begin,
    open,
    authorize,
    complete,
    proof,
    sign,
    sessionCookie,
    dependencies,
    graph,
    directory,
    closed,
    publicKey,
  };
}

describe('Pages collector orchestration, no real network/credentials', () => {
  it('publishes a Pages invocation route for browser pairing, revocation and CSS', async () => {
    const { readFile } = await import('node:fs/promises');
    const routeFile = JSON.parse(
      await readFile(new URL('../../public/_routes.json', import.meta.url), 'utf8'),
    ) as {
      version: number;
      include: string[];
      exclude: string[];
    };
    expect(routeFile.version).toBe(1);
    expect(routeFile.include).toEqual(
      expect.arrayContaining(['/auth/*', '/api/*', '/frequency-collector/*']),
    );
    for (const url of [
      '/frequency-collector/connect',
      '/frequency-collector/revoke',
      '/frequency-collector/style.css',
    ]) {
      expect(
        routeFile.include.some((path) => path.endsWith('/*') && url.startsWith(path.slice(0, -1))),
      ).toBe(true);
    }
    expect(routeFile.exclude).toEqual([]);
  });

  it('mounts the unavailable route by default while preserving ordinary application routes', async () => {
    const execution = {
      ...env,
      COLLECTOR_ENABLED: undefined,
      COLLECTOR_DB: undefined,
    };
    for (const path of [prefix + 'config', prefix + 'access', '/frequency-collector/connect']) {
      const reply = (await onRequest({
        request: new Request(origin + path),
        env: execution,
        waitUntil: () => undefined,
      } as never)) as Response;
      expect(reply.status).toBe(503);
      expect(await reply.json()).toHaveProperty('code', 'ACCESS_NOT_CONFIGURED');
    }
    const health = (await onRequest({
      request: new Request(origin + '/api/health'),
      env: execution,
      waitUntil: () => undefined,
    } as never)) as Response;
    expect(health.status).toBe(200);
    // The sign-in callback is the application's alone: no collector state claims it any more.
    for (const state of ['ordinary', 'collector.' + 's'.repeat(43)])
      expect(
        await handleCollectorRequestV1(new Request(origin + '/auth/callback?state=' + state), env),
      ).toBeNull();
  });
  it('rejects unsigned requests without consuming budgets; valid signed attempts still hit rate limits', async () => {
    const f = await fixture();
    for (let i = 0; i < 35; i++) {
      const reply = await f.request(prefix + 'pairings', { not: 'a valid proof' });
      expect(reply.status).toBe(403);
    }
    const forged = await f.request(
      prefix + 'pairings',
      { not: 'a valid proof' },
      { 'CF-Connecting-IP': '198.51.100.21' },
    );
    expect(forged.status).toBe(403);
    expect(
      (
        await db.query<{ n: number }>(
          'SELECT count(*)::integer AS n FROM collector_auth.pairing_rate_v1',
        )
      ).rows[0]?.n,
    ).toBe(0);
    for (let i = 0; i < 30; i++) await f.begin();
    const thumb = await collectorKeyThumbprintV1(f.publicKey),
      id = crypto.randomUUID(),
      nonce = 'n'.repeat(43),
      issuedAt = Date.now(),
      expiresAt = issuedAt + 120_000;
    const bytes = new TextEncoder().encode(
      JSON.stringify([
        id,
        thumb,
        nonce,
        origin,
        'POST',
        prefix + 'pairings',
        'collector-pairing',
        issuedAt,
        expiresAt,
      ]),
    );
    const blocked = await f.request(prefix + 'pairings', {
      id,
      publicKey: f.publicKey,
      nonce,
      issuedAt,
      expiresAt,
      signature: await f.sign(bytes),
    });
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toHaveProperty('code', 'ACCESS_UNAVAILABLE');
    const count = (
      await db.query<{ n: number }>('SELECT count(*)::integer AS n FROM collector_auth.pairings')
    ).rows[0]?.n;
    expect(count).toBe(30);
  });
  it('keeps the pairing pending when the directory cannot be read, and authorizes it afterwards', async () => {
    const f = await fixture(),
      pair = await f.begin();
    const session = await f.sessionCookie(),
      page = await f.open(pair, session);
    const form = { pairing: pair.id, csrf: page.csrf },
      cookies = [session, page.cookie];
    f.directory.down = true;
    const reply = await f.authorize(form, cookies);
    expect(reply.status).toBe(503);
    const body = await reply.text();
    expect(body).toContain('Não foi possível conferir a sua conta agora');
    expect(body).not.toContain('PRIVATE');
    expect(body).not.toContain(pair.displayCode);
    const state = async () =>
      (
        await db.query<{ state: string }>('SELECT state FROM collector_auth.pairings WHERE id=$1', [
          pair.id,
        ])
      ).rows[0]?.state;
    expect(await state()).toBe('pending');
    expect((await db.query('SELECT id FROM collector_auth.oauth_grants')).rows).toHaveLength(0);
    f.directory.down = false;
    expect((await f.authorize(form, cookies)).status).toBe(200);
    expect(await state()).toBe('completed');
  });
  it('shows safe retry instructions for a used pairing without revealing codes or tokens', async () => {
    const f = await fixture(),
      pair = await f.begin();
    await f.complete(pair);
    const expired = await f.request('/frequency-collector/connect?pairing=' + pair.id, undefined, {
      Cookie: await f.sessionCookie(),
    });
    // A used pairing cannot be authorized again, and the response must stay
    // human-readable without disclosing any keys or six-digit code.
    expect(expired.status).toBe(410);
    const body = await expired.text();
    expect(body).toContain('Autorização expirada');
    expect(body).not.toContain(pair.displayCode);
    expect(body).not.toContain(pair.pollToken);
  });
  it('runs signed pairing, one-click authorization by the signed-in person, local claim and nonce-protected access', async () => {
    const f = await fixture(),
      pair = await f.begin(),
      before = Math.floor(Date.now() / 1000),
      { form, cookies } = await f.complete(pair);
    // The same click again authorizes nothing more.
    const replay = await f.authorize(form, cookies);
    expect(replay.status).toBe(403);
    expect(await replay.text()).toContain('inicie uma nova autorização');
    const grants = (
      await db.query<{ actor_id: string; client_id: string; origin: Date; state: string }>(
        'SELECT actor_id,client_id,origin_authenticated_at AS origin,state FROM collector_auth.oauth_grants',
      )
    ).rows;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ actor_id: actor, client_id: client, state: 'active' });
    // The grant begins at the sign-in of the session that authorized it.
    expect(grants[0]!.origin.getTime() / 1000).toBeGreaterThanOrEqual(before);
    expect(grants[0]!.origin.getTime()).toBeLessThanOrEqual(Date.now());
    const poll = (await (
      await f.request(prefix + 'pairings/poll', { id: pair.id, pollToken: pair.pollToken })
    ).json()) as { deviceId: string };
    expect((await f.request(prefix + 'challenge', { deviceId: poll.deviceId })).status).toBe(403);
    expect(
      (await f.request(prefix + 'pairings/claim', { id: pair.id, pollToken: pair.pollToken }))
        .status,
    ).toBe(200);
    const input = await f.proof(poll.deviceId),
      access = await f.request(prefix + 'access', input),
      body = await access.json();
    expect(access.status).toBe(200);
    expect(body).toHaveProperty('capability', 'frequency.collector.use');
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|access_token|refresh_token/u);
    expect((await f.request(prefix + 'access', input)).status).toBe(403);
    expect((await f.request(prefix + 'revoke', input)).status).toBe(403);
    expect(f.closed).toHaveBeenCalled();
  });
  it('revoke uses its own purpose, works during a directory outage, and cannot be used for access', async () => {
    const f = await fixture(),
      pair = await f.begin();
    await f.complete(pair);
    const poll = (await (
      await f.request(prefix + 'pairings/poll', { id: pair.id, pollToken: pair.pollToken })
    ).json()) as { deviceId: string };
    await f.request(prefix + 'pairings/claim', { id: pair.id, pollToken: pair.pollToken });
    const proof = await f.proof(poll.deviceId, 'collector-revoke'),
      calls = f.graph.mock.calls.length;
    f.directory.down = true;
    expect((await f.request(prefix + 'access', proof)).status).toBe(403);
    expect((await f.request(prefix + 'revoke', proof)).status).toBe(200);
    expect(f.graph.mock.calls).toHaveLength(calls);
    const grant = (
      await db.query<{ state: string }>('SELECT state FROM collector_auth.oauth_grants')
    ).rows[0]!;
    expect(grant).toMatchObject({ state: 'revoked' });
    expect((await f.request(prefix + 'challenge', { deviceId: poll.deviceId })).status).toBe(403);
    expect(
      (await f.request(prefix + 'revoke', await f.proof(poll.deviceId, 'collector-revoke'))).status,
    ).toBe(200);
  });
  it('cancellation racing after the authorization retires the unclaimed grant/device and prevents claim', async () => {
    const f = await fixture(),
      pair = await f.begin();
    await f.complete(pair);
    const owner = { id: pair.id, pollToken: pair.pollToken };
    expect((await f.request(prefix + 'pairings/cancel', owner)).status).toBe(200);
    expect((await f.request(prefix + 'pairings/claim', owner)).status).toBe(403);
    const grants = (
      await db.query<{ state: string }>('SELECT state FROM collector_auth.oauth_grants')
    ).rows;
    expect(grants[0]).toMatchObject({ state: 'revoked' });
  });
  it('an unclaimed device may retire itself by signed revoke after a client crash, but cannot access', async () => {
    const f = await fixture(),
      pair = await f.begin();
    await f.complete(pair);
    const poll = (await (
      await f.request(prefix + 'pairings/poll', { id: pair.id, pollToken: pair.pollToken })
    ).json()) as { deviceId: string };
    expect((await f.request(prefix + 'challenge', { deviceId: poll.deviceId })).status).toBe(403);
    expect(
      (await f.request(prefix + 'revoke', await f.proof(poll.deviceId, 'collector-revoke'))).status,
    ).toBe(200);
    expect(
      (await f.request(prefix + 'pairings/claim', { id: pair.id, pollToken: pair.pollToken }))
        .status,
    ).toBe(403);
  });
  it('web withdrawal is owner-only, origin/CSRF bound, and remains usable with collector activation disabled', async () => {
    const f = await fixture(),
      pair = await f.begin();
    await f.complete(pair);
    const poll = (await (
      await f.request(prefix + 'pairings/poll', { id: pair.id, pollToken: pair.pollToken })
    ).json()) as { deviceId: string };
    const thumb = await collectorKeyThumbprintV1(f.publicKey),
      inactive = { ...env, COLLECTOR_ENABLED: undefined } as RuntimeEnv;
    const owner = await f.sessionCookie(actor, ['VISITANTE']),
      other = await f.sessionCookie(stranger, ['VISITANTE']);
    const path = '/frequency-collector/revoke?device=' + poll.deviceId;
    expect(
      (
        await handleCollectorRequestV1(
          new Request(origin + path, { headers: { Cookie: other } }),
          inactive,
          f.dependencies,
        )
      )?.status,
    ).toBe(404);
    const page = await handleCollectorRequestV1(
      new Request(origin + path, { headers: { Cookie: owner } }),
      inactive,
      f.dependencies,
    );
    expect(page?.status).toBe(200);
    const csrf = (await page!.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)![1]!,
      withdraw = page!.headers.get('Set-Cookie')!.split(';')[0]!;
    const form = new URLSearchParams({ device: poll.deviceId, csrf, confirm: 'yes' });
    for (const [cookie, from] of [
      [other, 'https://admin.escolaieda.com'],
      [owner, 'https://other.invalid'],
    ]) {
      const reply = await handleCollectorRequestV1(
        new Request(origin + '/frequency-collector/revoke', {
          method: 'POST',
          headers: {
            Cookie: cookie + '; ' + withdraw,
            Origin: from!,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form,
        }),
        inactive,
        f.dependencies,
      );
      expect(reply?.status).toBe(403);
    }
    expect(
      await (
        await f.request(prefix + 'device-status', { deviceId: poll.deviceId, keyThumbprint: thumb })
      ).json(),
    ).toEqual({ revoked: false });
    const reply = await handleCollectorRequestV1(
      new Request(origin + '/frequency-collector/revoke', {
        method: 'POST',
        headers: {
          Cookie: owner + '; ' + withdraw,
          Origin: origin,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
      }),
      inactive,
      f.dependencies,
    );
    expect(reply?.status).toBe(200);
    expect(
      await (
        await f.request(prefix + 'device-status', { deviceId: poll.deviceId, keyThumbprint: thumb })
      ).json(),
    ).toEqual({ revoked: true });
    const grant = (
      await db.query<{ state: string }>('SELECT state FROM collector_auth.oauth_grants')
    ).rows[0]!;
    expect(grant).toMatchObject({ state: 'revoked' });
  });
  it('expired unclaimed registrations retire credentials on the next configured request', async () => {
    const f = await fixture(),
      pair = await f.begin();
    await f.complete(pair);
    await db.query(
      `WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS now)
      UPDATE collector_auth.pairings SET created_at=stamp.now-interval '11 minutes',
      expires_at=stamp.now-interval '1 minute' FROM stamp WHERE id=$1`,
      [pair.id],
    );
    expect((await f.request(prefix + 'config')).status).toBe(200);
    expect(
      (await db.query<{ state: string }>('SELECT state FROM collector_auth.oauth_grants')).rows[0]!
        .state,
    ).toBe('revoked');
  });
  it('authorizes only from this origin, with the page token, by the same signed-in Secretaria session', async () => {
    const f = await fixture(),
      pair = await f.begin();
    const session = await f.sessionCookie(),
      page = await f.open(pair, session);
    const form = { pairing: pair.id, csrf: page.csrf };
    const refused: Array<[string, Promise<Response>]> = [
      ['another origin', f.authorize(form, [session, page.cookie], 'https://other.invalid')],
      ['a wrong token', f.authorize({ ...form, csrf: 'wrong' }, [session, page.cookie])],
      ['another pairing', f.authorize({ ...form, pairing: stranger }, [session, page.cookie])],
      ['an extra field', f.authorize({ ...form, code: pair.displayCode }, [session, page.cookie])],
      ['no page cookie', f.authorize(form, [session])],
      ['no session', f.authorize(form, [page.cookie])],
      ['another person', f.authorize(form, [await f.sessionCookie(stranger), page.cookie])],
      [
        'the same person outside the Secretaria',
        f.authorize(form, [await f.sessionCookie(actor, ['PROFESSOR']), page.cookie]),
      ],
    ];
    for (const [name, attempt] of refused) {
      const reply = await attempt;
      expect(reply.status, name).toBe(403);
      expect(await reply.text(), name).not.toContain('PRIVATE');
    }
    expect(f.graph).not.toHaveBeenCalled();
    expect((await db.query('SELECT id FROM collector_auth.oauth_grants')).rows).toHaveLength(0);
    expect(
      (await f.request(prefix + 'pairings/poll', { id: pair.id, pollToken: 'x'.repeat(43) }))
        .status,
    ).toBe(403);
    expect((await f.authorize(form, [session, page.cookie])).status).toBe(200);
  });
  it.each([
    ['left the Secretaria group', (d: { groups: string[] }) => (d.groups = [])],
    ['was disabled', (d: { user: { accountEnabled: boolean } }) => (d.user.accountEnabled = false)],
    [
      'changed the password after signing in',
      (d: { user: { signInSessionsValidFromDateTime: string } }) =>
        (d.user.signInSessionsValidFromDateTime = new Date(Date.now() + 60_000).toISOString()),
    ],
  ])('refuses the click of a person who %s since the sign-in', async (_name, change) => {
    const f = await fixture(),
      pair = await f.begin();
    const session = await f.sessionCookie(),
      page = await f.open(pair, session);
    change(f.directory);
    const reply = await f.authorize({ pairing: pair.id, csrf: page.csrf }, [session, page.cookie]);
    expect(reply.status).toBe(403);
    expect(await reply.text()).toContain('Conta sem permissão');
    expect((await db.query('SELECT id FROM collector_auth.oauth_grants')).rows).toHaveLength(0);
    expect(
      (
        await db.query<{ state: string }>('SELECT state FROM collector_auth.pairings WHERE id=$1', [
          pair.id,
        ])
      ).rows[0]?.state,
    ).toBe('pending');
  });
  it('denies missing configuration before opening a database', async () => {
    const factory = vi.fn();
    for (const changes of [{ COLLECTOR_ENABLED: undefined }, { COLLECTOR_DB: undefined }])
      expect(
        await createCollectorRuntimeV1({ ...env, ...changes } as RuntimeEnv, { database: factory }),
      ).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });
  it('keeps the collector database open until the frequency request has finished', async () => {
    let open = true;
    const dependencies: CollectorRuntimeDependenciesV1 = {
      database: async () => ({
        query: async <T extends Record<string, unknown>>(sql: string, parameters: unknown[]) => {
          if (!open) throw new Error('synthetic-connection-ended');
          return (await db.query<T>(sql, parameters)).rows;
        },
        close: async () => {
          open = false;
        },
      }),
    };
    const body = {
      proof: {
        deviceId: '66666666-6666-4666-8666-666666666666',
        nonce: 'n'.repeat(43),
        signature: 's'.repeat(86),
      },
      payload: { operation: 'status', academicYear: 2026 },
    };
    const reply = await handleCollectorRequestV1(
      new Request(origin + prefix + 'frequency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      dependencies,
    );
    // An unknown device is a denied proof, never a closed-connection outage.
    expect(reply?.status).toBe(403);
    expect(await reply?.json()).toEqual({ contractVersion: 2, state: 'not-authorized' });
    expect(open).toBe(false);
  });
  it('sends a visitor who is not signed in to the sign-in, and the sign-in back to the same pairing', async () => {
    const f = await fixture(),
      pair = await f.begin();
    const reply = await f.request('/frequency-collector/connect?pairing=' + pair.id);
    expect(reply.status).toBe(302);
    expect(reply.headers.get('Location')).toBe(origin + '/auth/login');
    const setCookie = reply.headers.get('Set-Cookie')!;
    // Lax: the way back from Microsoft is a cross-site navigation.
    expect(setCookie).toMatch(
      /^__Host-collector_return=[A-Za-z0-9_-]+;.*HttpOnly; Secure; SameSite=Lax; Max-Age=600/u,
    );
    expect(setCookie).not.toContain(pair.id);
    const callback = (cookie?: string) =>
      collectorSignInReturnV1(
        new Request(origin + '/auth/callback?state=ordinary', {
          headers: cookie ? { Cookie: cookie } : {},
        }),
        env,
      );
    expect(await callback()).toBeNull();
    const back = await callback(setCookie.split(';')[0]);
    expect(back?.location).toBe(origin + '/frequency-collector/connect?pairing=' + pair.id);
    expect(back?.cookie).toMatch(/^__Host-collector_return=;.*Max-Age=0/u);
    // A cookie that is not ours, or too old, never chooses where the sign-in ends.
    for (const cookie of [
      '__Host-collector_return=forged',
      '__Host-collector_return=' +
        (await seal(
          { purpose: 'collector-return', id: pair.id, exp: Date.now() - 1 },
          env.SESSION_SECRET,
          'collector-return',
        )),
      '__Host-collector_return=' +
        (await seal(
          { purpose: 'collector-return', id: pair.id, exp: Date.now() + 60_000 },
          env.SESSION_SECRET,
          'collector-confirm',
        )),
    ]) {
      const refused = await callback(cookie);
      expect(refused?.location).toBe(origin);
      expect(refused?.cookie).toMatch(/Max-Age=0/u);
    }
    expect(f.graph).not.toHaveBeenCalled();
  });
  it('tells a signed-in person outside the Secretaria why the collector cannot be authorized', async () => {
    const f = await fixture(),
      pair = await f.begin();
    const reply = await f.request('/frequency-collector/connect?pairing=' + pair.id, undefined, {
      Cookie: await f.sessionCookie(actor, ['PROFESSOR']),
    });
    expect(reply.status).toBe(403);
    const body = await reply.text();
    expect(body).toContain('grupo da Secretaria');
    expect(body).toContain('Synthetic &lt;secretary&gt;');
    expect(body).not.toContain('<form');
    expect(body).not.toContain(pair.displayCode);
    expect(reply.headers.get('Set-Cookie')).toBeNull();
  });
});

describe('collector request without maintenance on every call (issue #1426, 13)', () => {
  it('checks the grants once per isolate and runs the retention cleanup only on pairing routes (issue #1450, 7)', async () => {
    const { resetCollectorRuntimeMemoryV1 } = await import('../../server/collector/runtime-v1');
    resetCollectorRuntimeMemoryV1();
    const seen: string[] = [];
    let clock = 1_000_000;
    const dependencies: CollectorRuntimeDependenciesV1 = {
      now: () => clock,
      database: async () => ({
        query: async <T extends Record<string, unknown>>(text: string) => {
          seen.push(text);
          return [{ ready: true }] as unknown as T[];
        },
        close: async () => undefined,
      }),
    };
    const count = (part: string) => seen.filter((text) => text.includes(part)).length;
    for (let index = 0; index < 3; index += 1) await createCollectorRuntimeV1(env, dependencies);
    expect(count('has_schema_privilege')).toBe(1);
    // The database job (pg_cron) does the retention; frequency requests never repeat it.
    expect(count('DELETE FROM collector_auth.challenges')).toBe(0);
    expect(count('WITH expired AS MATERIALIZED')).toBe(3);
    clock += 60_000;
    await createCollectorRuntimeV1(env, dependencies);
    expect(count('DELETE FROM collector_auth.challenges')).toBe(0);
    await createCollectorRuntimeV1(env, dependencies, { pairingRoute: true });
    expect(count('DELETE FROM collector_auth.challenges')).toBe(1);
    resetCollectorRuntimeMemoryV1();
  });
});
