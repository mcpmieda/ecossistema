// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { graphAllPages, GraphError, graphRequest } from '../server/graph/client';
import { graphRetryAfterMsV1 } from '../server/graph/request-policy-v1';
import { testEnv } from './fixtures';

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers });
const input = { env: testEnv, path: '/sites/example/lists', token: 'synthetic-token' };

describe('Graph production backoff and intent #806', () => {
  it.each(['60', 'Tue, 15 Sep 2026 12:01:00 GMT'])('does not shorten Retry-After %s or hold the interface open', async (header) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}, 429, { 'Retry-After': header }));
    const sleep = vi.fn(async () => undefined);
    await expect(graphRequest({ ...input, dependencies: { fetch, sleep, now: () => Date.parse('2026-09-15T12:00:00Z') } }))
      .rejects.toMatchObject({ status: 429, retryAfterSeconds: 60 });
    expect(fetch).toHaveBeenCalledOnce(); expect(sleep).not.toHaveBeenCalled();
  });
  it('parses seconds, HTTP dates and malformed Retry-After without negative sleeps', () => {
    const now = Date.parse('2026-09-15T12:00:00Z');
    expect(graphRetryAfterMsV1('15', now)).toBe(15_000);
    expect(graphRetryAfterMsV1('Tue, 15 Sep 2026 12:00:02 GMT', now)).toBe(2000);
    expect(graphRetryAfterMsV1('Tue, 15 Sep 2026 11:00:00 GMT', now)).toBe(0);
    expect(graphRetryAfterMsV1('unknown', now)).toBeUndefined();
  });
  it.each(['POST', 'PATCH', 'DELETE'] as const)('does not replay ambiguous %s server failures', async (method) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}, 503));
    await expect(graphRequest({ ...input, method, body: { name: 'SYNTHETIC' },
      dependencies: { fetch, sleep: async () => undefined } })).rejects.toBeInstanceOf(GraphError);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('recovers a pure read once the transient connection returns', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new TypeError('synthetic offline'))
      .mockResolvedValueOnce(json({ value: [1] }));
    expect((await graphRequest({ ...input, dependencies: { fetch, sleep: async () => undefined } })).data).toEqual({ value: [1] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps a rejected write byte-identical when retrying a short explicit 429', async () => {
    const body = { version: 1 };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({}, 429, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(json({ ok: true }));
    await graphRequest({ ...input, method: 'PATCH', body, etag: '"1"',
      dependencies: { fetch, sleep: async () => { body.version = 2; } } });
    expect(fetch.mock.calls[0]![1]?.body).toBe(fetch.mock.calls[1]![1]?.body);
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get('If-Match')).toBe('"1"');
  });
  it('cancels before replay and never retries an authorization denial', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}, 503));
    await expect(graphRequest({ ...input, signal: controller.signal,
      dependencies: { fetch, sleep: async () => { controller.abort(); } } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledOnce();
    const denied = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}, 403));
    await expect(graphRequest({ ...input, dependencies: { fetch: denied, sleep: async () => undefined } })).rejects.toMatchObject({ status: 403 });
    expect(denied).toHaveBeenCalledOnce();
  });
});

describe('Graph complete pagination #806', () => {
  it('reads more than ten pages and retains the exact opaque cursor query', async () => {
    let page = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer synthetic-token');
      const index = page++;
      return json({ value: [index], ...(page < 12 ? { '@odata.nextLink': `https://graph.microsoft.com/v1.0/sites/example/lists?$skiptoken=${page}%2FA%2BB%3D` } : {}) });
    });
    const result = await graphAllPages<number>(testEnv, input.path, input.token, { dependencies: { fetch, sleep: async () => undefined } });
    expect(result).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(fetch.mock.calls[1]![0]).toBe('https://graph.microsoft.com/v1.0/sites/example/lists?$skiptoken=1%2FA%2BB%3D');
  });
  it.each(['https://graph.microsoft.com.attacker.invalid/v1.0/lists', 'https://attacker.invalid/v1.0/lists',
    'https://graph.microsoft.com/v1.0/../../outside', 'https://x@graph.microsoft.com/v1.0/lists'])('rejects unsafe nextLink %s before sending a token', async (link) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ value: [1], '@odata.nextLink': link }));
    await expect(graphAllPages(testEnv, input.path, input.token, { dependencies: { fetch, sleep: async () => undefined } })).rejects.toThrow('approved API');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects cursor loops rather than returning a partial collection', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json({ value: [1], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/sites/example/lists' }));
    await expect(graphAllPages(testEnv, input.path, input.token, { dependencies: { fetch, sleep: async () => undefined } })).rejects.toThrow('cycle');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects a malformed page instead of skipping its contents', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ value: null }));
    await expect(graphAllPages(testEnv, input.path, input.token, { dependencies: { fetch, sleep: async () => undefined } })).rejects.toMatchObject({ status: 502 });
  });
});
