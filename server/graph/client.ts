import { z } from 'zod';
import type { RuntimeEnv } from '../env';
import { createClientAssertion } from '../auth/client-assertion';
import { graphCredentials, type GraphCredentialSlot } from '../auth/technical-identity';
import { GraphError, graphDefaultsV1, graphFetchV1, graphRetryAfterMsV1, graphUrlV1, type GraphDependencies } from './request-policy-v1';
export { GraphError } from './request-policy-v1';
export type { GraphDependencies } from './request-policy-v1';

const tokenSchema = z.object({ access_token: z.string(), expires_in: z.number() });
export type GraphTokenFailureStage = 'assertion' | 'transport' | 'response-contract';
export class GraphTokenError extends Error {
  constructor(
    readonly stage: GraphTokenFailureStage,
    readonly slot: GraphCredentialSlot | null,
  ) {
    super('Graph token preparation failed');
  }
}
/** The issued token; null when this certificate was refused (the next one may be tried). */
async function tokenOrRefusalV1(response: Response, slot: GraphCredentialSlot,
  dependencies: GraphDependencies): Promise<string | null> {
  if (response.ok) {
    try { return tokenSchema.parse(await response.json()).access_token; }
    catch { throw new GraphTokenError('response-contract', slot); }
  }
  const wait = graphRetryAfterMsV1(response.headers.get('Retry-After'), (dependencies.now ?? Date.now)());
  await response.body?.cancel().catch(() => undefined);
  // A throttled identity endpoint is not an invitation to try another certificate immediately.
  if (response.status === 429 || response.status >= 500)
    throw new GraphError(response.status, crypto.randomUUID(), wait === undefined ? undefined : Math.ceil(wait / 1000));
  return null;
}
export async function getGraphToken(env: RuntimeEnv, dependencies: GraphDependencies = graphDefaultsV1,
  slot?: GraphCredentialSlot): Promise<string> {
  const endpoint = `https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`;
  let lastStatus = 0;
  let lastAssertionSlot: GraphCredentialSlot | undefined;
  for (const credential of graphCredentials(env, slot)) {
    let assertion: string;
    try {
      assertion = await createClientAssertion({ clientId: env.GRAPH_CLIENT_ID, tenantId: env.TENANT_ID,
        privateKeyPkcs8: credential.privateKeyPkcs8, certificateThumbprint: credential.certificateThumbprint });
    } catch {
      lastAssertionSlot = credential.slot;
      if (slot) throw new GraphTokenError('assertion', credential.slot);
      continue;
    }
    let response: Response;
    try {
      // Workers intentionally rejects `redirect: "error"` before issuing the
      // subrequest. Manual mode keeps the assertion on the approved origin and
      // lets the status handling below fail closed on every 3xx response.
      response = await dependencies.fetch(endpoint, { method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.GRAPH_CLIENT_ID, scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion }),
        signal: AbortSignal.timeout(10_000) });
    } catch { throw new GraphTokenError('transport', credential.slot); }
    lastStatus = response.status;
    const token = await tokenOrRefusalV1(response, credential.slot, dependencies);
    if (token !== null) return token;
  }
  if (lastStatus === 0) {
    throw new GraphTokenError('assertion', lastAssertionSlot ?? slot ?? null);
  }
  // Keep the identity provider response body private, but retain the status and an
  // opaque correlation id so callers can classify an outage without parsing text.
  throw new GraphError(lastStatus || 503, crypto.randomUUID());
}

export async function graphRequest<T>(input: {
  env: RuntimeEnv; path: string; method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown;
  etag?: string; prefer?: 'bypass-shared-lock'; correlationId?: string; dependencies?: GraphDependencies;
  token?: string; credentialSlot?: GraphCredentialSlot; signal?: AbortSignal; budgetMs?: number;
}): Promise<{ data: T; etag: string | null; correlationId: string }> {
  const url = graphUrlV1(input.path);
  const dependencies = input.dependencies ?? graphDefaultsV1;
  input.signal?.throwIfAborted();
  const token = input.token ?? await getGraphToken(input.env, dependencies, input.credentialSlot);
  const correlationId = input.correlationId ?? crypto.randomUUID();
  const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: 'application/json',
    'client-request-id': correlationId, 'return-client-request-id': 'true' });
  if (input.body !== undefined) headers.set('Content-Type', 'application/json');
  if (input.etag) headers.set('If-Match', input.etag);
  if (input.prefer) headers.set('Prefer', input.prefer);
  const response = await graphFetchV1({ url, dependencies, correlationId, signal: input.signal, budgetMs: input.budgetMs,
    init: { method: input.method ?? 'GET', headers, body: input.body === undefined ? undefined : JSON.stringify(input.body) } });
  const data = response.status === 204 ? null : await response.json();
  return { data: data as T, etag: response.headers.get('ETag'), correlationId };
}

