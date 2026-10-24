import { emptyHealthReviewV1, isHealthReviewV1, type HealthReviewV1 } from '../../../shared/health-review-v1';
import { readHealthReviewV1 } from '../observability/health-review-v1';
import { portalDatabaseV1 } from './database-v1';
import { assertPortalMonitoringContextV1 } from './monitoring-v1';
import type { PortalCompositionEnvV1 } from './config-v1';
export function createHealthReviewCacheV1(now = Date.now) {
  let sample: HealthReviewV1 | null = null, pending: Promise<HealthReviewV1> | null = null;
  return async (load: () => Promise<HealthReviewV1>): Promise<HealthReviewV1> => {
    const age = sample ? now() - Date.parse(sample.generatedAt) : Infinity;
    if (sample && age >= 0 && age < 60_000) return sample;
    if (pending) return pending;
    sample = null;
    const task = Promise.resolve().then(load).then((value) => {
      if (!isHealthReviewV1(value)) throw new Error('review-invalid');
      const loadedAge = now() - Date.parse(value.generatedAt);
      if (value.state === 'ok' && loadedAge >= 0 && loadedAge < 60_000) sample = value;
      return value;
    });
    pending = task;
    try { return await task; } finally { if (pending === task) pending = null; }
  };
}
const caches = new WeakMap<object, Map<string, ReturnType<typeof createHealthReviewCacheV1>>>();
export async function portalHealthReviewRpcV1(env: PortalCompositionEnvV1, context: unknown): Promise<HealthReviewV1> {
  assertPortalMonitoringContextV1(env, context);
  if (!env.PORTAL_DB) return emptyHealthReviewV1('unconfigured');
  let group = caches.get(env.PORTAL_DB);
  if (!group) { group = new Map(); caches.set(env.PORTAL_DB, group); }
  const key = `${env.PORTAL_ENVIRONMENT}|${env.PORTAL_ADMIN_TENANT_ID.toLowerCase()}`;
  let cache = group.get(key);
  if (!cache) {
    if (group.size >= 4) group.clear();
    cache = createHealthReviewCacheV1();
    group.set(key, cache);
  }
  try { return await cache(() => portalDatabaseV1(env, 'admin-query', readHealthReviewV1)); }
  catch { return emptyHealthReviewV1('unavailable'); }
}
