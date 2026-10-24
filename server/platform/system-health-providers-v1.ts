import { healthDeadlineV1, readHealthJsonV1 } from '../../shared/health-io-v1';
import { isPublicProviderHealthV1, PUBLIC_PROVIDERS_V1, type PublicProviderHealthV1,
  type PublicProviderPointV1 } from '../../shared/public-provider-health-v1';
const URLS = { cloudflare: 'https://www.cloudflarestatus.com/api/v2/status.json',
  supabase: 'https://status.supabase.com/api/v2/status.json' } as const;
const INDICATORS = new Set(['none', 'minor', 'major', 'critical']);
function parse(value: unknown, provider: PublicProviderPointV1['provider'], now: number): PublicProviderPointV1 | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { page?: { url?: unknown; updated_at?: unknown }; status?: { indicator?: unknown } };
  if (typeof v.status?.indicator !== 'string' || !INDICATORS.has(v.status.indicator)
    || typeof v.page?.updated_at !== 'string' || v.page.updated_at.length > 40
    || !Number.isFinite(Date.parse(v.page.updated_at)) || Date.parse(v.page.updated_at) > now + 5000) return null;
  // Never follow any URL or serialize descriptions/incident text supplied by the provider.
  return { provider, state: 'ok', indicator: v.status.indicator as PublicProviderPointV1['indicator'],
    checkedAt: new Date(now).toISOString(), changedAt: new Date(v.page.updated_at).toISOString() };
}
export async function collectPublicProviderHealthV1(fetcher: typeof fetch = fetch, now = Date.now): Promise<PublicProviderHealthV1> {
  const providers = await Promise.all(PUBLIC_PROVIDERS_V1.map(async (provider): Promise<PublicProviderPointV1> => {
    const absent = (state: PublicProviderPointV1['state']): PublicProviderPointV1 => ({ provider, state,
      indicator: null, changedAt: null, checkedAt: new Date(now()).toISOString() });
    try {
      return await healthDeadlineV1(async (signal) => {
        const response = await fetcher(URLS[provider], { method: 'GET', redirect: 'error', credentials: 'omit',
          referrerPolicy: 'no-referrer', cache: 'no-store', signal,
          headers: { Accept: 'application/json', 'User-Agent': 'EscolaIeda-SystemHealth/1.0 (+https://github.com/mcpmieda/ecossistema-escola)' } });
        if (response.status !== 200) {
          await response.body?.cancel();
          return absent(response.status === 429 ? 'rate-limited' : 'unavailable');
        }
        const value = await readHealthJsonV1(response, signal, 8192);
        return parse(value, provider, now()) ?? absent('unexpected');
      }, 2500);
    } catch { return absent('unavailable'); }
  }));
  const result = { version: 1, state: 'ok', source: 'public-status', generatedAt: new Date(now()).toISOString(), providers };
  if (!isPublicProviderHealthV1(result)) throw new Error('provider-status-unavailable');
  return result;
}
/** Public aggregate only. Failure is cached briefly too, so clicks never become a retry storm. */
export function createPublicProviderCacheV1(now = Date.now) {
  let value: PublicProviderHealthV1 | null = null, until = 0, pending: Promise<PublicProviderHealthV1> | null = null;
  return async (load: () => Promise<PublicProviderHealthV1> = () => collectPublicProviderHealthV1()): Promise<PublicProviderHealthV1> => {
    if (value && now() >= Date.parse(value.generatedAt) && now() < until) return value;
    if (pending) return pending;
    value = null;
    const task = Promise.resolve().then(load).then((sample) => {
      if (!isPublicProviderHealthV1(sample)) throw new Error('provider-status-invalid');
      const ttl = sample.providers.every((p) => p.state === 'ok') ? 300_000 : 60_000;
      if (now() >= Date.parse(sample.generatedAt) && now() < Date.parse(sample.generatedAt) + ttl) {
        value = sample; until = Date.parse(sample.generatedAt) + ttl;
      }
      return sample;
    });
    pending = task;
    try { return await task; } finally { if (pending === task) pending = null; }
  };
}
export const readPublicProviderHealthV1 = createPublicProviderCacheV1();
