// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import {
  collectPublicProviderHealthV1,
  createPublicProviderCacheV1,
} from '../../server/platform/system-health-providers-v1';
import { isPublicProviderHealthV1 } from '../../shared/public-provider-health-v1';
const NOW = Date.parse('2026-09-22T03:00:00.000Z');
const payload = (indicator = 'none') => ({
  page: { updated_at: '2026-09-01T00:00:00+00:00', url: 'https://untrusted.invalid/private' },
  status: { indicator, description: 'SYNTHETIC-PRIVATE-TEXT' },
  incidents: [{ name: 'private' }],
});
const fetcher = () => vi.fn<typeof fetch>(async () => Response.json(payload()));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('uses only the two fixed public URLs, no identity or credentials, and projects only closed fields', async () => {
  const read = fetcher();
  const result = await collectPublicProviderHealthV1(read, () => NOW);
  expect(isPublicProviderHealthV1(result)).toBe(true);
  expect(read.mock.calls.map(([url]) => url)).toEqual([
    'https://www.cloudflarestatus.com/api/v2/status.json',
    'https://status.supabase.com/api/v2/status.json',
  ]);
  for (const [, options] of read.mock.calls) {
    expect(options).toMatchObject({
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    expect(JSON.stringify(options)).not.toMatch(/Cookie|Authorization|actorId/u);
  }
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|untrusted|incidents/u);
  expect(result.providers[0]?.changedAt).toBe('2026-09-01T00:00:00.000Z');
  expect(isPublicProviderHealthV1({ ...result, private: 'data' })).toBe(false);
  expect(
    isPublicProviderHealthV1({ ...result, providers: [result.providers[0], result.providers[0]] }),
  ).toBe(false);
});
it('keeps independent provider failures unknown, including rate limits and invalid formats', async () => {
  const read = fetcher();
  read
    .mockResolvedValueOnce(new Response('private', { status: 429 }))
    .mockResolvedValueOnce(Response.json(payload('major')));
  const result = await collectPublicProviderHealthV1(read, () => NOW);
  expect(result.providers.map((p) => [p.state, p.indicator])).toEqual([
    ['rate-limited', null],
    ['ok', 'major'],
  ]);
  read.mockRejectedValue(Error('private credential'));
  const failed = await collectPublicProviderHealthV1(read, () => NOW);
  expect(failed.providers.every((p) => p.state === 'unavailable' && p.indicator === null)).toBe(
    true,
  );
  expect(JSON.stringify(failed)).not.toContain('credential');
});
it.each([
  null,
  {},
  payload('unrecognized'),
  { ...payload(), page: { updated_at: 'private' } },
  { ...payload(), page: { updated_at: '2099-01-01T00:00:00Z' } },
])('rejects malformed provider data without showing its text', async (value) => {
  const read = vi.fn<typeof fetch>(async () => Response.json(value));
  const data = await collectPublicProviderHealthV1(read, () => NOW);
  expect(data.providers.every((p) => p.state === 'unexpected')).toBe(true);
});
it('rejects oversized responses and bounds a stalled provider without delaying the other indefinitely', async () => {
  const big = vi.fn<typeof fetch>(async () =>
    Response.json({ ...payload(), extra: 'x'.repeat(9000) }),
  );
  expect(
    (await collectPublicProviderHealthV1(big, () => NOW)).providers.every(
      (p) => p.state === 'unavailable',
    ),
  ).toBe(true);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const read = vi.fn<typeof fetch>(() => new Promise(() => undefined));
  const task = collectPublicProviderHealthV1(read);
  await vi.advanceTimersByTimeAsync(2600);
  const data = await task;
  expect(data.providers.every((p) => p.state === 'unavailable')).toBe(true);
  expect(read.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
});
it('caches global status for five minutes and failures for one without restamping', async () => {
  let now = NOW;
  const cache = createPublicProviderCacheV1(() => now);
  const good = vi.fn(() => collectPublicProviderHealthV1(fetcher(), () => now));
  await Promise.all([cache(good), cache(good)]);
  expect(good).toHaveBeenCalledTimes(1);
  now += 299999;
  expect((await cache(good)).generatedAt).toBe(new Date(NOW).toISOString());
  now += 2;
  await cache(good);
  expect(good).toHaveBeenCalledTimes(2);
  const failedCache = createPublicProviderCacheV1(() => now);
  const bad = vi.fn(() =>
    collectPublicProviderHealthV1(
      vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })),
      () => now,
    ),
  );
  await failedCache(bad);
  now += 59999;
  await failedCache(bad);
  expect(bad).toHaveBeenCalledTimes(1);
  now += 2;
  await failedCache(bad);
  expect(bad).toHaveBeenCalledTimes(2);
});
