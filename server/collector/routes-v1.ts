import { z } from 'zod';
import type { RuntimeEnv } from '../env';
import { seal, unseal } from '../auth/sealed';
import { readCookie, secureCookie, clearCookie } from '../auth/cookies';
import { encodeBase64Url } from '../auth/base64url';
import { readBoundedJson, readBoundedBytes, enforceWriteOrigin } from '../http/security';
import {
  createCollectorRuntimeV1,
  type CollectorRuntimeDependenciesV1,
  createCollectorWithdrawalStoreV1,
} from './runtime-v1';

import { readSession, requireAuth } from '../auth/session';
import { handleCollectorAccessRequestV1 } from './http-v1';
import { handleCollectorFrequencyRequestV2 } from './frequency-http-v2';
import {
  CollectorDirectoryErrorV1,
  readCollectorDirectoryV1,
  type CollectorGrantBindingV1,
} from './directory-v1';
import { verifyCollectorPairingV1 } from './pairing-proof-v1';
import { collectorOpaqueHashV1 } from './pairing-store-v1';

const CONFIRM_COOKIE = '__Host-collector_confirm',
  RETURN_COOKIE = '__Host-collector_return';
const uuid = z.string().uuid(),
  secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const random = () => encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const confirmSchema = z
  .object({
    purpose: z.literal('collector-confirm'),
    id: uuid,
    actor: uuid,
    csrf: secret,
    exp: z.number().int().positive(),
  })
  .strict();
const returnSchema = z
  .object({ purpose: z.literal('collector-return'), id: uuid, exp: z.number().int().positive() })
  .strict();
const withdrawalSchema = z
  .object({
    purpose: z.literal('collector-withdraw'),
    device: uuid,
    actor: uuid,
    tenant: uuid,
    thumb: secret,
    csrf: secret,
    exp: z.number().int().positive(),
  })
  .strict();
