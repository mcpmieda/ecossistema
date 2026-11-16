// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PortalSignalBufferV1 } from '../../server/student-portal/observability/signal-buffer-v1';
import {
  emptyPortalSignalsV1,
  isPortalSignalsPageV1,
  portalSignalInputV1,
  portalSignalPointV1,
  SIGNAL_INTERVAL_MS_V1,
} from '../../shared/portal-signals-v1';
const now = Date.parse('2026-09-22T01:00:00.000Z');
const event = { source: 'login', outcome: 'ok', elapsedMs: 12 } as const;
const point = () => ({
  bucketAt: new Date(now).toISOString(),
  source: 'login' as const,
  outcome: 'ok' as const,
  samples: 1,
  totalMs: 12,
  maxMs: 12,
  slow: 0,
  capped: false,
});
function store() {
  let persisted: unknown = null;
  return {
    read: () => persisted,
    write: vi.fn((value: unknown) => {
      persisted = structuredClone(value);
    }),
  };
}
describe('bounded aggregate signal buffer', () => {
  it('coalesces a burst into one checkpoint, survives restart and does not retain original objects', () => {
    const storage = store(),
      buffer = new PortalSignalBufferV1(storage);
    for (let i = 0; i < 100; i++) expect(buffer.record(event, now + i)).toBe(true);
    expect(storage.write).toHaveBeenCalledTimes(1);
    expect(buffer.snapshot(now + 100).points[0]?.samples).toBe(100);
    expect(storage.write).toHaveBeenCalledTimes(1);
    buffer.snapshot(now + 30_000);
    expect(storage.write).toHaveBeenCalledTimes(2);
    const restored = new PortalSignalBufferV1(storage);
    expect(restored.snapshot(now + 30_001).points[0]?.samples).toBe(100);
    const exposed = restored.snapshot(now + 30_002);
    exposed.points[0]!.samples = 900;
    expect(restored.snapshot(now + 30_003).points[0]?.samples).toBe(100);
  });
  it('caps server observations, distinguishes slow requests and expires the short buffer', () => {
    const storage = store(),
      buffer = new PortalSignalBufferV1(storage);
    for (let i = 0; i < 1100; i++) buffer.record({ ...event, elapsedMs: 3000 }, now);
    expect(buffer.snapshot(now).points[0]).toMatchObject({
      samples: 1000,
      slow: 1000,
      capped: true,
      maxMs: 3000,
    });
    expect(buffer.snapshot(now + 20 * 60_000).points).toEqual([]);
    expect(storage.write).toHaveBeenCalledTimes(2);
  });
  it('limits untrusted browser categories separately and cannot submit server success or arbitrary fields', () => {
    const storage = store(),
      buffer = new PortalSignalBufferV1(storage);
    for (let i = 0; i < 70; i++)
      buffer.record({ source: 'browser-read', outcome: 'failed', elapsedMs: 0 }, now);
    expect(buffer.snapshot(now).points[0]).toMatchObject({ samples: 60, capped: true });
    for (const input of [
      { ...event, token: 'SYNTHETIC-PRIVATE' },
      { ...event, source: '__proto__' },
      { source: 'browser-read', outcome: 'ok', elapsedMs: 0 },
      { ...event, elapsedMs: Infinity },
    ])
      expect(buffer.record(input, now)).toBe(false);
    expect(JSON.stringify(buffer.snapshot(now))).not.toContain('SYNTHETIC');
  });
  it('does not treat a corrupt checkpoint as real observations', () => {
    const buffer = new PortalSignalBufferV1({
      read: () => ({ version: 1, savedAt: now, points: [{ ...point(), name: 'private' }] }),
      write: vi.fn(),
    });
    expect(buffer.snapshot(now).points).toEqual([]);
  });
});
describe('closed signal contracts', () => {
  it('accepts only bounded, coherent aggregate values and rejects unknown browser outcomes', () => {
    expect(portalSignalInputV1.safeParse(event).success).toBe(true);
    expect(portalSignalPointV1.safeParse(point()).success).toBe(true);
    for (const patch of [
      { samples: 0 },
      { samples: 1001 },
      { totalMs: 99 },
      { slow: 1 },
      { maxMs: -1 },
      { raw: 'private' },
    ])
      expect(portalSignalPointV1.safeParse({ ...point(), ...patch }).success).toBe(false);
  });
  it('rejects future/expired/duplicated samples, invented coverage and malformed cursor pages', () => {
    const page = {
      ...emptyPortalSignalsV1('unavailable', new Date(now).toISOString()),
      state: 'ok',
      points: [point()],
    };
    expect(isPortalSignalsPageV1(page)).toBe(true);
    expect(isPortalSignalsPageV1({ ...page, coverage: 'complete' })).toBe(false);
    expect(isPortalSignalsPageV1({ ...page, points: [point(), point()] })).toBe(false);
    expect(isPortalSignalsPageV1({ ...page, nextBefore: point().bucketAt })).toBe(false);
    for (const offset of [SIGNAL_INTERVAL_MS_V1, -30 * 86400_000])
      expect(
        isPortalSignalsPageV1({
          ...page,
          points: [{ ...point(), bucketAt: new Date(now + offset).toISOString() }],
        }),
      ).toBe(false);
  });
});
