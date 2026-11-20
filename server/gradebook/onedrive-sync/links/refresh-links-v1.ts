import {
  forceXlsbRecalcOnOpenV1,
  forceXlsxRecalcOnOpenV1,
  readXlsbLinkCacheV1,
  readXlsxLinkCacheV1,
  rewriteXlsbLinkCacheV1,
  rewriteXlsxLinkCacheV1,
  type ExternalLinkCacheV1,
  type ExternalNameV1,
  type LinkAdditionsV1,
  type LinkCellV1,
  type LinkValueV1,
} from './external-link-cache-v1';
import {
  cellKeyV1,
  MAX_COLUMNS_V1,
  readLinkUseV1,
  type CellAreaV1,
  type LinkUseV1,
  type SheetUseV1,
} from './formula-references-v1';
import {
  blockedRecalcReportV1,
  recalculateLinkedCellsV1,
  type RecalcReportV1,
} from './recalc/recalc-v1';
import type { SourceValuesV1 } from './source-values-v1';
import {
  readZipEntryV1,
  readZipPackageV1,
  rewriteZipPackageV1,
  zipEntryNamesV1,
  type ZipPackageV1,
} from './zip-package-v1';

/** Where a link points: the Graph item, or a path inside the same drive. */
export type LinkSourceRefV1 =
  | { readonly kind: 'item'; readonly driveId: string; readonly itemId: string }
  | { readonly kind: 'path'; readonly path: string };

export type LinkPartV1 = {
  readonly part: string;
  readonly cache: ExternalLinkCacheV1;
  readonly targets: readonly string[];
};

export type DestinationLinksV1 = {
  readonly format: 'xlsb' | 'xlsx';
  readonly links: readonly LinkPartV1[];
};

export type LinkPartStatusV1 =
  'updated' | 'same' | 'source-unavailable' | 'sheet-missing' | 'unsupported';

export type RefreshOutcomeV1 = {
  readonly outcome: 'no-links' | 'unchanged' | 'changed';
  /** The new workbook when outcome is changed. */
  readonly bytes: Uint8Array | null;
  readonly changedCells: number;
  readonly parts: readonly {
    readonly part: string;
    readonly source: LinkSourceRefV1 | null;
    readonly status: LinkPartStatusV1;
    readonly changed: number;
  }[];
  /** The recalculation of the cells that depend on the links; null when not asked for. */
  readonly recalc: RecalcReportV1 | null;
};

const LINK_PART_V1 = /^xl\/externalLinks\/externalLink\d+\.(bin|xml)$/u;

function relsTargetsV1(xml: string): string[] {
  return [...xml.matchAll(/<Relationship\b([^>]*)\/?>/gu)]
    .filter((match) => /Type="[^"]*\/externalLinkPath"/u.test(match[1]!))
    .map((match) => /\sTarget="([^"]*)"/u.exec(match[1]!)?.[1] ?? '')
    .filter(Boolean)
    .map((target) => target.replaceAll('&amp;', '&'));
}

function packageFormatV1(names: readonly string[]): 'xlsb' | 'xlsx' | null {
  if (names.includes('xl/workbook.bin')) return 'xlsb';
  if (names.includes('xl/workbook.xml')) return 'xlsx';
  return null;
}

