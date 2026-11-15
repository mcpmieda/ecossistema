import { DurableObject } from 'cloudflare:workers';
import type {
  OneDriveSyncActorV1,
  OneDriveSyncCommandV1,
  OneDriveSyncStatusV1,
} from '../../../shared/gradebook-contracts/onedrive-sync/onedrive-sync-contract-v1';
import {
  DRIVE_SUBSCRIPTION_MAX_MINUTES_V1,
  DeltaResyncRequiredError,
  graphCreateDriveSubscriptionV1,
  graphDeleteSubscriptionV1,
  graphDriveDeltaV1,
  graphDriveIdV1,
  graphFolderWorkbooksV1,
  graphLatestDeltaLinkV1,
  graphRenewSubscriptionV1,
  graphWorkbookItemV1,
  notificationUrlV1,
  type DriveWorkbookV1,
  type GraphAppEnvV1,
} from './graph-drive-v1';
import { WRITE_QUEUE_DEADLINE_CODE_V1, type ProcessWorkbookInputV1 } from './process-workbook-v1';
import {
  DEFAULT_SYNC_SETTINGS_V1,
  expiredLeasesV1,
  filesToStartV1,
  finishReadingV1,
  INITIAL_SYNC_PARALLEL_V1,
  nextBreakerV1,
  nextParallelV1,
  SYNC_PARALLEL_MAX_V1,
  nextWakeV1,
  editPollUntilV1,
  safetyDeltaIntervalMsV1,
  observeFileV1,
  placeFileV1,
  pollWindowV1,
  schoolDayOfV1,
  rereadFileV1,
  startReadingV1,
  type PollWindowV1,
  type ReadResultV1,
  type SchoolDayWindowV1,
  type SyncFileV1,
  type SyncParallelV1,
  type SyncSettingsV1,
} from './sync-rules-v1';

/**
 * The reader is called as a request (not an RPC method): the Worker's placement next to the
 * database applies only to requests, and RPC calls run where the caller is.
 */
