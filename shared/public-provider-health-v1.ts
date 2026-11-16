import { z } from 'zod';
export const PROVIDER_HEALTH_ROUTE_V1 = '/api/platform/system-health/providers';
export const PROVIDER_HEALTH_BYTES_V1 = 4_096;
export const PROVIDER_HEALTH_FRESH_MS_V1 = 600_000;
export const PUBLIC_PROVIDERS_V1 = ['cloudflare', 'supabase'] as const;
const provider = z
  .object({
    provider: z.enum(PUBLIC_PROVIDERS_V1),
    state: z.enum(['ok', 'unavailable', 'rate-limited', 'unexpected']),
    indicator: z.enum(['none', 'minor', 'major', 'critical']).nullable(),
    checkedAt: z.iso.datetime(),
    changedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine((p) =>
    p.state === 'ok'
      ? p.indicator !== null && p.changedAt !== null
      : p.indicator === null && p.changedAt === null,
  )
  .refine((p) => p.changedAt === null || Date.parse(p.changedAt) <= Date.parse(p.checkedAt) + 5000);
const schema = z
  .object({
    version: z.literal(1),
    state: z.literal('ok'),
    source: z.literal('public-status'),
    generatedAt: z.iso.datetime(),
    providers: z.array(provider).length(2),
  })
  .strict();
export type PublicProviderHealthV1 = z.infer<typeof schema>;
export type PublicProviderPointV1 = z.infer<typeof provider>;
export function isPublicProviderHealthV1(value: unknown): value is PublicProviderHealthV1 {
  const result = schema.safeParse(value);
  if (!result.success) return false;
  return result.data.providers.every(
    (p, i) =>
      p.provider === PUBLIC_PROVIDERS_V1[i] &&
      Date.parse(p.checkedAt) <= Date.parse(result.data.generatedAt) &&
      Date.parse(result.data.generatedAt) - Date.parse(p.checkedAt) < 10_000,
  );
}