export async function graphContentRequest(input: {
  env: RuntimeEnv; path: string; method: 'GET' | 'PUT'; body?: Uint8Array; contentType?: string;
  correlationId?: string; dependencies?: GraphDependencies; token?: string;
  credentialSlot?: GraphCredentialSlot; signal?: AbortSignal;
}): Promise<{ response: Response; correlationId: string }> {
  const url = graphUrlV1(input.path);
  if (input.method === 'PUT' && !input.contentType) throw new Error('Graph binary PUT requires contentType');
  const dependencies = input.dependencies ?? graphDefaultsV1;
  input.signal?.throwIfAborted();
  const token = input.token ?? await getGraphToken(input.env, dependencies, input.credentialSlot);
  const correlationId = input.correlationId ?? crypto.randomUUID();
  let body: ArrayBuffer | undefined;
  if (input.body !== undefined) {
    const stable = new Uint8Array(input.body.byteLength); stable.set(input.body); body = stable.buffer;
  }
  const headers = new Headers({ Authorization: `Bearer ${token}`, 'client-request-id': correlationId, 'return-client-request-id': 'true' });
  if (input.contentType) headers.set('Content-Type', input.contentType);
  const response = await graphFetchV1({ url, dependencies, correlationId, signal: input.signal,
    attemptTimeoutMs: 30_000, budgetMs: 45_000, allowContentRedirect: true,
    init: { method: input.method, headers, body } });
  return { response, correlationId };
}

/** The next page, absent on the last one; anything but a non-empty link is a broken page. */
function nextPageV1(link: unknown, correlationId: string): string | null {
  if (link !== undefined && (typeof link !== 'string' || !link)) throw new GraphError(502, correlationId);
  return typeof link === 'string' ? graphUrlV1(link) : null;
}

/** Complete pagination, one token, opaque cursors and a resource deadline. Never return a
 * silently truncated collection. A loop, wrong origin or capacity failure is explicit.
 */
export async function graphAllPages<T>(env: RuntimeEnv, initialPath: string, token?: string,
  options: { dependencies?: GraphDependencies; signal?: AbortSignal; budgetMs?: number } = {}): Promise<T[]> {
  const dependencies = options.dependencies ?? graphDefaultsV1, clock = dependencies.now ?? Date.now;
  const started = clock(), budget = options.budgetMs ?? 30_000;
  let next: string | null = graphUrlV1(initialPath);
  options.signal?.throwIfAborted();
  const ownToken = token ?? await getGraphToken(env, dependencies);
  const values: T[] = [], seen = new Set<string>();
  const correlationId = crypto.randomUUID();
  while (next) {
    const url = graphUrlV1(next);
    if (seen.has(url)) throw new Error('Graph pagination cycle detected');
    seen.add(url);
    const remaining = budget - (clock() - started);
    if (remaining <= 0 || seen.size > 1000) throw new Error('Graph pagination capacity exceeded');
    const result = await graphRequest<{ value: T[]; '@odata.nextLink'?: string }>({
      env, path: url, token: ownToken, dependencies, correlationId, signal: options.signal, budgetMs: remaining });
    if (!result.data || !Array.isArray(result.data.value)) throw new GraphError(502, correlationId);
    if (values.length + result.data.value.length > 50_000) throw new Error('Graph pagination capacity exceeded');
    for (const value of result.data.value) values.push(value);
    next = nextPageV1(result.data['@odata.nextLink'], correlationId);
  }
  return values;
}

export async function graphBatch(env: RuntimeEnv,
  requests: Array<{ id: string; method: string; url: string }>): Promise<unknown> {
  if (requests.length === 0 || requests.length > 20) throw new Error('Graph batch requires 1 to 20 requests');
  return (await graphRequest<unknown>({ env, path: '/$batch', method: 'POST', body: { requests } })).data;
}