export interface SyncReaderV1 {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

const READER_URL_V1 = 'https://notas-sync-reader.internal/ler';
/** The read through the Worker's public address: only a request gets the region placement. */
export const READ_PATH_V1 = '/ler';
const PUBLIC_READ_TIMEOUT_MS_V1 = 170_000;

type ReadEnvV1 = Pick<SyncCoordinatorEnvV1, 'SELF' | 'NOTAS_SYNC_PUBLIC_URL' | 'NOTAS_SYNC_READ_TOKEN'>;

async function readFileV1(env: ReadEnvV1, input: ProcessWorkbookInputV1,
  publicFetch: typeof fetch = fetch): Promise<ReadResultV1> {
  const body = JSON.stringify(input);
  if (env.NOTAS_SYNC_PUBLIC_URL && env.NOTAS_SYNC_READ_TOKEN) {
    const response = await publicFetch(`${env.NOTAS_SYNC_PUBLIC_URL}${READ_PATH_V1}`, {
      method: 'POST', body, signal: AbortSignal.timeout(PUBLIC_READ_TIMEOUT_MS_V1),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.NOTAS_SYNC_READ_TOKEN}` },
    });
    if (response.ok) return (await response.json()) as ReadResultV1;
    // Refused before reading (route or secret not there yet): read through SELF instead.
    if (![401, 404, 405].includes(response.status)) throw new Error(`notas-sync-reader-http-${response.status}`);
    console.error(JSON.stringify({ event: 'notas-sync-public-read-refused', status: response.status }));
  }
  // Same limit as the public read: a read that never answers must not hold the alarm (issue #1450, 4).
  const response = await env.SELF.fetch(READER_URL_V1, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    signal: AbortSignal.timeout(PUBLIC_READ_TIMEOUT_MS_V1),
  });
  if (!response.ok) throw new Error(`notas-sync-reader-http-${response.status}`);
  return (await response.json()) as ReadResultV1;
}

export const readFileForTestsV1 = readFileV1;

export interface SyncCoordinatorEnvV1 extends GraphAppEnvV1 {
  /** The secretaria's OneDrive site; the folder of each academic year is chosen in the admin panel. */
  NOTAS_SITE_ID: string;
  NOTAS_SYNC_PUBLIC_URL?: string;
  NOTAS_SYNC_CLIENT_STATE?: string;
  /** Secret of `POST /ler` (the read through the public address, next to the database). */
  NOTAS_SYNC_READ_TOKEN?: string;
  NOTAS_MAX_WORKBOOK_BYTES?: string;
  SELF: SyncReaderV1;
  /** The Portal's minute and its school hours (calendar and bells) for the 10 s poll. */
  PORTAL_SCHEDULER?: { pollWindow?(day: string): Promise<SchoolDayWindowV1 | null> };
  /** The deployed version this code belongs to (binding `CF_VERSION_METADATA`). */
  CF_VERSION_METADATA?: CodeVersionV1;
  /** The coordinator namespace, used only to recognise the retired first coordinator. */
  NOTAS_SYNC?: { idFromName(name: string): { equals(other: DurableObjectId): boolean } };
}

/**
 * The first coordinator (created in the United States, far from the database in São Paulo).
 * Replaced by one created in South America; when it wakes it erases itself and does nothing.
 */
export const RETIRED_COORDINATOR_NAME_V1 = 'notas-onedrive-sync';

export type SyncControlV1 = OneDriveSyncCommandV1;

type FolderConfigV1 = OneDriveSyncStatusV1['folders'][number];
type SourceV1 = NonNullable<OneDriveSyncStatusV1['sources']>[number];

export type SyncStatusV1 = OneDriveSyncStatusV1;

const META_DEFAULTS_V1 = { settings: DEFAULT_SYNC_SETTINGS_V1 };
const DELTA_INTERVAL_WITHOUT_WEBHOOK_MS = 60_000;
const SUBSCRIPTION_RENEW_BEFORE_MS = 3 * 24 * 60 * 60_000;
const NIGHTLY_UTC_HOUR = 6; // 03:00 at the school (America/Bahia)
/** While reads run, the coordinator looks again this often (a Graph notice is picked up at once). */
const LOOP_TICK_MS = 2_000;
/**
 * While someone is editing (a source workbook changed in the last 25 min on a school day, 10 min
 * otherwise) the folder is asked this often, without waiting for Microsoft's notice; with nothing
 * changing, only the notice and the safety delta (owner decision 15/11/2026, replaces the fixed
 * school-hours poll of 14/11, issue #1426, 29).
 */
const POLL_MS = 10_000;
/** Graph notices that arrive together wait this long, so they become a single delta. */
const NOTIFY_DEBOUNCE_MS = 5_000;
/** A write turn not given back in this time is taken over (a reader that died mid-write). */
const WRITE_TURN_MAX_MS = 45_000;

const sleepV1 = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const EVENT_LIMIT = 500;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The single coordinator of the sync. State lives in this object's own SQLite storage
 * (operational status only; grades and the Auditoria stay in PostgreSQL). Reads run in
 * separate Worker invocations through the `SELF` reader, at most `maxParallel` at once.
 */
export class NotasSyncCoordinatorV1 extends DurableObject<SyncCoordinatorEnvV1> {
  private readonly retired: boolean;
  /** Reads in flight, each awaited by the alarm that started it (a read left alone can be lost). */
  private readonly inflight = new Set<Promise<void>>();
  /** One database write at a time: reads run side by side, their writes take turns in order. */
  private writer: { token: string; since: number } | null = null;
  private readonly writeQueue: Array<(token: string) => void> = [];

  constructor(ctx: DurableObjectState, env: SyncCoordinatorEnvV1) {
    super(ctx, env);
    this.retired = env.NOTAS_SYNC?.idFromName(RETIRED_COORDINATOR_NAME_V1).equals(ctx.id) ?? false;
    // SQLite in a Durable Object is synchronous: the tables exist before any request runs.
    if (this.retired) return;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT, detail TEXT NOT NULL)`);
  }

  /** The retired first coordinator erases itself when it wakes and does nothing else. */
  private async eraseRetired(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ---- storage helpers -------------------------------------------------------------
  private meta<T>(key: string, fallback: T): T {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  private setMeta(key: string, value: unknown): void {
    this.ctx.storage.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, JSON.stringify(value));
  }
  private files(): SyncFileV1[] {
    return this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM files').toArray().map((row) => JSON.parse(row.data) as SyncFileV1);
  }
  private file(id: string): SyncFileV1 | null {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM files WHERE id = ?', id).toArray()[0];
    return row ? (JSON.parse(row.data) as SyncFileV1) : null;
  }
  private saveFile(file: SyncFileV1): void {
    this.ctx.storage.sql.exec('INSERT INTO files (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      file.id, JSON.stringify(file));
  }
  private event(kind: string, detail: Record<string, unknown> = {}, actor: string | null = null): void {
    this.ctx.storage.sql.exec('INSERT INTO events (at, kind, actor, detail) VALUES (?, ?, ?, ?)',
      Date.now(), kind, actor, JSON.stringify(detail));
    this.ctx.storage.sql.exec('DELETE FROM events WHERE id <= (SELECT max(id) FROM events) - ?', EVENT_LIMIT);
  }
  private settings(): SyncSettingsV1 {
    // The reads at once are no longer a setting: the sync adjusts them (nextParallelV1).
    return { ...META_DEFAULTS_V1.settings, ...this.meta<Partial<SyncSettingsV1>>('settings', {}), maxParallel: this.parallel().limit };
  }
  private parallel(): SyncParallelV1 {
    return this.meta<SyncParallelV1>('parallel', INITIAL_SYNC_PARALLEL_V1);
  }

  // ---- RPC ----------------------------------------------------------------------------
  /**
   * A reader asks for the database and waits its turn, in order. A turn not given back in
   * WRITE_TURN_MAX_MS (a reader that died mid-write) is taken over by the first one waiting
   * (issue #1426, 30: a timed-out wait no longer leaves a ghost in the line).
   */
  async beginWrite(): Promise<string> {
    if (!this.writer || Date.now() - this.writer.since >= WRITE_TURN_MAX_MS) return this.grantWriteV1();
    return new Promise<string>((resolve) => {
      this.writeQueue.push(resolve);
      this.watchWriteTurnV1();
    });
  }

  /** The reader is done: the turn goes straight to the next in line (no one can cut in between). */
  endWrite(token: string): void {
    if (this.writer?.token !== token) return;
    this.writer = null;
    const next = this.writeQueue.shift();
    if (next) next(this.grantWriteV1());
  }

  private grantWriteV1(): string {
    const token = crypto.randomUUID();
    this.writer = { token, since: Date.now() };
    return token;
  }

  /** One timer for the line: when the current turn is overdue, the first in line takes it. */
  private writeWatch: ReturnType<typeof setTimeout> | null = null;
  private watchWriteTurnV1(): void {
    if (this.writeWatch !== null || !this.writer) return;
    const wait = Math.max(0, WRITE_TURN_MAX_MS - (Date.now() - this.writer.since));
    this.writeWatch = setTimeout(() => {
      this.writeWatch = null;
      if (this.writer && Date.now() - this.writer.since < WRITE_TURN_MAX_MS) return this.watchWriteTurnV1();
      const next = this.writeQueue.shift();
      if (next) next(this.grantWriteV1());
      else this.writer = null;
      if (this.writeQueue.length > 0) this.watchWriteTurnV1();
    }, wait);
  }

  /** A Graph change notification arrived: look at delta right away. */
  async notify(): Promise<void> {
    this.setMeta('deltaRequested', true);
    // A burst of notices (one save sends several) becomes one look at OneDrive (issue #1450, 8b).
    await this.wakeAt(Date.now() + (this.inflight.size > 0 ? 0 : NOTIFY_DEBOUNCE_MS));
  }

  /**
   * Called every minute by the cron: safety-net delta, nightly check, webhook renewal. `caller` is
   * the cron's code version: a deploy does not always restart this object, so when the cron already
   * runs newer code and nothing is being read or written here, the object restarts and the next
   * call finds it on the new code.
   */
  async tick(caller?: CodeVersionV1): Promise<void> {
    if (this.retired) return this.eraseRetired();
    if (runsOlderCodeV1(this.env.CF_VERSION_METADATA, caller) && this.inflight.size === 0 && this.writer === null) {
      console.log(JSON.stringify({ event: 'notas-sync-coordinator-restart',
        from: this.env.CF_VERSION_METADATA?.id.slice(0, 8), to: caller?.id.slice(0, 8) }));
      this.ctx.abort('newer-code-deployed');
      return;
    }
    if (!this.settings().enabled) return;
    const now = Date.now();
    const webhookActive = this.meta<{ id: string } | null>('subscription', null) !== null;
    const lastDelta = this.meta<number | null>('lastDeltaAt', null);
    const interval = webhookActive ? safetyDeltaIntervalMsV1(await this.pollWindow(now)) : DELTA_INTERVAL_WITHOUT_WEBHOOK_MS;
    if (lastDelta === null || now - lastDelta >= interval) this.setMeta('deltaRequested', true);
    const today = new Date(now).toISOString().slice(0, 10);
    if (new Date(now).getUTCHours() === NIGHTLY_UTC_HOUR && this.meta<string | null>('nightlyOn', null) !== today) {
      this.setMeta('nightlyRequested', true);
      this.setMeta('nightlyOn', today);
    }
    await this.ensureSubscription(now);
    // Only something due wakes the alarm now; otherwise the next one stays as scheduled (issue #1426, 2).
    if (this.meta('deltaRequested', false) || this.meta('nightlyRequested', false)) await this.wakeAt(now);
    else await this.scheduleNext();
  }

  async control(command: SyncControlV1, actor: OneDriveSyncActorV1): Promise<SyncStatusV1> {
    // State from before sources existed is migrated first (files get their source and year).
    this.sources();
    const settings = this.settings();
    switch (command.action) {
      // The older panel chose one folder per year; it is now one more source.
      case 'set-folder': this.addSource({ itemId: command.folderId, kind: 'folder', path: command.folderPath, year: command.year }, actor); break;
      case 'add-source': this.addSource({ itemId: command.itemId, kind: command.kind, path: command.path, year: command.year }, actor); break;
      case 'remove-source': this.removeSource(command.itemId); break;
      // The cursor kept while off may be too old: start from the current one and list the sources.
      case 'enable': this.setMeta('settings', { ...settings, enabled: true }); this.setMeta('deltaLink', null); this.setMeta('deltaRequested', true); break;
      case 'disable': this.setMeta('settings', { ...settings, enabled: false }); break;
      case 'pause': this.setMeta('settings', { ...settings, paused: true }); break;
      case 'resume': this.setMeta('settings', { ...settings, paused: false }); this.setMeta('breakerUntil', null); break;
      case 'set-wait': this.setMeta('settings', { ...settings, waitSeconds: Math.min(Math.max(Math.round(command.seconds), 0), 600) }); break;
      case 'read-all': {
        // "Conferir tudo agora": every file is read again, whole, even unchanged ones; the result
        // also depends on the Relação and the folder's year (issue #1426, 16).
        const now = Date.now();
        for (const file of this.files()) this.saveFile(rereadFileV1(file, now));
        this.setMeta('nightlyRequested', true);
        break;
      }
      case 'reread-year': this.rereadYear(command.year); break;
      case 'read-now': {
        const file = this.file(command.fileId);
        if (file && file.state !== 'reading') this.saveFile({ ...file, state: 'pending', dueAt: Date.now(), processedHash: null, memory: null });
        break;
      }
    }
    this.event('control', { ...command }, actor.name);
    if (command.action === 'disable') await this.removeSubscription();
    await this.wakeAt(Date.now());
    return this.status();
  }

  /** Its files leave the list (a read in progress ends as removed); grades already written stay. */
  private removeSource(itemId: string): void {
    const sources = this.sources();
    delete sources[itemId];
    this.setMeta('sources', sources);
    this.setMeta('activeYear', latestYearV1(sources));
    for (const file of this.files()) {
      if (file.sourceId !== itemId) continue;
      if (file.state === 'reading') this.saveFile({ ...file, removed: true, dirty: false });
      else this.ctx.storage.sql.exec('DELETE FROM files WHERE id = ?', file.id);
    }
    // A file may still belong to another source (its folder): the full check finds it again.
    this.setMeta('nightlyRequested', true);
  }

  /** A Relação was applied: the year's teacher workbooks are read again, whole. */
  private rereadYear(year: number): void {
    const now = Date.now();
    for (const file of this.files()) {
      if (file.year === year && file.workbook !== 'relacao') this.saveFile(rereadFileV1(file, now));
    }
  }

  /** A folder or one workbook of an academic year; the next check lists it whole. */
  private addSource(source: Pick<SourceV1, 'itemId' | 'kind' | 'path' | 'year'>, actor: OneDriveSyncActorV1): void {
    const sources = this.sources();
    sources[source.itemId] = { ...source, setBy: actor.name, setAt: Date.now() };
    this.setMeta('sources', sources);
    this.setMeta('activeYear', latestYearV1(sources));
    this.setMeta('nightlyRequested', true);
  }

  /**
   * Every source by Graph id. Before sources existed, the active year's folder was the only one
   * read: the first time, it becomes a stored source and the files already known are tied to it.
   */
  private sources(): Record<string, SourceV1> {
    const stored = this.meta<Record<string, SourceV1> | null>('sources', null);
    if (stored) return stored;
    const folder = this.activeFolder();
    const migrated: Record<string, SourceV1> = folder ? { [folder.folderId]: { itemId: folder.folderId, kind: 'folder',
      path: folder.folderPath, year: folder.year, setBy: folder.setBy, setAt: folder.setAt } } : {};
    this.setMeta('sources', migrated);
    if (folder) {
      for (const file of this.files()) {
        if (file.sourceId !== undefined) continue;
        const tied = { ...file, sourceId: folder.folderId, year: file.year ?? folder.year };
        this.saveFile(file.lastOutcome === 'ignored' ? rereadFileV1(tied, Date.now()) : tied);
      }
    }
    return migrated;
  }

  status(): SyncStatusV1 {
    const subscription = this.meta<{ id: string; expiresAt: string } | null>('subscription', null);
    const sources = Object.values(this.sources()).sort((a, b) => b.year - a.year || a.path.localeCompare(b.path, 'pt-BR'));
    return {
      settings: this.settings(),
      activeYear: this.meta<number | null>('activeYear', null),
      folders: sources.filter((source) => source.kind === 'folder').map((source) => ({
        year: source.year, folderId: source.itemId, folderPath: source.path, setBy: source.setBy, setAt: source.setAt })),
      sources,
      codeVersion: this.env.CF_VERSION_METADATA?.id.slice(0, 8) ?? null,
      parallelCeiling: SYNC_PARALLEL_MAX_V1,
      breakerUntil: this.meta<number | null>('breakerUntil', null),
      webhook: { active: subscription !== null, expiresAt: subscription?.expiresAt ?? null },
      lastDeltaAt: this.meta<number | null>('lastDeltaAt', null),
      files: this.files().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map((file) => ({
        id: file.id, name: file.name, size: file.size, modifiedAt: file.modifiedAt, state: file.state, removed: file.removed,
        lastOutcome: file.lastOutcome, lastCode: file.lastCode, lastReadAt: file.lastReadAt, lastReadMs: file.lastReadMs,
        lastSavedToWrittenMs: file.lastSavedToWrittenMs,
        lastAppliedAt: file.lastAppliedAt ?? null,
        ...(file.heldStudents ? { heldStudents: file.heldStudents } : {}),
      })),
      events: this.ctx.storage.sql.exec<{ at: number; kind: string; actor: string | null; detail: string }>(
        'SELECT at, kind, actor, detail FROM events ORDER BY id DESC LIMIT 50').toArray(),
    };
  }

  // ---- alarm: the work loop --------------------------------------------------------
  override async alarm(): Promise<void> {
    if (this.retired) return this.eraseRetired();
    const now = Date.now();
    for (const file of expiredLeasesV1(this.files(), now)) {
      await this.finish(file.id, file.lease ?? '', { outcome: 'failed', code: 'LEASE-EXPIRED', readHash: null, readMs: 0, savedToWrittenMs: null });
    }
    if (this.settings().enabled) {
      await this.lookAtOneDrive(now);
      this.startReads(now);
      // The alarm stays while reads run (a read left alone can be lost) and keeps looking at
      // OneDrive meanwhile, so a workbook saved during a batch does not wait for the batch.
      while (this.inflight.size > 0) {
        await Promise.race([...this.inflight, sleepV1(LOOP_TICK_MS)]);
        if (!this.settings().enabled) continue;
        const at = Date.now();
        await this.lookAtOneDrive(at);
        this.startReads(at);
      }
    }
    await this.scheduleNext();
  }

  /** While someone is editing, the folder is asked every POLL_MS even without a Microsoft notice. */
  private pollDue(now: number): boolean {
    return this.editPolling(now) && now - (this.meta<number | null>('lastDeltaAt', null) ?? 0) >= POLL_MS;
  }

  private editPolling(now: number): boolean {
    const settings = this.settings();
    return settings.enabled && !settings.paused && now < (this.meta<number | null>('editPollUntil', null) ?? 0);
  }

  /** Today's poll window, asked of the Portal once a day (again within the hour if it did not answer). */
  private async pollWindow(now: number): Promise<PollWindowV1> {
    const day = schoolDayOfV1(now);
    const cached = this.meta<PollWindowV1 | null>('pollWindow', null);
    if (cached?.day === day && (cached.retryAfter === null || cached.retryAfter > now)) return cached;
    const read: SchoolDayWindowV1 | null = await Promise.resolve(this.env.PORTAL_SCHEDULER?.pollWindow?.(day))
      .then((answer) => answer ?? null, () => null);
    const window = pollWindowV1(day, read, now);
    this.setMeta('pollWindow', window);
    return window;
  }

  /** Nightly check, a requested delta, or the school-hours poll; Graph errors back off for a minute. */
  private async lookAtOneDrive(now: number): Promise<void> {
    const breakerUntil = this.meta<number | null>('breakerUntil', null);
    const graphAllowed = now >= this.meta('graphBackoffUntil', 0) && (breakerUntil === null || breakerUntil <= now);
    if (!graphAllowed) return;
    try {
      if (this.meta('nightlyRequested', false)) {
        await this.fullCheck(now).catch((cause: unknown) => {
          this.setMeta('nightlyRequested', true);
          throw cause;
        });
      }
      else if (this.meta('deltaRequested', false) || this.pollDue(now)) await this.deltaCheck(now);
    } catch (cause) {
      if (cause instanceof NoFolderConfiguredError) {
        this.setMeta('deltaRequested', false);
        this.setMeta('nightlyRequested', false);
      } else {
        // A listing error only waits (and honours Retry-After); the breaker is for reads that fail.
        this.event('graph-error', { status: graphStatusV1(cause) });
        this.setMeta('graphBackoffUntil', now + Math.max(60, graphRetryAfterSecondsV1(cause)) * 1000);
      }
    }
  }

  /** The folder chosen before sources existed (by its Graph id, so a rename does not break it). */
  private activeFolder(): FolderConfigV1 | null {
    const year = this.meta<number | null>('activeYear', null);
    return year === null ? null : this.meta<Record<string, FolderConfigV1>>('folders', {})[String(year)] ?? null;
  }

  /** The secretaria's drive (every source lives in it); nothing to look at without a source. */
  private async driveId(): Promise<string> {
    if (Object.keys(this.sources()).length === 0) throw new NoFolderConfiguredError();
    const known = this.meta<string | null>('driveId', null) ?? this.meta<{ driveId: string } | null>('location', null)?.driveId ?? null;
    if (known) return known;
    const driveId = await graphDriveIdV1(this.env, this.env.NOTAS_SITE_ID);
    this.setMeta('driveId', driveId);
    return driveId;
  }

  /**
   * Changes of the sources' workbooks (anything else in the drive is ignored), tagged with their year.
   * True when a source workbook was saved since last seen (a new date or new content).
   */
  private observe(items: readonly DriveWorkbookV1[], now: number): boolean {
    const settings = this.settings();
    const sources = this.sources();
    let saved = false;
    for (const item of items) {
      const source = sourceOfV1(item, sources);
      const current = this.file(item.id);
      if (!source && !(item.deleted && current)) continue;
      if (source && !item.deleted && (current?.modifiedAt !== item.lastModifiedDateTime
        || current.hash !== item.quickXorHash)) saved = true;
      const next = observeFileV1(current, {
        id: item.id, name: item.name, size: item.size, modifiedAt: item.lastModifiedDateTime, hash: item.quickXorHash, deleted: item.deleted,
      }, now, settings);
      const file = next ?? current;
      if (!file) continue;
      const placed = placeFileV1(file, source, now);
      if (next || placed !== file) this.saveFile(placed);
    }
    return saved;
  }

  private async deltaCheck(now: number): Promise<void> {
    const driveId = await this.driveId();
    const link = this.meta<string | null>('deltaLink', null);
    // No cursor yet: list the sources and start from the current cursor, never the whole drive.
    if (link === null) {
      await this.resyncSources(now, driveId, false);
      return;
    }
    let delta: Awaited<ReturnType<typeof graphDriveDeltaV1>>;
    try {
      delta = await graphDriveDeltaV1(this.env, driveId, link);
    } catch (cause) {
      if (!(cause instanceof DeltaResyncRequiredError)) throw cause;
      // Graph forgot the cursor (410) or it is too old: list the sources from the current one (issue #1450, 3).
      this.event('delta-resync', {});
      this.setMeta('deltaLink', null);
      await this.resyncSources(now, driveId, false);
      return;
    }
    // A workbook saved opens (or extends) the 10 s poll: the next saves, and Excel Online's content
    // written after the date it reports, arrive without waiting for Microsoft's notice.
    if (this.observe(delta.changes, now)) this.setMeta('editPollUntil', editPollUntilV1(await this.pollWindow(now), now));
    this.setMeta('deltaLink', delta.deltaLink);
    this.setMeta('deltaRequested', false);
    this.setMeta('lastDeltaAt', now);
  }

  /** Nightly safety net: every source against what was processed, plus a fresh delta cursor. */
  private async fullCheck(now: number): Promise<void> {
    // Taken now: a request made while this check awaits Graph (a source added) stays for the next one.
    this.setMeta('nightlyRequested', false);
    const driveId = await this.driveId();
    await this.resyncSources(now, driveId, true);
  }

  /**
   * Every source listed against what is known, from the drive's current cursor (Graph
   * `token=latest`, taken first so nothing saved meanwhile is lost): a few calls instead of
   * enumerating the whole OneDrive (issue #1426, 1). `nightly` also forgets each file's memory.
   */
  private async resyncSources(now: number, driveId: string, nightly: boolean): Promise<void> {
    const deltaLink = await graphLatestDeltaLinkV1(this.env, driveId);
    const listed: DriveWorkbookV1[] = [];
    for (const source of Object.values(this.sources())) listed.push(...await this.listSource(driveId, source));
    const present = new Set(listed.map((item) => item.id));
    this.observe(listed, now);
    for (const file of this.files()) {
      if (!present.has(file.id) && !file.removed) this.saveFile({ ...file, removed: true, state: file.state === 'reading' ? 'reading' : 'idle', dueAt: null });
      // Once a day the next read of each file writes everything again (memory forgotten).
      else if (nightly && file.memory) this.saveFile({ ...file, memory: null });
    }
    this.setMeta('deltaLink', deltaLink);
    this.setMeta('deltaRequested', false);
    this.setMeta('lastDeltaAt', now);
    this.event(nightly ? 'full-check' : 'source-listing', { files: listed.length });
  }

  /** The workbooks of one source; a folder deleted in OneDrive lists none (its files end up removed). */
  private async listSource(driveId: string, source: { kind: string; itemId: string }): Promise<DriveWorkbookV1[]> {
    if (source.kind !== 'folder') {
      const workbook = await graphWorkbookItemV1(this.env, driveId, source.itemId);
      return workbook ? [workbook] : [];
    }
    return graphFolderWorkbooksV1(this.env, driveId, source.itemId).catch((cause: unknown) => {
      if (graphStatusV1(cause) === 404) return [];
      throw cause;
    });
  }

  /** Starts every read that may start now; the alarm loop awaits them. */
  private startReads(now: number): void {
    const driveId = this.meta<string | null>('driveId', null) ?? this.meta<{ driveId: string } | null>('location', null)?.driveId ?? null;
    if (!driveId) return;
    const breakerUntil = this.meta<number | null>('breakerUntil', null);
    const maxBytes = Number(this.env.NOTAS_MAX_WORKBOOK_BYTES) || DEFAULT_MAX_BYTES;
    // Only files of a source still chosen are read.
    const sources = this.sources();
    const files = this.files().filter((file) => file.sourceId !== undefined && sources[file.sourceId] !== undefined);
    for (const file of filesToStartV1(files, now, this.settings(), breakerUntil)) {
      // Larger than allowed by the listing already: no download, no reader (issue #1426, 43).
      if (file.size > maxBytes) {
        this.saveFile({ ...file, state: 'idle', dueAt: null, dirty: false, lastOutcome: 'too-large', lastCode: 'FILE-TOO-LARGE',
          lastReadAt: now, lastReadMs: 0, processedHash: file.hash });
        continue;
      }
      const lease = crypto.randomUUID();
      this.saveFile(startReadingV1(file, lease, now));
      const input: ProcessWorkbookInputV1 = {
        driveId, itemId: file.id, name: file.name, hash: file.hash, modifiedAt: file.modifiedAt, maxBytes,
        expectedYear: file.year ?? this.activeFolder()?.year ?? null, memory: file.memory ?? null,
        // A Relação is written only from a source of its own (issue #1450, 9); the write turn is taken
        // only while there is still time to finish before this read times out (issue #1450, 4).
        sourceKind: file.sourceId === undefined ? null : sources[file.sourceId]?.kind ?? null,
        writeDeadlineAt: now + PUBLIC_READ_TIMEOUT_MS_V1 - WRITE_TURN_MAX_MS,
      };
      const read = readFileV1(this.env, input)
        .catch((cause: unknown): ReadResultV1 => {
          console.error(JSON.stringify({ event: 'notas-sync-reader-unreachable', error: String(cause).slice(0, 300) }));
          return { outcome: 'failed', code: 'READER-UNREACHABLE', readHash: null, readMs: 0, savedToWrittenMs: null };
        })
        .then((result) => this.finish(file.id, lease, result))
        .catch((cause: unknown) => {
          console.error(JSON.stringify({ event: 'notas-sync-finish-failed', error: String(cause).slice(0, 300) }));
        })
        .then(() => { this.inflight.delete(read); });
      this.inflight.add(read);
    }
  }

  private async finish(id: string, lease: string, result: ReadResultV1): Promise<void> {
    const file = this.file(id);
    if (!file) return;
    const now = Date.now();
    const finished = finishReadingV1(file, lease, result, now, this.settings().waitSeconds * 1000);
    if (!finished) return;
    this.saveFile(finished);
    const parallel = this.parallel();
    const nextParallel = nextParallelV1(parallel, result);
    if (nextParallel.limit !== parallel.limit || nextParallel.clean !== parallel.clean) this.setMeta('parallel', nextParallel);
    if (nextParallel.limit !== parallel.limit) this.event('parallel', { from: parallel.limit, to: nextParallel.limit, code: result.code });
    if (result.relationChanged) {
      // New students may have been left out of workbooks read before: the year's are read again.
      const others = this.files().filter((other) => other.id !== id && !other.removed && other.workbook !== 'relacao'
        && (file.year === undefined || other.year === file.year));
      for (const other of others) this.saveFile(rereadFileV1(other, now));
      this.event('relation-changed', { reread: others.length });
    }
    // Waiting too long for the write turn is not a failure of OneDrive or of the database.
    const breaker = result.code === WRITE_QUEUE_DEADLINE_CODE_V1
      ? { consecutiveFailures: this.meta('consecutiveFailures', 0), breakerUntil: null }
      : nextBreakerV1(this.meta('consecutiveFailures', 0), result.outcome, now);
    this.setMeta('consecutiveFailures', breaker.consecutiveFailures);
    if (breaker.breakerUntil !== null) {
      this.setMeta('breakerUntil', breaker.breakerUntil);
      this.event('breaker-open', { until: breaker.breakerUntil });
    }
    console.log(JSON.stringify({ event: 'notas-sync-read', outcome: result.outcome, code: result.code,
      readMs: Math.round(result.readMs), savedToWrittenMs: result.savedToWrittenMs }));
  }

  private async ensureSubscription(now: number): Promise<void> {
    const current = this.meta<{ id: string; expiresAt: string } | null>('subscription', null);
    if (current && Date.parse(current.expiresAt) - now > SUBSCRIPTION_RENEW_BEFORE_MS) return;
    if (!this.env.NOTAS_SYNC_PUBLIC_URL || !this.env.NOTAS_SYNC_CLIENT_STATE || Object.keys(this.sources()).length === 0) return;
    const lastTry = this.meta<number | null>('subscriptionTriedAt', null);
    if (lastTry !== null && now - lastTry < 60 * 60_000) return;
    this.setMeta('subscriptionTriedAt', now);
    const expiresAt = new Date(now + (DRIVE_SUBSCRIPTION_MAX_MINUTES_V1 - 60) * 60_000);
    // Still there: its expiry moves forward (issue #1426, 12d); only a vanished one is created again.
    if (current && Date.parse(current.expiresAt) > now && (await this.renewSubscription(current.id, expiresAt)) !== 'gone') return;
    try {
      const driveId = await this.driveId();
      const created = await graphCreateDriveSubscriptionV1(this.env, {
        driveId,
        notificationUrl: notificationUrlV1(this.env.NOTAS_SYNC_PUBLIC_URL, '/graph/notificacoes'),
        clientState: this.env.NOTAS_SYNC_CLIENT_STATE,
        expiresAt,
      });
      this.setMeta('subscription', { id: created.id, expiresAt: created.expirationDateTime });
      this.event('webhook-subscribed', { expiresAt: created.expirationDateTime });
      if (current) await graphDeleteSubscriptionV1(this.env, current.id).catch(() => undefined);
    } catch (cause) {
      if (current && Date.parse(current.expiresAt) <= now) this.setMeta('subscription', null);
      this.event('webhook-error', { status: graphStatusV1(cause) });
    }
  }

  /** PATCH of the subscription's expiry; 'gone' when Graph no longer knows it (then it is created again). */
  private async renewSubscription(id: string, expiresAt: Date): Promise<'renewed' | 'gone' | 'failed'> {
    try {
      const renewed = await graphRenewSubscriptionV1(this.env, id, expiresAt);
      if (renewed === null) return 'gone';
      this.setMeta('subscription', { id, expiresAt: renewed });
      this.event('webhook-renewed', { expiresAt: renewed });
      return 'renewed';
    } catch (cause) {
      this.event('webhook-error', { status: graphStatusV1(cause) });
      return 'failed';
    }
  }

  private async removeSubscription(): Promise<void> {
    const current = this.meta<{ id: string } | null>('subscription', null);
    if (!current) return;
    await graphDeleteSubscriptionV1(this.env, current.id).catch(() => undefined);
    this.setMeta('subscription', null);
  }

  private async wakeAt(moment: number): Promise<void> {
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > moment) await this.ctx.storage.setAlarm(moment);
  }

  private async scheduleNext(): Promise<void> {
    const now = Date.now();
    const pendingWork = this.meta('deltaRequested', false) || this.meta('nightlyRequested', false);
    // Off or paused, waiting files do not wake it (only reads still running do).
    const settings = this.settings();
    const active = settings.enabled && !settings.paused;
    const files = active ? this.files() : this.files().filter((file) => file.state === 'reading');
    const next = nextWakeV1(files, this.meta<number | null>('breakerUntil', null), now);
    const graphReadyAt = Math.max(now + 5_000, this.meta('graphBackoffUntil', 0), this.meta<number | null>('breakerUntil', null) ?? 0);
    const pollAt = active && this.editPolling(now)
      ? Math.max(now + 1_000, (this.meta<number | null>('lastDeltaAt', null) ?? 0) + POLL_MS) : null;
    const candidates = [next, pendingWork && this.settings().enabled ? graphReadyAt : null, pollAt]
      .filter((value): value is number => value !== null);
    if (candidates.length > 0) await this.wakeAt(Math.min(...candidates));
  }
}

/** The source a workbook belongs to: itself (a single-file source) or its folder; null for anything else. */
export function sourceOfV1(item: Pick<DriveWorkbookV1, 'id' | 'parentId'>, sources: Record<string, SourceV1>): SourceV1 | null {
  const own = sources[item.id];
  if (own?.kind === 'file') return own;
  const folder = item.parentId === null ? undefined : sources[item.parentId];
  return folder?.kind === 'folder' ? folder : null;
}

/** A deployed code version, as the version-metadata binding gives it. */
export type CodeVersionV1 = { readonly id: string; readonly timestamp: string };

/**
 * True only when the caller's code is a later deploy than this object's: during a rollout an
 * older caller never makes a newer object restart (no restart loop).
 */
export function runsOlderCodeV1(own: CodeVersionV1 | undefined, caller: CodeVersionV1 | undefined): boolean {
  if (!own || !caller || own.id === caller.id) return false;
  const ownAt = Date.parse(own.timestamp);
  const callerAt = Date.parse(caller.timestamp);
  return Number.isFinite(ownAt) && Number.isFinite(callerAt) && callerAt > ownAt;
}

function latestYearV1(sources: Record<string, SourceV1>): number | null {
  const years = Object.values(sources).map((source) => source.year);
  return years.length === 0 ? null : Math.max(...years);
}

/** Nothing to read until an admin chooses a source of an academic year. */
class NoFolderConfiguredError extends Error {
  constructor() {
    super('No OneDrive folder configured');
  }
}

function graphRetryAfterSecondsV1(cause: unknown): number {
  const value = typeof cause === 'object' && cause !== null && 'retryAfterSeconds' in cause ? Number(cause.retryAfterSeconds) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function graphStatusV1(cause: unknown): number | null {
  return typeof cause === 'object' && cause !== null && 'status' in cause ? Number(cause.status) : null;
}
