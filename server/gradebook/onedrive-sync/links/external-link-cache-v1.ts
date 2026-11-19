import {
  readBiff12RecordsV1,
  writeBiff12RecordsV1,
  type Biff12RecordV1,
} from './biff12-records-v1';

/**
 * The copy of the source cells that Excel keeps inside a workbook for each external link
 * (xl/externalLinks/externalLinkN.bin or .xml). "Update links" in Excel replaces exactly these
 * values with the ones saved in the source and recalculates; this module reads and rewrites them.
 */
export type LinkValueV1 =
  | { readonly kind: 'blank' }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'error'; readonly code: number };

/** A cached cell: sheet name of the source, zero-based row and column. */
export type LinkCellV1 = {
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
  readonly value: LinkValueV1;
};

/** Zero-based cell area of one source sheet. */
export type LinkAreaV1 = {
  readonly r1: number;
  readonly r2: number;
  readonly c1: number;
  readonly c2: number;
};

/**
 * A name of the source that the destination's formulas use ("=PROCV(x;[2]!SEXTOA;…)"): Excel
 * keeps in the cache the cells of its area that had a value. Sheet and area are null when the
 * link does not say where the name points (not defined, an error, beyond row 65536 in .xlsb).
 */
export type ExternalNameV1 = {
  readonly name: string;
  readonly sheet: string | null;
  readonly area: LinkAreaV1 | null;
};

export type ExternalLinkCacheV1 = {
  readonly sheetNames: readonly string[];
  readonly cells: readonly LinkCellV1[];
  /** Graph ids of the source that Excel stores with the link (newer Excel); null when absent. */
  readonly driveId: string | null;
  readonly itemId: string | null;
  /** The source's names the link lists, with the area each points to. */
  readonly names: readonly ExternalNameV1[];
};

/** What the cache should hold for a cell, or undefined to keep the value it already has. */
export type LinkValueLookupV1 = (cell: LinkCellV1) => LinkValueV1 | undefined;

export const BLANK_V1: LinkValueV1 = { kind: 'blank' };

export function sameLinkValueV1(a: LinkValueV1, b: LinkValueV1): boolean {
  switch (a.kind) {
    case 'blank':
      return b.kind === 'blank';
    case 'number':
      return b.kind === 'number' && a.value === b.value;
    case 'string':
      return b.kind === 'string' && a.value === b.value;
    case 'boolean':
      return b.kind === 'boolean' && a.value === b.value;
    case 'error':
      return b.kind === 'error' && a.code === b.code;
  }
}

/** Excel error codes (BErr) and their text in the XML format. */
const ERROR_TEXT_V1 = new Map<number, string>([
  [0x00, '#NULL!'],
  [0x07, '#DIV/0!'],
  [0x0f, '#VALUE!'],
  [0x17, '#REF!'],
  [0x1d, '#NAME?'],
  [0x24, '#NUM!'],
  [0x2a, '#N/A'],
  [0x2b, '#GETTING_DATA'],
]);
const ERROR_CODE_V1 = new Map([...ERROR_TEXT_V1].map(([code, text]) => [text, code]));

export class UnsupportedLinkValueError extends Error {
  constructor(message: string) {
    super(`External link cache: ${message}`);
  }
}

/* ---------------------------------------------------------------- .xlsb (BIFF12) */

const SUP_TABS_V1 = 0x167;
const TABLE_START_V1 = 0x16b;
const ROW_HEADER_V1 = 0x16e;
const CELL_BLANK_V1 = 0x16f;
const CELL_REAL_V1 = 0x170;
const CELL_BOOL_V1 = 0x171;
const CELL_ERROR_V1 = 0x172;
const CELL_STRING_V1 = 0x173;
/** Future record with the source's alternate URLs, driveId and itemId as wide strings. */
const ALTERNATE_URLS_V1 = 0x13f4;
/** BrtSupNameStart (the name) and BrtSupNameFmla (where it points) of an external name. */
const SUP_NAME_START_V1 = 0x241;
const SUP_NAME_FMLA_V1 = 0x249;
const END_SUP_BOOK_V1 = 0x24c;

const CELL_TYPES_V1 = new Set([
  CELL_BLANK_V1,
  CELL_REAL_V1,
  CELL_BOOL_V1,
  CELL_ERROR_V1,
  CELL_STRING_V1,
]);

