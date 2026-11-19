import type { SheetJs } from '../../../../src/features/gradebook/import/spreadsheet-recognizer';
import { WorkbookTooLargeError } from '../graph-drive-v1';
import type { LinkItemV1, ReplaceOutcomeV1 } from './graph-links-v1';
import {
  refreshDestinationLinksV1,
  resolveLinkSourcesV1,
  type LinkSourceRefV1,
} from './refresh-links-v1';
import { readSourceValuesV1, type SourceValuesV1 } from './source-values-v1';

/** What the coordinator asks for one workbook that has links. */
export type LinkRefreshInputV1 = {
  readonly driveId: string;
  /** The drive's web address, to recognise link addresses inside it. */
  readonly driveWebUrl: string;
  readonly itemId: string;
  readonly maxBytes: number;
  /** Graph ids of the sources that changed; null refreshes every link (first time, nightly). */
  readonly onlySources: readonly string[] | null;
  /** The workbook must be unchanged at least this long (a burst of saves still going waits). */
  readonly settleMs: number;
  /** The last try found it open: ask whether it still is before downloading anything. */
  readonly probeLockFirst?: boolean;
};

export type LinkRefreshOutcomeV1 =
  | 'unchanged'
  | 'written'
  | 'no-links'
  | 'locked'
  | 'changed-meanwhile'
  | 'settling'
  | 'too-large'
  | 'gone'
  | 'failed';

export type LinkRefreshResultV1 = {
  readonly outcome: LinkRefreshOutcomeV1;
  readonly code: string | null;
  /** Graph ids of every source the workbook's links use (for the reverse map). */
  readonly sources: readonly string[];
  /** The content hash of each source as seen by this refresh (a later save is a change). */
  readonly sourceHashes: Readonly<Record<string, string | null>>;
  /** Links whose source is outside the drive, missing, too large or unreadable. */
  readonly unavailableLinks: number;
  readonly changedCells: number;
  /** The workbook as seen before writing (name, hash, date). */
  readonly seen: {
    readonly name: string;
    readonly hash: string | null;
    readonly modifiedAt: string;
  } | null;
  /** The workbook after this write: its own save, not a person's. */
  readonly written: { readonly hash: string | null; readonly modifiedAt: string | null } | null;
  readonly ms: number;
};

export type LinkRefreshPortsV1 = {
  readonly xlsx: SheetJs;
  /** Elapsed-time clock (ms) for the duration. */
  readonly now: () => number;
  /** Wall clock (ms since 1970) for the settle check; defaults to Date.now. */
  readonly wallClock?: () => number;
  readonly item: (driveId: string, itemId: string) => Promise<LinkItemV1 | null>;
  readonly itemByPath: (driveId: string, path: string) => Promise<LinkItemV1 | null>;
  readonly download: (driveId: string, itemId: string, maxBytes: number) => Promise<ArrayBuffer>;
  readonly replace: (input: {
    driveId: string;
    itemId: string;
    eTag: string;
    bytes: Uint8Array;
  }) => Promise<ReplaceOutcomeV1>;
  /** Whether someone holds the file open, without writing (an upload session opened and dropped). */
  readonly probeLock?: (input: {
    driveId: string;
    itemId: string;
    eTag: string;
  }) => Promise<'locked' | 'free'>;
};

function statusOfV1(cause: unknown): number | null {
  return typeof cause === 'object' && cause !== null && 'status' in cause
    ? Number(cause.status)
    : null;
}

function codeOfV1(cause: unknown): string {
  if (cause instanceof WorkbookTooLargeError) return 'FILE-TOO-LARGE';
  const status = statusOfV1(cause);
  return status ? `GRAPH-${status}` : 'LINKS-FAILED';
}

/** A source that can never be read as it is (too large, gone); anything else is tried again. */
function permanentSourceErrorV1(cause: unknown): boolean {
  return cause instanceof WorkbookTooLargeError || statusOfV1(cause) === 404;
}

/**
 * The sources of one refresh: found by id or path, read once each, and counted. A source that
 * cannot be read as it is gives null; a passing failure (throttling, a network error) throws, so
 * the refresh fails and the changed sources are kept for the next try.
 */
class SourceLoaderV1 {
  readonly sources = new Set<string>();
  readonly hashes: Record<string, string | null> = {};
  unavailable = 0;
  private readonly loaded = new Map<string, Promise<SourceValuesV1 | null>>();

  constructor(
    private readonly input: LinkRefreshInputV1,
    private readonly ports: LinkRefreshPortsV1,
  ) {}

  private async find(candidates: readonly LinkSourceRefV1[]): Promise<LinkItemV1 | null> {
    for (const ref of candidates) {
      const item =
        ref.kind === 'item'
          ? await this.ports.item(this.input.driveId, ref.itemId)
          : await this.ports.itemByPath(this.input.driveId, ref.path);
      if (item && item.id !== this.input.itemId) return item;
    }
    return null;
  }

