import { portalSignalInputV1, signalCheckpointV1, signalKeyV1, SIGNAL_BUFFER_MS_V1,
  SIGNAL_INTERVAL_MS_V1, type PortalSignalBatchV1, type PortalSignalPointV1 } from '../../../shared/portal-signals-v1';

interface SignalCheckpointStoreV1 { read(): unknown; write(value: unknown): void }
/** Best-effort observations, not a request ledger. A restart can lose the last 30 seconds. */
export class PortalSignalBufferV1 {
  private readonly points = new Map<string, PortalSignalPointV1>();
  private savedAt = -Infinity;
  private attemptedAt = -Infinity;
  private dirty = false;
  constructor(private readonly store: SignalCheckpointStoreV1) {
    const saved = signalCheckpointV1.safeParse(store.read());
    if (saved.success) {
      this.savedAt = saved.data.savedAt;
      for (const point of saved.data.points) this.points.set(signalKeyV1(point), point);
    }
  }
  private prune(now: number): void {
    const floor = Math.floor(now / SIGNAL_INTERVAL_MS_V1) * SIGNAL_INTERVAL_MS_V1;
    for (const [key, point] of this.points) {
      const at = Date.parse(point.bucketAt);
      if (at <= floor - SIGNAL_BUFFER_MS_V1 || at > floor) { this.points.delete(key); this.dirty = true; }
    }
  }
  private checkpoint(now: number): void {
    const last = Math.max(this.savedAt, this.attemptedAt);
    if (!this.dirty || (now >= last && now - last < 30_000)) return;
    this.attemptedAt = now;
    try {
      this.store.write({ version: 1, savedAt: now, points: Array.from(this.points.values()) });
      this.savedAt = now; this.dirty = false;
    } catch { /* Keep a bounded in-memory sample; no write retry storm on storage failure. */ }
  }
  record(input: unknown, now = Date.now()): boolean {
    const parsed = portalSignalInputV1.safeParse(input);
    if (!parsed.success || !Number.isSafeInteger(now) || now < 0) return false;
    this.prune(now);
    const value = parsed.data;
    const bucketAt = new Date(Math.floor(now / SIGNAL_INTERVAL_MS_V1) * SIGNAL_INTERVAL_MS_V1).toISOString();
    const key = signalKeyV1({ bucketAt, ...value });
    let point = this.points.get(key);
    const limit = value.source.startsWith('browser-') ? 60 : 1000;
    if (point && point.samples >= limit) {
      if (!point.capped) { point.capped = true; this.dirty = true; }
      this.checkpoint(now); return false;
    }
    if (!point) {
      point = { bucketAt, source: value.source, outcome: value.outcome, samples: 0,
        totalMs: 0, maxMs: 0, slow: 0, capped: false };
      this.points.set(key, point);
    }
    point.samples++; point.totalMs += value.elapsedMs;
    point.maxMs = Math.max(point.maxMs, value.elapsedMs);
    if (value.elapsedMs >= 3000) point.slow++;
    this.dirty = true; this.checkpoint(now); return true;
  }
  snapshot(now = Date.now()): PortalSignalBatchV1 {
    this.prune(now); this.checkpoint(now);
    return { version: 1, generatedAt: new Date(now).toISOString(),
      points: Array.from(this.points.values(), (point) => ({ ...point })) };
  }
}
