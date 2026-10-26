import type { z } from 'zod';
import { ACCESS_CLOSED_ACCEPT_HEADER_V1 } from '../../../../shared/student-portal-contracts/auth-v1';
import {
  ERROR_HTTP_V1,
  failureV1,
  type FailureV1,
} from '../../../../shared/student-portal-contracts/core-v1';

export type PortalFetchV1 = (path: string, init: RequestInit) => Promise<Response>;
export type PortalClientStateV1 = FailureV1['state'] | 'invalid-response' | 'network-error';
export class PortalClientErrorV1 extends Error {
  constructor(
    readonly state: PortalClientStateV1,
    readonly status = 0,
    readonly retryAfterSeconds?: number,
    readonly requestId?: string,
  ) {
    super(state);
    this.name = 'PortalClientErrorV1';
  }
}
export function isAmbiguousPortalResponseV1(error: unknown): error is PortalClientErrorV1 {
  if (!(error instanceof PortalClientErrorV1) || error.retryAfterSeconds !== undefined)
    return false;
  if (error.state === 'network-error' || error.state === 'unavailable') return true;
  return (
    error.state === 'invalid-response' &&
    (error.status === 0 || error.status === 200 || error.status >= 500)
  );
}
export interface PortalTransportOptionsV1 {
  fetch?: PortalFetchV1;
  onUnauthorized?: () => void;
  respectRetryAfter?: boolean;
  acceptAccessClosed?: boolean;
}

/** Pages adds private/no-cache directives; require the exact no-store directive, not header equality. */
export function hasPortalNoStoreV1(headers: Headers): boolean {
  return (headers.get('Cache-Control') ?? '')
    .split(',')
    .some((value) => value.trim().toLowerCase() === 'no-store');
}

function retryDelay(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = /^\d+$/u.test(header)
    ? Number(header)
    : Math.ceil((Date.parse(header) - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.min(86400, Math.max(1, seconds)) : undefined;
}

const UUID_V1 = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
/** The session check of one account, with its live connection when there is one. */
const SESSION_CHECK_PATH_V1 = new RegExp(
  String.raw`^/api/student/session\?accountId=${UUID_V1}(?:&connectionId=${UUID_V1})?$`,
  'iu',
);

/** Fixed same-origin paths only: the student session and auth routes, the Portal ADM query and
 * command, and the session check of one account (with its live connection). */
function allowedPortalPathV1(path: string) {
  return (
    /^\/api\/(?:student\/(?:session|me|status|auth\/(?:challenge|activate|login|logout))|student-portal\/admin\/(?:query|command))$/u.test(
      path,
    ) ||
    SESSION_CHECK_PATH_V1.test(path)
  );
}

function dropExpiredV1(cooldowns: Map<string, number>, now: number) {
  for (const [key, until] of cooldowns) if (until <= now) cooldowns.delete(key);
}

/** A new live connection ID must not bypass the same account's session cooldown. */
function cooldownKeyV1(path: string) {
  return path.startsWith('/api/student/session?') ? path.split('&connectionId=')[0]!.toLowerCase() : path;
}

/** Only sign-in and the session ask for the access-closed answer, when the client accepts it. */
function acceptsAccessClosedV1(path: string, acceptAccessClosed: boolean | undefined) {
  return Boolean(acceptAccessClosed) &&
    (path === '/api/student/auth/challenge' || path === '/api/student/auth/login' || path.startsWith('/api/student/session'));
}

function requestInitV1(body: string | undefined, signal: AbortSignal | undefined, accessClosed: boolean): RequestInit {
  return {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal,
    headers: {
      Accept: 'application/json',
      ...(accessClosed ? { [ACCESS_CLOSED_ACCEPT_HEADER_V1]: 'v1' } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
  };
}

/** Fixed same-origin paths only; no identity headers, persistence, logging or automatic retries. */
export function createPortalTransportV1(options: PortalTransportOptionsV1 = {}) {
  const fetcher = options.fetch ?? ((path, init) => fetch(path, init));
  const cooldowns = new Map<string, number>();
  return async <T>(
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    body?: string,
  ): Promise<T> => {
    if (!allowedPortalPathV1(path)) throw new PortalClientErrorV1('invalid-request');
    signal?.throwIfAborted();
    const now = Date.now();
    dropExpiredV1(cooldowns, now);
    const cooldownKey = cooldownKeyV1(path);
    const remaining = (cooldowns.get(cooldownKey) ?? 0) - now;
    if (options.respectRetryAfter && remaining > 0)
      throw new PortalClientErrorV1('rate-limited', 429, Math.ceil(remaining / 1000));
    let response: Response;
    try {
      response = await fetcher(
        path,
        requestInitV1(body, signal, acceptsAccessClosedV1(path, options.acceptAccessClosed)),
      );
    } catch {
      signal?.throwIfAborted();
      throw new PortalClientErrorV1('network-error');
    }
    signal?.throwIfAborted();
    if (response.status === 401) options.onUnauthorized?.();
    const delay = retryDelay(response.headers.get('Retry-After'));
    let value: unknown;
    try {
      if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
        throw new Error('student-portal-response-not-json');
      value = await response.json();
    } catch {
      signal?.throwIfAborted();
      throw new PortalClientErrorV1('invalid-response', response.status, delay);
    }
    signal?.throwIfAborted();
    const failure = failureV1.safeParse(value);
    if (failure.success && response.status === ERROR_HTTP_V1[failure.data.state]) {
      if (options.respectRetryAfter && failure.data.state === 'rate-limited')
        cooldowns.set(
          cooldownKey,
          Date.now() + Math.max(delay ?? 1, failure.data.retryAfterSeconds ?? 1) * 1000,
        );
      throw new PortalClientErrorV1(
        failure.data.state,
        response.status,
        Math.max(delay ?? 0, failure.data.retryAfterSeconds ?? 0) || undefined,
        failure.data.requestId,
      );
    }
    const success = schema.safeParse(value);
    if (response.status !== 200 || !success.success || !hasPortalNoStoreV1(response.headers))
      throw new PortalClientErrorV1('invalid-response', response.status, delay);
    return success.data;
  };
}

export function portalRequestBodyV1<T>(schema: z.ZodType<T>, input: unknown): string {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new PortalClientErrorV1('invalid-request');
  return JSON.stringify(parsed.data);
}
