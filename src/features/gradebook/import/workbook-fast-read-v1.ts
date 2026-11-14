import type { SheetJs, Workbook, Worksheet } from './spreadsheet-recognizer';

/**
 * Faster, observably equivalent read of a teacher's `.xlsb` for the server-side sync.
 *
 * Decoding formula text is ~80% of the cost of opening a teacher workbook, but the import
 * only asks WHETHER a cell holds a formula (`cell.f` truthiness). This reader opens the file
 * without formula decoding and marks formula cells from a direct scan of each sheet's
 * BIFF12 records, following SheetJS 0.20.3's own rule. Sheets the import never reads
 * (overview `VG`, `RELAÇÃO`, `INICIO`) are not opened; `SheetNames` still lists them, so the
 * recognizer sees the same names. Anything unexpected falls back to the regular full read.
 *
 * The formula text itself is not kept: a marked cell carries `FORMULA_PRESENT_V1`.
 */
export const FORMULA_PRESENT_V1 = '=';

type ZipEntryV1 = { content?: Uint8Array | ArrayLike<number> };
type FastWorkbookV1 = Workbook & {
  bookType?: string;
  files?: Record<string, ZipEntryV1>;
  keys?: string[];
  Workbook?: { Sheets?: Array<{ name?: string; id?: string; strRelID?: string }> };
};

const BRT_ROW_HDR = 0x0000;
const BRT_FMLA_FIRST = 0x0008;
const BRT_FMLA_LAST = 0x000b;
const BRT_ARR_FMLA = 0x01aa;
const BRT_SHR_FMLA = 0x01ab;
const BRT_CELL_RSTRING = 0x003e;
const COLUMNS_PER_ROW = 16_384;

function normalizedSheetNameV1(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/gu, '').toUpperCase().trim();
}

const SKIPPED_AUXILIARY_SHEETS_V1 = new Set(['RELACAO', 'INICIO']);

/** Sheets the teacher import never reads: overview tabs and two auxiliary tabs. */
export function isSheetSkippedByFastReadV1(name: string): boolean {
  if (/VG\s*(D\d+)?$/iu.test(name.trim())) return true;
  return SKIPPED_AUXILIARY_SHEETS_V1.has(normalizedSheetNameV1(name));
}

function isCellRecordV1(type: number): boolean {
  return (type >= 0x0001 && type <= 0x0012) || type === BRT_CELL_RSTRING;
}

/** BrtShort* cells (0x0C–0x12) omit the column: like SheetJS, they sit one past the last. */
function isShortCellRecordV1(type: number): boolean {
  return type >= 0x000c && type <= 0x0012;
}

function readUInt32V1(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error('fast-read-truncated-record');
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) + bytes[offset + 3]! * 0x1000000;
}

/**
 * Keys (row * 16384 + column) of the cells SheetJS marks with `f` in a worksheet part.
 * Mirrors SheetJS 0.20.3 `parse_ws_bin`: a formula record is marked unless it lies inside an
 * array-formula range already seen in the sheet; `BrtArrFmla`/`BrtShrFmla` mark their anchor.
 */
export function scanFormulaCellsV1(bytes: Uint8Array): Set<number> {
  const marked = new Set<number>();
  const arrays: Array<readonly [number, number, number, number]> = [];
  let position = 0;
  let row = -1;
  let column = -1;
  let lastCell = -1;
  while (position < bytes.length) {
    let type = bytes[position++]!;
    if (type & 0x80) type = (type & 0x7f) | ((bytes[position++]! & 0x7f) << 7);
    let size = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = bytes[position++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80 && shift < 28);
    if (position + size > bytes.length) throw new Error('fast-read-truncated-record');
    if (type === BRT_ROW_HDR) {
      row = readUInt32V1(bytes, position);
      column = -1;
    } else if (isCellRecordV1(type)) {
      if (row < 0) throw new Error('fast-read-cell-before-row');
      column = isShortCellRecordV1(type) ? column + 1 : readUInt32V1(bytes, position);
      lastCell = row * COLUMNS_PER_ROW + column;
      const isFormula = type >= BRT_FMLA_FIRST && type <= BRT_FMLA_LAST;
      const insideArray = arrays.some(
        ([firstRow, lastRow, firstColumn, lastColumn]) =>
          row >= firstRow && row <= lastRow && column >= firstColumn && column <= lastColumn,
      );
      if (isFormula && !insideArray) marked.add(lastCell);
    } else if (type === BRT_ARR_FMLA || type === BRT_SHR_FMLA) {
      if (lastCell < 0) throw new Error('fast-read-anchor-without-cell');
      if (type === BRT_ARR_FMLA) {
        arrays.push([
          readUInt32V1(bytes, position),
          readUInt32V1(bytes, position + 4),
          readUInt32V1(bytes, position + 8),
          readUInt32V1(bytes, position + 12),
        ]);
      }
      marked.add(lastCell);
    }
    position += size;
  }
  return marked;
}