function u32(data: Uint8Array, at: number): number {
  if (at + 4 > data.length) throw new UnsupportedLinkValueError('record is too short');
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);
}

function wideStringV1(data: Uint8Array, at: number): { value: string; end: number } {
  const length = u32(data, at);
  // Excel writes an empty text result as the null string (length 0xFFFFFFFF).
  if (length === 0xffffffff) return { value: '', end: at + 4 };
  const end = at + 4 + length * 2;
  if (end > data.length) throw new UnsupportedLinkValueError('string is truncated');
  return { value: new TextDecoder('utf-16le').decode(data.subarray(at + 4, end)), end };
}

function xlsbValueV1(type: number, data: Uint8Array): LinkValueV1 {
  switch (type) {
    case CELL_BLANK_V1:
      return BLANK_V1;
    case CELL_REAL_V1:
      return {
        kind: 'number',
        value: new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(4, true),
      };
    case CELL_BOOL_V1:
      return { kind: 'boolean', value: data[4] !== 0 };
    case CELL_ERROR_V1:
      return { kind: 'error', code: data[4]! };
    default:
      return { kind: 'string', value: wideStringV1(data, 4).value };
  }
}

function xlsbCellRecordV1(col: number, value: LinkValueV1): Biff12RecordV1 {
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, col, true);
  const join = (type: number, tail: Uint8Array): Biff12RecordV1 => {
    const data = new Uint8Array(4 + tail.length);
    data.set(head, 0);
    data.set(tail, 4);
    return { type, data };
  };
  switch (value.kind) {
    case 'blank':
      return { type: CELL_BLANK_V1, data: head };
    case 'number': {
      const tail = new Uint8Array(8);
      new DataView(tail.buffer).setFloat64(0, value.value, true);
      return join(CELL_REAL_V1, tail);
    }
    case 'boolean':
      return join(CELL_BOOL_V1, Uint8Array.of(value.value ? 1 : 0));
    case 'error':
      if (!ERROR_TEXT_V1.has(value.code))
        throw new UnsupportedLinkValueError(`error code ${value.code}`);
      return join(CELL_ERROR_V1, Uint8Array.of(value.code));
    case 'string': {
      if (value.value === '') return join(CELL_STRING_V1, Uint8Array.of(0xff, 0xff, 0xff, 0xff));
      const units = utf16UnitsV1(value.value);
      const tail = new Uint8Array(4 + units.length * 2);
      const dv = new DataView(tail.buffer);
      dv.setUint32(0, units.length, true);
      units.forEach((unit, index) => dv.setUint16(4 + index * 2, unit, true));
      return join(CELL_STRING_V1, tail);
    }
  }
}

/** The UTF-16 code units of a text (what Excel stores), surrogate pairs included. */
function utf16UnitsV1(text: string): number[] {
  const units: number[] = [];
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (point > 0xffff) {
      const offset = point - 0x10000;
      units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
    } else units.push(point);
  }
  return units;
}

const DRIVE_ID_V1 = /b![A-Za-z0-9_-]{20,}/u;
const ITEM_ID_V1 = /\b01[A-Z0-9]{30,40}\b/u;

function idsFromWideTextV1(data: Uint8Array): { driveId: string | null; itemId: string | null } {
  for (const start of [0, 1]) {
    const text = new TextDecoder('utf-16le').decode(
      data.subarray(start, start + ((data.length - start) & ~1)),
    );
    const driveId = DRIVE_ID_V1.exec(text)?.[0] ?? null;
    const itemId = ITEM_ID_V1.exec(text)?.[0] ?? null;
    if (driveId || itemId) return { driveId, itemId };
  }
  return { driveId: null, itemId: null };
}

type XlsbWalkV1 = (
  record: Biff12RecordV1,
  cell: { sheet: string; row: number; col: number } | null,
) => Biff12RecordV1;

type XlsbStateV1 = {
  sheetNames: string[];
  driveId: string | null;
  itemId: string | null;
  table: number | null;
  row: number | null;
  names: { name: string; tab: number | null; area: LinkAreaV1 | null }[];
};

