import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createPlatformDataV2,
  usePlatformDataV2,
  type PlatformLoadStateV2,
} from '../src/platform/platform-data-v2';
import { usePlatformIdentityV1 } from '../src/platform/platform-identity-v1';
import { buildPlatformSnapshot } from '../server/platform/snapshot';

let reads = 0;
const template = () =>
  buildPlatformSnapshot(
    {
      lists: [],
      moduleItems: [],
      configurationItems: [],
      auditItems: [],
      migrationItems: [],
      // Every reading has its own correlation and time, even with the same content.
      correlationId: `synthetic-${++reads}`,
      generatedAt: new Date(1_800_000_000_000 + reads * 1000).toISOString(),
    },
    ['platform.snapshot.read', 'platform.settings.read'],
  );
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('the ADM reads nothing on a clock (A27)', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(async () => json(template()));
  vi.stubGlobal('fetch', fetcher);
  renderHook(() => usePlatformDataV2());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  const first = fetcher.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60_000);
  });
  expect(fetcher.mock.calls).toHaveLength(first);
});

it('a reading that says the same is not published again (A27)', async () => {
  let clock = 0;
  const states: PlatformLoadStateV2[] = [];
  const fetcher = vi.fn<typeof fetch>(async () => json(template()));
  const controller = createPlatformDataV2((state) => states.push(state), fetcher, () => clock);
  try {
    await controller.start();
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'ready', auxiliary: 'ready' }));
    const published = states.length;
    clock = 120_000;
    await controller.refresh();
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('/snapshot-v2'))).toHaveLength(2);
    expect(states).toHaveLength(published);
  } finally {
    controller.dispose();
  }
});

it('the same identity read again keeps the object shown (A27)', async () => {
  const body = {
    authenticated: true,
    name: 'Pessoa sintética',
    capabilities: ['platform.snapshot.read'],
    identityKey: 'synthetic-identity',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => json(body)));
  const { result } = renderHook(() => usePlatformIdentityV1());
  await vi.waitFor(() => expect(result.current.identity?.authenticated).toBe(true));
  const shown = result.current.identity;
  await act(async () => {
    result.current.recheck();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(result.current.identity).toBe(shown);
});
