import type { SheetJs } from '../../../../src/features/gradebook/import/spreadsheet-recognizer';
import { WorkbookTooLargeError } from '../graph-drive-v1';
import type { LinkItemV1, ReplaceOutcomeV1 } from './graph-links-v1';
import {
  refreshDestinationLinksV1,
  resolveLinkSourceV1,
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
};

function codeOfV1(cause: unknown): string {
  if (cause instanceof WorkbookTooLargeError) return 'FILE-TOO-LARGE';
  const status =
    typeof cause === 'object' && cause !== null && 'status' in cause ? Number(cause.status) : null;
  return status ? `GRAPH-${status}` : 'LINKS-FAILED';
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
  const sources = new Set<string>();
  const sourceHashes: Record<string, string | null> = {};
  let unavailableLinks = 0;
  let seen: LinkRefreshResultV1['seen'] = null;
  const result = (
    outcome: LinkRefreshOutcomeV1,
    code: string | null = null,
    extra: Partial<Pick<LinkRefreshResultV1, 'changedCells' | 'written'>> = {},
  ): LinkRefreshResultV1 => ({
    outcome,
    code,
    sources: [...sources].sort((a, b) => a.localeCompare(b)),
    sourceHashes,
    unavailableLinks,
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
    if (destination.size > input.maxBytes) return result('too-large', 'FILE-TOO-LARGE');
    const savedAt = Date.parse(destination.lastModifiedDateTime);
    const wallNow = (ports.wallClock ?? Date.now)();
    if (Number.isFinite(savedAt) && wallNow - savedAt < input.settleMs) return result('settling');
    const bytes = new Uint8Array(await ports.download(input.driveId, input.itemId, input.maxBytes));
    const loaded = new Map<string, Promise<SourceValuesV1 | null | 'skip'>>();
    const loadSource = async (
      ref: LinkSourceRefV1,
      sheets: readonly string[],
    ): Promise<SourceValuesV1 | null | 'skip'> => {
      const item =
        ref.kind === 'item'
          ? await ports.item(input.driveId, ref.itemId)
          : await ports.itemByPath(input.driveId, ref.path);
      if (!item || item.id === input.itemId) {
        unavailableLinks++;
        return null;
      }
      sources.add(item.id);
      sourceHashes[item.id] = item.quickXorHash;
      if (input.onlySources && !input.onlySources.includes(item.id)) return 'skip';
      const key = `${item.id}|${[...sheets].sort((a, b) => a.localeCompare(b)).join('|')}`;
      let values = loaded.get(key);
      if (!values) {
        values = (async () => {
          if (item.size > input.maxBytes) return null;
          const source = await ports.download(input.driveId, item.id, input.maxBytes);
          return readSourceValuesV1(ports.xlsx, source, sheets);
        })().catch(() => null);
        loaded.set(key, values);
      }
      const read = await values;
      if (!read) unavailableLinks++;
      return read;
    };
    const refreshed = await refreshDestinationLinksV1({
      bytes,
      resolve: (link) =>
        resolveLinkSourceV1(
          link,
          { driveId: input.driveId, webUrl: input.driveWebUrl },
          destination.folderPath ?? '',
        ),
      loadSource,
    });
    for (const part of refreshed.parts) if (part.source === null) unavailableLinks++;
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
