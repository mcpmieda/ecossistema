import { DurableObject } from 'cloudflare:workers';
import type {
  OneDriveSyncActorV1,
  OneDriveSyncCommandV1,
  OneDriveSyncStatusV1,
} from '../../../shared/gradebook-contracts/onedrive-sync/onedrive-sync-contract-v1';
import {
  DRIVE_SUBSCRIPTION_MAX_MINUTES_V1,
  graphCreateDriveSubscriptionV1,
  graphDeleteSubscriptionV1,
  graphDriveDeltaV1,
  graphDriveIdV1,
  graphFolderWorkbooksV1,
  type DriveWorkbookV1,
  type GraphAppEnvV1,
} from './graph-drive-v1';
import type { ProcessWorkbookInputV1 } from './process-workbook-v1';
import {
  DEFAULT_SYNC_SETTINGS_V1,
  expiredLeasesV1,
  filesToStartV1,
  finishReadingV1,
  nextBreakerV1,
  nextWakeV1,
  observeFileV1,
  startReadingV1,
  type ReadResultV1,
  type SyncFileV1,
  type SyncSettingsV1,
} from './sync-rules-v1';

export interface SyncReaderV1 {
  processFile(input: ProcessWorkbookInputV1): Promise<ReadResultV1>;
}

export interface SyncCoordinatorEnvV1 extends GraphAppEnvV1 {
  /** The secretaria's OneDrive site; the folder of each academic year is chosen in the admin panel. */
  NOTAS_SITE_ID: string;
  NOTAS_SYNC_PUBLIC_URL?: string;
  NOTAS_SYNC_CLIENT_STATE?: string;
  NOTAS_MAX_WORKBOOK_BYTES?: string;
  SELF: SyncReaderV1;
}

export type SyncControlV1 = OneDriveSyncCommandV1;

type FolderConfigV1 = OneDriveSyncStatusV1['folders'][number];

export type SyncStatusV1 = OneDriveSyncStatusV1;

const META_DEFAULTS_V1 = { settings: DEFAULT_SYNC_SETTINGS_V1 };
const DELTA_INTERVAL_WITH_WEBHOOK_MS = 60 * 60_000;
const DELTA_INTERVAL_WITHOUT_WEBHOOK_MS = 60_000;
const SUBSCRIPTION_RENEW_BEFORE_MS = 3 * 24 * 60 * 60_000;
const NIGHTLY_UTC_HOUR = 6; // 03:00 in America/Sao_Paulo
const EVENT_LIMIT = 500;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The single coordinator of the sync. State lives in this object's own SQLite storage
 * (operational status only; grades and the Auditoria stay in PostgreSQL). Reads run in
 * separate Worker invocations through `SELF.processFile`, at most `maxParallel` at once.
 */