function decodeAddressV1(address: string): number | null {
  const match = /^([A-Z]{1,3})(\d+)$/u.exec(address);
  if (!match) return null;
  let column = 0;
  for (const letter of match[1]!) column = column * 26 + (letter.codePointAt(0)! - 64);
  return (Number(match[2]) - 1) * COLUMNS_PER_ROW + (column - 1);
}

function relationshipTargetsV1(xml: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const tag of xml.match(/<Relationship\b[^>]*>/gu) ?? []) {
    const id = /\bId="([^"]+)"/u.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/u.exec(tag)?.[1];
    if (id && target) targets.set(id, target);
  }
  return targets;
}

function zipEntryV1(files: Record<string, ZipEntryV1>, path: string): Uint8Array | null {
  const wanted = path.replace(/^\/+/u, '').toLowerCase();
  for (const [key, entry] of Object.entries(files)) {
    if (key.replace(/^Root Entry\//u, '').replace(/^\/+/u, '').toLowerCase() !== wanted) continue;
    return entry.content ? Uint8Array.from(entry.content) : null;
  }
  return null;
}

function sheetPartPathsV1(workbook: FastWorkbookV1): Map<string, string> | null {
  const files = workbook.files;
  const sheets = workbook.Workbook?.Sheets;
  if (!files || sheets?.length !== workbook.SheetNames.length) return null;
  const rels = zipEntryV1(files, 'xl/_rels/workbook.bin.rels');
  if (!rels) return null;
  const targets = relationshipTargetsV1(new TextDecoder().decode(rels));
  const paths = new Map<string, string>();
  for (const [index, name] of workbook.SheetNames.entries()) {
    const relationId = sheets[index]?.id ?? sheets[index]?.strRelID;
    const target = relationId ? targets.get(relationId) : undefined;
    if (!target) return null;
    paths.set(name, `xl/${target.replace(/^\/?xl\//u, '')}`);
  }
  return paths;
}

function markFormulaCellsV1(workbook: FastWorkbookV1, keep: readonly string[]): boolean {
  const paths = sheetPartPathsV1(workbook);
  if (!paths || !workbook.files) return false;
  for (const name of keep) {
    const sheet: Worksheet | undefined = workbook.Sheets[name];
    const path = paths.get(name);
    const part = path ? zipEntryV1(workbook.files, path) : null;
    if (!sheet || !part) return false;
    const marked = scanFormulaCellsV1(part);
    for (const [address, value] of Object.entries(sheet)) {
      if (address.startsWith('!') || !value || typeof value !== 'object') continue;
      const key = decodeAddressV1(address);
      if (key !== null && marked.has(key)) value.f = FORMULA_PRESENT_V1;
    }
  }
  return true;
}

function fastReadV1(xlsx: SheetJs, data: ArrayBuffer, options: Record<string, unknown>): Workbook | null {
  const names = xlsx.read(data, { type: 'array', bookSheets: true }).SheetNames;
  // The master Relação workbook needs INICIO and its agenda tab: never take the shortcut.
  if (names.some((name) => normalizedSheetNameV1(name).includes('VINCULO AGENDA'))) return null;
  const keep = names.filter((name) => !isSheetSkippedByFastReadV1(name));
  if (keep.length === 0) return null;
  const workbook = xlsx.read(data, {
    ...options,
    cellFormula: false,
    sheets: keep,
    bookFiles: true,
  }) as FastWorkbookV1;
  if (workbook.bookType !== 'xlsb' || !markFormulaCellsV1(workbook, keep)) return null;
  delete workbook.files;
  delete workbook.keys;
  return workbook;
}

/**
 * A SheetJS facade for `readWorkbookData`: reads that ask for formulas take the fast path;
 * every other call, and any failure of the fast path, uses the regular `read`.
 */
export function createFastTeacherSheetJsV1(xlsx: SheetJs): SheetJs {
  const read: SheetJs['read'] = (data, options = {}) => {
    if (options.cellFormula !== true || options.sheets !== undefined) return xlsx.read(data, options);
    try {
      return fastReadV1(xlsx, data, options) ?? xlsx.read(data, options);
    } catch {
      return xlsx.read(data, options);
    }
  };
  return { ...xlsx, read };
}
