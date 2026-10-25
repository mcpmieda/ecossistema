export type GraphDependencies = {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now?: () => number;
};
export const graphDefaultsV1: GraphDependencies = {
  fetch: (input, init) => fetch(input, init),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};
export class GraphError extends Error {
  constructor(readonly status: number, readonly correlationId: string, readonly retryAfterSeconds?: number) {
    super(`Graph request failed (${status})`);
  }
}

/** Keep the complete opaque nextLink query, but never send a bearer token to another host. */
export function graphUrlV1(path: string): string {
  const url = new URL(path.startsWith('/') && !path.startsWith('//')
    ? `https://graph.microsoft.com/v1.0${path}` : path);
  if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.hash
    || !(url.pathname === '/v1.0' || url.pathname.startsWith('/v1.0/')))
    throw new Error('Graph URL is outside the approved API');
  return url.href;
}
export function graphRetryAfterMsV1(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
async function waitV1(milliseconds: number, dependencies: GraphDependencies, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!signal) return dependencies.sleep(milliseconds);
  let abort!: () => void;
  try {
    await Promise.race([dependencies.sleep(milliseconds), new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

/** One request: the response when it succeeds, or the status (and Retry-After) of a failure that
 * may be retried. Anything else throws. */
async function graphAttemptV1(
  input: Parameters<typeof graphFetchV1>[0],
  method: string,
  remaining: number,
  clock: () => number,
): Promise<Response | { status: number; retryMs: number | undefined }> {
  try {
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(input.attemptTimeoutMs ?? 12_000, remaining))));
    const response = await input.dependencies.fetch(input.url, { ...input.init,
      // Cloudflare Workers only accepts follow/manual. Manual is the
      // fail-closed equivalent here: non-2xx responses are rejected below,
      // without forwarding the bearer token to a redirect destination.
      redirect: input.allowContentRedirect && method === 'GET' ? 'follow' : 'manual',
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout });
    if (response.ok) return response;
    const retryMs = graphRetryAfterMsV1(response.headers.get('Retry-After'), clock());
    await response.body?.cancel().catch(() => undefined);
    if (response.status !== 429 && !(method === 'GET' && response.status >= 500))
      throw new GraphError(response.status, input.correlationId);
    return { status: response.status, retryMs };
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof GraphError) throw error;
    // A write might already have committed. Reconciliation belongs to that command's owner.
    if (method !== 'GET') throw new GraphError(503, input.correlationId);
    return { status: 503, retryMs: undefined };
  }
}

/** No sleeping for less than Retry-After. Long throttling is surfaced to the caller instead
 * of holding an interactive request open. Only GET can replay an ambiguous transport/5xx result.
 */
export async function graphFetchV1(input: {
  url: string; init: RequestInit; correlationId: string; dependencies: GraphDependencies;
  signal?: AbortSignal; attemptTimeoutMs?: number; budgetMs?: number; allowContentRedirect?: boolean;
}): Promise<Response> {
  const clock = input.dependencies.now ?? Date.now;
  const started = clock(), budget = input.budgetMs ?? 20_000;
  let waited = 0, lastStatus = 503;
  const elapsed = () => Math.max(clock() - started, waited);
  const method = input.init.method ?? 'GET';
  for (let attempt = 0; attempt < 5; attempt++) {
    input.signal?.throwIfAborted();
    const remaining = budget - elapsed();
    if (remaining <= 0) throw new GraphError(lastStatus, input.correlationId);
    const outcome = await graphAttemptV1(input, method, remaining, clock);
    if (outcome instanceof Response) return outcome;
    lastStatus = outcome.status;
    const retryMs = outcome.retryMs;
    const delay = retryMs ?? Math.min(8000, 1000 * 2 ** attempt);
    const retryAfterSeconds = Number.isFinite(delay) ? Math.ceil(delay / 1000) : undefined;
    const jitter = crypto.getRandomValues(new Uint8Array(1))[0]!;
    if (attempt === 4 || delay + jitter >= budget - elapsed())
      throw new GraphError(lastStatus, input.correlationId, retryAfterSeconds);
    await waitV1(delay + jitter, input.dependencies, input.signal);
    waited += delay + jitter;
  }
  throw new GraphError(lastStatus, input.correlationId);
}
