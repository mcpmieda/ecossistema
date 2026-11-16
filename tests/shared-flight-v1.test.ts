// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { joinFlightV1 } from '../server/http/shared-flight-v1';
import { createSystemHealthCacheV1 } from '../server/platform/system-health-source-v1';

afterEach(() => {
  vi.useRealTimers();
});

describe('reads shared between requests never wait forever (issue #1450, finding 2)', () => {
  it('a read in flight is joined while it answers in time', async () => {
    const own = vi.fn(async () => 'own');
    await expect(joinFlightV1(Promise.resolve('shared'), 1000, own)).resolves.toBe('shared');
    expect(own).not.toHaveBeenCalled();
  });

  it('past the wait, the caller reads on its own', async () => {
    vi.useFakeTimers();
    const own = vi.fn(async () => 'own');
    const joined = joinFlightV1(new Promise<string>(() => undefined), 500, own);
    await vi.advanceTimersByTimeAsync(501);
    await expect(joined).resolves.toBe('own');
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('the system health cache does not stay stuck on a read that never answers', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const cache = createSystemHealthCacheV1(() => clock);
    const snapshot = { schemaVersion: 1 } as never;
    void cache(() => new Promise(() => undefined));
    clock = 16_000;
    await expect(cache(async () => snapshot)).resolves.toBe(snapshot);
  });
});