/**
 * Where an external name points (BrtSupNameFmla: cb, then one ExtPtg, MS-XLSB): ExtPtgArea3D
 * (0x3B: iTabFirst, iTabLast, rows and columns of 2 bytes) or ExtPtgRef3D (0x3A: iTabs, row,
 * column) on one sheet. Anything else (an error, a name over several sheets) is unknown.
 */
function externalNameTargetV1(data: Uint8Array): { tab: number; area: LinkAreaV1 } | null {
  if (data.length < 4) return null;
  const size = u32(data, 0);
  if (size === 0 || 4 + size > data.length) return null;
  const view = new DataView(data.buffer, data.byteOffset + 4, size);
  const kind = data[4];
  if ((kind !== 0x3b || size < 13) && (kind !== 0x3a || size < 9)) return null;
  const tab = view.getInt16(1, true);
  if (tab < 0 || view.getInt16(3, true) !== tab) return null;
  const col = (at: number) => view.getUint16(at, true) & 0x3fff;
  if (kind === 0x3a) {
    const row = view.getUint16(5, true);
    return { tab, area: { r1: row, r2: row, c1: col(7), c2: col(7) } };
  }
  return {
    tab,
    area: { r1: view.getUint16(5, true), r2: view.getUint16(7, true), c1: col(9), c2: col(11) },
  };
}

function sheetNamesV1(data: Uint8Array): string[] {
  const names: string[] = [];
  const count = u32(data, 0);
  let at = 4;
  for (let i = 0; i < count; i++) {
    const name = wideStringV1(data, at);
    names.push(name.value);
    at = name.end;
  }
  return names;
}

/** What a record that is not a cell tells about the cells that follow. */
function trackXlsbRecordV1(state: XlsbStateV1, record: Biff12RecordV1): void {
  switch (record.type) {
    case SUP_TABS_V1:
      state.sheetNames.push(...sheetNamesV1(record.data));
      break;
    case ALTERNATE_URLS_V1:
      Object.assign(state, idsFromWideTextV1(record.data));
      break;
    case TABLE_START_V1:
      state.table = u32(record.data, 0);
      state.row = null;
      break;
    case ROW_HEADER_V1:
      state.row = u32(record.data, 0);
      break;
    case SUP_NAME_START_V1:
      state.names.push({ name: wideStringV1(record.data, 0).value, tab: null, area: null });
      break;
    case SUP_NAME_FMLA_V1: {
      const name = state.names.at(-1);
      if (name) Object.assign(name, externalNameTargetV1(record.data) ?? {});
      break;
    }
    default:
      break;
  }
}

function walkXlsbV1(bytes: Uint8Array, visit: XlsbWalkV1) {
  const state: XlsbStateV1 = {
    sheetNames: [],
    driveId: null,
    itemId: null,
    table: null,
    row: null,
    names: [],
  };
  const out: Biff12RecordV1[] = [];
  for (const record of readBiff12RecordsV1(bytes)) {
    if (!CELL_TYPES_V1.has(record.type)) {
      trackXlsbRecordV1(state, record);
      out.push(visit(record, null));
      continue;
    }
    const sheet = state.table === null ? undefined : state.sheetNames[state.table];
    if (sheet === undefined || state.row === null)
      throw new UnsupportedLinkValueError('cell outside a sheet table');
    out.push(visit(record, { sheet, row: state.row, col: u32(record.data, 0) }));
  }
  const names = state.names.map(({ name, tab, area }) => {
    const sheet = tab === null ? undefined : state.sheetNames[tab];
    return sheet === undefined || !area ? { name, sheet: null, area: null } : { name, sheet, area };
  });
  return {
    out,
    sheetNames: state.sheetNames,
    driveId: state.driveId,
    itemId: state.itemId,
    names,
  };
}

export function readXlsbLinkCacheV1(bytes: Uint8Array): ExternalLinkCacheV1 {
  const cells: LinkCellV1[] = [];
  const { sheetNames, driveId, itemId, names } = walkXlsbV1(bytes, (record, cell) => {
    if (cell) cells.push({ ...cell, value: xlsbValueV1(record.type, record.data) });
    return record;
  });
  return { sheetNames, cells, driveId, itemId, names };
}

