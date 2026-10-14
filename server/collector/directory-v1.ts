import { z } from 'zod';
import { collectorGrantBindingV1, type CollectorGrantBindingV1 } from './refresh-cipher-v1';

const DIRECTORY_WINDOW_MS = 300_000;
const ownUser = z.object({ id: z.string().uuid(), accountEnabled: z.literal(true),
  signInSessionsValidFromDateTime: z.string().datetime({ offset: true }) });
const memberships = z.object({ value: z.array(z.string().uuid()).max(1) });
const refreshed = z.object({ token_type: z.literal('Bearer'), access_token: z.string().min(16).max(16_384),
  expires_in: z.number().int().positive().max(86_400), scope: z.string().max(4096),
  refresh_token: z.string().min(16).max(16_384).optional() });
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const USER_READ_SCOPE = 'https://graph.microsoft.com/User.Read';

export type CollectorDirectoryEvidenceV1 = Readonly<{
  tenantId: string; actorId: string; grantId: string; grantGeneration: number;
  originAuthenticatedAt: number; directoryCheckedAt: number; directoryValidUntil: number;
}>;
export class CollectorDirectoryErrorV1 extends Error {
  constructor(readonly reason: 'access-denied' | 'reauthentication-required' | 'unavailable' | 'invalid-contract') {
    super('collector-directory-' + reason);
  }
}
export type CollectorDirectoryDependenciesV1 = {
  fetch: typeof fetch; now: () => number; clientAssertion: () => Promise<string>;
};

async function readJson(response: Response, maximum = 48_000): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new CollectorDirectoryErrorV1('invalid-contract');
  const reader = response.body?.getReader();
  if (!reader) throw new CollectorDirectoryErrorV1('invalid-contract');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) throw new CollectorDirectoryErrorV1('invalid-contract');
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { throw new CollectorDirectoryErrorV1('invalid-contract'); }
}

function valid(binding: CollectorGrantBindingV1, evidence: CollectorDirectoryEvidenceV1, now: number): boolean {
  return evidence.tenantId === binding.tenantId && evidence.actorId === binding.actorId
    && evidence.grantId === binding.grantId && evidence.grantGeneration === binding.generation
    && evidence.originAuthenticatedAt === binding.originAuthenticatedAt
    && Number.isSafeInteger(evidence.directoryCheckedAt) && evidence.directoryCheckedAt <= now
    && evidence.directoryValidUntil === evidence.directoryCheckedAt + DIRECTORY_WINDOW_MS
    && now < evidence.directoryValidUntil;
}

/** Evidence is checked independently of a local device/session revocation read.
 * The lease may never extend beyond directoryValidUntil, even at the cache edge. */
export function collectorLeaseExpiryV1(binding: CollectorGrantBindingV1, evidence: CollectorDirectoryEvidenceV1,
  now: number, leaseMs = DIRECTORY_WINDOW_MS): number {
  if (!valid(binding, evidence, now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > DIRECTORY_WINDOW_MS)
    throw new CollectorDirectoryErrorV1('access-denied');
  return Math.min(now + leaseMs, evidence.directoryValidUntil);
}

/** Server-private result. Never return its Microsoft tokens through an HTTP handler.
 * Caller must replace/discard a returned refresh token atomically under a grant
 * version/refresh lease; Microsoft does not invalidate the previous refresh token. */
export async function readCollectorOwnDirectoryV1(input: {
  binding: CollectorGrantBindingV1; expectedTenantId: string; expectedClientId: string; adminGroupId: string;
  refreshToken: string; dependencies: CollectorDirectoryDependenciesV1;
}): Promise<{ evidence: CollectorDirectoryEvidenceV1; nextRefreshToken: string }> {
  const { dependencies } = input;
  try {
    const binding = collectorGrantBindingV1.parse(input.binding);
    const group = z.string().uuid().parse(input.adminGroupId).toLowerCase();
    if (binding.tenantId !== input.expectedTenantId || binding.clientId !== input.expectedClientId
        || input.refreshToken.length < 16 || input.refreshToken.length > 16_384)
      throw new CollectorDirectoryErrorV1('access-denied');
    const directoryCheckedAt = dependencies.now();
    const signal = AbortSignal.timeout(15_000);
    const response = await dependencies.fetch(`https://login.microsoftonline.com/${binding.tenantId}/oauth2/v2.0/token`, {
      method: 'POST', redirect: 'manual', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: binding.clientId, grant_type: 'refresh_token',
        refresh_token: input.refreshToken, scope: USER_READ_SCOPE,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await dependencies.clientAssertion() }),
    });
    if (!response.ok) {
      if (response.status === 400 || response.status === 401 || response.status === 403)
        throw new CollectorDirectoryErrorV1('reauthentication-required');
      throw new CollectorDirectoryErrorV1('unavailable');
    }
    const token = refreshed.parse(await readJson(response));
    // Response scope is checked too; do not treat a broader pre-existing consent
    // or .default token as an acceptable collector delegation.
    const scopes = token.scope.trim().split(/\s+/u);
    if (scopes.length !== 1 || !['User.Read', USER_READ_SCOPE].includes(scopes[0]!))
      throw new CollectorDirectoryErrorV1('invalid-contract');
    const headers = { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' };
    const meResponse = await dependencies.fetch(GRAPH_ORIGIN + '/v1.0/me?$select=id,accountEnabled,signInSessionsValidFromDateTime',
      { method: 'GET', headers, redirect: 'manual', signal });
    if (!meResponse.ok) {
      if ([401, 403, 404].includes(meResponse.status)) throw new CollectorDirectoryErrorV1('access-denied');
      throw new CollectorDirectoryErrorV1('unavailable');
    }
    const me = ownUser.parse(await readJson(meResponse, 8192));
    if (me.id.toLowerCase() !== binding.actorId.toLowerCase()
        || Date.parse(me.signInSessionsValidFromDateTime) > binding.originAuthenticatedAt)
      throw new CollectorDirectoryErrorV1('access-denied');
    const groupResponse = await dependencies.fetch(GRAPH_ORIGIN + '/v1.0/me/checkMemberGroups',
      { method: 'POST', redirect: 'manual', signal, headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupIds: [group] }) });
    if (!groupResponse.ok) {
      if ([401, 403, 404].includes(groupResponse.status)) throw new CollectorDirectoryErrorV1('access-denied');
      throw new CollectorDirectoryErrorV1('unavailable');
    }
    const result = memberships.parse(await readJson(groupResponse, 8192));
    if (result.value.length !== 1 || result.value[0]!.toLowerCase() !== group)
      throw new CollectorDirectoryErrorV1('access-denied');
    const evidence = Object.freeze({ tenantId: binding.tenantId, actorId: binding.actorId,
      grantId: binding.grantId, grantGeneration: binding.generation, originAuthenticatedAt: binding.originAuthenticatedAt,
      directoryCheckedAt, directoryValidUntil: directoryCheckedAt + DIRECTORY_WINDOW_MS });
    collectorLeaseExpiryV1(binding, evidence, dependencies.now());
    return { evidence, nextRefreshToken: token.refresh_token ?? input.refreshToken };
  } catch (error) {
    if (error instanceof CollectorDirectoryErrorV1) throw error;
    // Provider bodies, tokens, assertions and malformed property values stay private.
    throw new CollectorDirectoryErrorV1('unavailable');
  }
}
