import { healthDeadlineV1 } from '../../shared/health-io-v1';
import {
  isPortalMonitorSampleV1,
  sampleIsFreshV1,
  SYSTEM_HEALTH_TTL_MS_V1,
  type PortalMonitorSampleV1,
  type PublicEntrySampleV1,
  type SystemHealthSnapshotV1,
} from '../../shared/system-health-v1';

import { joinFlightV1 } from '../http/shared-flight-v1';

const PUBLIC_ENTRY_V1 = 'https://aluno.escolaieda.com/';
/** Longer than the read's own 12 s deadline, so a healthy read in flight is always joined. */
const HEALTH_PENDING_SHARE_MS_V1 = 15_000;
type HealthSourcesV1 = {
  production: boolean;
  readPortal?: () => Promise<unknown>;
  fetcher?: typeof fetch;
  now?: () => number;
};
async function readPortalV1(
  input: HealthSourcesV1,
  now: () => number,
): Promise<{
  portalReadState: SystemHealthSnapshotV1['portalReadState'];
  portal: PortalMonitorSampleV1 | null;
}> {
  if (!input.readPortal) return { portalReadState: 'unconfigured', portal: null };
  try {
    const portal = await healthDeadlineV1(() => input.readPortal!(), 8_000);
    if (!isPortalMonitorSampleV1(portal) || !sampleIsFreshV1(portal.observedAt, now(), 30_000))
      throw new Error('health-portal-contract');
    return { portalReadState: 'ok', portal };
  } catch {
    return { portalReadState: 'unavailable', portal: null };
  }
}
async function publicEntryV1(
  input: HealthSourcesV1,
  now: () => number,
): Promise<PublicEntrySampleV1> {
  if (!input.production)
    return { outcome: 'not-probed', status: null, durationMs: null, observedAt: null };
  const start = now();
  try {
    return await healthDeadlineV1<PublicEntrySampleV1>(async (signal) => {
      // A fixed HEAD of the static entry, not a student login or an uptime/SLO claim.
      // Workerd supports manual redirects; every 3xx remains an HTTP error below.
      const response = await (input.fetcher ?? fetch)(PUBLIC_ENTRY_V1, {
        method: 'HEAD',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        headers: { Accept: 'text/html' },
        signal,
      });
      void response.body?.cancel().catch(() => undefined);
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      let outcome: PublicEntrySampleV1['outcome'] = 'http-error';
      if (response.status === 200)
        outcome = contentType === 'text/html' ? 'ok' : 'unexpected-response';
      return {
        outcome,
        status: response.status,
        durationMs: Math.max(0, now() - start),
        observedAt: new Date(now()).toISOString(),
      };
    }, 3_000);
  } catch {
    return {
      outcome: 'unavailable',
      status: null,
      durationMs: Math.max(0, now() - start),
      observedAt: new Date(now()).toISOString(),
    };
  }
}
/** Independent sources: an HTTP problem never discards a successful private database sample. */
export async function collectSystemHealthV1(
  input: HealthSourcesV1,
): Promise<SystemHealthSnapshotV1> {
  const now = input.now ?? Date.now;
  const [portal, publicEntry] = await Promise.all([
    readPortalV1(input, now),
    publicEntryV1(input, now),
  ]);
  return { schemaVersion: 1, generatedAt: new Date(now()).toISOString(), ...portal, publicEntry };
}

/** One aggregate snapshot and one in-flight read per instance; no identity or credential is retained. */
export function createSystemHealthCacheV1(now: () => number = Date.now) {
  let saved: SystemHealthSnapshotV1 | undefined;
  let savedAt = -Infinity;
  let pending: Promise<SystemHealthSnapshotV1> | undefined;
  let pendingSince = 0;
  return (load: () => Promise<SystemHealthSnapshotV1>): Promise<SystemHealthSnapshotV1> => {
    const age = now() - savedAt;
    if (saved && age >= 0 && age < SYSTEM_HEALTH_TTL_MS_V1) return Promise.resolve(saved);
    // Joined only briefly: the read belongs to the request that started it.
    if (pending && now() - pendingSince < HEALTH_PENDING_SHARE_MS_V1)
      return joinFlightV1(pending, HEALTH_PENDING_SHARE_MS_V1 - (now() - pendingSince), load);
    const flight = Promise.resolve()
      .then(load)
      .then((value) => {
        saved = value;
        savedAt = now();
        return value;
      })
      .finally(() => {
        if (pending === flight) pending = undefined;
      });
    pending = flight;
    pendingSince = now();
    return flight;
  };
}
