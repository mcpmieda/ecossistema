// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  PORTAL_SCHEDULED_PATH_V1,
  runScheduledNearbyV1,
  scheduledRequestTimeV1,
} from '../../../server/student-portal/composition/scheduled-nearby-v1';

const token = 's'.repeat(40);
const env = { PORTAL_ENVIRONMENT: 'production', PORTAL_ORIGIN: 'https://portal.example.test', PORTAL_SCHEDULED_TOKEN: token };
const answer = (status: number) => vi.fn(async () => new Response(status === 204 ? null : 'x', { status }));

describe('scheduled work next to the database', () => {
  it('asks its own address with the secret and the scheduled time', async () => {
    const publicFetch = answer(204);
    expect(await runScheduledNearbyV1(env, 120_000, publicFetch as unknown as typeof fetch)).toBe(true);
    const [url, init] = publicFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://portal.example.test${PORTAL_SCHEDULED_PATH_V1}`);
    expect(init.body).toBe(JSON.stringify({ scheduledTime: 120_000 }));
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  });

  it('works here when there is no secret, outside production or when refused before working', async () => {
    const never = answer(204);
    expect(await runScheduledNearbyV1({ ...env, PORTAL_SCHEDULED_TOKEN: undefined }, 1, never as unknown as typeof fetch)).toBe(false);
    expect(await runScheduledNearbyV1({ ...env, PORTAL_ENVIRONMENT: 'preview' }, 1, never as unknown as typeof fetch)).toBe(false);
    expect(never).not.toHaveBeenCalled();
    for (const status of [401, 404, 405])
      expect(await runScheduledNearbyV1(env, 1, answer(status) as unknown as typeof fetch)).toBe(false);
  });

  it('does not repeat work that may have started', async () => {
    expect(await runScheduledNearbyV1(env, 1, answer(500) as unknown as typeof fetch)).toBe(true);
    const thrown = vi.fn(async () => { throw new Error('timeout'); });
    expect(await runScheduledNearbyV1(env, 1, thrown as unknown as typeof fetch)).toBe(true);
  });

  it('the route accepts only the secret and a finite time', async () => {
    const post = (auth: string, body: unknown) => new Request(`https://portal.example.test${PORTAL_SCHEDULED_PATH_V1}`, {
      method: 'POST', body: JSON.stringify(body), headers: { Authorization: `Bearer ${auth}` } });
    expect(await scheduledRequestTimeV1(post(token, { scheduledTime: 60_000 }), env)).toEqual({ scheduledTime: 60_000 });
    expect(await scheduledRequestTimeV1(post('x'.repeat(40), { scheduledTime: 1 }), env)).toEqual({ status: 401 });
    expect(await scheduledRequestTimeV1(post('', { scheduledTime: 1 }), { ...env, PORTAL_SCHEDULED_TOKEN: '' })).toEqual({ status: 401 });
    expect(await scheduledRequestTimeV1(post('short', { scheduledTime: 1 }), { ...env, PORTAL_SCHEDULED_TOKEN: 'short' })).toEqual({ status: 401 });
    expect(await scheduledRequestTimeV1(post(token, { scheduledTime: 'x' }), env)).toEqual({ status: 400 });
  });
});