  private async read(item: LinkItemV1, sheets: readonly string[]): Promise<SourceValuesV1 | null> {
    let source: ArrayBuffer;
    try {
      source = await this.ports.download(this.input.driveId, item.id, this.input.maxBytes);
    } catch (cause) {
      if (permanentSourceErrorV1(cause)) return null;
      throw cause;
    }
    try {
      return readSourceValuesV1(this.ports.xlsx, source, sheets);
    } catch {
      return null;
    }
  }

  readonly load = async (
    candidates: readonly LinkSourceRefV1[],
    sheets: readonly string[],
  ): Promise<SourceValuesV1 | null | 'skip'> => {
    const item = await this.find(candidates);
    if (item) this.sources.add(item.id);
    if (!item || item.size > this.input.maxBytes) {
      this.unavailable++;
      return null;
    }
    if (this.input.onlySources && !this.input.onlySources.includes(item.id)) return 'skip';
    const key = `${item.id}|${[...sheets].sort((a, b) => a.localeCompare(b)).join('|')}`;
    let values = this.loaded.get(key);
    if (!values) {
      values = this.read(item, sheets);
      this.loaded.set(key, values);
    }
    const read = await values;
    if (!read) {
      this.unavailable++;
      return null;
    }
    // Only a source actually read counts as seen: a later save of it is a change.
    this.hashes[item.id] = item.quickXorHash;
    return read;
  };
}

/** Before downloading: gone, too large, still being saved, or still open since the last try. */
async function blockedBeforeDownloadV1(
  input: LinkRefreshInputV1,
  ports: LinkRefreshPortsV1,
  destination: LinkItemV1,
): Promise<[LinkRefreshOutcomeV1, string | null] | null> {
  if (destination.size > input.maxBytes) return ['too-large', 'FILE-TOO-LARGE'];
  const savedAt = Date.parse(destination.lastModifiedDateTime);
  const wallNow = (ports.wallClock ?? Date.now)();
  if (Number.isFinite(savedAt) && wallNow - savedAt < input.settleMs) return ['settling', null];
  if (!input.probeLockFirst || !ports.probeLock) return null;
  const lock = await ports.probeLock({
    driveId: input.driveId,
    itemId: input.itemId,
    eTag: destination.eTag,
  });
  return lock === 'locked' ? ['locked', 'FILE-OPEN'] : null;
}

/**
 * One workbook with links: refreshed from its sources' saved values and written back only when
 * the cache changed, at the version it was read from and never over an open file.
 */
export async function runLinkRefreshV1(
  input: LinkRefreshInputV1,
  ports: LinkRefreshPortsV1,
): Promise<LinkRefreshResultV1> {
  const started = ports.now();
  const loader = new SourceLoaderV1(input, ports);
  let seen: LinkRefreshResultV1['seen'] = null;
  const result = (
    outcome: LinkRefreshOutcomeV1,
    code: string | null = null,
    extra: Partial<Pick<LinkRefreshResultV1, 'changedCells' | 'written'>> = {},
  ): LinkRefreshResultV1 => ({
    outcome,
    code,
    sources: [...loader.sources].sort((a, b) => a.localeCompare(b)),
    sourceHashes: loader.hashes,
    unavailableLinks: loader.unavailable,
    changedCells: extra.changedCells ?? 0,
    seen,
    written: extra.written ?? null,
    ms: Math.round(ports.now() - started),
  });
  try {
    // The version (eTag) is taken before the download: content newer than it can never be sent
    // back with an older version, and content older than the file is refused by if-match.
    const destination = await ports.item(input.driveId, input.itemId);
    if (!destination) return result('gone');
    seen = {
      name: destination.name,
      hash: destination.quickXorHash,
      modifiedAt: destination.lastModifiedDateTime,
    };
    const blocked = await blockedBeforeDownloadV1(input, ports, destination);
    if (blocked) return result(...blocked);
    const bytes = new Uint8Array(await ports.download(input.driveId, input.itemId, input.maxBytes));
    const drive = { driveId: input.driveId, webUrl: input.driveWebUrl };
    const refreshed = await refreshDestinationLinksV1({
      bytes,
      resolve: (link) => resolveLinkSourcesV1(link, drive, destination.folderPath ?? ''),
      loadSource: loader.load,
    });
    loader.unavailable += refreshed.parts.filter(
      (part) => part.source === null || part.status === 'sheet-missing',
    ).length;
    if (refreshed.outcome === 'no-links') return result('no-links');
    if (refreshed.outcome === 'unchanged' || !refreshed.bytes) return result('unchanged');
    const replaced = await ports.replace({
      driveId: input.driveId,
      itemId: input.itemId,
      eTag: destination.eTag,
      bytes: refreshed.bytes,
    });
    if (replaced.outcome === 'locked') return result('locked', 'FILE-OPEN');
    if (replaced.outcome === 'changed') return result('changed-meanwhile', 'FILE-SAVED-MEANWHILE');
    return result('written', null, {
      changedCells: refreshed.changedCells,
      written: { hash: replaced.quickXorHash, modifiedAt: replaced.lastModifiedDateTime },
    });
  } catch (cause) {
    return result(cause instanceof WorkbookTooLargeError ? 'too-large' : 'failed', codeOfV1(cause));
  }
}
