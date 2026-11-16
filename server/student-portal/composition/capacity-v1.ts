import {
  CAPACITY_CACHE_MS_V1,
  capacitySampleFreshV1,
  emptyPortalCapacityV1,
  isPortalCapacitySampleV1,
  type PortalCapacitySampleV1,
} from '../../../shared/portal-capacity-v1';
import { readPortalCapacityV1 } from '../observability/capacity-v1';
import { assertPortalMonitoringContextV1 } from './monitoring-v1';
import { portalDatabaseV1 } from './database-v1';
import type { PortalCompositionEnvV1 } from './config-v1';

/** Best-effort per-isolate cache; no new storage, credentials or shared service.
 * Never restamp an observation or retain an unavailable result as a successful sample. */
export function createCapacityCacheV1(now = Date.now) {
  let cached: PortalCapacitySampleV1 | null = null;
  let pending: Promise<PortalCapacitySampleV1> | null = null;
  return async (load: () => Promise<PortalCapacitySampleV1>): Promise<PortalCapacitySampleV1> => {
    if (cached && capacitySampleFreshV1(cached, now(), CAPACITY_CACHE_MS_V1)) return cached;
    if (pending) return pending;
    cached = null;
    const task = Promise.resolve()
      .then(load)
      .then((sample) => {
        if (!isPortalCapacitySampleV1(sample)) throw new Error('capacity-invalid-sample');
        if (sample.state === 'ok' && capacitySampleFreshV1(sample, now(), CAPACITY_CACHE_MS_V1))
          cached = sample;
        return sample;
      });
    pending = task;
    try {
      return await task;
    } finally {
      if (pending === task) pending = null;
    }
  };
}
const caches = new WeakMap<object, Map<string, ReturnType<typeof createCapacityCacheV1>>>();
function cacheFor(env: PortalCompositionEnvV1, binding: object) {
  let group = caches.get(binding);
  if (!group) {
    group = new Map();
    caches.set(binding, group);
  }
  const key = `${env.PORTAL_ENVIRONMENT}|${env.PORTAL_ADMIN_TENANT_ID?.toLowerCase()}`;
  let cache = group.get(key);
  if (!cache) {
    if (group.size >= 4) group.clear();
    cache = createCapacityCacheV1();
    group.set(key, cache);
  }
  return cache;
}
export async function portalCapacityRpcV1(
  env: PortalCompositionEnvV1,
  input: unknown,
): Promise<PortalCapacitySampleV1> {
  // Authorization precedes even cache hits and missing-binding responses.
  assertPortalMonitoringContextV1(env, input);
  if (!env.PORTAL_DB) return emptyPortalCapacityV1('unconfigured');
  try {
    return await cacheFor(
      env,
      env.PORTAL_DB,
    )(() => portalDatabaseV1(env, 'admin-query', readPortalCapacityV1));
  } catch {
    return emptyPortalCapacityV1('unavailable');
  }
}
