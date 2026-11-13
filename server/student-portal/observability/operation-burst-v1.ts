import { emitPortalOperationBurstMetricV1 } from './metrics-v1';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cloudflareClientIpV1 } from './audit-context-v1';
import { portalJsonV1 } from '../runtime/http-v1';
import type { FailureV1 } from '../../../shared/student-portal-contracts/core-v1';

/** The provider has no precise reset timestamp. Every configured window is 60 seconds. */
export class PortalRateLimitErrorV1 extends Error {
  readonly retryAfterSeconds = 60;
  constructor(readonly state: 'rate-limited' | 'unavailable') {
    super('student-portal-operation-' + state);
  }
}

/** Native per-location burst containment, not a global accounting or authorization system.
 * Call only with closed server operation names and a bounded subject. Never log the key.
 */
export async function checkPortalOperationV1(binding: Pick<RateLimit, 'limit'> | undefined,
  operation: string, subject: string): Promise<void> {
  const started = Date.now();
  let outcome: 'allowed' | 'limited' | 'unavailable' = 'unavailable';
  try {
    if (!binding || !/^[a-z][a-z0-9-]{0,63}$/u.test(operation) || !subject || subject.length > 512)
      throw new PortalRateLimitErrorV1('unavailable');
    let success: boolean;
    try {
      const key = createHash('sha256').update('student-portal:operation:v1\0')
        .update(operation).update('\0').update(subject).digest('hex');
      const result = await binding.limit({ key });
      if (typeof result?.success !== 'boolean') throw new Error('invalid-rate-limit-response');
      success = result.success;
    } catch { throw new PortalRateLimitErrorV1('unavailable'); }
    outcome = success ? 'allowed' : 'limited';
    if (!success) throw new PortalRateLimitErrorV1('rate-limited');
  } finally {
    emitPortalOperationBurstMetricV1({ event: 'student-portal-operation-burst-v1', operation, outcome,
      elapsedMs: Math.max(0, Date.now() - started) });
  }
}

export type AnonymousPeerSourceV1 = 'cf' | 'header' | 'unknown';
const peerIpV1 = z.union([z.ipv4(), z.ipv6()]);

/** Where the peer address came from. Self is reachable only through the edge service binding
 * (workers_dev false, no routes), so the cf-connecting-ip header Cloudflare set at the edge is
 * kept even if request.cf does not survive the binding. Never an identity, only a budget key. */
export function portalAnonymousPeerIpV1(request: Request): { ip: string | null; source: AnonymousPeerSourceV1 } {
  const proven = cloudflareClientIpV1(request);
  if (proven) return { ip: proven, source: 'cf' };
  const header = peerIpV1.safeParse(request.headers.get('cf-connecting-ip'));
  return header.success ? { ip: header.data, source: 'header' } : { ip: null, source: 'unknown' };
}

/** The anonymous subject before a session or credential is proven: the network peer (an IPv6
 * /64 counts as one), never one shared key, so one client cannot spend every family's entry
 * budget. After the session is found, the per-account limits stay the main ones. */
export function portalAnonymousSubjectV1(request: Request): string {
  const { ip } = portalAnonymousPeerIpV1(request);
  if (!ip) return 'ip:unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(ip);
  if (mapped) return `ip4:${mapped[1]}`;
  return ip.includes(':') ? `ip6:${ipv6Prefix64V1(ip)}` : `ip4:${ip}`;
}

function ipv6Prefix64V1(ip: string): string {
  const [head = '', tail] = ip.toLowerCase().split('::');
  const groups = (part: string) => (part ? part.split(':') : []);
  const left = groups(head);
  const right = groups(tail ?? '');
  // An embedded IPv4 (::ffff:1.2.3.4) fills two groups.
  const extra = right.at(-1)?.includes('.') ? 1 : 0;
  const full = tail === undefined
    ? left
    : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length - extra)).fill('0'), ...right];
  return full.slice(0, 4).map((group) => group.replace(/^0+(?=.)/u, '')).join(':');
}

export function portalRateLimitResponseV1(error: PortalRateLimitErrorV1, requestId = crypto.randomUUID()): Response {
  const body: FailureV1 = { contractVersion: 1, requestId, state: error.state,
    ...(error.state === 'rate-limited' ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
  const response = portalJsonV1(body, error.state === 'rate-limited' ? 429 : 503);
  if (error.state === 'rate-limited') response.headers.set('Retry-After', String(error.retryAfterSeconds));
  return response;
}
