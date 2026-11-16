// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  emptyPortalSignalsV1,
  isPortalSignalsPageV1,
  portalSignalBatchV1,
  portalSignalPointV1,
  signalCheckpointV1,
} from '../../shared/portal-signals-v1';
import { PortalSignalBufferV1 } from '../../server/student-portal/observability/signal-buffer-v1';
const at = '2026-09-22T01:00:00.000Z';
const now = Date.parse(at);
it.each(['browser-module', 'browser-render', 'browser-read'] as const)(
  'enforces the 60-report boundary for %s in every shared envelope',
  (source) => {
    const valid = {
      bucketAt: at,
      source,
      outcome: 'failed',
      samples: 60,
      totalMs: 0,
      maxMs: 0,
      slow: 0,
      capped: true,
    };
    const invalid = { ...valid, samples: 61 };
    const page = { ...emptyPortalSignalsV1('unavailable', at), state: 'ok', points: [valid] };
    expect(portalSignalPointV1.safeParse(valid).success).toBe(true);
    expect(isPortalSignalsPageV1(page)).toBe(true);
    expect(portalSignalPointV1.safeParse(invalid).success).toBe(false);
    expect(isPortalSignalsPageV1({ ...page, points: [invalid] })).toBe(false);
    expect(
      portalSignalBatchV1.safeParse({ version: 1, generatedAt: at, points: [invalid] }).success,
    ).toBe(false);
    const checkpoint = { version: 1, savedAt: now, points: [invalid] };
    expect(signalCheckpointV1.safeParse(checkpoint).success).toBe(false);
    const restored = new PortalSignalBufferV1({ read: () => checkpoint, write: vi.fn() });
    expect(restored.snapshot(now).points).toEqual([]);
  },
);
it('preserves the larger server bound and the slow-count invariant', () => {
  const point = {
    bucketAt: at,
    source: 'login',
    outcome: 'ok',
    samples: 1000,
    totalMs: 3000000,
    maxMs: 3000,
    slow: 1000,
    capped: true,
  };
  expect(portalSignalPointV1.safeParse(point).success).toBe(true);
  expect(portalSignalPointV1.safeParse({ ...point, slow: 1001 }).success).toBe(false);
});
it('keeps checkpoint failures out of the observation outcome and avoids repeated writes within thirty seconds', () => {
  const write = vi.fn(() => {
    throw Error('SYNTHETIC storage unavailable');
  });
  const buffer = new PortalSignalBufferV1({ read: () => null, write });
  for (let i = 0; i < 100; i++)
    expect(buffer.record({ source: 'login', outcome: 'ok', elapsedMs: 10 }, now + i)).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
  expect(buffer.snapshot(now + 100).points[0]?.samples).toBe(100);
  expect(write).toHaveBeenCalledTimes(1);
  expect(buffer.snapshot(now + 30000).points[0]?.samples).toBe(100);
  expect(write).toHaveBeenCalledTimes(2);
});