export function rewriteXlsbLinkCacheV1(
  bytes: Uint8Array,
  lookup: LinkValueLookupV1,
  additions: LinkAdditionsV1 = NO_ADDITIONS_V1,
): { bytes: Uint8Array; changed: number } {
  let changed = 0;
  const { out, sheetNames } = walkXlsbV1(bytes, (record, cell) => {
    if (!cell) return record;
    const current: LinkCellV1 = { ...cell, value: xlsbValueV1(record.type, record.data) };
    const wanted = lookup(current);
    if (!wanted || sameLinkValueV1(wanted, current.value)) return record;
    changed++;
    return xlsbCellRecordV1(cell.col, wanted);
  });
  const inserted = insertXlsbCellsV1(out, sheetNames, additions);
  changed += inserted.added;
  return { bytes: changed ? writeBiff12RecordsV1(inserted.records) : bytes, changed };
}

/**
 * Cells to put in a sheet's table that the cache does not hold yet. Excel leaves out a referenced
 * cell that was empty when it last updated; once the source cell gets a value it must come in.
 */
export type LinkAdditionsV1 = ReadonlyMap<
  string,
  ReadonlyArray<{ readonly row: number; readonly col: number; readonly value: LinkValueV1 }>
>;
const NO_ADDITIONS_V1: LinkAdditionsV1 = new Map();

const TABLE_END_V1 = 0x16c;

function rowHeaderRecordV1(row: number): Biff12RecordV1 {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, row, true);
  return { type: ROW_HEADER_V1, data };
}

/** A sheet table (row headers and cells only) with new cells, rows and columns in order; null otherwise. */
function rebuildXlsbTableV1(
  body: readonly Biff12RecordV1[],
  additions: NonNullable<ReturnType<LinkAdditionsV1['get']>>,
): { records: Biff12RecordV1[]; added: number } | null {
  const rows = new Map<number, { header: Biff12RecordV1; cells: Map<number, Biff12RecordV1> }>();
  let row: { header: Biff12RecordV1; cells: Map<number, Biff12RecordV1> } | undefined;
  for (const record of body) {
    if (record.type === ROW_HEADER_V1) {
      row = { header: record, cells: new Map() };
      rows.set(u32(record.data, 0), row);
    } else if (CELL_TYPES_V1.has(record.type) && row) row.cells.set(u32(record.data, 0), record);
    else return null;
  }
  let added = 0;
  for (const cell of additions) {
    let target = rows.get(cell.row);
    if (!target) {
      target = { header: rowHeaderRecordV1(cell.row), cells: new Map() };
      rows.set(cell.row, target);
    }
    if (target.cells.has(cell.col)) continue;
    target.cells.set(cell.col, xlsbCellRecordV1(cell.col, cell.value));
    added++;
  }
  const records = [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, item]) => [
      item.header,
      ...[...item.cells.entries()].sort(([a], [b]) => a - b).map(([, record]) => record),
    ]);
  return { records, added };
}

function insertXlsbCellsV1(
  records: readonly Biff12RecordV1[],
  sheetNames: readonly string[],
  additions: LinkAdditionsV1,
): { records: readonly Biff12RecordV1[]; added: number } {
  if (additions.size === 0) return { records, added: 0 };
  const out: Biff12RecordV1[] = [];
  const tables = new Set<number>();
  let added = 0;
  let index = 0;
  while (index < records.length) {
    const record = records[index]!;
    out.push(record);
    index++;
    if (record.type !== TABLE_START_V1) continue;
    const tab = u32(record.data, 0);
    tables.add(tab);
    const start = index;
    const end = records.findIndex((item, at) => at >= start && item.type === TABLE_END_V1);
    const sheet = sheetNames[tab];
    const wanted = sheet === undefined ? undefined : additions.get(sheet);
    if (end < 0 || !wanted?.length) continue;
    const rebuilt = rebuildXlsbTableV1(records.slice(start, end), wanted);
    if (!rebuilt) continue;
    out.push(...rebuilt.records);
    added += rebuilt.added;
    // The table end is pushed by the next turn of the loop.
    index = end;
  }
  added += addXlsbTablesV1(out, sheetNames, additions, tables);
  return { records: out, added };
}