export async function readDestinationLinksV1(bytes: Uint8Array) {
  const pkg = readZipPackageV1(bytes);
  const names = zipEntryNamesV1(pkg);
  const format = packageFormatV1(names);
  if (!format) return { pkg, format: null, links: [] as LinkPartV1[] };
  const links: LinkPartV1[] = [];
  for (const part of names.filter((name) => LINK_PART_V1.test(name))) {
    const content = await readZipEntryV1(pkg, part);
    if (!content) continue;
    const cache = part.endsWith('.bin')
      ? readXlsbLinkCacheV1(content)
      : readXlsxLinkCacheV1(new TextDecoder().decode(content));
    const relsName = part.replace(/^xl\/externalLinks\//u, 'xl/externalLinks/_rels/') + '.rels';
    const rels = await readZipEntryV1(pkg, relsName);
    links.push({ part, cache, targets: rels ? relsTargetsV1(new TextDecoder().decode(rels)) : [] });
  }
  return { pkg, format, links };
}

/** A percent-encoded piece of an address; null when it is malformed. */
function decodedV1(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** "https://host/personal/x/Documents/A/B.xlsb" (or the same without the host) → "A/B.xlsb". */
function pathFromAddressV1(raw: string, base: URL): string | null {
  if (/^https?:\/\//iu.test(raw)) {
    const url = URL.canParse(raw) ? new URL(raw) : null;
    const inside =
      url?.host.toLowerCase() === base.host.toLowerCase() && url.pathname.startsWith(base.pathname);
    return inside ? decodedV1(url.pathname.slice(base.pathname.length)) : null;
  }
  return raw.startsWith(base.pathname) ? decodedV1(raw.slice(base.pathname.length)) : null;
}

/** "../X/Y.xlsb" next to the destination's folder → "A/X/Y.xlsb"; null for anything absolute. */
function pathFromRelativeV1(raw: string, folder: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) return null;
  const decoded = decodedV1(raw);
  if (decoded === null) return null;
  const parts = folder.split('/').filter(Boolean);
  for (const piece of decoded.split(/[\\/]/u)) {
    if (piece === '..') parts.pop();
    else if (piece && piece !== '.') parts.push(piece);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * Which file a link uses, in the order to try: the Graph ids Excel stores with the link, then the
 * OneDrive address, then the path relative to the destination (a source deleted and uploaded again
 * keeps its path but gets a new id). Anything outside the drive is not followed.
 */
export function resolveLinkSourcesV1(
  link: LinkPartV1,
  drive: { readonly driveId: string; readonly webUrl: string },
  destinationFolder: string,
): LinkSourceRefV1[] {
  const candidates: LinkSourceRefV1[] = [];
  if (link.cache.itemId && link.cache.driveId === drive.driveId)
    candidates.push({ kind: 'item', driveId: drive.driveId, itemId: link.cache.itemId });
  const base = new URL(drive.webUrl.endsWith('/') ? drive.webUrl : `${drive.webUrl}/`);
  const paths = [
    ...link.targets.map((raw) => pathFromAddressV1(raw, base)),
    ...link.targets.map((raw) => pathFromRelativeV1(raw, destinationFolder)),
  ].filter((path): path is string => path !== null);
  for (const path of new Set(paths)) candidates.push({ kind: 'path', path });
  return candidates;
}

/** Holes larger than this in one column are left for Excel (a cache spread over the whole sheet). */
const MAX_FILLED_ROWS_V1 = 20_000;

/**
 * Cells inside the area a link already caches (per column, from its first to its last cached row)
 * that the cache does not hold and the source now has: Excel leaves out a referenced cell that was
 * empty when it last updated, so a grade typed there later comes in through these.
 */
export function missingLinkCellsV1(
  cells: readonly LinkCellV1[],
  values: SourceValuesV1,
): LinkAdditionsV1 {
  const columns = new Map<
    string,
    { sheet: string; col: number; rows: Set<number>; first: number; last: number }
  >();
  for (const cell of cells) {
    const key = `${cell.sheet}\u0000${cell.col}`;
    let column = columns.get(key);
    if (!column) {
      column = {
        sheet: cell.sheet,
        col: cell.col,
        rows: new Set(),
        first: cell.row,
        last: cell.row,
      };
      columns.set(key, column);
    }
    column.rows.add(cell.row);
    column.first = Math.min(column.first, cell.row);
    column.last = Math.max(column.last, cell.row);
  }
  const additions = new Map<string, Array<{ row: number; col: number; value: LinkValueV1 }>>();
  for (const { sheet, col, rows, first, last } of columns.values()) {
    if (last - first > MAX_FILLED_ROWS_V1) continue;
    for (let row = first; row <= last; row++) {
      if (rows.has(row)) continue;
      const value = values.valueAt(sheet, row, col);
      if (!value || value.kind === 'blank') continue;
      const list = additions.get(sheet) ?? [];
      list.push({ row, col, value });
      additions.set(sheet, list);
    }
  }
  return additions;
}

/** Areas larger than this are walked through the source's own cells (a whole column, a PROCV). */
const MAX_AREA_CELLS_V1 = 20_000;
/**
 * More new cells than this in one link means something is not as expected: none is added (the
 * cached ones are still refreshed) and the link shows as one without an accessible source.
 */
export const MAX_NEW_CELLS_PER_LINK_V1 = 50_000;

/**
 * What the destination uses of one link: what its formulas point to plus the areas of the source's
 * names they use (the simulados' "SEXTOA" = RELAÇÃO!$J$3:$J$48), which Excel also caches.
 */
export function linkUseWithNamesV1(
  use: ReadonlyMap<string, SheetUseV1> | undefined,
  names: readonly ExternalNameV1[],
): Map<string, SheetUseV1> {
  const merged = new Map<string, SheetUseV1>();
  for (const [sheet, used] of use ?? [])
    merged.set(sheet, { cells: new Set(used.cells), areas: new Map(used.areas) });
  for (const { sheet, area } of names) {
    if (sheet === null || !area) continue;
    let used = merged.get(sheet);
    if (!used) {
      used = { cells: new Set(), areas: new Map() };
      merged.set(sheet, used);
    }
    if (area.r1 === area.r2 && area.c1 === area.c2) used.cells.add(cellKeyV1(area.r1, area.c1));
    else used.areas.set(`${area.r1}:${area.r2}:${area.c1}:${area.c2}`, area);
  }
  return merged;
}

/**
 * Cells the destination's formulas use that the cache does not hold and the source now has: Excel
 * leaves out a used cell that was empty at its last update (a student added at the end of a list,
 * a column of a term not started).
 */
export function usedLinkCellsV1(
  cells: readonly LinkCellV1[],
  use: ReadonlyMap<string, SheetUseV1> | undefined,
  values: SourceValuesV1,
): LinkAdditionsV1 {
  const additions = new Map<string, Array<{ row: number; col: number; value: LinkValueV1 }>>();
  if (!use) return additions;
  const cached = cachedKeysV1(cells);
  for (const [sheet, used] of use) {
    const have = cached.get(sheet) ?? new Set<number>();
    const list: Array<{ row: number; col: number; value: LinkValueV1 }> = [];
    for (const { row, col } of usedPositionsV1(sheet, used, values)) {
      const key = cellKeyV1(row, col);
      if (have.has(key)) continue;
      have.add(key);
      const value = values.valueAt(sheet, row, col);
      if (value && value.kind !== 'blank') list.push({ row, col, value });
    }
    if (list.length > 0) additions.set(sheet, list);
  }
  return additions;
}

/** The cells each sheet's cache holds (row × 16384 + column). */
function cachedKeysV1(cells: readonly LinkCellV1[]): Map<string, Set<number>> {
  const cached = new Map<string, Set<number>>();
  for (const cell of cells) {
    const keys = cached.get(cell.sheet) ?? new Set<number>();
    keys.add(cellKeyV1(cell.row, cell.col));
    cached.set(cell.sheet, keys);
  }
  return cached;
}

/**
 * Every cell one sheet's use points to. Areas with the same columns are joined first (a PROCV
 * filled down gives one area per row, all overlapping), so each cell is visited once; a large one
 * only through the cells the source has.
 */
function* usedPositionsV1(
  sheet: string,
  used: SheetUseV1,
  values: SourceValuesV1,
): Generator<{ row: number; col: number }> {
  for (const key of used.cells)
    yield { row: Math.floor(key / MAX_COLUMNS_V1), col: key % MAX_COLUMNS_V1 };
  for (const area of joinedAreasV1(used.areas.values())) {
    if ((area.r2 - area.r1 + 1) * (area.c2 - area.c1 + 1) > MAX_AREA_CELLS_V1) {
      yield* values.cellsIn(sheet, area);
      continue;
    }
    for (let row = area.r1; row <= area.r2; row++)
      for (let col = area.c1; col <= area.c2; col++) yield { row, col };
  }
}

/** Areas of the same columns whose rows overlap or touch, joined into one (nothing else changes). */
export function joinedAreasV1(areas: Iterable<CellAreaV1>): CellAreaV1[] {
  const byColumns = new Map<string, CellAreaV1[]>();
  for (const area of areas) {
    const key = `${area.c1}:${area.c2}`;
    const list = byColumns.get(key) ?? [];
    list.push(area);
    byColumns.set(key, list);
  }
  const joined: CellAreaV1[] = [];
  for (const list of byColumns.values()) {
    list.sort((a, b) => a.r1 - b.r1);
    let current = { ...list[0]! };
    for (const area of list.slice(1)) {
      if (area.r1 <= current.r2 + 1) current.r2 = Math.max(current.r2, area.r2);
      else {
        joined.push(current);
        current = { ...area };
      }
    }
    joined.push(current);
  }
  return joined;
}

/**
 * Whether what the formulas use explains this link: every formula was read to the end and every
 * cell the cache holds is among the used ones. Otherwise the reading misses something, and the
 * holes of each cached column are filled too (a cell between two used rows is likely used).
 */
export function useCoversCacheV1(
  use: Pick<LinkUseV1, 'complete'> | null,
  cells: readonly LinkCellV1[],
  partUse: ReadonlyMap<string, SheetUseV1>,
): boolean {
  if (!use?.complete) return false;
  return cells.every((cell) => {
    const used = partUse.get(cell.sheet);
    if (!used) return false;
    if (used.cells.has(cellKeyV1(cell.row, cell.col))) return true;
    for (const area of used.areas.values())
      if (cell.row >= area.r1 && cell.row <= area.r2 && cell.col >= area.c1 && cell.col <= area.c2)
        return true;
    return false;
  });
}

function additionCountV1(additions: LinkAdditionsV1): number {
  let count = 0;
  for (const list of additions.values()) count += list.length;
  return count;
}

/** Both kinds of new cells, each cell once (so the limit counts real cells). */
export function mergeAdditionsV1(first: LinkAdditionsV1, second: LinkAdditionsV1): LinkAdditionsV1 {
  const merged = new Map(first);
  for (const [sheet, list] of second) {
    const current = merged.get(sheet) ?? [];
    const have = new Set(current.map((cell) => cellKeyV1(cell.row, cell.col)));
    const extra = list.filter((cell) => !have.has(cellKeyV1(cell.row, cell.col)));
    if (extra.length > 0) merged.set(sheet, [...current, ...extra]);
  }
  return merged;
}

/**
 * One destination: refresh every link cache it holds from the sources' saved values, exactly as
 * Excel's "update links" with the sources closed, and ask Excel to recalculate when the file is
 * next opened. Cells, formulas, VBA and protection are not touched. Nothing is produced when the
 * cache already matches the sources, so a refresh never writes the same file twice.
 */
export async function refreshDestinationLinksV1(input: {
  readonly bytes: Uint8Array;
  /** The places a link may point to, in the order to try (empty: nothing in reach). */
  readonly resolve: (link: LinkPartV1) => readonly LinkSourceRefV1[];
  /** null: the source cannot be read; 'skip': it did not change, the cache is kept as it is. */
  readonly loadSource: (
    candidates: readonly LinkSourceRefV1[],
    sheets: readonly string[],
  ) => Promise<SourceValuesV1 | null | 'skip'>;
  /** Also recalculate the cells that depend on the links (#1541, off unless switched on). */
  readonly recalculate?: boolean;
}): Promise<RefreshOutcomeV1> {
  const { pkg, format, links } = await readDestinationLinksV1(input.bytes);
  if (!format || links.length === 0)
    return { outcome: 'no-links', bytes: null, changedCells: 0, parts: [], recalc: null };
  // What the formulas use: a used cell empty at the last update is not in the cache.
  const use = await readLinkUseV1(
    pkg,
    format,
    new Map(links.map((link) => [link.part, link.cache.sheetNames])),
  ).catch(() => null);
  const replacements = new Map<string, Uint8Array>();
  const parts: RefreshOutcomeV1['parts'][number][] = [];
  let changedCells = 0;
  for (const link of links) {
    const refreshed = await refreshOneLinkV1({ ...input, pkg, format, use }, link);
    if (refreshed.bytes) replacements.set(link.part, refreshed.bytes);
    changedCells += refreshed.part.changed;
    parts.push(refreshed.part);
  }
  if (replacements.size === 0)
    return { outcome: 'unchanged', bytes: null, changedCells: 0, parts, recalc: null };
  const report = input.recalculate
    ? await recalculateCellsV1(pkg, format, links, replacements)
    : null;
  const recalc = await recalcOnOpenPartV1(pkg, format);
  if (recalc) replacements.set(recalc.name, recalc.bytes);
  return {
    outcome: 'changed',
    bytes: await rewriteZipPackageV1(pkg, replacements),
    changedCells,
    parts,
    recalc: report,
  };
}

/**
 * The cells that depend on the refreshed links, recalculated (only .xlsb): their new results go
 * into `replacements` next to the link parts. Any failure leaves the cells as they are (Excel still
 * recalculates them when the file is opened) and is reported, never failing the refresh.
 */
async function recalculateCellsV1(
  pkg: ZipPackageV1,
  format: 'xlsb' | 'xlsx',
  links: readonly LinkPartV1[],
  replacements: Map<string, Uint8Array>,
): Promise<RecalcReportV1> {
  if (format !== 'xlsb') return blockedRecalcReportV1('only .xlsb files are recalculated');
  try {
    const before = new Map(links.map((link) => [link.part, link.cache]));
    const after = new Map(
      links.map((link) => {
        const rewritten = replacements.get(link.part);
        return [link.part, rewritten ? readXlsbLinkCacheV1(rewritten) : link.cache];
      }),
    );
    const result = await recalculateLinkedCellsV1({ pkg, before, after });
    for (const [part, bytes] of result.replacements) replacements.set(part, bytes);
    return result.report;
  } catch {
    return blockedRecalcReportV1('recalculation failed');
  }
}

type LinkRunV1 = Parameters<typeof refreshDestinationLinksV1>[0] & {
  readonly pkg: ZipPackageV1;
  readonly format: 'xlsb' | 'xlsx';
  readonly use: LinkUseV1 | null;
};

/** One link part: read from its source and rewritten; bytes only when a cell changed. */
async function refreshOneLinkV1(
  run: LinkRunV1,
  link: LinkPartV1,
): Promise<{ part: RefreshOutcomeV1['parts'][number]; bytes: Uint8Array | null }> {
  const candidates = run.resolve(link);
  const source = candidates[0] ?? null;
  const partUse = linkUseWithNamesV1(run.use?.byPart.get(link.part), link.cache.names);
  const sheets = [...new Set([...link.cache.cells.map((cell) => cell.sheet), ...partUse.keys()])];
  const values = source && sheets.length > 0 ? await run.loadSource(candidates, sheets) : null;
  if (!source || sheets.length === 0 || values === 'skip' || values === null) {
    const status = unreadStatusV1(source, sheets.length, values);
    return { part: { part: link.part, source, status, changed: 0 }, bytes: null };
  }
  const additions = linkAdditionsV1(run.use, link, partUse, values);
  const refreshed = await refreshLinkPartV1(
    run.pkg,
    run.format,
    link,
    values,
    additions ?? new Map(),
  );
  return {
    part: {
      part: link.part,
      source,
      status: additions ? refreshed.status : 'unsupported',
      changed: refreshed.changed,
    },
    bytes: refreshed.bytes,
  };
}

/**
 * The new cells of one link: the used ones, plus the holes of each column when the formulas do not
 * explain the cache. Null when there are more than MAX_NEW_CELLS_PER_LINK_V1.
 */
function linkAdditionsV1(
  use: LinkUseV1 | null,
  link: LinkPartV1,
  partUse: ReadonlyMap<string, SheetUseV1>,
  values: SourceValuesV1,
): LinkAdditionsV1 | null {
  const used = usedLinkCellsV1(link.cache.cells, partUse, values);
  const found = useCoversCacheV1(use, link.cache.cells, partUse)
    ? used
    : mergeAdditionsV1(used, missingLinkCellsV1(link.cache.cells, values));
  return additionCountV1(found) > MAX_NEW_CELLS_PER_LINK_V1 ? null : found;
}

/** A link not read: no source in reach, or a source that did not change (or a cache without cells). */
function unreadStatusV1(
  source: LinkSourceRefV1 | null,
  sheetCount: number,
  values: SourceValuesV1 | null | 'skip',
): LinkPartStatusV1 {
  if (!source) return 'source-unavailable';
  if (sheetCount === 0 || values === 'skip') return 'same';
  return 'source-unavailable';
}

/** One link part rewritten from the source's values; bytes only when a cell changed. */
async function refreshLinkPartV1(
  pkg: ZipPackageV1,
  format: 'xlsb' | 'xlsx',
  link: LinkPartV1,
  values: SourceValuesV1,
  additions: LinkAdditionsV1,
): Promise<{ status: LinkPartStatusV1; changed: number; bytes: Uint8Array | null }> {
  let missingSheet = false;
  const lookup = (cell: { sheet: string; row: number; col: number }) => {
    const value = values.valueAt(cell.sheet, cell.row, cell.col);
    if (value === undefined) missingSheet = true;
    return value;
  };
  const content = await readZipEntryV1(pkg, link.part);
  if (!content) return { status: 'same', changed: 0, bytes: null };
  let rewritten: { bytes: Uint8Array; changed: number };
  if (format === 'xlsb' && link.part.endsWith('.bin'))
    rewritten = rewriteXlsbLinkCacheV1(content, lookup, additions);
  else {
    const xml = rewriteXlsxLinkCacheV1(new TextDecoder().decode(content), lookup, additions);
    rewritten = { bytes: new TextEncoder().encode(xml.xml), changed: xml.changed };
  }
  let status: LinkPartStatusV1 = rewritten.changed ? 'updated' : 'same';
  if (missingSheet) status = 'sheet-missing';
  return { status, changed: rewritten.changed, bytes: rewritten.changed ? rewritten.bytes : null };
}

/** The workbook part with "recalculate everything when opened" switched on. */
async function recalcOnOpenPartV1(
  pkg: ZipPackageV1,
  format: 'xlsb' | 'xlsx',
): Promise<{ name: string; bytes: Uint8Array } | null> {
  const name = format === 'xlsb' ? 'xl/workbook.bin' : 'xl/workbook.xml';
  const workbook = await readZipEntryV1(pkg, name);
  if (!workbook) return null;
  const bytes =
    format === 'xlsb'
      ? forceXlsbRecalcOnOpenV1(workbook)
      : new TextEncoder().encode(forceXlsxRecalcOnOpenV1(new TextDecoder().decode(workbook)));
  return { name, bytes };
}
