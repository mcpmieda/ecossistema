import { expect, it, vi } from 'vitest';
import {
  buildHealthReviewV1,
  emptyHealthReviewV1,
  HEALTH_REVIEW_BYTES_V1,
  isHealthReviewV1,
  reviewGuidanceV1,
  reviewTotalsV1,
  reviewWindowV1,
} from '../../shared/health-review-v1';
import { createHealthReviewCacheV1 } from '../../server/student-portal/composition/health-review-v1';
const NOW = Date.parse('2026-09-22T03:02:00.000Z'),
  END = Date.parse(reviewWindowV1(NOW).to);
const at = (n: number) => new Date(n).toISOString();
const point = (n: number, maintenanceState = 'normal') => ({
  bucketAt: at(END - n * 300_000),
  observedAt: at(END - n * 300_000 + 1000),
  servingEnabled: true,
  credentialsConfigured: true,
  maintenanceState,
  publicationDue: 0,
  livePending: 0,
  waitingConnections: 0,
  readDurationMs: 10,
});
const operation = (source = 'login', outcome = 'failed') => ({
  source,
  outcome,
  samples: 1,
  maxMs: 4000,
  slow: 1,
  capped: false,
});
const summary = () => buildHealthReviewV1(at(NOW), [point(1)], [operation()]);
it('uses exactly 288 completed five-minute windows and keeps missing collection distinct from downtime', () => {
  const empty = buildHealthReviewV1(at(NOW), [], []);
  expect(isHealthReviewV1(empty)).toBe(true);
  expect(empty.hours).toHaveLength(24);
  expect(reviewTotalsV1(empty)).toMatchObject({
    samples: 0,
    missing: 288,
    failed: 0,
    recovered: 0,
  });
  expect(reviewGuidanceV1(empty)).toEqual(['coverage']);
  const full = buildHealthReviewV1(
    at(NOW),
    Array.from({ length: 288 }, (_, i) => point(i + 1)),
    [],
  );
  expect(reviewTotalsV1(full)).toMatchObject({ samples: 288, missing: 0, attention: 0 });
  expect(full.hours.every((h) => h.samples === 12)).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(full)).length).toBeLessThan(
    HEALTH_REVIEW_BYTES_V1,
  );
});
it('classifies consecutive recovery across hour boundaries but never across a gap', () => {
  const consecutive = buildHealthReviewV1(at(NOW), [point(12), point(13, 'intervention')], []);
  expect(reviewTotalsV1(consecutive)).toMatchObject({ samples: 2, critical: 1, recovered: 1 });
  const gap = buildHealthReviewV1(at(NOW), [point(12), point(14, 'attention')], []);
  expect(reviewTotalsV1(gap).recovered).toBe(0);
  expect(reviewGuidanceV1(consecutive)).toContain('maintenance');
});
it('separates refusals, limits, browser reports, failures, saturation and duration', () => {
  const data = buildHealthReviewV1(
    at(NOW),
    [point(1)],
    [
      operation(),
      operation('session', 'refused'),
      { ...operation('challenge', 'limited'), samples: 2, slow: 0, maxMs: 1, capped: true },
      { ...operation('browser-render'), samples: 3, slow: 0, maxMs: 0 },
    ],
  );
  expect(reviewTotalsV1(data)).toMatchObject({
    failed: 1,
    refused: 1,
    limited: 2,
    browser: 3,
    slow: 2,
    maxMs: 4000,
    capped: true,
  });
  expect(reviewGuidanceV1(data)).toEqual(['server', 'limits', 'browser', 'slow', 'coverage']);
});
it.each(['name', 'email', 'ip', 'raw', 'student', 'token', 'rate', 'uptime'])(
  'rejects unapproved %s fields',
  (key) => {
    const data = summary();
    expect(isHealthReviewV1({ ...data, [key]: 'SYNTHETIC-PRIVATE' })).toBe(false);
    expect(
      isHealthReviewV1({ ...data, hours: data.hours.map((h) => ({ ...h, [key]: 'private' })) }),
    ).toBe(false);
    expect(
      isHealthReviewV1({ ...data, operations: [{ ...data.operations[0], [key]: 'private' }] }),
    ).toBe(false);
  },
);
it('rejects current, old, duplicate and malformed points and inconsistent aggregate contracts', () => {
  for (const points of [
    [point(0)],
    [point(289)],
    [point(1), point(1)],
    [{ ...point(1), name: 'private' }],
  ])
    expect(() => buildHealthReviewV1(at(NOW), points, [])).toThrow();
  for (const operations of [
    [operation(), operation()],
    [{ ...operation(), samples: 288001 }],
    [{ ...operation('browser-render'), maxMs: 0, slow: 0, samples: 17281 }],
  ])
    expect(() => buildHealthReviewV1(at(NOW), [], operations)).toThrow();
  const data = summary();
  expect(isHealthReviewV1({ ...data, hours: data.hours.slice(1) })).toBe(false);
  expect(isHealthReviewV1({ ...data, hours: [...data.hours].reverse() })).toBe(false);
  expect(isHealthReviewV1({ ...data, from: at(END) })).toBe(false);
  expect(isHealthReviewV1({ ...data, generatedAt: at(END - 1) })).toBe(false);
  for (const state of ['unconfigured', 'unavailable'] as const) {
    expect(isHealthReviewV1(emptyHealthReviewV1(state, NOW))).toBe(true);
    expect(isHealthReviewV1({ ...emptyHealthReviewV1(state, NOW), hours: data.hours })).toBe(false);
  }
});
it('coalesces cache reads without restamping time and retries failures without preserving stale success', async () => {
  let now = NOW;
  const cache = createHealthReviewCacheV1(() => now);
  const load = vi.fn(async () => buildHealthReviewV1(at(now), [], []));
  await Promise.all([cache(load), cache(load), cache(load)]);
  expect(load).toHaveBeenCalledTimes(1);
  now += 59000;
  expect((await cache(load)).generatedAt).toBe(at(NOW));
  now += 1001;
  await cache(load);
  expect(load).toHaveBeenCalledTimes(2);
  now += 60001;
  await expect(
    cache(async () => {
      throw Error('synthetic');
    }),
  ).rejects.toThrow();
  expect((await cache(load)).generatedAt).toBe(at(now));
  now -= 120000;
  await cache(load);
  expect(load).toHaveBeenCalledTimes(4);
  const failed = createHealthReviewCacheV1(() => NOW),
    unavailable = vi.fn(async () => emptyHealthReviewV1('unavailable', NOW));
  await failed(unavailable);
  await failed(unavailable);
  expect(unavailable).toHaveBeenCalledTimes(2);
});
