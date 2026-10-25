import { z } from 'zod';
import { HEALTH_HISTORY_RETENTION_MS_V1, isHistoryBeforeV1 } from './system-health-history-v1';

export { HEALTH_HISTORY_INTERVAL_MS_V1 as SIGNAL_INTERVAL_MS_V1 } from './system-health-history-v1';
export const SIGNAL_BUFFER_MS_V1 = 20 * 60_000;
export const SIGNAL_PAGE_WINDOWS_V1 = 12;
export const SIGNAL_BODY_BYTES_V1 = 98_304;
export const SIGNAL_SOURCES_V1 = ['challenge', 'login', 'activation', 'session', 'profile', 'browser-module', 'browser-render', 'browser-read'] as const;
export const SIGNAL_OUTCOMES_V1 = ['ok', 'refused', 'limited', 'failed'] as const;
const source = z.enum(SIGNAL_SOURCES_V1);
const outcome = z.enum(SIGNAL_OUTCOMES_V1);
const bucket = z.string().refine((value) => isHistoryBeforeV1(value));
const duration = z.number().int().min(0).max(60_000);
const count = z.number().int().min(1).max(1000);
const browserShape = (value: { source: string; outcome: string; maxMs: number }) =>
  !value.source.startsWith('browser-') || (value.outcome === 'failed' && value.maxMs === 0);

export const portalSignalInputV1 = z.object({ source, outcome, elapsedMs: duration }).strict()
  .refine((value) => browserShape({ ...value, maxMs: value.elapsedMs }));
export type PortalSignalInputV1 = z.infer<typeof portalSignalInputV1>;
export const portalSignalPointV1 = z.object({
  bucketAt: bucket, source, outcome, samples: count,
  totalMs: z.number().int().min(0).max(60_000_000), maxMs: duration,
  slow: z.number().int().min(0).max(1000), capped: z.boolean(),
}).strict().refine((value) => browserShape(value) && value.slow <= value.samples
  && (!value.source.startsWith('browser-') || value.samples <= 60)
  && value.totalMs >= value.maxMs && value.totalMs <= value.samples * value.maxMs
  && (value.maxMs >= 3000 || value.slow === 0));
export type PortalSignalPointV1 = z.infer<typeof portalSignalPointV1>;
export const signalCheckpointV1 = z.object({
  version: z.literal(1), savedAt: z.number().int().nonnegative().safe(),
  points: z.array(portalSignalPointV1).max(128),
}).strict();
export const portalSignalBatchV1 = z.object({
  version: z.literal(1), generatedAt: z.iso.datetime(), points: z.array(portalSignalPointV1).max(128),
}).strict();
export type PortalSignalBatchV1 = z.infer<typeof portalSignalBatchV1>;
const pageSchema = z.object({
  version: z.literal(1), generatedAt: z.iso.datetime(), retentionDays: z.literal(30),
  coverage: z.literal('partial'), state: z.enum(['ok', 'unconfigured', 'unavailable']),
  points: z.array(portalSignalPointV1).max(384), nextBefore: bucket.nullable(),
}).strict();
export type PortalSignalsPageV1 = z.infer<typeof pageSchema>;
export function emptyPortalSignalsV1(state: 'unconfigured' | 'unavailable', generatedAt = new Date().toISOString()): PortalSignalsPageV1 {
  return { version: 1, generatedAt, retentionDays: 30, coverage: 'partial', state, points: [], nextBefore: null };
}
export function signalKeyV1(point: Pick<PortalSignalPointV1, 'bucketAt' | 'source' | 'outcome'>): string {
  return `${point.bucketAt}|${point.source}|${point.outcome}`;
}
export function isPortalSignalsPageV1(value: unknown): value is PortalSignalsPageV1 {
  const parsed = pageSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  if (data.state !== 'ok') return data.points.length === 0 && data.nextBefore === null;
  const now = Date.parse(data.generatedAt), keys = new Set<string>(), windows = new Set<string>();
  let previous = Infinity;
  for (const point of data.points) {
    const at = Date.parse(point.bucketAt), key = signalKeyV1(point);
    if (at > now || at <= now - HEALTH_HISTORY_RETENTION_MS_V1 || at > previous || keys.has(key)) return false;
    keys.add(key); windows.add(point.bucketAt); previous = at;
  }
  if (windows.size > SIGNAL_PAGE_WINDOWS_V1) return false;
  return data.nextBefore === null || (windows.size === SIGNAL_PAGE_WINDOWS_V1 && data.nextBefore === data.points.at(-1)?.bucketAt);
}
