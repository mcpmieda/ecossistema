// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GraphError, graphRequest } from '../server/graph/client';
import { graphRetryAfterMsV1 } from '../server/graph/request-policy-v1';
import { testEnv } from './fixtures';

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers });
const input = { env: testEnv, path: '/sites/example/lists', token: 'synthetic-token' };

describe('Graph production backoff and intent #806', () => {
  it.each(['60', 'Tue, 15 Sep 2026 12:01:00 GMT'])(
    'does not shorten Retry-After %s or hold the interface open',
    async (header) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(json({}, 429, { 'Retry-After': header }));
      const sleep = vi.fn(async () => undefined);
      await expect(
        graphRequest({
          ...input,
          dependencies: { fetch, sleep, now: () => Date.parse('2026-09-15T12:00:00Z') },
        }),
      ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 60 });
      expect(fetch).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    },
  );
  it('parses seconds, HTTP dates and malformed Retry-After without negative sleeps', () => {
    const now = Date.parse('2026-09-15T12:00:00Z');
    expect(graphRetryAfterMsV1('15', now)).toBe(15_000);
    expect(graphRetryAfterMsV1('Tue, 15 Sep 2026 12:00:02 GMT', now)).toBe(2000);
    expect(graphRetryAfterMsV1('Tue, 15 Sep 2026 11:00:00 GMT', now)).toBe(0);
    expect(graphRetryAfterMsV1('unknown', now)).toBeUndefined();
  });
  it.each(['POST', 'PATCH', 'DELETE'] as const)(
    'does not replay ambiguous %s server failures',
    async (method) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}, 503));
      await expect(
        graphRequest({
          ...input,
          method,
          body: { name: 'SYNTHETIC' },
          dependencies: { fetch, sleep: async () => undefined },
        }),
      ).rejects.toBeInstanceOf(GraphError);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it('recovers a pure read once the transient connection returns', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('synthetic offline'))
      .mockResolvedValueOnce(json({ value: [1] }));
    expect(
      (await graphRequest({ ...input, dependencies: { fetch, sleep: async () => undefined } }))
        .data,
    ).toEqual({ value: [1] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps a rejected write byte-identical when retrying a short explicit 429', async () => {
    const body = { version: 1 };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({}, 429, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(json({ ok: true }));
    await graphRequest({
      ...input,
      method: 'PATCH',
      body,
      etag: '"1"',
      dependencies: {
        fetch,
        sleep: async () => {
          body.version = 2;
        },
      },
    });
    expect(fetch.mock.calls[0]![1]?.body).toBe(fetch.mock.calls[1]![1]?.body);
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get('If-Match')).toBe('"1"');
  });
  it('cancels before replay and never retries an authorization denial', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}, 503));
    await expect(
      graphRequest({
        ...input,
        signal: controller.signal,
        dependencies: {
          fetch,
          sleep: async () => {
            controller.abort();
          },
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledOnce();
    const denied = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}, 403));
    await expect(
      graphRequest({ ...input, dependencies: { fetch: denied, sleep: async () => undefined } }),
    ).rejects.toMatchObject({ status: 403 });
    expect(denied).toHaveBeenCalledOnce();
  });
});
