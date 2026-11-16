import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import {
  checkPortalOperationV1,
  PortalRateLimitErrorV1,
  portalRateLimitResponseV1,
} from '../../../server/student-portal/observability/operation-burst-v1';

it('separates accounts and operations without exposing identity, credentials or IP', async () => {
  const limit = vi.fn().mockResolvedValue({ success: true });
  await checkPortalOperationV1({ limit }, 'read', 'account-A');
  await checkPortalOperationV1({ limit }, 'read', 'account-A');
  await checkPortalOperationV1({ limit }, 'read', 'account-B');
  await checkPortalOperationV1({ limit }, 'logout', 'account-A');
  const keys = limit.mock.calls.map(([input]) => input.key);
  expect(keys[0]).toBe(keys[1]);
  expect(new Set(keys).size).toBe(3);
  expect(keys.every((key) => /^[a-f0-9]{64}$/u.test(key))).toBe(true);
  expect(JSON.stringify(keys)).not.toContain('account-');
});
it('keeps missing, throwing and malformed backend responses unavailable, never a fake 429', async () => {
  for (const binding of [
    undefined,
    { limit: vi.fn().mockRejectedValue(new Error('PRIVATE')) },
    { limit: vi.fn().mockResolvedValue({}) },
  ]) {
    await expect(checkPortalOperationV1(binding, 'read', 'A')).rejects.toMatchObject({
      state: 'unavailable',
    });
  }
  const response = portalRateLimitResponseV1(new PortalRateLimitErrorV1('unavailable'));
  expect(response.status).toBe(503);
  expect(response.headers.has('retry-after')).toBe(false);
  expect(await response.json()).toMatchObject({ state: 'unavailable' });
});
it('returns a conservative full configured window and does no implicit retry', async () => {
  const limit = vi.fn().mockResolvedValue({ success: false });
  await expect(checkPortalOperationV1({ limit }, 'read', 'A')).rejects.toMatchObject({
    state: 'rate-limited',
    retryAfterSeconds: 60,
  });
  expect(limit).toHaveBeenCalledTimes(1);
  const response = portalRateLimitResponseV1(new PortalRateLimitErrorV1('rate-limited'));
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
  expect(await response.json()).toMatchObject({ state: 'rate-limited', retryAfterSeconds: 60 });
});
it('keeps configuration aligned with Retry-After and independent namespaces', () => {
  const config = JSON.parse(readFileSync('wrangler.student-portal.jsonc', 'utf8'));
  const bindings: {
    name: string;
    namespace_id: string;
    simple: { limit: number; period: number };
  }[] = config.env.production.ratelimits;
  expect(new Set(bindings.map((binding) => binding.namespace_id)).size).toBe(bindings.length);
  expect(bindings.every((binding) => binding.simple.period === 60)).toBe(true);
  const policy = Object.fromEntries(
    bindings.map((binding) => [binding.name, binding.simple.limit]),
  );
  expect(policy).toMatchObject({
    PORTAL_AUTH_GLOBAL: 3000,
    PORTAL_AUTH_SUBJECT: 30,
    PORTAL_SESSION_ACCOUNT: 120,
    PORTAL_READ_ACCOUNT: 120,
    PORTAL_PHOTO_ACCOUNT: 120,
    PORTAL_LIVE_ACCOUNT: 120,
    PORTAL_STATUS_ACCOUNT: 60,
    PORTAL_ADMIN_READ: 600,
  });
});
it('obeys a deterministic adapter window without claiming distributed N+1 accuracy', async () => {
  let now = 0,
    window = 0,
    count = 0;
  const limit = vi.fn(async () => {
    if (now >= window + 60_000) {
      window = now;
      count = 0;
    }
    return { success: ++count <= 1 };
  });
  await checkPortalOperationV1({ limit }, 'read', 'A');
  now = 59_999;
  await expect(checkPortalOperationV1({ limit }, 'read', 'A')).rejects.toMatchObject({
    state: 'rate-limited',
  });
  now = 60_000;
  await expect(checkPortalOperationV1({ limit }, 'read', 'A')).resolves.toBeUndefined();
});