/**
 * A sheet with new cells and no table yet (Excel writes one per sheet, but a cache may lack it):
 * BrtExternTableStart (iTab, flags 0), its rows and cells and BrtExternTableEnd, in sheet order,
 * before the next sheet's table or the end of the link. Nothing when there is no such place.
 */
function addXlsbTablesV1(
  out: Biff12RecordV1[],
  sheetNames: readonly string[],
  additions: LinkAdditionsV1,
  tables: ReadonlySet<number>,
): number {
  let added = 0;
  sheetNames.forEach((sheet, tab) => {
    const wanted = additions.get(sheet);
    if (tables.has(tab) || !wanted?.length) return;
    let at = out.findIndex((record) => record.type === TABLE_START_V1 && u32(record.data, 0) > tab);
    if (at < 0) at = out.findIndex((record) => record.type === END_SUP_BOOK_V1);
    if (at < 0) return;
    const rebuilt = rebuildXlsbTableV1([], wanted)!;
    const head = new Uint8Array(5);
    new DataView(head.buffer).setUint32(0, tab, true);
    out.splice(at, 0, { type: TABLE_START_V1, data: head }, ...rebuilt.records, {
      type: TABLE_END_V1,
      data: new Uint8Array(0),
    });
    added += rebuilt.added;
  });
  return added;
}

/* ---------------------------------------------------------------- .xlsx/.xlsm (XML) */

function decodeXmlV1(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/gu, (entity, body: string) => {
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    const code = body.startsWith('#x')
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
  });
}

