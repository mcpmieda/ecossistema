// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  finishReadingV1,
  INITIAL_SYNC_PARALLEL_V1,
  nextParallelV1,
  observeFileV1,
  rereadFileV1,
  startReadingV1,
  SYNC_PARALLEL_MAX_V1,
  type ReadResultV1,
  type SyncFileV1,
} from '../../../server/gradebook/onedrive-sync/sync-rules-v1';
import { minutesSecondsV1 } from '../../../src/features/gradebook/onedrive-sync/onedrive-sync-page-v1';

const result = (
  outcome: ReadResultV1['outcome'],
  extra: Partial<ReadResultV1> = {},
): ReadResultV1 => ({
  outcome,
  code: null,
  readHash: 'h',
  readMs: 900,
  savedToWrittenMs: 102_000,
  ...extra,
});
const file = (): SyncFileV1 =>
  observeFileV1(
    null,
    {
      id: 'a',
      name: 'a.xlsb',
      size: 1,
      modifiedAt: '2026-11-15T10:00:00.000Z',
      hash: 'h',
      deleted: false,
    },
    0,
  )!;

describe('reads at once, set by the sync (owner request of 15/11/2026)', () => {
  it('starts at the ceiling and halves on congestion', () => {
    expect(INITIAL_SYNC_PARALLEL_V1.limit).toBe(SYNC_PARALLEL_MAX_V1);
    expect(
      nextParallelV1({ limit: 6, clean: 3 }, result('failed', { code: 'WRITE-QUEUE-DEADLINE' })),
    ).toEqual({ limit: 3, clean: 0 });
    expect(
      nextParallelV1({ limit: 3, clean: 0 }, result('failed', { code: 'DATABASE-UNAVAILABLE' })),
    ).toEqual({ limit: 1, clean: 0 });
    expect(nextParallelV1({ limit: 1, clean: 0 }, result('failed'))).toEqual({
      limit: 1,
      clean: 0,
    });
    expect(nextParallelV1({ limit: 4, clean: 0 }, result('applied', { readMs: 75_000 }))).toEqual({
      limit: 2,
      clean: 0,
    });
  });

  it('adds one after as many clean reads as the limit, up to the ceiling', () => {
    let state = { limit: 2, clean: 0 };
    state = nextParallelV1(state, result('applied'));
    expect(state).toEqual({ limit: 2, clean: 1 });
    state = nextParallelV1(state, result('no-changes'));
    expect(state).toEqual({ limit: 3, clean: 0 });
    // A problem in the spreadsheet is not congestion.
    expect(
      nextParallelV1({ limit: 6, clean: 0 }, result('blocked', { code: 'AUDIT-BLOCKING' })),
    ).toEqual({ limit: 6, clean: 0 });
  });
});

describe('arrival of grades', () => {
  it('keeps when grades went in and the time from the save, only for applied reads', () => {
    const applied = finishReadingV1(startReadingV1(file(), 'l', 0), 'l', result('applied'), 5_000)!;
    expect(applied).toMatchObject({ lastAppliedAt: 5_000, lastSavedToWrittenMs: 102_000 });
    const unchanged = finishReadingV1(
      startReadingV1({ ...applied, state: 'pending' }, 'm', 6_000),
      'm',
      result('no-changes'),
      7_000,
    )!;
    expect(unchanged).toMatchObject({ lastAppliedAt: 5_000, lastSavedToWrittenMs: 102_000 });
  });

  it('a read caused by the Relação has no time from a save', () => {
    const reread = rereadFileV1({ ...file(), state: 'idle' }, 10);
    const applied = finishReadingV1(startReadingV1(reread, 'l', 10), 'l', result('applied'), 20)!;
    expect(applied).toMatchObject({
      lastAppliedAt: 20,
      lastSavedToWrittenMs: null,
      rereading: false,
    });
  });

  it('shows durations in minutes and seconds only', () => {
    expect(minutesSecondsV1(8_400)).toBe('8 s');
    expect(minutesSecondsV1(102_000)).toBe('1 min 42 s');
    expect(minutesSecondsV1(113_849_100)).toBe('1.897 min 29 s');
    expect(minutesSecondsV1(null)).toBeNull();
  });
});
