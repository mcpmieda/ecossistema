// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { getGraphToken, GraphError, graphRequest } from '../server/graph/client';
import { testEnv } from './fixtures';

async function validRotatedCredential(createdAt: string) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const bytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const base64 = Buffer.from(bytes).toString('base64');
  return JSON.stringify({
    privateKeyPkcs8: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`,
    certificateThumbprint: 'synthetic-thumbprint-value', keyId: crypto.randomUUID(), createdAt,
  });
}

describe('Graph client resilience', () => {
  it('falls back when the newest credential parses but cannot sign an assertion', async () => {
    const env = {
      ...testEnv,
      GRAPH_CREDENTIAL_A: JSON.stringify({ privateKeyPkcs8: 'x'.repeat(256), certificateThumbprint: 'synthetic-thumbprint-value',
        keyId: crypto.randomUUID(), createdAt: '2026-02-01T00:00:00.000Z' }),
      GRAPH_CREDENTIAL_B: await validRotatedCredential('2026-01-01T00:00:00.000Z'),
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: 'synthetic-token', expires_in: 3600 }));
    await expect(getGraphToken(env, { fetch: fetchMock, sleep: async () => undefined })).resolves.toBe('synthetic-token');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![1]?.redirect).toBe('manual');
  });
  it('returns JSON and ETag on success', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ETag: '"1"' } }),
      );
    const result = await graphRequest<{ ok: boolean }>({
      env: testEnv,
      path: '/x',
      token: 'token',
      dependencies: { fetch: fetchMock, sleep: async () => undefined },
    });
    expect(result.data.ok).toBe(true);
    expect(result.etag).toBe('"1"');
    expect(fetchMock.mock.calls[0]![1]?.redirect).toBe('manual');
  });
  it('fails closed without following a Graph redirect', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'https://foreign.invalid/' } }),
    );
    await expect(graphRequest({
      env: testEnv,
      path: '/x',
      token: 'token',
      dependencies: { fetch: fetchMock, sleep: async () => undefined },
    })).rejects.toBeInstanceOf(GraphError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![1]?.redirect).toBe('manual');
  });
  it('sends If-Match for controlled updates', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await graphRequest({
      env: testEnv,
      path: '/x',
      method: 'PATCH',
      body: { x: 1 },
      etag: '"4"',
      token: 'token',
      dependencies: { fetch: fetchMock, sleep: async () => undefined },
    });
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('If-Match')).toBe('"4"');
  });
  it('surfaces 412 conflicts without retry', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 412 }));
    await expect(
      graphRequest({
        env: testEnv,
        path: '/x',
        token: 'token',
        dependencies: { fetch: fetchMock, sleep: async () => undefined },
      }),
    ).rejects.toBeInstanceOf(GraphError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('retries 429 without an infinite loop', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    await graphRequest({
      env: testEnv,
      path: '/x',
      token: 'token',
      dependencies: { fetch: fetchMock, sleep },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
  it('respects Retry-After', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    await graphRequest({
      env: testEnv,
      path: '/x',
      token: 'token',
      dependencies: { fetch: fetchMock, sleep },
    });
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(2000);
  });
  it('stops after five transient failures', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(
      graphRequest({
        env: testEnv,
        path: '/x',
        token: 'token',
        dependencies: { fetch: fetchMock, sleep: async () => undefined },
      }),
    ).rejects.toBeInstanceOf(GraphError);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