const XML_ESCAPES_V1: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function encodeXmlV1(text: string): string {
  return text.replace(/[&<>"]/gu, (char) => XML_ESCAPES_V1[char] ?? char);
}

/** Excel writes control characters in XML text as _xHHHH_ (and a literal "_x" escape as _x005F_). */
function unescapeExcelTextV1(text: string): string {
  return text.replace(/_x([0-9A-Fa-f]{4})_/gu, (_whole, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

/** Characters XML text cannot carry as they are (a carriage return would come back as a line feed). */
function needsExcelEscapeV1(code: number): boolean {
  return (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0xfffe || code === 0xffff;
}

function escapeExcelTextV1(text: string): string {
  let out = '';
  for (const char of text.replaceAll(/_x(?=[0-9A-Fa-f]{4}_)/gu, '_x005F_x')) {
    const code = char.codePointAt(0)!;
    out += needsExcelEscapeV1(code)
      ? `_x${code.toString(16).toUpperCase().padStart(4, '0')}_`
      : char;
  }
  return out;
}

function attributeV1(tag: string, name: string): string | null {
  const match = new RegExp(String.raw`\s${name}="([^"]*)"`, 'u').exec(tag);
  return match ? decodeXmlV1(match[1]!) : null;
}

/** "AB12" → zero-based column 27, row 11. */
export function parseA1V1(ref: string): { row: number; col: number } {
  const match = /^([A-Z]{1,3})(\d+)$/u.exec(ref);
  if (!match) throw new UnsupportedLinkValueError(`cell reference ${ref}`);
  let col = 0;
  for (const char of match[1]!) col = col * 26 + (char.codePointAt(0)! - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}

const CELL_ELEMENT_V1 = /<cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/cell>)/gu;

function xlsxValueV1(attributes: string, inner: string | undefined): LinkValueV1 {
  const type = attributeV1(attributes, 't') ?? 'n';
  const raw = inner === undefined ? null : /<v>([\s\S]*?)<\/v>|<v\/>/u.exec(inner);
  if (!raw) return type === 'str' ? { kind: 'string', value: '' } : BLANK_V1;
  const text = decodeXmlV1(raw[1] ?? '');
  switch (type) {
    case 'n': {
      if (text === '') return BLANK_V1;
      const value = Number(text);
      if (!Number.isFinite(value)) throw new UnsupportedLinkValueError(`number ${text}`);
      return { kind: 'number', value };
    }
    case 'b':
      return { kind: 'boolean', value: text === '1' || text.toLowerCase() === 'true' };
    case 'e': {
      const code = ERROR_CODE_V1.get(text);
      if (code === undefined) throw new UnsupportedLinkValueError(`error ${text}`);
      return { kind: 'error', code };
    }
    case 'str':
      return { kind: 'string', value: unescapeExcelTextV1(text) };
    default:
      throw new UnsupportedLinkValueError(`cell type ${type}`);
  }
}

function xlsxCellV1(ref: string, value: LinkValueV1): string {
  switch (value.kind) {
    case 'blank':
      return `<cell r="${ref}"/>`;
    case 'number':
      if (!Number.isFinite(value.value)) throw new UnsupportedLinkValueError('number');
      return `<cell r="${ref}"><v>${String(value.value)}</v></cell>`;
    case 'boolean':
      return `<cell r="${ref}" t="b"><v>${value.value ? 1 : 0}</v></cell>`;
    case 'error': {
      const text = ERROR_TEXT_V1.get(value.code);
      if (!text) throw new UnsupportedLinkValueError(`error code ${value.code}`);
      return `<cell r="${ref}" t="e"><v>${text}</v></cell>`;
    }
    case 'string':
      return `<cell r="${ref}" t="str"><v>${encodeXmlV1(escapeExcelTextV1(value.value))}</v></cell>`;
  }
}

/** "AB12" from zero-based row 11 and column 27. */
function a1V1(row: number, col: number): string {
  let letters = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCodePoint(65 + ((n - 1) % 26)) + letters;
  return `${letters}${row + 1}`;
}

const ROW_ELEMENT_V1 = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gu;

/** A sheetData body (rows and cells only) with new cells, rows and columns in order; null otherwise. */
function rebuildXlsxSheetV1(
  body: string,
  additions: NonNullable<ReturnType<LinkAdditionsV1['get']>>,
): { xml: string; added: number } | null {
  const rows = new Map<number, { attrs: string; cells: Map<number, string> }>();
  if (body.replace(ROW_ELEMENT_V1, '').trim() !== '') return null;
  for (const match of body.matchAll(ROW_ELEMENT_V1)) {
    const index = Number(attributeV1(match[1]!, 'r')) - 1;
    const inner = match[2] ?? '';
    if (!Number.isInteger(index) || index < 0 || inner.replace(CELL_ELEMENT_V1, '').trim() !== '')
      return null;
    const cells = new Map<number, string>();
    for (const cell of inner.matchAll(CELL_ELEMENT_V1)) {
      const ref = attributeV1(cell[1]!, 'r');
      if (!ref) return null;
      cells.set(parseA1V1(ref).col, cell[0]);
    }
    rows.set(index, { attrs: match[1]!, cells });
  }
  let added = 0;
  for (const cell of additions) {
    let row = rows.get(cell.row);
    if (!row) {
      row = { attrs: ` r="${cell.row + 1}"`, cells: new Map() };
      rows.set(cell.row, row);
    }
    if (row.cells.has(cell.col)) continue;
    row.cells.set(cell.col, xlsxCellV1(a1V1(cell.row, cell.col), cell.value));
    added++;
  }
  const xml = [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(
      ([, row]) =>
        `<row${row.attrs}>${[...row.cells.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, cell]) => cell)
          .join('')}</row>`,
    )
    .join('');
  return { xml, added };
}

type XmlSheetRangeV1 = { sheet: string; start: number; end: number };

function xlsxSheetRangesV1(xml: string, sheetNames: readonly string[]): XmlSheetRangeV1[] {
  const ranges: XmlSheetRangeV1[] = [];
  const opening = /<sheetData\b([^>]*?)(\/?)>/gu;
  for (let match = opening.exec(xml); match; match = opening.exec(xml)) {
    const id = Number(attributeV1(match[1]!, 'sheetId'));
    const sheet = sheetNames[id];
    if (sheet === undefined) throw new UnsupportedLinkValueError('sheetData without sheet');
    if (match[2] === '/') continue;
    const start = match.index + match[0].length;
    const end = xml.indexOf('</sheetData>', start);
    if (end < 0) throw new UnsupportedLinkValueError('unclosed sheetData');
    ranges.push({ sheet, start, end });
  }
  return ranges;
}

/** "='Nota final'!$B$2:$C$9" or "=RELAÇÃO!$J$3" → the sheet (as the link lists it) and the area. */
/** "'Nota d''ouro'" or "RELAÇÃO" (before the "!") → the sheet name. */
function sheetOfReferenceV1(text: string): string {
  return text.startsWith("'") && text.endsWith("'") && text.length > 1
    ? text.slice(1, -1).replaceAll("''", "'")
    : text;
}

const A1_CELL_V1 = /^\$?([A-Z]{1,3})\$?(\d+)$/u;

function xlsxNameTargetV1(
  refersTo: string | null,
  sheetNames: readonly string[],
): { sheet: string; area: LinkAreaV1 } | null {
  const text = (refersTo?.trim() ?? '').replace(/^=/u, '');
  const bang = text.lastIndexOf('!');
  if (bang <= 0) return null;
  const wanted = sheetOfReferenceV1(text.slice(0, bang)).toLocaleLowerCase('pt-BR');
  const sheet = sheetNames.find((name) => name.toLocaleLowerCase('pt-BR') === wanted);
  const [first, last, ...rest] = text.slice(bang + 1).split(':');
  const a = A1_CELL_V1.exec(first ?? '');
  const b = last === undefined ? a : A1_CELL_V1.exec(last);
  if (sheet === undefined || !a || !b || rest.length > 0) return null;
  const start = parseA1V1(`${a[1]}${a[2]}`);
  const end = parseA1V1(`${b[1]}${b[2]}`);
  return {
    sheet,
    area: {
      r1: Math.min(start.row, end.row),
      r2: Math.max(start.row, end.row),
      c1: Math.min(start.col, end.col),
      c2: Math.max(start.col, end.col),
    },
  };
}

function xlsxHeaderV1(xml: string) {
  const sheetNames = [...xml.matchAll(/<sheetName\b([^>]*?)\/?>/gu)].map(
    (match) => attributeV1(match[1]!, 'val') ?? '',
  );
  const alternate = /<\w*:?alternateUrls\b([^>]*)>/u.exec(xml);
  const names = [...xml.matchAll(/<definedName\b([^>]*?)\/?>/gu)].map((match) => {
    const target = xlsxNameTargetV1(attributeV1(match[1]!, 'refersTo'), sheetNames);
    return { name: attributeV1(match[1]!, 'name') ?? '', sheet: null, area: null, ...target };
  });
  return {
    sheetNames,
    driveId: alternate ? attributeV1(alternate[1]!, 'driveId') : null,
    itemId: alternate ? attributeV1(alternate[1]!, 'itemId') : null,
    names,
  };
}

/**
 * Every sheet with new cells gets an open sheetData: Excel writes `<sheetData sheetId="n"/>` for
 * a sheet without cells (and may leave a sheet out). A sheet whose last refresh failed in Excel
 * (refreshError) is left as it is.
 */
function openXlsxSheetsV1(
  xml: string,
  sheetNames: readonly string[],
  additions: LinkAdditionsV1,
): string {
  if (additions.size === 0) return xml;
  const wanted = (id: number) => {
    const sheet = sheetNames[id];
    return sheet !== undefined && (additions.get(sheet)?.length ?? 0) > 0;
  };
  let out = xml.replace(/<sheetData\b([^>]*?)\/>/gu, (tag, attrs: string) =>
    wanted(Number(attributeV1(attrs, 'sheetId'))) && attributeV1(attrs, 'refreshError') !== '1'
      ? `<sheetData${attrs}></sheetData>`
      : tag,
  );
  const present = new Set(
    [...out.matchAll(/<sheetData\b([^>]*?)\/?>/gu)].map((match) =>
      Number(attributeV1(match[1]!, 'sheetId')),
    ),
  );
  sheetNames.forEach((_sheet, id) => {
    if (present.has(id) || !wanted(id)) return;
    const element = `<sheetData sheetId="${id}"></sheetData>`;
    const next = [...out.matchAll(/<sheetData\b([^>]*?)\/?>/gu)].find(
      (match) => Number(attributeV1(match[1]!, 'sheetId')) > id,
    );
    if (next) out = out.slice(0, next.index) + element + out.slice(next.index);
    else if (out.includes('</sheetDataSet>'))
      out = out.replace('</sheetDataSet>', `${element}</sheetDataSet>`);
    else if (/<sheetDataSet\s*\/>/u.test(out))
      out = out.replace(/<sheetDataSet\s*\/>/u, `<sheetDataSet>${element}</sheetDataSet>`);
    else if (out.includes('</externalBook>'))
      out = out.replace(
        '</externalBook>',
        `<sheetDataSet>${element}</sheetDataSet></externalBook>`,
      );
  });
  return out;
}

export function readXlsxLinkCacheV1(xml: string): ExternalLinkCacheV1 {
  const header = xlsxHeaderV1(xml);
  const cells: LinkCellV1[] = [];
  for (const range of xlsxSheetRangesV1(xml, header.sheetNames)) {
    const body = xml.slice(range.start, range.end);
    for (const match of body.matchAll(CELL_ELEMENT_V1)) {
      const ref = attributeV1(match[1]!, 'r');
      if (!ref) throw new UnsupportedLinkValueError('cell without reference');
      cells.push({
        sheet: range.sheet,
        ...parseA1V1(ref),
        value: xlsxValueV1(match[1]!, match[2]),
      });
    }
  }
  return { ...header, cells };
}

export function rewriteXlsxLinkCacheV1(
  xml: string,
  lookup: LinkValueLookupV1,
  additions: LinkAdditionsV1 = NO_ADDITIONS_V1,
): { xml: string; changed: number } {
  const header = xlsxHeaderV1(xml);
  const source = openXlsxSheetsV1(xml, header.sheetNames, additions);
  let changed = 0;
  let out = '';
  let at = 0;
  for (const range of xlsxSheetRangesV1(source, header.sheetNames)) {
    out += source.slice(at, range.start);
    let body = source
      .slice(range.start, range.end)
      .replace(CELL_ELEMENT_V1, (element, attrs: string, inner?: string) => {
        const ref = attributeV1(attrs, 'r');
        if (!ref) throw new UnsupportedLinkValueError('cell without reference');
        const current: LinkCellV1 = {
          sheet: range.sheet,
          ...parseA1V1(ref),
          value: xlsxValueV1(attrs, inner),
        };
        const wanted = lookup(current);
        if (!wanted || sameLinkValueV1(wanted, current.value)) return element;
        changed++;
        return xlsxCellV1(ref, wanted);
      });
    const wanted = additions.get(range.sheet);
    const rebuilt = wanted?.length ? rebuildXlsxSheetV1(body, wanted) : null;
    if (rebuilt?.added) {
      body = rebuilt.xml;
      changed += rebuilt.added;
    }
    out += body;
    at = range.end;
  }
  out += source.slice(at);
  return { xml: changed ? out : xml, changed };
}

/* ---------------------------------------------------------------- recalculation on open */

const CALC_PROP_V1 = 0x9d;

/** .xlsb: BrtCalcProp with recalcID 0 and fFullCalcOnLoad, so Excel recalculates when opening. */
export function forceXlsbRecalcOnOpenV1(workbookBin: Uint8Array): Uint8Array {
  const records = readBiff12RecordsV1(workbookBin);
  let found = false;
  const out = records.map((record) => {
    if (record.type !== CALC_PROP_V1) return record;
    if (record.data.length < 26) throw new UnsupportedLinkValueError('short calculation record');
    found = true;
    const data = record.data.slice();
    new DataView(data.buffer).setUint32(0, 0, true);
    data[24] = data[24]! | 0x01;
    return { type: record.type, data };
  });
  if (!found) throw new UnsupportedLinkValueError('workbook has no calculation record');
  return writeBiff12RecordsV1(out);
}

/** .xlsx: calcPr fullCalcOnLoad="1". */
export function forceXlsxRecalcOnOpenV1(workbookXml: string): string {
  const tag = /<calcPr\b([^>]*?)(\/?)>/u.exec(workbookXml);
  if (!tag) throw new UnsupportedLinkValueError('workbook has no calcPr');
  const attrs = /\sfullCalcOnLoad="[^"]*"/u.test(tag[1]!)
    ? tag[1]!.replace(/\sfullCalcOnLoad="[^"]*"/u, ' fullCalcOnLoad="1"')
    : `${tag[1]} fullCalcOnLoad="1"`;
  return (
    workbookXml.slice(0, tag.index) +
    `<calcPr${attrs}${tag[2]}>` +
    workbookXml.slice(tag.index + tag[0].length)
  );
}
