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
  graphWorkbookItemV1,
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
  rereadFileV1,
  startReadingV1,
  type ReadResultV1,
  type SyncFileV1,
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
  const response = await env.SELF.fetch(READER_URL_V1, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
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
const DELTA_INTERVAL_WITH_WEBHOOK_MS = 60 * 60_000;
const DELTA_INTERVAL_WITHOUT_WEBHOOK_MS = 60_000;
const SUBSCRIPTION_RENEW_BEFORE_MS = 3 * 24 * 60 * 60_000;
const NIGHTLY_UTC_HOUR = 6; // 03:00 in America/Sao_Paulo
/** While reads run, the coordinator looks again this often (a Graph notice is picked up at once). */
const LOOP_TICK_MS = 2_000;
/** In school hours the folder is also asked directly this often, without waiting for Microsoft's notice. */
const POLL_MS = 10_000;
/** 06:00 to 23:00 in America/Sao_Paulo (UTC-3). */
const POLL_LOCAL_HOURS: readonly [number, number] = [6, 23];
/** A write turn not given back in this time is taken over (a reader that died mid-write). */
const WRITE_TURN_MAX_MS = 120_000;

function schoolHoursV1(now: number): boolean {
  const hour = (new Date(now).getUTCHours() + 21) % 24;
  return hour >= POLL_LOCAL_HOURS[0] && hour < POLL_LOCAL_HOURS[1];
}

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
  /** One database write at a time: reads run side by side, their writes take turns. */
  private writer: { token: string; since: number } | null = null;
  private readonly writeWaiters: Array<() => void> = [];

  constructor(ctx: DurableObjectState, env: SyncCoordinatorEnvV1) {
    super(ctx, env);
    this.retired = env.NOTAS_SYNC?.idFromName(RETIRED_COORDINATOR_NAME_V1).equals(ctx.id) ?? false;
    void ctx.blockConcurrencyWhile(async () => {
      if (this.retired) {
        await ctx.storage.deleteAlarm();
        await ctx.storage.deleteAll();
        return;
      }
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
  /** A reader asks for the database: it waits for the write in progress, if any. */
  async beginWrite(): Promise<string> {
    while (this.writer && Date.now() - this.writer.since < WRITE_TURN_MAX_MS) {
      await new Promise<void>((resolve) => {
        this.writeWaiters.push(resolve);
        setTimeout(resolve, WRITE_TURN_MAX_MS);
      });
    }
    const token = crypto.randomUUID();
    this.writer = { token, since: Date.now() };
    return token;
  }

  /** The reader is done with the database: the next one in line goes. */
  endWrite(token: string): void {
    if (this.writer?.token === token) this.writer = null;
    this.writeWaiters.shift()?.();
  }

  /** A Graph change notification arrived: look at delta right away. */
  async notify(): Promise<void> {
    this.setMeta('deltaRequested', true);
    await this.wakeAt(Date.now());
  }

  /** Called every minute by the cron: safety-net delta, nightly check, webhook renewal. */
  async tick(): Promise<void> {
    if (this.retired || !this.settings().enabled) return;
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
      // The older panel chose one folder per year; it is now one more source.
      case 'set-folder': this.addSource({ itemId: command.folderId, kind: 'folder', path: command.folderPath, year: command.year }, actor); break;
      case 'add-source': this.addSource({ itemId: command.itemId, kind: command.kind, path: command.path, year: command.year }, actor); break;
      case 'remove-source': {
        const sources = this.sources();
        delete sources[command.itemId];
        this.setMeta('sources', sources);
        this.setMeta('activeYear', latestYearV1(sources));
        // Its files leave the list; grades already written stay as they are.
        for (const file of this.files()) {
          if (file.sourceId === command.itemId && file.state !== 'reading') this.ctx.storage.sql.exec('DELETE FROM files WHERE id = ?', file.id);
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

  /** A folder or one workbook of an academic year; the next check lists it whole. */
  private addSource(source: Pick<SourceV1, 'itemId' | 'kind' | 'path' | 'year'>, actor: OneDriveSyncActorV1): void {
    const sources = this.sources();
    sources[source.itemId] = { ...source, setBy: actor.name, setAt: Date.now() };
    this.setMeta('sources', sources);
    this.setMeta('activeYear', latestYearV1(sources));
    this.setMeta('nightlyRequested', true);
  }

  /** Every source by Graph id. Before sources existed, the active year's folder was the only one read. */
  private sources(): Record<string, SourceV1> {
    const stored = this.meta<Record<string, SourceV1> | null>('sources', null);
    if (stored) return stored;
    const folder = this.activeFolder();
    return folder ? { [folder.folderId]: { itemId: folder.folderId, kind: 'folder', path: folder.folderPath,
      year: folder.year, setBy: folder.setBy, setAt: folder.setAt } } : {};
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
    if (this.retired) return;
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

  /** In school hours the folder is asked every POLL_MS even without a Microsoft notice. */
  private pollDue(now: number): boolean {
    const settings = this.settings();
    if (!settings.enabled || settings.paused || !schoolHoursV1(now)) return false;
    return now - (this.meta<number | null>('lastDeltaAt', null) ?? 0) >= POLL_MS;
  }

  /** Nightly check, a requested delta, or the school-hours poll; Graph errors back off for a minute. */
  private async lookAtOneDrive(now: number): Promise<void> {
    const breakerUntil = this.meta<number | null>('breakerUntil', null);
    const graphAllowed = now >= this.meta('graphBackoffUntil', 0) && (breakerUntil === null || breakerUntil <= now);
    if (!graphAllowed) return;
    try {
      if (this.meta('nightlyRequested', false)) await this.fullCheck(now);
      else if (this.meta('deltaRequested', false) || this.pollDue(now)) await this.deltaCheck(now);
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

  /** Changes of the sources' workbooks (anything else in the drive is ignored), tagged with their year. */
  private observe(items: readonly DriveWorkbookV1[], now: number): void {
    const settings = this.settings();
    const sources = this.sources();
    for (const item of items) {
      const source = sourceOfV1(item, sources);
      const current = this.file(item.id);
      if (!source && !(item.deleted && current)) continue;
      const next = observeFileV1(current, {
        id: item.id, name: item.name, size: item.size, modifiedAt: item.lastModifiedDateTime, hash: item.quickXorHash, deleted: item.deleted,
      }, now, settings);
      const file = next ?? current;
      if (!file) continue;
      const retag = source !== null && (file.sourceId !== source.itemId || file.year !== source.year);
      if (next || retag) this.saveFile(source ? { ...file, sourceId: source.itemId, year: source.year } : file);
    }
  }

  private async deltaCheck(now: number): Promise<void> {
    const driveId = await this.driveId();
    const delta = await graphDriveDeltaV1(this.env, driveId, this.meta<string | null>('deltaLink', null));
    this.observe(delta.changes, now);
    this.setMeta('deltaLink', delta.deltaLink);
    this.setMeta('deltaRequested', false);
    this.setMeta('lastDeltaAt', now);
  }

  /** Nightly safety net: every source against what was processed, plus a fresh delta cursor. */
  private async fullCheck(now: number): Promise<void> {
    const driveId = await this.driveId();
    const listed: DriveWorkbookV1[] = [];
    for (const source of Object.values(this.sources())) {
      if (source.kind === 'folder') listed.push(...await graphFolderWorkbooksV1(this.env, driveId, source.itemId));
      else {
        const workbook = await graphWorkbookItemV1(this.env, driveId, source.itemId);
        if (workbook) listed.push(workbook);
      }
    }
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

  /** Starts every read that may start now; the alarm loop awaits them. */
  private startReads(now: number): void {
    const driveId = this.meta<string | null>('driveId', null) ?? this.meta<{ driveId: string } | null>('location', null)?.driveId ?? null;
    if (!driveId) return;
    const breakerUntil = this.meta<number | null>('breakerUntil', null);
    const maxBytes = Number(this.env.NOTAS_MAX_WORKBOOK_BYTES) || DEFAULT_MAX_BYTES;
    for (const file of filesToStartV1(this.files(), now, this.settings(), breakerUntil)) {
      const lease = crypto.randomUUID();
      this.saveFile(startReadingV1(file, lease, now));
      const input: ProcessWorkbookInputV1 = {
        driveId, itemId: file.id, name: file.name, hash: file.hash, modifiedAt: file.modifiedAt, maxBytes,
        expectedYear: file.year ?? this.activeFolder()?.year ?? null, memory: file.memory ?? null,
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
    const finished = finishReadingV1(file, lease, result, now);
    if (!finished) return;
    this.saveFile(finished);
    if (result.relationChanged) {
      // New students may have been left out of workbooks read before: the year's are read again.
      const others = this.files().filter((other) => other.id !== id && !other.removed && (file.year === undefined || other.year === file.year));
      for (const other of others) this.saveFile(rereadFileV1(other, now));
      this.event('relation-changed', { reread: others.length });
    }
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
    if (!this.env.NOTAS_SYNC_PUBLIC_URL || !this.env.NOTAS_SYNC_CLIENT_STATE || Object.keys(this.sources()).length === 0) return;
    const lastTry = this.meta<number | null>('subscriptionTriedAt', null);
    if (lastTry !== null && now - lastTry < 60 * 60_000) return;
    this.setMeta('subscriptionTriedAt', now);
    try {
      const driveId = await this.driveId();
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
    // Off or paused, waiting files do not wake it (only reads still running do).
    const settings = this.settings();
    const active = settings.enabled && !settings.paused;
    const files = active ? this.files() : this.files().filter((file) => file.state === 'reading');
    const next = nextWakeV1(files, this.meta<number | null>('breakerUntil', null), now);
    const graphReadyAt = Math.max(now + 5_000, this.meta('graphBackoffUntil', 0), this.meta<number | null>('breakerUntil', null) ?? 0);
    const pollAt = active && schoolHoursV1(now)
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

function graphStatusV1(cause: unknown): number | null {
  return typeof cause === 'object' && cause !== null && 'status' in cause ? Number(cause.status) : null;
}
