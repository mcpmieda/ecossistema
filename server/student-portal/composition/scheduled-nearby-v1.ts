/**
 * The minute's scheduled work (retention, live outbox, health history and signals) talks to the
 * database in São Paulo. A cron runs wherever Cloudflare starts it; the region placement
 * (aws:sa-east-1) applies only to requests. So the cron asks the Worker's own public address to do
 * the work, and that request runs next to the database. Without the secret, or when the address
 * refuses before working, the cron does the work itself as before.
 */
export const PORTAL_SCHEDULED_PATH_V1 = '/api/internal/agendado';
const NEARBY_TIMEOUT_MS_V1 = 50_000;

export interface PortalScheduledNearbyEnvV1 {
  readonly PORTAL_ORIGIN?: string;
  readonly PORTAL_ENVIRONMENT?: string;
  readonly PORTAL_SCHEDULED_TOKEN?: string;
}

/** Constant-time comparison; an expected secret shorter than 32 characters never matches. */
function sameSecretV1(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0 && expected.length >= 32;
}

/** True when the request did the work; false when the cron must do it here. */
export async function runScheduledNearbyV1(env: PortalScheduledNearbyEnvV1, scheduledTime: number,
  publicFetch: typeof fetch = fetch): Promise<boolean> {
  if (env.PORTAL_ENVIRONMENT !== 'production' || !env.PORTAL_ORIGIN || !env.PORTAL_SCHEDULED_TOKEN) return false;
  try {
    const response = await publicFetch(`${env.PORTAL_ORIGIN}${PORTAL_SCHEDULED_PATH_V1}`, {
      method: 'POST', body: JSON.stringify({ scheduledTime }), signal: AbortSignal.timeout(NEARBY_TIMEOUT_MS_V1),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.PORTAL_SCHEDULED_TOKEN}` },
    });
    await response.body?.cancel();
    if (response.ok) return true;
    // Refused before working (route or secret not deployed yet): the cron works here.
    if ([401, 404, 405].includes(response.status)) return false;
    console.error(JSON.stringify({ event: 'portal-scheduled-nearby-failed', status: response.status }));
    return true;
  } catch (cause) {
    // It may have started: the next minute runs again, so nothing is repeated here.
    console.error(JSON.stringify({ event: 'portal-scheduled-nearby-failed', error: String(cause).slice(0, 200) }));
    return true;
  }
}

/** The scheduled time of an authorised request; null answers 401/400 to anything else. */
export async function scheduledRequestTimeV1(request: Request, env: PortalScheduledNearbyEnvV1):
  Promise<{ readonly status: 401 | 400 } | { readonly scheduledTime: number }> {
  const given = request.headers.get('Authorization')?.replace(/^Bearer\s+/u, '') ?? '';
  if (!sameSecretV1(given, env.PORTAL_SCHEDULED_TOKEN ?? '')) return { status: 401 };
  const body = await request.json().catch(() => null) as { scheduledTime?: unknown } | null;
  const time = body?.scheduledTime;
  return typeof time === 'number' && Number.isFinite(time) ? { scheduledTime: time } : { status: 400 };
}
