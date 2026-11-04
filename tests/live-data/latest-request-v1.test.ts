// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLatestPortalRequestV1, type PortalLoadStateV1 } from '../../src/features/student-portal/shared/latest-request-v1';
import { PortalClientErrorV1 } from '../../src/features/student-portal/shared/transport-v1';

afterEach(() => vi.useRealTimers());
describe('silent read boundaries', () => {
  it('preserves the same visible object while refreshing, then applies the confirmed response', async () => {
    const states: PortalLoadStateV1<{ value: number }>[] = [];
    const reader = createLatestPortalRequestV1<{ value: number }>((state) => states.push(state));
    const first = { value: 1 };
    await reader.run(async () => first);
    let resolve!: (value: { value: number }) => void;
    const next = reader.run(() => new Promise((done) => { resolve = done; }), { background: true });
    expect(states.at(-1)).toEqual({ state: 'ready', data: first, refreshing: true });
    const duplicate = vi.fn(async () => ({ value: 9 }));
    await reader.run(duplicate, { background: true });
    expect(duplicate).not.toHaveBeenCalled();
    resolve({ value: 2 }); await next;
    expect(states.at(-1)).toEqual({ state: 'ready', data: { value: 2 } });
  });
  it('reports a transient refresh error without clearing the view, but clears after denial', async () => {
    const publish = vi.fn();
    const reader = createLatestPortalRequestV1(publish);
    await reader.run(async () => 'authorized');
    await reader.run(async () => { throw new PortalClientErrorV1('unavailable', 503); }, { background: true });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ state: 'ready', data: 'authorized', refreshError: { state: 'unavailable' } });
    await reader.run(async () => { throw new PortalClientErrorV1('unauthenticated', 401); }, { background: true });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ state: 'error', error: { state: 'unauthenticated' } });
  });
  it('publishes nothing for a silent read that finds the same answer, and only the change otherwise', async () => {
    const publish = vi.fn();
    const reader = createLatestPortalRequestV1<{ rows: string[]; seals: Map<string, number> }>(publish);
    await reader.run(async () => ({ rows: ['a'], seals: new Map([['a', 2]]) }));
    const shown = publish.mock.lastCall?.[0].data;
    publish.mockClear();
    await reader.run(async () => ({ rows: ['a'], seals: new Map([['a', 2]]) }), { background: true, silent: true });
    expect(publish).not.toHaveBeenCalled();
    await reader.run(async () => ({ rows: ['a'], seals: new Map([['a', 3]]) }), { background: true, silent: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.lastCall?.[0]).toEqual({ state: 'ready', data: { rows: ['a'], seals: new Map([['a', 3]]) } });
    expect(publish.mock.lastCall?.[0].data).not.toBe(shown);
  });
  it('keeps the screen through a silent failure of any age, clears its notice with the same object, and keeps denial strict', async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const reader = createLatestPortalRequestV1<{ value: number }>(publish);
    await reader.run(async () => ({ value: 1 }));
    const shown = publish.mock.lastCall?.[0].data;
    publish.mockClear();
    vi.advanceTimersByTime(30 * 60_000);
    await reader.run(async () => { throw new PortalClientErrorV1('network-error'); }, { silent: true });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ state: 'ready', data: shown, refreshError: { state: 'network-error' } });
    expect(publish.mock.calls.some(([state]) => state.state === 'loading' || state.refreshing)).toBe(false);
    await reader.run(async () => ({ value: 1 }), { silent: true });
    expect(publish.mock.lastCall?.[0]).toEqual({ state: 'ready', data: shown });
    expect(publish.mock.lastCall?.[0].data).toBe(shown);
    await reader.run(async () => { throw new PortalClientErrorV1('forbidden', 403); }, { silent: true });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ state: 'error', error: { state: 'forbidden' } });
    // A silent retry from an error shows no loading in between.
    publish.mockClear();
    await reader.run(async () => ({ value: 2 }), { silent: true });
    expect(publish.mock.calls.map(([state]) => state.state)).toEqual(['ready']);
  });
  it('lets a read someone asked for replace a silent one, never the other way round', async () => {
    const publish = vi.fn();
    const reader = createLatestPortalRequestV1<string>(publish);
    await reader.run(async () => 'first');
    let resolveSilent!: (value: string) => void;
    const silent = reader.run(() => new Promise<string>((done) => { resolveSilent = done; }), { silent: true });
    const skipped = vi.fn(async () => 'skipped');
    await reader.run(skipped, { silent: true });
    expect(skipped).not.toHaveBeenCalled();
    const asked = vi.fn(async () => 'asked');
    await reader.run(asked, { background: true });
    expect(asked).toHaveBeenCalledOnce();
    resolveSilent('obsolete'); await silent;
    expect(publish.mock.lastCall?.[0]).toEqual({ state: 'ready', data: 'asked' });
    let resolveAsked!: (value: string) => void;
    const pending = reader.run(() => new Promise<string>((done) => { resolveAsked = done; }), { background: true });
    const late = vi.fn(async () => 'late');
    await reader.run(late, { silent: true });
    expect(late).not.toHaveBeenCalled();
    resolveAsked('kept'); await pending;
    expect(publish.mock.lastCall?.[0]).toEqual({ state: 'ready', data: 'kept' });
  });
  it('bounds stale retention and never restores a cleared context from an obsolete read', async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const reader = createLatestPortalRequestV1(publish);
    await reader.run(async () => 'first');
    vi.advanceTimersByTime(60_001);
    await reader.run(async () => { throw new PortalClientErrorV1('unavailable'); }, { background: true });
    expect(publish.mock.lastCall?.[0].state).toBe('error');
    let resolve!: (value: string) => void;
    const pending = reader.run(() => new Promise<string>((done) => { resolve = done; }));
    reader.clear(); resolve('obsolete'); await pending;
    expect(publish.mock.lastCall?.[0]).toEqual({ state: 'idle' });
  });
});
