/**
 * Pure rules of the Notas OneDrive sync. The coordinator (a Durable Object) stores this state
 * and applies these functions; nothing here touches Graph, the database or the clock.
 *
 * Per file: one read at a time. A save that arrives while the file is being read marks it
 * dirty, and the file is read again right after. A file whose content hash equals the last
 * processed one is skipped without download.
 */
export type SyncFileStateV1 = 'idle' | 'pending' | 'reading';

export type SyncOutcomeV1 =
  | 'applied' // grades written
  | 'no-changes' // read and audited; nothing new to write
  | 'blocked' // audit errors: not written, diagnostics recorded in the Auditoria
  | 'rejected' // the persistence service refused it (conflict, invalid, review)
  | 'unreadable' // not a teacher workbook the import recognizes
  | 'ignored' // a file the sync never writes (e.g. the master Relação)
  | 'too-large'
  | 'failed'; // transient: Graph, network or database

export type SyncFileV1 = {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly hash: string | null;
  readonly processedHash: string | null;
  readonly state: SyncFileStateV1;
  readonly dirty: boolean;
  readonly dueAt: number | null;
  readonly lease: string | null;
  readonly leaseUntil: number | null;
  readonly attempts: number;
  readonly lastOutcome: SyncOutcomeV1 | null;
  readonly lastCode: string | null;
  readonly lastReadAt: number | null;
  readonly lastReadMs: number | null;
  readonly lastSavedToWrittenMs: number | null;
  readonly removed: boolean;
  /** What was last written for this file, so an unchanged part is not written again. */
  readonly memory?: SyncMemoryV1 | null;
  /** The source (folder or workbook) this file was seen through, and that source's academic year. */
  readonly sourceId?: string;
  readonly year?: number;
  /** Read again from scratch when the read in progress ends (the Relação changed meanwhile). */
  readonly forget?: boolean;
};

/**
 * Fingerprints of the last successful write of a file: its Auditoria and each class/subject
 * (plus the request header). Cleared by "ler agora" and by the nightly check (full write).
 */
export type SyncMemoryV1 = {
  readonly audit: string | null;
  readonly offers: Readonly<Record<string, string>>;
};

export type SyncSettingsV1 = {
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly waitSeconds: number;
  readonly maxParallel: number;
};

export const DEFAULT_SYNC_SETTINGS_V1: SyncSettingsV1 = { enabled: false, paused: false, waitSeconds: 0, maxParallel: 6 };
export const SYNC_LEASE_MS_V1 = 3 * 60_000;
export const SYNC_BREAKER_FAILURES_V1 = 5;
export const SYNC_BREAKER_PAUSE_MS_V1 = 15 * 60_000;
const RETRY_DELAYS_MS_V1 = [60_000, 5 * 60_000, 15 * 60_000] as const;

export type ObservedFileV1 = {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly hash: string | null;
  readonly deleted: boolean;
};

export function newSyncFileV1(observed: ObservedFileV1): SyncFileV1 {
  return {
    id: observed.id, name: observed.name, size: observed.size, modifiedAt: observed.modifiedAt, hash: observed.hash,
    processedHash: null, state: 'idle', dirty: false, dueAt: null, lease: null, leaseUntil: null, attempts: 0,
    lastOutcome: null, lastCode: null, lastReadAt: null, lastReadMs: null, lastSavedToWrittenMs: null, removed: false,
  };
}

/**
 * A change seen by delta, the folder listing or the nightly check. Deleting a file never
 * deletes grades: the file is only marked removed.
 */
export function observeFileV1(current: SyncFileV1 | null, observed: ObservedFileV1, now: number,
  settings: SyncSettingsV1): SyncFileV1 | null {
  if (observed.deleted) return current ? { ...current, removed: true, state: current.state === 'reading' ? 'reading' : 'idle', dueAt: null, dirty: false } : null;
  const base = current ?? newSyncFileV1(observed);
  const updated: SyncFileV1 = { ...base, name: observed.name, size: observed.size, modifiedAt: observed.modifiedAt,
    hash: observed.hash, removed: false };
  const unchanged = observed.hash !== null && observed.hash === base.processedHash;
  if (unchanged && base.state !== 'reading') return { ...updated, state: 'idle', dueAt: null };
  if (base.state === 'reading') return { ...updated, dirty: !unchanged || base.dirty };
  const due = now + settings.waitSeconds * 1000;
  // A later save pushes the wait forward: the read happens once the file settles.
  return { ...updated, state: 'pending', dueAt: Math.max(due, base.state === 'pending' ? (base.dueAt ?? due) : due), attempts: 0 };
}

