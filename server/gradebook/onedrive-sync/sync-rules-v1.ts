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
  /** When grades of this file last went into the Banco (absent before 15/11/2026). */
  readonly lastAppliedAt?: number | null;
  /** Read again because the Relação changed, not because the teacher saved: no save-to-write time. */
  readonly rereading?: boolean;
  readonly removed: boolean;
  /** What was last written for this file, so an unchanged part is not written again. */
  readonly memory?: SyncMemoryV1 | null;
  /** The source (folder or workbook) this file was seen through, and that source's academic year. */
  readonly sourceId?: string;
  readonly year?: number;
  /** Read again from scratch when the read in progress ends (the Relação changed meanwhile). */
  readonly forget?: boolean;
  /** What the last read recognised: a teacher grade workbook or the Relação. */
  readonly workbook?: 'notas' | 'relacao';
  /** Students the last read held (name or Relação check), 0 or absent when none. */
  readonly heldStudents?: number;
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

/** Most reads at once. Each read runs in its own Worker invocation; the Banco takes one write at a time. */
export const SYNC_PARALLEL_MAX_V1 = 6;
export const DEFAULT_SYNC_SETTINGS_V1: SyncSettingsV1 = { enabled: false, paused: false, waitSeconds: 0, maxParallel: SYNC_PARALLEL_MAX_V1 };

/**
 * The reads allowed at once, set by the sync itself (owner request of 15/11/2026): a read that shows
 * congestion (the write turn ran out, the database, OneDrive or the reader did not answer in time, a
 * read lost its lease or took over a minute) halves it; a run of clean reads as long as the limit
 * adds one, up to SYNC_PARALLEL_MAX_V1.
 */
export type SyncParallelV1 = { readonly limit: number; readonly clean: number };
export const INITIAL_SYNC_PARALLEL_V1: SyncParallelV1 = { limit: SYNC_PARALLEL_MAX_V1, clean: 0 };
const CONGESTION_CODES_V1: ReadonlySet<string> = new Set([
  'WRITE-QUEUE-DEADLINE', 'DATABASE-UNAVAILABLE', 'DATABASE-WRITE', 'READER-UNREACHABLE', 'LEASE-EXPIRED', 'GRAPH-DOWNLOAD',
]);
const SLOW_READ_MS_V1 = 60_000;

export function nextParallelV1(current: SyncParallelV1, result: Pick<ReadResultV1, 'outcome' | 'code' | 'readMs'>): SyncParallelV1 {
  const limit = Math.min(Math.max(Math.round(current.limit) || 1, 1), SYNC_PARALLEL_MAX_V1);
  const congested = result.outcome === 'failed' || (result.code !== null && CONGESTION_CODES_V1.has(result.code))
    || result.readMs > SLOW_READ_MS_V1;
  if (congested) return { limit: Math.max(1, Math.floor(limit / 2)), clean: 0 };
  if (limit >= SYNC_PARALLEL_MAX_V1) return { limit, clean: 0 };
  const clean = current.clean + 1;
  return clean >= limit ? { limit: limit + 1, clean: 0 } : { limit, clean };
}
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
  // During a read, the hash being read is `base.hash`: a repeated notice of that same save is not a
  // change (issue #1450, 14). Without a hash it is taken as a change.
  if (base.state === 'reading') {
    const sameAsReading = observed.hash !== null && observed.hash === base.hash;
    return { ...updated, dirty: base.dirty || !sameAsReading };
  }
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
  /** What the read recognised, when it got that far. */
  readonly workbook?: 'notas' | 'relacao';
  /** Students held by the Relação checks (rule 14 and students missing from the Relação). */
  readonly heldStudents?: number;
};

/** Applies a finished read. Returns null when the lease is stale (another read owns the file). */
export function finishReadingV1(file: SyncFileV1, lease: string, result: ReadResultV1, now: number,
  waitMs = 0): SyncFileV1 | null {
  if (file.state !== 'reading' || file.lease !== lease) return null;
  const transient = result.outcome === 'failed';
  const attempts = transient ? file.attempts + 1 : 0;
  const memory = result.memory === undefined ? (file.memory ?? null) : result.memory;
  const finished: SyncFileV1 = {
    ...file, lease: null, leaseUntil: null, attempts,
    lastOutcome: result.outcome, lastCode: result.code, lastReadAt: now, lastReadMs: result.readMs,
    // The arrival of grades and its time from the teacher's save go together: both change only
    // when grades went in; a read caused by the Relação has no save to count from.
    ...(result.outcome === 'applied'
      ? { lastAppliedAt: now, lastSavedToWrittenMs: file.rereading ? null : result.savedToWrittenMs }
      : {}),
    // A reread asked during this read (forget) applies to the next one.
    ...(transient ? {} : { rereading: Boolean(file.forget) }),
    processedHash: transient ? file.processedHash : (result.readHash ?? file.processedHash),
    memory: file.forget ? null : memory,
    ...(file.forget ? { processedHash: null, forget: false } : {}),
    ...(result.workbook ? { workbook: result.workbook } : {}),
    ...(result.heldStudents === undefined ? {} : { heldStudents: result.heldStudents }),
  };
  if (file.removed) return { ...finished, state: 'idle', dirty: false, dueAt: null };
  // Saved again while it was read: read again after the same wait as any save (issue #1426, 7).
  if (file.dirty) return { ...finished, state: 'pending', dirty: false, dueAt: now + waitMs };
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
  if (file.state === 'reading') return { ...file, dirty: true, forget: true, rereading: true };
  return { ...file, memory: null, processedHash: null, state: 'pending', dueAt: now, attempts: 0, rereading: true };
}

