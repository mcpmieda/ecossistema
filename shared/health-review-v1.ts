import { z } from 'zod';
import { SIGNAL_OUTCOMES_V1, SIGNAL_SOURCES_V1 } from './portal-signals-v1';
import { HEALTH_HISTORY_INTERVAL_MS_V1, isPortalHistoryPointV1, portalHistoryChangeV1,
  portalHistoryPointStateV1, type PortalHistoryPointV1 } from './system-health-history-v1';

export const HEALTH_REVIEW_ROUTE_V1 = '/api/platform/system-health/review';
export const HEALTH_REVIEW_BYTES_V1 = 16_384;
const HOUR = 3_600_000;
const small = z.number().int().min(0).max(12);
const hourSchema = z.object({ startAt: z.iso.datetime(), samples: small, normal: small,
  attention: small, critical: small, unknown: small, missing: small, recovered: small }).strict()
  .refine((h) => h.normal + h.attention + h.critical + h.unknown === h.samples
    && h.samples + h.missing === 12 && h.recovered <= h.normal);
const reviewOperationV1 = z.object({ source: z.enum(SIGNAL_SOURCES_V1), outcome: z.enum(SIGNAL_OUTCOMES_V1),
  samples: z.number().int().min(1).max(288_000), maxMs: z.number().int().min(0).max(60_000),
  slow: z.number().int().min(0).max(288_000), capped: z.boolean() }).strict()
  .refine((p) => p.slow <= p.samples && (p.maxMs >= 3000 || p.slow === 0)
    && (!p.source.startsWith('browser-') || (p.outcome === 'failed' && p.maxMs === 0 && p.samples <= 17_280)));
const schema = z.object({ version: z.literal(1), state: z.enum(['ok', 'unconfigured', 'unavailable']),
  coverage: z.literal('partial'), generatedAt: z.iso.datetime(), from: z.iso.datetime(), to: z.iso.datetime(),
  hours: z.array(hourSchema).max(24), operations: z.array(reviewOperationV1).max(32) }).strict();
export type HealthReviewV1 = z.infer<typeof schema>;
export function reviewWindowV1(now: number): { from: string; to: string } {
  const end = Math.floor(now / HEALTH_HISTORY_INTERVAL_MS_V1) * HEALTH_HISTORY_INTERVAL_MS_V1;
  return { from: new Date(end - 24 * HOUR).toISOString(), to: new Date(end).toISOString() };
}
export function emptyHealthReviewV1(state: 'unconfigured' | 'unavailable', now = Date.now()): HealthReviewV1 {
  return { version: 1, state, coverage: 'partial', generatedAt: new Date(now).toISOString(),
    ...reviewWindowV1(now), hours: [], operations: [] };
}
export function isHealthReviewV1(value: unknown): value is HealthReviewV1 {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return false;
  const p = parsed.data, start = Date.parse(p.from), end = Date.parse(p.to), now = Date.parse(p.generatedAt);
  if (end - start !== 24 * HOUR || end % HEALTH_HISTORY_INTERVAL_MS_V1 !== 0 || end > now
    || now - end >= HEALTH_HISTORY_INTERVAL_MS_V1) return false;
  if (p.state !== 'ok') return !p.hours.length && !p.operations.length;
  if (p.hours.length !== 24 || p.hours.some((h, i) => Date.parse(h.startAt) !== start + i * HOUR)) return false;
  const keys = p.operations.map((op) => `${op.source}|${op.outcome}`);
  return new Set(keys).size === keys.length;
}
/** Use the canonical point classification before grouping; missing windows are not downtime. */
export function buildHealthReviewV1(generatedAt: string, input: readonly unknown[], operations: readonly unknown[]): HealthReviewV1 {
  const window = reviewWindowV1(Date.parse(generatedAt)), start = Date.parse(window.from), end = Date.parse(window.to);
  const seen = new Set<string>(), points: PortalHistoryPointV1[] = [];
  if (input.length > 288) throw new Error('review-invalid-history');
  for (const point of input) {
    if (!isPortalHistoryPointV1(point) || Date.parse(point.bucketAt) < start || Date.parse(point.bucketAt) >= end
      || seen.has(point.bucketAt)) throw new Error('review-invalid-history');
    points.push(point); seen.add(point.bucketAt);
  }
  points.sort((a, b) => Date.parse(a.bucketAt) - Date.parse(b.bucketAt));
  const hours = Array.from({ length: 24 }, (_, i) => ({ startAt: new Date(start + i * HOUR).toISOString(),
    samples: 0, normal: 0, attention: 0, critical: 0, unknown: 0, missing: 12, recovered: 0 }));
  points.forEach((point, i) => {
    const hour = hours[Math.floor((Date.parse(point.bucketAt) - start) / HOUR)]!;
    hour.samples++; hour.missing--; hour[portalHistoryPointStateV1(point)]++;
    if (portalHistoryChangeV1(point, points[i - 1]) === 'recovered') hour.recovered++;
  });
  const result = { version: 1, state: 'ok', coverage: 'partial', generatedAt, ...window, hours, operations: [...operations] };
  if (!isHealthReviewV1(result)) throw new Error('review-invalid-summary');
  return result;
}
export function reviewTotalsV1(data: HealthReviewV1) {
  const total = { samples: 0, missing: 0, attention: 0, critical: 0, unknown: 0, recovered: 0,
    refused: 0, limited: 0, failed: 0, browser: 0, slow: 0, maxMs: 0, capped: false };
  for (const h of data.hours) for (const k of ['samples', 'missing', 'attention', 'critical', 'unknown', 'recovered'] as const) total[k] += h[k];
  for (const p of data.operations) {
    total.capped ||= p.capped;
    if (p.source.startsWith('browser-')) { total.browser += p.samples; continue; }
    if (p.outcome !== 'ok') total[p.outcome] += p.samples;
    total.slow += p.slow; total.maxMs = Math.max(total.maxMs, p.maxMs);
  }
  return total;
}
/** Closed, historical advice codes only; never claims root cause or current availability. */
export function reviewGuidanceV1(data: HealthReviewV1): string[] {
  const t = reviewTotalsV1(data), flags: string[] = [];
  if (t.critical || t.attention) flags.push('maintenance');
  if (t.failed) flags.push('server');
  if (t.limited) flags.push('limits');
  if (t.browser) flags.push('browser');
  if (t.slow) flags.push('slow');
  if (t.unknown || t.missing) flags.push('coverage');
  return flags;
}