export class NotasSyncCoordinatorV1 extends DurableObject<SyncCoordinatorEnvV1> {
  constructor(ctx: DurableObjectState, env: SyncCoordinatorEnvV1) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT, detail TEXT NOT NULL)`);
    });
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
    return { ...META_DEFAULTS_V1.settings, ...this.meta<Partial<SyncSettingsV1>>('settings', {}) };
  }

  // ---- RPC ----------------------------------------------------------------------------
  /** A Graph change notification arrived: look at delta right away. */
  async notify(): Promise<void> {
    this.setMeta('deltaRequested', true);
    await this.wakeAt(Date.now());
  }

  /** Called every minute by the cron: safety-net delta, nightly check, webhook renewal. */
  async tick(): Promise<void> {
    if (!this.settings().enabled) return;
    const now = Date.now();
    const webhookActive = this.meta<{ id: string } | null>('subscription', null) !== null;
    const lastDelta = this.meta<number | null>('lastDeltaAt', null);
    const interval = webhookActive ? DELTA_INTERVAL_WITH_WEBHOOK_MS : DELTA_INTERVAL_WITHOUT_WEBHOOK_MS;
    if (lastDelta === null || now - lastDelta >= interval) this.setMeta('deltaRequested', true);
    const today = new Date(now).toISOString().slice(0, 10);
    if (new Date(now).getUTCHours() === NIGHTLY_UTC_HOUR && this.meta<string | null>('nightlyOn', null) !== today) {
      this.setMeta('nightlyRequested', true);
      this.setMeta('nightlyOn', today);
    }
    await this.ensureSubscription(now);
    await this.wakeAt(now);
  }

  async control(command: SyncControlV1, actor: OneDriveSyncActorV1): Promise<SyncStatusV1> {
    const settings = this.settings();
    switch (command.action) {
      case 'set-folder': {
        // One folder per academic year; the year chosen last is the one read.
        const folders = this.meta<Record<string, FolderConfigV1>>('folders', {});
        const current = this.meta<number | null>('activeYear', null);
        const previous = current === null ? null : folders[String(current)] ?? null;
        folders[String(command.year)] = {
          year: command.year, folderId: command.folderId, folderPath: command.folderPath, setBy: actor.name, setAt: Date.now(),
        };
        this.setMeta('folders', folders);
        this.setMeta('activeYear', command.year);
        if (previous?.folderId !== command.folderId) {
          // Another folder: start its status from scratch; grades already written stay as they are.
          this.ctx.storage.sql.exec('DELETE FROM files');
          this.setMeta('location', null);
          this.setMeta('deltaLink', null);
          this.setMeta('deltaRequested', true);
        }
        break;
      }
      case 'enable': this.setMeta('settings', { ...settings, enabled: true }); this.setMeta('deltaRequested', true); break;
      case 'disable': this.setMeta('settings', { ...settings, enabled: false }); break;
      case 'pause': this.setMeta('settings', { ...settings, paused: true }); break;
      case 'resume': this.setMeta('settings', { ...settings, paused: false }); this.setMeta('breakerUntil', null); break;
      case 'set-wait': this.setMeta('settings', { ...settings, waitSeconds: Math.min(Math.max(Math.round(command.seconds), 0), 600) }); break;
      case 'set-parallel': this.setMeta('settings', { ...settings, maxParallel: Math.min(Math.max(Math.round(command.count), 1), 10) }); break;
      case 'read-all': this.setMeta('nightlyRequested', true); break;
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

  status(): SyncStatusV1 {
    const subscription = this.meta<{ id: string; expiresAt: string } | null>('subscription', null);
    return {
      settings: this.settings(),
      activeYear: this.meta<number | null>('activeYear', null),
      folders: Object.values(this.meta<Record<string, FolderConfigV1>>('folders', {})).sort((a, b) => b.year - a.year),
      breakerUntil: this.meta<number | null>('breakerUntil', null),
      webhook: { active: subscription !== null, expiresAt: subscription?.expiresAt ?? null },
      lastDeltaAt: this.meta<number | null>('lastDeltaAt', null),
      files: this.files().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map((file) => ({
        id: file.id, name: file.name, size: file.size, modifiedAt: file.modifiedAt, state: file.state, removed: file.removed,
        lastOutcome: file.lastOutcome, lastCode: file.lastCode, lastReadAt: file.lastReadAt, lastReadMs: file.lastReadMs,
        lastSavedToWrittenMs: file.lastSavedToWrittenMs,
      })),
      events: this.ctx.storage.sql.exec<{ at: number; kind: string; actor: string | null; detail: string }>(
        'SELECT at, kind, actor, detail FROM events ORDER BY id DESC LIMIT 50').toArray(),
    };
  }

  // ---- alarm: the work loop --------------------------------------------------------
  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const file of expiredLeasesV1(this.files(), now)) {
      await this.finish(file.id, file.lease ?? '', { outcome: 'failed', code: 'LEASE-EXPIRED', readHash: null, readMs: 0, savedToWrittenMs: null });
    }
    const breakerUntil = this.meta<number | null>('breakerUntil', null);
    const graphAllowed = now >= this.meta('graphBackoffUntil', 0) && (breakerUntil === null || breakerUntil <= now);
    if (this.settings().enabled) {
      try {
        if (graphAllowed && this.meta('nightlyRequested', false)) await this.fullCheck(now);
        else if (graphAllowed && this.meta('deltaRequested', false)) await this.deltaCheck(now);
      } catch (cause) {
        if (cause instanceof NoFolderConfiguredError) {
          this.setMeta('deltaRequested', false);
          this.setMeta('nightlyRequested', false);
        } else {
          this.event('graph-error', { status: graphStatusV1(cause) });
          this.setMeta('graphBackoffUntil', now + 60_000);
          this.recordFailure(now);
        }
      }
      // The alarm waits for its reads: a read left running after the alarm ends can be lost.
      await this.dispatch(now);
    }
    await this.scheduleNext();
  }

  /** The active year's folder (by its Graph id, so a rename does not break it), or null if none is set. */
  private activeFolder(): FolderConfigV1 | null {
    const year = this.meta<number | null>('activeYear', null);
    return year === null ? null : this.meta<Record<string, FolderConfigV1>>('folders', {})[String(year)] ?? null;
  }

  private async location(): Promise<{ driveId: string; folderId: string }> {
    const folder = this.activeFolder();
    if (!folder) throw new NoFolderConfiguredError();
    const known = this.meta<{ driveId: string; folderId: string } | null>('location', null);
    if (known && known.folderId === folder.folderId) return known;
    const driveId = await graphDriveIdV1(this.env, this.env.NOTAS_SITE_ID);
    this.setMeta('location', { driveId, folderId: folder.folderId });
    this.setMeta('deltaLink', null);
    return { driveId, folderId: folder.folderId };
  }

  private observe(items: readonly DriveWorkbookV1[], now: number): void {
    const settings = this.settings();
    for (const item of items) {
      const next = observeFileV1(this.file(item.id), {
        id: item.id, name: item.name, size: item.size, modifiedAt: item.lastModifiedDateTime, hash: item.quickXorHash, deleted: item.deleted,
      }, now, settings);
      if (next) this.saveFile(next);
    }
  }

  private async deltaCheck(now: number): Promise<void> {
    const { driveId, folderId } = await this.location();
    const delta = await graphDriveDeltaV1(this.env, driveId, this.meta<string | null>('deltaLink', null));
    this.observe(delta.changes.filter((item) => item.parentId === folderId), now);
    this.setMeta('deltaLink', delta.deltaLink);
    this.setMeta('deltaRequested', false);
    this.setMeta('lastDeltaAt', now);
  }

  /** Nightly safety net: the whole folder against what was processed, plus a fresh delta cursor. */
  private async fullCheck(now: number): Promise<void> {
    const { driveId, folderId } = await this.location();
    const listed = await graphFolderWorkbooksV1(this.env, driveId, folderId);
    const present = new Set(listed.map((item) => item.id));
    this.observe(listed, now);
    for (const file of this.files()) {
      if (!present.has(file.id) && !file.removed) this.saveFile({ ...file, removed: true, state: file.state === 'reading' ? 'reading' : 'idle', dueAt: null });
      // Once a day the next read of each file writes everything again (memory forgotten).
      else if (file.memory) this.saveFile({ ...file, memory: null });
    }
    const delta = await graphDriveDeltaV1(this.env, driveId, null);
    this.setMeta('deltaLink', delta.deltaLink);
    this.setMeta('nightlyRequested', false);
    this.setMeta('deltaRequested', false);
    this.setMeta('lastDeltaAt', now);
    this.event('full-check', { files: listed.length });
  }

  /** Starts every read that may start now and waits for them; each finished read starts the next. */
  private async dispatch(now: number): Promise<void> {
    const location = this.meta<{ driveId: string } | null>('location', null);
    if (!location) return;
    const breakerUntil = this.meta<number | null>('breakerUntil', null);
    const maxBytes = Number(this.env.NOTAS_MAX_WORKBOOK_BYTES) || DEFAULT_MAX_BYTES;
    const reads = filesToStartV1(this.files(), now, this.settings(), breakerUntil).map(async (file) => {
      const lease = crypto.randomUUID();
      this.saveFile(startReadingV1(file, lease, now));
      const input: ProcessWorkbookInputV1 = {
        driveId: location.driveId, itemId: file.id, name: file.name, hash: file.hash, modifiedAt: file.modifiedAt, maxBytes,
        expectedYear: this.activeFolder()?.year ?? null, memory: file.memory ?? null,
      };
      const result = await this.env.SELF.processFile(input).catch((cause: unknown): ReadResultV1 => {
        console.error(JSON.stringify({ event: 'notas-sync-reader-unreachable', error: String(cause).slice(0, 300) }));
        return { outcome: 'failed', code: 'READER-UNREACHABLE', readHash: null, readMs: 0, savedToWrittenMs: null };
      });
      await this.finish(file.id, lease, result);
      if (this.settings().enabled) await this.dispatch(Date.now());
    });
    await Promise.all(reads);
  }

  private async finish(id: string, lease: string, result: ReadResultV1): Promise<void> {
    const file = this.file(id);
    if (!file) return;
    const now = Date.now();
    const finished = finishReadingV1(file, lease, result, now);
    if (!finished) return;
    this.saveFile(finished);
    const breaker = nextBreakerV1(this.meta('consecutiveFailures', 0), result.outcome, now);
    this.setMeta('consecutiveFailures', breaker.consecutiveFailures);
    if (breaker.breakerUntil !== null) {
      this.setMeta('breakerUntil', breaker.breakerUntil);
      this.event('breaker-open', { until: breaker.breakerUntil });
    }
    console.log(JSON.stringify({ event: 'notas-sync-read', outcome: result.outcome, code: result.code,
      readMs: Math.round(result.readMs), savedToWrittenMs: result.savedToWrittenMs }));
  }

  private recordFailure(now: number): void {
    const breaker = nextBreakerV1(this.meta('consecutiveFailures', 0), 'failed', now);
    this.setMeta('consecutiveFailures', breaker.consecutiveFailures);
    if (breaker.breakerUntil !== null) this.setMeta('breakerUntil', breaker.breakerUntil);
  }

  private async ensureSubscription(now: number): Promise<void> {
    const current = this.meta<{ id: string; expiresAt: string } | null>('subscription', null);
    if (current && Date.parse(current.expiresAt) - now > SUBSCRIPTION_RENEW_BEFORE_MS) return;
    if (!this.env.NOTAS_SYNC_PUBLIC_URL || !this.env.NOTAS_SYNC_CLIENT_STATE || !this.activeFolder()) return;
    const lastTry = this.meta<number | null>('subscriptionTriedAt', null);
    if (lastTry !== null && now - lastTry < 60 * 60_000) return;
    this.setMeta('subscriptionTriedAt', now);
    try {
      const { driveId } = await this.location();
      const created = await graphCreateDriveSubscriptionV1(this.env, {
        driveId,
        notificationUrl: `${this.env.NOTAS_SYNC_PUBLIC_URL.replace(/\/+$/u, '')}/graph/notificacoes`,
        clientState: this.env.NOTAS_SYNC_CLIENT_STATE,
        expiresAt: new Date(now + (DRIVE_SUBSCRIPTION_MAX_MINUTES_V1 - 60) * 60_000),
      });
      this.setMeta('subscription', { id: created.id, expiresAt: created.expirationDateTime });
      this.event('webhook-subscribed', { expiresAt: created.expirationDateTime });
      if (current) await graphDeleteSubscriptionV1(this.env, current.id).catch(() => undefined);
    } catch (cause) {
      if (current && Date.parse(current.expiresAt) <= now) this.setMeta('subscription', null);
      this.event('webhook-error', { status: graphStatusV1(cause) });
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
    const next = nextWakeV1(this.files(), this.meta<number | null>('breakerUntil', null), now);
    const graphReadyAt = Math.max(now + 5_000, this.meta('graphBackoffUntil', 0), this.meta<number | null>('breakerUntil', null) ?? 0);
    const candidates = [next, pendingWork && this.settings().enabled ? graphReadyAt : null].filter((value): value is number => value !== null);
    if (candidates.length > 0) await this.wakeAt(Math.min(...candidates));
  }
}

/** Nothing to read until an admin chooses the folder of an academic year. */
class NoFolderConfiguredError extends Error {
  constructor() {
    super('No OneDrive folder configured');
  }
}

function graphStatusV1(cause: unknown): number | null {
  return typeof cause === 'object' && cause !== null && 'status' in cause ? Number(cause.status) : null;
}