/**
 * Ties a file to its source and that source's year. A file whose year changed (the source's year
 * was corrected) or that the old reader skipped as "not a teacher's" (the Relação) is read again whole.
 */
export function placeFileV1(file: SyncFileV1, source: { readonly itemId: string; readonly year: number } | null,
  now: number): SyncFileV1 {
  if (!source) return file;
  const yearChanged = file.year !== undefined && file.year !== source.year;
  const kept = yearChanged || file.lastOutcome === 'ignored' ? rereadFileV1(file, now) : file;
  if (kept === file && file.sourceId === source.itemId && file.year === source.year) return file;
  return { ...kept, sourceId: source.itemId, year: source.year };
}

/** One day's school hours as the Portal knows them (calendar and bells), "HH:MM" in local time. */
export type SchoolDayWindowV1 = { readonly schoolDay: boolean; readonly starts: string; readonly ends: string; readonly source: string };

/** When the 10 s poll runs on `day`: from 30 min before the first lesson to 1 h after the last. */
export type PollWindowV1 = {
  readonly day: string; readonly schoolDay: boolean; readonly startsAt: number; readonly endsAt: number;
  readonly source: string; readonly retryAfter: number | null;
};
const POLL_MARGIN_BEFORE_MS_V1 = 30 * 60_000;
const POLL_MARGIN_AFTER_MS_V1 = 60 * 60_000;
const HHMM_V1 = /^([01]\d|2[0-3]):([0-5]\d)$/u;

/** The school's day (America/Bahia, UTC−3, no daylight saving) of an instant. */
export function schoolDayOfV1(now: number): string {
  return new Date(now - 3 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * The poll window of `day` from what the Portal answered; without an answer (Portal unreachable),
 * Monday to Friday 07:00–18:00, asked again within the hour (owner decision, issue #1426, 29).
 */
export function pollWindowV1(day: string, read: SchoolDayWindowV1 | null, now: number): PollWindowV1 {
  const at = (time: string) => Date.parse(`${day}T${HHMM_V1.test(time) ? time : '07:00'}:00-03:00`);
  if (read) {
    const ends = HHMM_V1.test(read.ends) ? read.ends : '18:00';
    return { day, schoolDay: read.schoolDay, startsAt: at(read.starts) - POLL_MARGIN_BEFORE_MS_V1,
      endsAt: at(ends) + POLL_MARGIN_AFTER_MS_V1, source: read.source, retryAfter: null };
  }
  const weekday = new Date(`${day}T12:00:00-03:00`).getUTCDay();
  return { day, schoolDay: weekday >= 1 && weekday <= 5, startsAt: at('07:00') - POLL_MARGIN_BEFORE_MS_V1,
    endsAt: at('18:00') + POLL_MARGIN_AFTER_MS_V1, source: 'weekday-fallback', retryAfter: now + 60 * 60_000 };
}

export function fastPollActiveV1(window: PollWindowV1, now: number): boolean {
  return window.schoolDay && now >= window.startsAt && now < window.endsAt;
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

/** When a file needs the coordinator: its due read, or the end of its read's lease. */
function wakeMomentsV1(file: SyncFileV1): number[] {
  if (file.state === 'pending' && file.dueAt !== null) return [file.dueAt];
  if (file.state === 'reading' && file.leaseUntil !== null) return [file.leaseUntil];
  return [];
}

/** The earliest moment the coordinator must wake up again. */
export function nextWakeV1(files: readonly SyncFileV1[], breakerUntil: number | null, now: number): number | null {
  const moments = files.flatMap(wakeMomentsV1);
  if (breakerUntil !== null && breakerUntil > now) moments.push(breakerUntil);
  return moments.length === 0 ? null : Math.max(now, Math.min(...moments));
}
