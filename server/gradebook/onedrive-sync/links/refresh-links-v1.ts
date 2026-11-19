import {
  forceXlsbRecalcOnOpenV1,
  forceXlsxRecalcOnOpenV1,
  readXlsbLinkCacheV1,
  readXlsxLinkCacheV1,
  rewriteXlsbLinkCacheV1,
  rewriteXlsxLinkCacheV1,
  type ExternalLinkCacheV1,
} from './external-link-cache-v1';
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
 * Which file a link uses. The Graph ids Excel stores with the link win; otherwise the OneDrive
 * address or the path relative to the destination is turned into a path in the same drive.
 * Anything outside the drive (another person's OneDrive, a local disk) is not followed.
 */
export function resolveLinkSourceV1(
  link: LinkPartV1,
  drive: { readonly driveId: string; readonly webUrl: string },
  destinationFolder: string,
): LinkSourceRefV1 | null {
  if (link.cache.itemId && link.cache.driveId === drive.driveId)
    return { kind: 'item', driveId: drive.driveId, itemId: link.cache.itemId };
  const base = new URL(drive.webUrl.endsWith('/') ? drive.webUrl : `${drive.webUrl}/`);
  for (const raw of link.targets) {
    const path = pathFromAddressV1(raw, base);
    if (path) return { kind: 'path', path };
  }
  for (const raw of link.targets) {
    const path = pathFromRelativeV1(raw, destinationFolder);
    if (path) return { kind: 'path', path };
  }
  return null;
}

export function sourceKeyV1(ref: LinkSourceRefV1): string {
  return ref.kind === 'item' ? `item:${ref.itemId}` : `path:${ref.path.toLowerCase()}`;
}

/**
 * One destination: refresh every link cache it holds from the sources' saved values, exactly as
 * Excel's "update links" with the sources closed, and ask Excel to recalculate when the file is
 * next opened. Cells, formulas, VBA and protection are not touched. Nothing is produced when the
 * cache already matches the sources, so a refresh never writes the same file twice.
 */
export async function refreshDestinationLinksV1(input: {
  readonly bytes: Uint8Array;
  readonly resolve: (link: LinkPartV1) => LinkSourceRefV1 | null;
  /** null: the source cannot be read; 'skip': it did not change, the cache is kept as it is. */
  readonly loadSource: (
    ref: LinkSourceRefV1,
    sheets: readonly string[],
  ) => Promise<SourceValuesV1 | null | 'skip'>;
}): Promise<RefreshOutcomeV1> {
  const { pkg, format, links } = await readDestinationLinksV1(input.bytes);
  if (!format || links.length === 0)
    return { outcome: 'no-links', bytes: null, changedCells: 0, parts: [] };
  const replacements = new Map<string, Uint8Array>();
  const parts: RefreshOutcomeV1['parts'][number][] = [];
  let changedCells = 0;
  for (const link of links) {
    const source = input.resolve(link);
    const sheets = [...new Set(link.cache.cells.map((cell) => cell.sheet))];
    const values = source && sheets.length > 0 ? await input.loadSource(source, sheets) : null;
    if (!source || sheets.length === 0 || values === 'skip' || values === null) {
      const status = unreadStatusV1(source, sheets.length, values);
      parts.push({ part: link.part, source, status, changed: 0 });
      continue;
    }
    const refreshed = await refreshLinkPartV1(pkg, format, link.part, values);
    if (refreshed.bytes) replacements.set(link.part, refreshed.bytes);
    changedCells += refreshed.changed;
    parts.push({ part: link.part, source, status: refreshed.status, changed: refreshed.changed });
  }
  if (replacements.size === 0) return { outcome: 'unchanged', bytes: null, changedCells: 0, parts };
  const recalc = await recalcOnOpenPartV1(pkg, format);
  if (recalc) replacements.set(recalc.name, recalc.bytes);
  return {
    outcome: 'changed',
    bytes: await rewriteZipPackageV1(pkg, replacements),
    changedCells,
    parts,
  };
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
  part: string,
  values: SourceValuesV1,
): Promise<{ status: LinkPartStatusV1; changed: number; bytes: Uint8Array | null }> {
  let missingSheet = false;
  const lookup = (cell: { sheet: string; row: number; col: number }) => {
    const value = values.valueAt(cell.sheet, cell.row, cell.col);
    if (value === undefined) missingSheet = true;
    return value;
  };
  const content = await readZipEntryV1(pkg, part);
  if (!content) return { status: 'same', changed: 0, bytes: null };
  let rewritten: { bytes: Uint8Array; changed: number };
  if (format === 'xlsb' && part.endsWith('.bin'))
    rewritten = rewriteXlsbLinkCacheV1(content, lookup);
  else {
    const xml = rewriteXlsxLinkCacheV1(new TextDecoder().decode(content), lookup);
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
