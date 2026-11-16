// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminQueryV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import { createPortalAdminClientV1 } from '../../../../src/features/student-portal-admin/shared/admin-client-v1';
import { createPublicationControllerV1, initialPublicationViewV1 } from '../../../../src/features/student-portal-admin/publication/publication-controller-v1';
import { publicationCommandV1 } from '../../../../src/features/student-portal-admin/publication/publication-values-v1';
import { PUBLICATION_ACCOUNT_V1, PUBLICATION_META_V1, publicationFixtureV1, publicationResponseV1 } from './fixtures-v1';

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});
const query = (operation: 'publication' | 'settings') => ({
  contractVersion: 1 as const, operation, scope: PUBLICATION_ACCOUNT_V1, page: { limit: 50 },
});
afterEach(() => vi.useRealTimers());

describe('publication read recovery #801', () => {
  it.each(['publication', 'settings'] as const)('recovers %s once using the same canonical bytes', async (operation) => {
    const fixture = publicationFixtureV1(PUBLICATION_ACCOUNT_V1);
    const bodies: string[] = [];
    const client = createPortalAdminClientV1({ fetch: async (path, init) => {
      expect(path).toBe('/api/student-portal/admin/query');
      bodies.push(String(init.body));
      if (bodies.length === 1) throw new TypeError('synthetic connection interruption');
      return json(operation === 'publication' ? publicationResponseV1(fixture)
        : { ...PUBLICATION_META_V1, state: 'settings', settings: fixture.settings });
    } });
    expect((await client.query(query(operation))).state).toBe(operation);
    expect(bodies).toHaveLength(2);
    expect(new Set(bodies).size).toBe(1);
  });
  it('stops after two failed transport attempts', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('synthetic offline'); });
    await expect(createPortalAdminClientV1({ fetch }).query(query('publication')))
      .rejects.toMatchObject({ state: 'network-error' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['unauthenticated', 401, {}], ['forbidden', 403, {}], ['conflict', 409, {}],
    ['rate-limited', 429, { 'Retry-After': '3' }], ['unavailable', 503, { 'Retry-After': '3' }],
  ] as const)('does not replay %s or override Retry-After', async (state, status, headers) => {
    const fetch = vi.fn(async () => json({ ...PUBLICATION_META_V1, state }, status, headers));
    await expect(createPortalAdminClientV1({ fetch }).query(query('publication'))).rejects.toMatchObject({ state });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not replay after the scope request is aborted', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      throw new TypeError('synthetic interrupted request');
    });
    await expect(createPortalAdminClientV1({ fetch }).query(query('publication'), controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function observationFixture() {
  const fixture = publicationFixtureV1(PUBLICATION_ACCOUNT_V1);
  let view = initialPublicationViewV1();
  let unavailable = false;
  let retryAfter: string | undefined;
  let reads = 0;
  const writes: string[] = [];
  const client = createPortalAdminClientV1({ fetch: async (path, init) => {
    if (path.endsWith('/command')) {
      writes.push(String(init.body));
      return json({ ...PUBLICATION_META_V1, state: 'committed', operationId: PUBLICATION_META_V1.requestId, version: 10 });
    }
    const input: AdminQueryV1 = JSON.parse(String(init.body));
    if (input.operation === 'settings') return json({ ...PUBLICATION_META_V1, state: 'settings', settings: fixture.settings });
    reads++;
    if (unavailable) return json({ ...PUBLICATION_META_V1, state: 'unavailable' }, 503,
      retryAfter ? { 'Retry-After': retryAfter } : {});
    return json(publicationResponseV1(fixture));
  } });
  const controller = createPublicationControllerV1(client, PUBLICATION_ACCOUNT_V1, (next) => { view = next; },
    { checkDelayMs: 100, maxChecks: 3 });
  return {
    controller, writes, view: () => view, reads: () => reads,
    fail: (after?: string) => { unavailable = true; retryAfter = after; },
    recover: () => {
      unavailable = false;
      fixture.items[0]!.state = 'published';
      fixture.items[0]!.publishedRevision = fixture.items[0]!.availableRevision;
    },
    command: () => publicationCommandV1(PUBLICATION_ACCOUNT_V1, fixture.items[0]!, 'publish', PUBLICATION_META_V1.requestId),
  };
}

describe('accepted publication observation #801', () => {
  it('recovers the read without resubmitting or changing the accepted decision', async () => {
    vi.useFakeTimers();
    const fixture = observationFixture();
    try {
      await fixture.controller.load();
      fixture.fail();
      await fixture.controller.submit(fixture.command());
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.view().load).toMatchObject({ state: 'ready', refreshError: { state: 'unavailable' } });
      expect(fixture.view().mutation).toMatchObject({ state: 'accepted', observation: 'observing', checks: 1 });
      fixture.recover();
      await vi.advanceTimersByTimeAsync(100);
      expect(fixture.view().mutation).toMatchObject({ observation: 'confirmed', checks: 2 });
      expect(fixture.writes).toHaveLength(1);
    } finally { fixture.controller.reset(); }
  });
  it('exhausts the existing observation budget without claiming success', async () => {
    vi.useFakeTimers();
    const fixture = observationFixture();
    try {
      await fixture.controller.load();
      fixture.fail();
      await fixture.controller.submit(fixture.command());
      await vi.advanceTimersByTimeAsync(2000);
      expect(fixture.view().mutation).toMatchObject({ observation: 'unconfirmed', checks: 3 });
      expect(fixture.view().load).toMatchObject({ state: 'ready', refreshError: { state: 'unavailable' } });
      expect(fixture.reads()).toBe(7); // one initial read plus two transport attempts per observation
      expect(fixture.writes).toHaveLength(1);
    } finally { fixture.controller.reset(); }
  });
  it('waits for Retry-After before observing again', async () => {
    vi.useFakeTimers();
    const fixture = observationFixture();
    try {
      await fixture.controller.load();
      fixture.fail('3');
      await fixture.controller.submit(fixture.command());
      await vi.advanceTimersByTimeAsync(0);
      const reads = fixture.reads();
      fixture.recover();
      await vi.advanceTimersByTimeAsync(2999);
      expect(fixture.reads()).toBe(reads);
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.view().mutation).toMatchObject({ observation: 'confirmed' });
      expect(fixture.writes).toHaveLength(1);
    } finally { fixture.controller.reset(); }
  });
  it('cancels recovery timers on reset and never revives the previous scope', async () => {
    vi.useFakeTimers();
    const fixture = observationFixture();
    await fixture.controller.load();
    fixture.fail();
    await fixture.controller.submit(fixture.command());
    await vi.advanceTimersByTimeAsync(0);
    fixture.controller.reset();
    const reads = fixture.reads();
    fixture.recover();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fixture.reads()).toBe(reads);
    expect(fixture.view()).toEqual(initialPublicationViewV1());
    expect(fixture.writes).toHaveLength(1);
  });
});