const deviceStatusSchema = z.object({ deviceId: uuid, keyThumbprint: secret }).strict(),
  pollSchema = z.object({ id: uuid, pollToken: secret }).strict();
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
const escaped = (text: string) =>
  text.replaceAll(
    /[&<>"']/gu,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
function page(
  title: string,
  body: string,
  status = 200,
  headers: HeadersInit = {},
  refreshUrl?: string,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(
    `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    ${refreshUrl ? `<meta http-equiv="refresh" content="0;url=${escaped(refreshUrl)}">` : ''}
    <title>${escaped(title)} — Ecossistema</title><link rel="stylesheet" href="/frequency-collector/style.css">
    <main><p class="brand">ECOSSISTEMA · COLETOR DE FREQUÊNCIA</p><h1>${escaped(title)}</h1>${body}</main></html>`,
    { status, headers: responseHeaders },
  );
}
const style = `:root{font-family:Segoe UI,system-ui,sans-serif;color:#291e23;background:#faf7f8}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}main{background:white;border:1px solid #e8dce1;border-radius:16px;padding:36px;max-width:480px}h1{font-size:26px}p{line-height:1.6}.brand{color:#8e2841;font-size:11px;font-weight:700;letter-spacing:.1em}form{display:grid;gap:18px}label{display:block;line-height:1.5}button{font:inherit;font-weight:600;border:0;border-radius:24px;padding:14px 18px;background:#a32743;color:white;cursor:pointer}small{display:block;overflow-wrap:anywhere;color:#64545c}a{color:#a32743}.note{padding:14px;background:#faf4f6;border-radius:8px}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #a32743;outline-offset:3px}`;

type CollectorRuntimeReadyV1 = NonNullable<Awaited<ReturnType<typeof createCollectorRuntimeV1>>>;
type WithdrawalStoreV1 = NonNullable<
  Awaited<ReturnType<typeof createCollectorWithdrawalStoreV1>>
>['store'];
type SessionV1 = Awaited<ReturnType<typeof requireAuth>>;
const WITHDRAW_COOKIE = '__Host-collector_withdraw';
const denied = () => json({ error: 'Collector access denied' }, 403);
const notAllowed = () => json({ error: 'Method not allowed' }, 405);
const foreignOrigin = (request: Request, env: RuntimeEnv) =>
  request.headers.has('Origin') && request.headers.get('Origin') !== env.OFFICIAL_ORIGIN;
const formOf = async (request: Request) =>
  new URLSearchParams(
    new TextDecoder('utf-8', { fatal: true }).decode(
      await readBoundedBytes(request, {
        maxBytes: 1024,
        allowedContentTypes: ['application/x-www-form-urlencoded'],
      }),
    ),
  );

/** A verified application session can only ask the revocation status or retire its own device. */
async function deviceStatus(
  request: Request,
  env: RuntimeEnv,
  store: WithdrawalStoreV1,
): Promise<Response> {
  if (request.method !== 'POST' || foreignOrigin(request, env))
    return json({ error: 'Denied' }, 403);
  const value = deviceStatusSchema.parse(await readBoundedJson(request, 1024));
  return json({ revoked: await store.revocationStatus(value.deviceId, value.keyThumbprint) });
}
async function withdrawalPage(
  url: URL,
  env: RuntimeEnv,
  store: WithdrawalStoreV1,
  session: SessionV1,
): Promise<Response> {
  const device = uuid.parse(url.searchParams.get('device'));
  const thumb = await store.ownedKey(device, env.TENANT_ID, session.oid);
  if (!thumb)
    return page('Vínculo indisponível', '<p>Esta sessão não é dona deste vínculo.</p>', 404);
  const csrf = random(),
    value = {
      purpose: 'collector-withdraw',
      device,
      actor: session.oid,
      tenant: env.TENANT_ID,
      thumb,
      csrf,
      exp: Date.now() + 600_000,
    };
  return page(
    'Concluir a saída do coletor',
    `<p>A chave local já pode ter sido apagada. Esta confirmação retira o acesso deste dispositivo no servidor, sem encerrar sessões de outros módulos.</p>
    <form method="post" action="/frequency-collector/revoke"><input type="hidden" name="device" value="${device}"><input type="hidden" name="csrf" value="${csrf}">
    <label><input type="checkbox" name="confirm" value="yes" required> Quero retirar o vínculo deste dispositivo.</label><button type="submit">Retirar vínculo</button></form>`,
    200,
    {
      'Set-Cookie': secureCookie(
        WITHDRAW_COOKIE,
        await seal(value, env.SESSION_SECRET, 'collector-withdraw'),
        { maxAge: 600, sameSite: 'Strict' },
      ),
    },
  );
}
async function confirmWithdrawal(
  request: Request,
  env: RuntimeEnv,
  store: WithdrawalStoreV1,
  session: SessionV1,
): Promise<Response> {
  enforceWriteOrigin(request, env);
  const form = await formOf(request);
  const cookie = readCookie(request, WITHDRAW_COOKIE);
  const value = withdrawalSchema.parse(
    cookie && cookie.length < 4096
      ? await unseal(cookie, env.SESSION_SECRET, 'collector-withdraw')
      : null,
  );
  const keys = [...form.keys()];
  const confirmed =
    keys.length === 3 &&
    new Set(keys).size === 3 &&
    form.get('confirm') === 'yes' &&
    value.exp > Date.now() &&
    value.device === form.get('device') &&
    value.csrf === form.get('csrf') &&
    value.actor === session.oid &&
    value.tenant === env.TENANT_ID;
  if (
    !confirmed ||
    (await store.ownedKey(value.device, env.TENANT_ID, session.oid)) !== value.thumb
  )
    throw new Error('withdrawal-denied');
  await store.revokeDevice(value.device, env.TENANT_ID, session.oid, value.thumb);
  return page('Vínculo retirado', '<p>Volte ao Coletor e clique em Concluir saída.</p>', 200, {
    'Set-Cookie': clearCookie(WITHDRAW_COOKIE),
  });
}
/** Withdrawal only: no directory/refresh key is needed and no authority is issued. */
async function handleWithdrawalV1(
  request: Request,
  url: URL,
  env: RuntimeEnv,
  dependencies: CollectorRuntimeDependenciesV1,
): Promise<Response> {
  const withdrawal = await createCollectorWithdrawalStoreV1(env, dependencies);
  if (!withdrawal) return json({ error: 'Collector withdrawal unavailable' }, 503);
  try {
    if (url.pathname === prefixPath('device-status'))
      return await deviceStatus(request, env, withdrawal.store);
    let session: SessionV1;
    try {
      session = await requireAuth(request, env);
    } catch {
      return page(
        'Entre para concluir a saída',
        '<p>Entre no Ecossistema com a conta dona do vínculo e depois reabra esta página pelo Coletor.</p><a href="/auth/login">Entrar no Ecossistema</a>',
        401,
      );
    }
    if (request.method === 'GET') return await withdrawalPage(url, env, withdrawal.store, session);
    if (request.method !== 'POST') return notAllowed();
    return await confirmWithdrawal(request, env, withdrawal.store, session);
  } catch {
    return json({ error: 'Collector withdrawal denied' }, 403);
  } finally {
    await withdrawal.close().catch(() => undefined);
  }
}

const connectUrl = (env: RuntimeEnv, pairingId: string) =>
  env.OFFICIAL_ORIGIN + '/frequency-collector/connect?pairing=' + pairingId;

/**
 * A sign-in that began on the authorization page ends back on it: the collector opened the browser
 * for one pairing, and the person should not have to open it a second time after signing in.
 * Null when this sign-in did not begin there.
 */
export async function collectorSignInReturnV1(
  request: Request,
  env: RuntimeEnv,
  now = Date.now(),
): Promise<{ location: string; cookie: string } | null> {
  const cookie = readCookie(request, RETURN_COOKIE);
  if (!cookie) return null;
  const value = returnSchema.safeParse(
    cookie.length < 4096
      ? await unseal(cookie, env.SESSION_SECRET, 'collector-return').catch(() => null)
      : null,
  );
  return {
    location:
      value.success && value.data.exp > now ? connectUrl(env, value.data.id) : env.OFFICIAL_ORIGIN,
    cookie: clearCookie(RETURN_COOKIE),
  };
}

/** One click (owner decision of 17/11/2026): the person signed in to the Ecossistema confirms the
 * pairing this collector opened. Whoever is not signed in signs in first and comes back here. */
async function connectPage(
  request: Request,
  url: URL,
  env: RuntimeEnv,
  runtime: CollectorRuntimeReadyV1,
): Promise<Response> {
  const id = uuid.parse(url.searchParams.get('pairing')),
    view = await runtime.pairings.browserView(id);
  if (!view)
    return page('Autorização expirada', '<p>Prepare o acesso novamente no Coletor.</p>', 410);
  const exp = Math.min(
    runtime.directory.now() + 600_000,
    new Date(view.expires_at as string | Date).getTime(),
  );
  const session = await readSession(request, env);
  if (session?.authenticatedAt === undefined)
    return new Response(null, {
      status: 302,
      headers: {
        Location: env.OFFICIAL_ORIGIN + '/auth/login',
        'Cache-Control': 'no-store',
        'Set-Cookie': secureCookie(
          RETURN_COOKIE,
          await seal(
            { purpose: 'collector-return', id, exp },
            env.SESSION_SECRET,
            'collector-return',
          ),
          { maxAge: 600 },
        ),
      },
    });
  if (!session.roles.includes('ADMINISTRADOR'))
    return page(
      'Conta sem permissão',
      `<p>Você entrou como <strong>${escaped(session.name)}</strong>. Só quem faz parte do grupo da Secretaria pode autorizar o Coletor.</p>
      <p>Saia do Ecossistema, entre com uma conta da Secretaria e abra o pedido de novo pelo Coletor.</p>`,
      403,
    );
  const csrf = random(),
    cookie = await seal(
      { purpose: 'collector-confirm', id, actor: session.oid, csrf, exp },
      env.SESSION_SECRET,
      'collector-confirm',
    );
  return page(
    'Autorizar este computador',
    `<p>Você entrou como <strong>${escaped(session.name)}</strong>.</p>
    <p>O Coletor deste computador deve estar mostrando o código <strong>${escaped(String(view.display_code))}</strong>. Autorize somente se foi você quem abriu este pedido no Coletor.</p>
    <form method="post" action="/frequency-collector/connect"><input type="hidden" name="pairing" value="${id}"><input type="hidden" name="csrf" value="${csrf}">
    <button type="submit">Autorizar este computador</button></form>
    <p class="note">O acesso vale enquanto a sua conta fizer parte do grupo da Secretaria; isso é conferido a cada cinco minutos. Nenhuma senha é guardada.</p>
    <small>Chave pública do pedido: ${escaped(String(view.key_thumbprint))}</small>`,
    200,
    { 'Set-Cookie': secureCookie(CONFIRM_COOKIE, cookie, { maxAge: 600, sameSite: 'Strict' }) },
  );
}

function connectRefusal(error: unknown): Response {
  const reason = error instanceof CollectorDirectoryErrorV1 ? error.reason : 'denied';
  if (reason === 'unavailable')
    return page(
      'Não foi possível conferir a sua conta agora',
      '<p>A consulta à Microsoft falhou. Espere um minuto e abra o pedido de novo pelo Coletor.</p>',
      503,
    );
  if (reason === 'access-denied')
    return page(
      'Conta sem permissão',
      '<p>A sua conta não está ativa no grupo da Secretaria, ou a senha dela mudou depois que você entrou. Saia do Ecossistema, entre de novo e abra o pedido outra vez pelo Coletor.</p>',
      403,
    );
  return page(
    'Não foi possível concluir a autorização',
    '<p>Este pedido não vale mais. Volte ao Coletor, cancele esta tentativa e inicie uma nova autorização.</p>',
    403,
  );
}

async function confirmConnect(
  request: Request,
  env: RuntimeEnv,
  runtime: CollectorRuntimeReadyV1,
): Promise<Response> {
  let stage = 'validate-request';
  try {
    enforceWriteOrigin(request, env);
    const form = await formOf(request);
    const keys = [...form.keys()];
    if (keys.length !== 2 || new Set(keys).size !== 2) throw new Error('confirmation-required');
    stage = 'verify-confirmation';
    const cookie = readCookie(request, CONFIRM_COOKIE),
      confirmed = confirmSchema.parse(
        cookie && cookie.length < 4096
          ? await unseal(cookie, env.SESSION_SECRET, 'collector-confirm')
          : null,
      );
    if (
      confirmed.exp <= runtime.directory.now() ||
      confirmed.id !== form.get('pairing') ||
      confirmed.csrf !== form.get('csrf')
    )
      throw new Error('confirmation-denied');
    stage = 'verify-session';
    const session = await readSession(request, env);
    if (
      session?.authenticatedAt === undefined ||
      session.oid !== confirmed.actor ||
      !session.roles.includes('ADMINISTRADOR')
    )
      throw new Error('confirmation-denied');
    // The session knows the group as it was at sign-in; the directory says how it is now.
    stage = 'verify-directory';
    const binding: CollectorGrantBindingV1 = {
      tenantId: env.TENANT_ID,
      actorId: session.oid,
      clientId: env.WEB_CLIENT_ID,
      grantId: crypto.randomUUID(),
      generation: 1,
      version: 0,
      originAuthenticatedAt: session.authenticatedAt * 1000,
    };
    const directory = await readCollectorDirectoryV1({
      binding,
      expectedTenantId: env.TENANT_ID,
      expectedClientId: env.WEB_CLIENT_ID,
      adminGroupId: env.GROUP_ADMIN_ID,
      dependencies: runtime.directory,
    });
    stage = 'authorize-pairing';
    if (!(await runtime.pairings.authorize({ pairingId: confirmed.id, binding, directory })))
      throw new Error('confirmation-denied');
    return page(
      'Computador autorizado',
      '<p>Volte ao Coletor: ele continua sozinho em alguns segundos. Se não continuar, clique em <strong>Verificar acesso</strong>.</p><p>Nenhuma senha ficou guardada no programa nem no servidor.</p>',
      200,
      { 'Set-Cookie': clearCookie(CONFIRM_COOKIE) },
    );
  } catch (error) {
    // Stage-only telemetry: never log pairing IDs, codes, cookies, identity, HTTP payload or
    // exception message.
    console.error(
      JSON.stringify({
        message: 'collector_confirmation_failed',
        stage,
        errorType: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return connectRefusal(error);
  }
}
/** Cloudflare supplies CF-Connecting-IP at the edge; avoid storing raw IP.
 * Do not trust forwarded client headers for authority: the independent
 * global database budget enforces a ceiling even if this one is spoofed. */
async function pairingScopeV1(request: Request, env: RuntimeEnv): Promise<string> {
  const edgeAddress = request.headers.get('CF-Connecting-IP') ?? '';
  const source = /^[0-9a-fA-F:.]{3,48}$/u.test(edgeAddress) ? edgeAddress.toLowerCase() : 'unknown';
  return 'client:' + (await collectorOpaqueHashV1(env.SESSION_SECRET + String.raw`\0` + source));
}
async function pairingRequest(
  request: Request,
  url: URL,
  env: RuntimeEnv,
  runtime: CollectorRuntimeReadyV1,
): Promise<Response> {
  if (request.method !== 'POST') return notAllowed();
  if (foreignOrigin(request, env)) return denied();
  const value = await readBoundedJson(request, 2048);
  if (url.pathname === '/api/frequency-collector/pairings') {
    const scope = await pairingScopeV1(request, env);
    // Malformed/unsigned requests must not consume the scarce school-wide
    // pairing quota. A self-signed valid key is still untrusted, hence DB caps.
    const proof = await verifyCollectorPairingV1(value, runtime.directory.now());
    const pollToken = random();
    const digits = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const displayCode = String(digits % 1_000_000).padStart(6, '0');
    // Database function reserves BOTH rate budgets and the 80th pending slot
    // together with this INSERT; a failed insert rolls back its reservations.
    if (
      !(await runtime.pairings.createAdmitted(scope, {
        id: proof.id,
        publicKey: proof.publicKey,
        pollHash: await collectorOpaqueHashV1(pollToken),
        displayCode,
        createdAt: runtime.directory.now(),
      }))
    )
      return new Response(
        JSON.stringify({ error: 'Pairing temporarily unavailable', code: 'ACCESS_UNAVAILABLE' }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '600',
          },
        },
      );
    return json({
      contractVersion: 1,
      id: proof.id,
      pollToken,
      displayCode,
      browserUrl: connectUrl(env, proof.id),
    });
  }
  const poll = pollSchema.parse(value),
    hash = await collectorOpaqueHashV1(poll.pollToken);
  if (url.pathname === '/api/frequency-collector/pairings/poll') {
    const found = await runtime.pairings.poll(poll.id, hash);
    if (!found) return json({ error: 'Pairing unavailable' }, 403);
    return json({
      contractVersion: 1,
      state: found.state,
      ...(found.state === 'completed' ? { deviceId: found.device_id } : {}),
    });
  }
  if (url.pathname === '/api/frequency-collector/pairings/cancel') {
    await runtime.pairings.cancel(poll.id, hash);
    return json({ cancelled: true });
  }
  if (url.pathname === '/api/frequency-collector/pairings/claim') {
    if (!(await runtime.pairings.claim(poll.id, hash)))
      return json({ error: 'Pairing unavailable' }, 403);
    return json({ claimed: true });
  }
  return json({ error: 'Not found' }, 404);
}
/** Every branch is awaited: the runtime's connection closes only after the response is complete. */
async function runtimeRoute(
  request: Request,
  url: URL,
  env: RuntimeEnv,
  runtime: CollectorRuntimeReadyV1,
): Promise<Response> {
  if (url.pathname === '/frequency-collector/connect') {
    if (request.method === 'GET') return await connectPage(request, url, env, runtime);
    if (request.method !== 'POST') return notAllowed();
    return await confirmConnect(request, env, runtime);
  }
  if (url.pathname === '/api/frequency-collector/config')
    return request.method === 'GET'
      ? json({ contractVersion: 1, ready: true, serverTime: runtime.directory.now() })
      : notAllowed();
  if (url.pathname === '/api/frequency-collector/frequency')
    return await handleCollectorFrequencyRequestV2(request, env, runtime.access);
  const access = await handleCollectorAccessRequestV1(request, runtime.access);
  if (access) return access;
  return await pairingRequest(request, url, env, runtime);
}

/** Pages-mounted orchestration. All credentials/SQL live on the server. */
export async function handleCollectorRequestV1(
  request: Request,
  env: RuntimeEnv,
  dependencies: CollectorRuntimeDependenciesV1 = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  const collectorPath =
    url.pathname.startsWith('/api/frequency-collector/') ||
    url.pathname.startsWith('/frequency-collector/');
  if (!collectorPath) return null;
  if (url.origin !== 'https://admin.escolaieda.com' || env.OFFICIAL_ORIGIN !== url.origin)
    return denied();
  if (url.pathname === '/frequency-collector/style.css')
    return request.method === 'GET'
      ? new Response(style, {
          headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      : notAllowed();
  if (
    url.pathname === '/frequency-collector/revoke' ||
    url.pathname === prefixPath('device-status')
  )
    return handleWithdrawalV1(request, url, env, dependencies);
  // Pairing pages keep the abandoned-pairing cleanup on every request.
  const pairingRoute =
    url.pathname.startsWith('/api/frequency-collector/pairings') ||
    url.pathname === '/frequency-collector/connect';
  const runtime = await createCollectorRuntimeV1(env, dependencies, { pairingRoute });
  if (!runtime)
    return json({ error: 'Collector access unavailable', code: 'ACCESS_NOT_CONFIGURED' }, 503);
  try {
    return await runtimeRoute(request, url, env, runtime);
  } catch {
    return json({ error: 'Collector access denied', code: 'ACCESS_REQUIRED' }, 403);
  } finally {
    await runtime.close().catch(() => undefined);
  }
}
function prefixPath(suffix: string) {
  return '/api/frequency-collector/' + suffix;
}
