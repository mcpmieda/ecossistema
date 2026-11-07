import { z } from 'zod';

export const CAPACITY_CACHE_MS_V1 = 60_000;
const CAPACITY_FRESH_MS_V1 = 120_000;
export const CAPACITY_BODY_BYTES_V1 = 2_048;
export const CAPACITY_ROUTE_V1 = '/api/platform/system-health/capacity';
const connections = z.number().int().min(0).max(1_000_000);
const metricsSchema = z.object({
  databaseBytes: z.number().int().nonnegative().safe(),
  portalConnections: connections,
  portalActive: connections,
  portalWaiting: connections,
  portalConnectionLimit: connections.nullable(),
  serverMaxConnections: connections.min(1),
  serverReservedConnections: connections,
}).strict().refine((value) => value.portalActive <= value.portalConnections
  && value.portalWaiting <= value.portalConnections
  && value.serverReservedConnections < value.serverMaxConnections);
const common = { version: z.literal(1), source: z.literal('postgresql'), observedAt: z.iso.datetime() };
const sampleSchema = z.discriminatedUnion('state', [
  z.object({ ...common, state: z.literal('ok'), metrics: metricsSchema }).strict(),
  z.object({ ...common, state: z.literal('unconfigured'), metrics: z.null() }).strict(),
  z.object({ ...common, state: z.literal('unavailable'), metrics: z.null() }).strict(),
]);
export type PortalCapacitySampleV1 = z.infer<typeof sampleSchema>;
export type PortalCapacityMetricsV1 = z.infer<typeof metricsSchema>;
export function isPortalCapacitySampleV1(input: unknown): input is PortalCapacitySampleV1 {
  return sampleSchema.safeParse(input).success;
}
export function emptyPortalCapacityV1(state: 'unconfigured' | 'unavailable', now = Date.now()): PortalCapacitySampleV1 {
  return { version: 1, source: 'postgresql', observedAt: new Date(now).toISOString(), state, metrics: null };
}
export function capacitySampleFreshV1(sample: PortalCapacitySampleV1, now: number, maxAge = CAPACITY_FRESH_MS_V1): boolean {
  const age = now - Date.parse(sample.observedAt);
  return Number.isFinite(age) && age >= -5_000 && age <= maxAge;
}
