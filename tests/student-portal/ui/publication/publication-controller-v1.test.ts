// @vitest-environment node
import { afterEach, describe, it, expect, vi } from 'vitest';
import type {
  AdminCommandV1,
  AdminQueryV1,
} from '../../../../shared/student-portal-contracts/admin-v1';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import { SYNTHETIC_ID_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import { createPortalAdminClientV1 } from '../../../../src/features/student-portal-admin/shared/admin-client-v1';
import {
  createPublicationControllerV1,
  initialPublicationViewV1,
} from '../../../../src/features/student-portal-admin/publication/publication-controller-v1';
import { publicationCommandV1 } from '../../../../src/features/student-portal-admin/publication/publication-values-v1';
import { SETTINGS_CLASS_V1 } from '../settings/fixtures-v1';
import {
  PUBLICATION_ACCOUNT_V1,
  PUBLICATION_META_V1,
  publicationFixtureV1,
  publicationResponseV1,
} from './fixtures-v1';
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
afterEach(() => vi.useRealTimers());
function setup(
  scope: ScopeV1 = PUBLICATION_ACCOUNT_V1,
  options: {
    write?: (command: AdminCommandV1) => Promise<Response>;
    query?: (query: AdminQueryV1) => Promise<Response> | undefined;
    maxChecks?: number;
    now?: () => number;
  } = {},
) {
  const fixture = publicationFixtureV1(scope),
    writes: string[] = [],
    queries: AdminQueryV1[] = [];
  let state = initialPublicationViewV1();
  const client = createPortalAdminClientV1({
    fetch: async (path, init) => {
      if (path.endsWith('/query')) {
        const input: AdminQueryV1 = JSON.parse(String(init.body));
        queries.push(input);
        const override = options.query?.(input);
        if (override) return override;
        return json(
          input.operation === 'publication'
            ? publicationResponseV1(fixture)
            : { ...PUBLICATION_META_V1, state: 'settings', settings: fixture.settings },
        );
      }
      writes.push(String(init.body));
      return options.write
        ? options.write(JSON.parse(String(init.body)))
        : json({
            ...PUBLICATION_META_V1,
            state: 'committed',
            operationId: SYNTHETIC_ID_V1,
            version: 10,
          });
    },
  });
  const controller = createPublicationControllerV1(
    client,
    scope,
    (value) => {
      state = value;
    },
    { checkDelayMs: 100, maxChecks: options.maxChecks ?? 3, now: options.now },
  );
  return {
    fixture,
    writes,
    queries,
    controller,
    state: () => state,
    command: () => publicationCommandV1(scope, fixture.items[0]!, 'publish', SYNTHETIC_ID_V1),
  };
}
describe('publication command and bounded observation', () => {
  it('separates acceptance from account materialization and observes only the approved revision', async () => {
    vi.useFakeTimers();
    const mock = setup();
    await mock.controller.load();
    await mock.controller.submit(mock.command());
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.state().mutation).toMatchObject({
      state: 'accepted',
      observation: 'observing',
      checks: 1,
    });
    mock.fixture.items[0]!.publishedRevision = 'synthetic:2026:revision:other';
    await vi.advanceTimersByTimeAsync(100);
    expect(mock.state().mutation).toMatchObject({ observation: 'observing', checks: 2 });
    mock.fixture.items[0]!.publishedRevision = 'synthetic:2026:revision:2';
    mock.fixture.items[0]!.state = 'published';
    await vi.advanceTimersByTimeAsync(100);
    expect(mock.state().mutation).toMatchObject({ observation: 'confirmed', checks: 3 });
    expect(mock.writes).toHaveLength(1);
    mock.controller.reset();
  });
  it('reports an aggregated revision without inventing all-profile completion', async () => {
    vi.useFakeTimers();
    const mock = setup(SETTINGS_CLASS_V1);
    await mock.controller.load();
    mock.fixture.items[0]!.publishedRevision = 'synthetic:2026:revision:2';
    mock.fixture.items[0]!.state = 'published';
    await mock.controller.submit(mock.command());
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.state().mutation).toMatchObject({ state: 'accepted', observation: 'reported' });
    mock.controller.reset();
  });
  it('stops after the bounded read count without retrying the mutation', async () => {
    vi.useFakeTimers();
    const mock = setup();
    await mock.controller.load();
    await mock.controller.submit(mock.command());
    await vi.advanceTimersByTimeAsync(5000);
    expect(mock.state().mutation).toMatchObject({ observation: 'unconfirmed', checks: 3 });
    expect(mock.queries.filter((query) => query.operation === 'publication')).toHaveLength(4);
    expect(mock.writes).toHaveLength(1);
    mock.controller.reset();
  });
  it('cancels observation without cancelling or repeating the accepted server decision', async () => {
    vi.useFakeTimers();
    const mock = setup();
    await mock.controller.load();
    await mock.controller.submit(mock.command());
    await vi.advanceTimersByTimeAsync(0);
    mock.controller.cancelObservation();
    const count = mock.queries.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(mock.queries).toHaveLength(count);
    expect(mock.state().mutation).toMatchObject({ state: 'accepted', observation: 'stopped' });
    expect(mock.state().load.state).toBe('ready');
    expect(mock.writes).toHaveLength(1);
    mock.controller.reset();
  });
  it('keeps canonical bytes after a lost reply and a changed caller object', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const mock = setup(undefined, {
      write: async () => {
        if (++attempts <= 2) throw new TypeError('lost');
        return json({
          ...PUBLICATION_META_V1,
          state: 'committed',
          operationId: SYNTHETIC_ID_V1,
          version: 10,
        });
      },
    });
    await mock.controller.load();
    const command = mock.command();
    await mock.controller.submit(command);
    expect(mock.state().mutation).toMatchObject({ state: 'error', retryable: true });
    if ('targetDataVersion' in command) command.targetDataVersion = 'synthetic:changed';
    await mock.controller.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(new Set(mock.writes).size).toBe(1);
    expect(mock.writes).toHaveLength(3);
    expect(mock.state().mutation).toMatchObject({
      state: 'accepted',
      command: { targetDataVersion: 'synthetic:2026:revision:2' },
    });
    mock.controller.reset();
  });
  it('does not promote a conflicting source/CAS or repeat a rejected command', async () => {
    const mock = setup(undefined, {
      write: async () => json({ ...PUBLICATION_META_V1, state: 'conflict' }, 409),
    });
    await mock.controller.load();
    await mock.controller.submit(mock.command());
    await mock.controller.retry();
    expect(mock.writes).toHaveLength(1);
    expect(mock.state().mutation).toMatchObject({ state: 'error', retryable: false });
    mock.fixture.items.forEach((item) => {
      item.version = 11;
      if (item.availableRevision) item.availableRevision = 'synthetic:2026:revision:3';
    });
    expect(JSON.parse(mock.writes[0]!)).toMatchObject({
      expectedVersion: 9,
      targetDataVersion: 'synthetic:2026:revision:2',
    });
    await mock.controller.load();
    expect(mock.state().load.state).toBe('ready');
    expect(mock.command()).toMatchObject({
      expectedVersion: 11,
      targetDataVersion: 'synthetic:2026:revision:3',
    });
    mock.controller.reset();
  });
  it('honors Retry-After for mutation retries and reload', async () => {
    let now = 0;
    const mock = setup(undefined, {
      now: () => now,
      write: async () =>
        json({ ...PUBLICATION_META_V1, state: 'rate-limited' }, 429, { 'Retry-After': '2' }),
    });
    await mock.controller.load();
    await mock.controller.submit(mock.command());
    const count = mock.queries.length;
    await mock.controller.retry();
    await mock.controller.load();
    expect(mock.writes).toHaveLength(1);
    expect(mock.queries).toHaveLength(count);
    now = 2000;
    await mock.controller.retry();
    expect(mock.writes).toHaveLength(2);
    mock.controller.reset();
  });
  it('honors a query Retry-After and stops observing on an unavailable read', async () => {
    let now = 0,
      fail = true;
    const mock = setup(undefined, {
      now: () => now,
      query: (query) =>
        fail && query.operation === 'publication'
          ? Promise.resolve(
              json({ ...PUBLICATION_META_V1, state: 'rate-limited' }, 429, { 'Retry-After': '3' }),
            )
          : undefined,
    });
    await mock.controller.load();
    expect(mock.state().load.state).toBe('error');
    const count = mock.queries.length;
    await mock.controller.load();
    expect(mock.queries).toHaveLength(count);
    now = 3000;
    fail = false;
    await mock.controller.load();
    fail = true;
    await mock.controller.submit(mock.command());
    await vi.waitFor(() =>
      expect(mock.state().mutation).toMatchObject({ observation: 'unconfirmed' }),
    );
    expect(mock.state().load).toMatchObject({
      state: 'ready',
      refreshError: { state: 'rate-limited' },
    });
    expect(mock.writes).toHaveLength(1);
    mock.controller.reset();
  });
  it('prevents duplicate dispatch, ignores a late write after reset and remains reusable', async () => {
    let resolve!: (response: Response) => void;
    const mock = setup(undefined, {
      write: async () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    });
    await mock.controller.load();
    const pending = mock.controller.submit(mock.command());
    await mock.controller.submit(mock.command());
    expect(mock.writes).toHaveLength(1);
    mock.controller.reset();
    resolve(
      json({
        ...PUBLICATION_META_V1,
        state: 'committed',
        operationId: SYNTHETIC_ID_V1,
        version: 10,
      }),
    );
    await pending;
    expect(mock.state()).toEqual(initialPublicationViewV1());
    await mock.controller.load();
    expect(mock.state().load.state).toBe('ready');
    mock.controller.reset();
  });
  it('refuses foreign scopes and unrelated commands before network dispatch', async () => {
    const mock = setup();
    await mock.controller.load();
    await expect(
      mock.controller.submit({ ...mock.command(), scope: SETTINGS_CLASS_V1 }),
    ).rejects.toThrow();
    await expect(
      mock.controller.submit({ ...mock.command(), operation: 'account-reset' } as never),
    ).rejects.toThrow();
    expect(mock.writes).toHaveLength(0);
    mock.controller.reset();
  });
});