/** Files to start now, oldest due first, within the parallel limit; none while paused or tripped. */
export function filesToStartV1(files: readonly SyncFileV1[], now: number, settings: SyncSettingsV1,
  breakerUntil: number | null): SyncFileV1[] {
  if (!settings.enabled || settings.paused || (breakerUntil !== null && breakerUntil > now)) return [];
  const reading = files.filter((file) => file.state === 'reading' && (file.leaseUntil ?? 0) > now).length;
  const free = Math.max(0, settings.maxParallel - reading);
  return files
    .filter((file) => file.state === 'pending' && !file.removed && (file.dueAt ?? 0) <= now)
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0) || a.id.localeCompare(b.id))
    .slice(0, free);
}

export function startReadingV1(file: SyncFileV1, lease: string, now: number): SyncFileV1 {
  return { ...file, state: 'reading', dirty: false, lease, leaseUntil: now + SYNC_LEASE_MS_V1 };
}

/** A read whose worker never reported back is retried, as a transient failure. */
export function expiredLeasesV1(files: readonly SyncFileV1[], now: number): SyncFileV1[] {
  return files.filter((file) => file.state === 'reading' && (file.leaseUntil ?? 0) <= now);
}

export type ReadResultV1 = {
  readonly outcome: SyncOutcomeV1;
  readonly code: string | null;
  readonly readHash: string | null;
  readonly readMs: number;
  readonly savedToWrittenMs: number | null;
  /** The new memory after this read; absent when the read did not change it. */
  readonly memory?: SyncMemoryV1 | null;
  /** A Relação was written with changes: the year's teacher workbooks are read again. */
  readonly relationChanged?: boolean;
};

/** Applies a finished read. Returns null when the lease is stale (another read owns the file). */
export function finishReadingV1(file: SyncFileV1, lease: string, result: ReadResultV1, now: number): SyncFileV1 | null {
  if (file.state !== 'reading' || file.lease !== lease) return null;
  const transient = result.outcome === 'failed';
  const attempts = transient ? file.attempts + 1 : 0;
  const finished: SyncFileV1 = {
    ...file, lease: null, leaseUntil: null, attempts,
    lastOutcome: result.outcome, lastCode: result.code, lastReadAt: now, lastReadMs: result.readMs,
    lastSavedToWrittenMs: result.savedToWrittenMs ?? file.lastSavedToWrittenMs,
    processedHash: transient ? file.processedHash : (result.readHash ?? file.processedHash),
    memory: file.forget ? null : result.memory === undefined ? (file.memory ?? null) : result.memory,
    ...(file.forget ? { processedHash: null, forget: false } : {}),
  };
  if (file.removed) return { ...finished, state: 'idle', dirty: false, dueAt: null };
  if (file.dirty) return { ...finished, state: 'pending', dirty: false, dueAt: now };
  if (transient) {
    const delay = RETRY_DELAYS_MS_V1[Math.min(attempts - 1, RETRY_DELAYS_MS_V1.length - 1)]!;
    return { ...finished, state: 'pending', dueAt: now + delay };
  }
  return { ...finished, state: 'idle', dirty: false, dueAt: null };
}

/**
 * The Relação changed: a workbook read before it may have left students out, so it is read
 * again, whole (memory forgotten). A read in progress is repeated when it ends.
 */
export function rereadFileV1(file: SyncFileV1, now: number): SyncFileV1 {
  if (file.removed) return file;
  if (file.state === 'reading') return { ...file, dirty: true, forget: true };
  return { ...file, memory: null, processedHash: null, state: 'pending', dueAt: now, attempts: 0 };
}

/** Consecutive transient failures across files trip the breaker for a while. */
export function nextBreakerV1(consecutiveFailures: number, outcome: SyncOutcomeV1, now: number):
  { readonly consecutiveFailures: number; readonly breakerUntil: number | null } {
  if (outcome !== 'failed') return { consecutiveFailures: 0, breakerUntil: null };
  const failures = consecutiveFailures + 1;
  return failures >= SYNC_BREAKER_FAILURES_V1
    ? { consecutiveFailures: 0, breakerUntil: now + SYNC_BREAKER_PAUSE_MS_V1 }
    : { consecutiveFailures: failures, breakerUntil: null };
}

/** The earliest moment the coordinator must wake up again. */
export function nextWakeV1(files: readonly SyncFileV1[], breakerUntil: number | null, now: number): number | null {
  const moments = files.flatMap((file) =>
    file.state === 'pending' && file.dueAt !== null ? [file.dueAt] : file.state === 'reading' && file.leaseUntil !== null ? [file.leaseUntil] : []);
  if (breakerUntil !== null && breakerUntil > now) moments.push(breakerUntil);
  return moments.length === 0 ? null : Math.max(now, Math.min(...moments));
}
