import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYNC_SETTINGS_V1,
  SYNC_BREAKER_FAILURES_V1,
  SYNC_BREAKER_PAUSE_MS_V1,
  SYNC_LEASE_MS_V1,
  expiredLeasesV1,
  filesToStartV1,
  finishReadingV1,
  nextBreakerV1,
  nextWakeV1,
  observeFileV1,
  startReadingV1,
  type ObservedFileV1,
  type ReadResultV1,
  type SyncFileV1,
} from '../../../server/gradebook/onedrive-sync/sync-rules-v1';

const on = { ...DEFAULT_SYNC_SETTINGS_V1, enabled: true };
const seen = (id: string, hash: string | null = `h-${id}`, extra: Partial<ObservedFileV1> = {}): ObservedFileV1 => ({
  id, name: `${id}.xlsb`, size: 10, modifiedAt: '2026-11-13T10:00:00.000Z', hash, deleted: false, ...extra,
});
const done = (outcome: ReadResultV1['outcome'], readHash: string | null = 'h-a'): ReadResultV1 => ({
  outcome, code: null, readHash, readMs: 1, savedToWrittenMs: null,
});
function pending(id: string, now = 0, settings = on): SyncFileV1 {
  return observeFileV1(null, seen(id), now, settings)!;
}

describe('Notas sync rules', () => {
  it('a new or changed file becomes pending, due after the configured wait', () => {
    expect(pending('a', 1000)).toMatchObject({ state: 'pending', dueAt: 1000 });
    expect(pending('a', 1000, { ...on, waitSeconds: 10 })).toMatchObject({ state: 'pending', dueAt: 11_000 });
  });

  it('a file identical to the last processed one is skipped without a read', () => {
    const processed = { ...pending('a'), state: 'idle' as const, processedHash: 'h-a', dueAt: null };
    expect(observeFileV1(processed, seen('a'), 5, on)).toMatchObject({ state: 'idle', dueAt: null });
  });

  it('a later save pushes the wait forward', () => {
    const settings = { ...on, waitSeconds: 10 };
    const first = observeFileV1(null, seen('a', 'h1'), 0, settings)!;
    expect(observeFileV1(first, seen('a', 'h2'), 4000, settings)).toMatchObject({ state: 'pending', dueAt: 14_000 });
  });

  it('a save during a read marks the file dirty; it is read again right after', () => {
    const reading = startReadingV1(pending('a'), 'lease-1', 0);
    const dirty = observeFileV1(reading, seen('a', 'h-new'), 10, on)!;
    expect(dirty).toMatchObject({ state: 'reading', dirty: true, lease: 'lease-1' });
    expect(finishReadingV1(dirty, 'lease-1', done('applied', 'h-a'), 20)).toMatchObject({
      state: 'pending', dueAt: 20, dirty: false, processedHash: 'h-a',
    });
  });

  it('never runs two reads of one file and respects the parallel limit', () => {
    const files = ['a', 'b', 'c'].map((id) => pending(id));
    const started = filesToStartV1(files, 0, { ...on, maxParallel: 2 }, null);
    expect(started.map((file) => file.id)).toEqual(['a', 'b']);
    const after = [startReadingV1(files[0]!, 'l1', 0), startReadingV1(files[1]!, 'l2', 0), files[2]!];
    expect(filesToStartV1(after, 0, { ...on, maxParallel: 2 }, null)).toEqual([]);
  });

  it('starts nothing when disabled, paused or tripped', () => {
    const files = [pending('a')];
    expect(filesToStartV1(files, 0, DEFAULT_SYNC_SETTINGS_V1, null)).toEqual([]);
    expect(filesToStartV1(files, 0, { ...on, paused: true }, null)).toEqual([]);
    expect(filesToStartV1(files, 0, on, 1000)).toEqual([]);
    expect(filesToStartV1(files, 2000, on, 1000)).toHaveLength(1);
  });

  it('ignores a finish with a stale lease', () => {
    const reading = startReadingV1(pending('a'), 'current', 0);
    expect(finishReadingV1(reading, 'old', done('applied'), 1)).toBeNull();
  });

  it('retries transient failures with growing delays and keeps the processed hash', () => {
    let file = startReadingV1(pending('a'), 'l', 0);
    file = finishReadingV1(file, 'l', done('failed', null), 100)!;
    expect(file).toMatchObject({ state: 'pending', dueAt: 100 + 60_000, attempts: 1, processedHash: null });
    file = finishReadingV1(startReadingV1(file, 'l2', 200), 'l2', done('failed', null), 300)!;
    expect(file).toMatchObject({ dueAt: 300 + 5 * 60_000, attempts: 2 });
  });

  it('does not retry deterministic results (blocked, unreadable) until the file changes', () => {
    const blocked = finishReadingV1(startReadingV1(pending('a'), 'l', 0), 'l', done('blocked'), 1)!;
    expect(blocked).toMatchObject({ state: 'idle', processedHash: 'h-a', lastOutcome: 'blocked' });
    expect(observeFileV1(blocked, seen('a'), 2, on)).toMatchObject({ state: 'idle' });
    expect(observeFileV1(blocked, seen('a', 'h-fixed'), 3, on)).toMatchObject({ state: 'pending' });
  });

  it('a deleted file is only marked removed, never read', () => {
    const removed = observeFileV1(pending('a'), seen('a', null, { deleted: true }), 0, on)!;
    expect(removed).toMatchObject({ removed: true, state: 'idle' });
    expect(filesToStartV1([removed], 0, on, null)).toEqual([]);
    expect(observeFileV1(null, seen('x', null, { deleted: true }), 0, on)).toBeNull();
  });

  it('reclaims reads whose lease expired', () => {
    const reading = startReadingV1(pending('a'), 'l', 0);
    expect(expiredLeasesV1([reading], SYNC_LEASE_MS_V1 - 1)).toEqual([]);
    expect(expiredLeasesV1([reading], SYNC_LEASE_MS_V1)).toHaveLength(1);
  });

  it('trips the breaker after consecutive failures and resets on success', () => {
    let state = { consecutiveFailures: 0, breakerUntil: null as number | null };
    for (let index = 1; index < SYNC_BREAKER_FAILURES_V1; index++) {
      state = nextBreakerV1(state.consecutiveFailures, 'failed', 0);
      expect(state.breakerUntil).toBeNull();
    }
    expect(nextBreakerV1(state.consecutiveFailures, 'failed', 10).breakerUntil).toBe(10 + SYNC_BREAKER_PAUSE_MS_V1);
    expect(nextBreakerV1(3, 'blocked', 10)).toEqual({ consecutiveFailures: 0, breakerUntil: null });
  });

  it('wakes at the earliest due read, lease end or breaker end', () => {
    const due = { ...pending('a'), dueAt: 500 };
    const reading = startReadingV1(pending('b'), 'l', 100);
    expect(nextWakeV1([due, reading], null, 0)).toBe(500);
    expect(nextWakeV1([], 300, 0)).toBe(300);
    expect(nextWakeV1([], null, 0)).toBeNull();
  });
});
