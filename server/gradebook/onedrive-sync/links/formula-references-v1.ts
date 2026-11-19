import { scanBiff12RecordsV1 } from './biff12-records-v1';
import { readZipEntryV1, zipEntryNamesV1, type ZipPackageV1 } from './zip-package-v1';

/**
 * The cells of each source that the destination's formulas use. Excel's "update links" keeps a
 * copy only of the used cells that have a value, so a used cell empty at the last update is not in
 * the copy; the formulas say which cells must come in once the source gets a value there.
 */
export type CellAreaV1 = {
  readonly r1: number;
  readonly r2: number;
  readonly c1: number;
  readonly c2: number;
};

/** Used cells of one source sheet: single cells (row × 16384 + column) and larger areas. */
export type SheetUseV1 = {
  readonly cells: Set<number>;
  readonly areas: Map<string, CellAreaV1>;
};

export type LinkUseV1 = {
  /** Link part → source sheet name (as the link lists it) → used cells. */
  readonly byPart: Map<string, Map<string, SheetUseV1>>;
  /** False when a formula could not be read to the end (what it uses may be missing). */
  readonly complete: boolean;
};

export const MAX_COLUMNS_V1 = 16_384;
const MAX_ROW_V1 = 1_048_575;

export const cellKeyV1 = (row: number, col: number): number => row * MAX_COLUMNS_V1 + col;

/** The source sheets each link lists, to name the sheets the formulas point to. */
export type LinkSheetsV1 = ReadonlyMap<string, readonly string[]>;

class UseCollectorV1 {
  readonly byPart = new Map<string, Map<string, SheetUseV1>>();
  complete = true;

  constructor(private readonly sheets: LinkSheetsV1) {}

  /** A sheet by its index in the link's list (.xlsb) or by its name in any case (.xlsx). */
  private sheetName(part: string, sheet: number | string): string | null {
    const names = this.sheets.get(part);
    if (!names) return null;
    if (typeof sheet === 'number') return names[sheet] ?? null;
    const wanted = sheet.toLocaleLowerCase('pt-BR');
    return names.find((name) => name.toLocaleLowerCase('pt-BR') === wanted) ?? null;
  }

  add(part: string, sheet: number | string, area: CellAreaV1): void {
    const name = this.sheetName(part, sheet);
    if (name === null) return;
    let sheets = this.byPart.get(part);
    if (!sheets) {
      sheets = new Map();
      this.byPart.set(part, sheets);
    }
    let use = sheets.get(name);
    if (!use) {
      use = { cells: new Set(), areas: new Map() };
      sheets.set(name, use);
    }
    const r1 = Math.min(area.r1, area.r2);
    const r2 = Math.max(area.r1, area.r2);
    const c1 = Math.min(area.c1, area.c2);
    const c2 = Math.max(area.c1, area.c2);
    if (r1 === r2 && c1 === c2) use.cells.add(cellKeyV1(r1, c1));
    else use.areas.set(`${r1}:${r2}:${c1}:${c2}`, { r1, r2, c1, c2 });
  }
}

/* ---------------------------------------------------------------- package relationships */

function decodeXmlTextV1(text: string): string {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attributeOfV1(tag: string, name: string): string | null {
  const match = new RegExp(String.raw`(?:^|\s)(?:\w+:)?${name}="([^"]*)"`, 'u').exec(tag);
  return match ? decodeXmlTextV1(match[1]!) : null;
}

/** Relationship id → part name, for the relationships of `owner` (e.g. "xl/workbook.bin"). */
async function relationshipsV1(pkg: ZipPackageV1, owner: string): Promise<Map<string, string>> {
  const folder = owner.slice(0, owner.lastIndexOf('/') + 1);
  const rels = await readZipEntryV1(pkg, `${folder}_rels/${owner.slice(folder.length)}.rels`);
  const targets = new Map<string, string>();
  if (!rels) return targets;
  for (const match of new TextDecoder().decode(rels).matchAll(/<Relationship\b([^>]*)\/?>/gu)) {
    const id = attributeOfV1(match[1]!, 'Id');
    const target = attributeOfV1(match[1]!, 'Target');
    if (!id || !target || attributeOfV1(match[1]!, 'TargetMode') === 'External') continue;
    const parts = (target.startsWith('/') ? target.slice(1) : folder + target).split('/');
    const resolved: string[] = [];
    for (const piece of parts) {
      if (piece === '..') resolved.pop();
      else if (piece && piece !== '.') resolved.push(piece);
    }
    targets.set(id, resolved.join('/'));
  }
  return targets;
}

/* ---------------------------------------------------------------- .xlsb formulas */

const u16 = (data: Uint8Array, at: number): number => data[at]! | (data[at + 1]! << 8);
const u32 = (data: Uint8Array, at: number): number =>
  (data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16)) + data[at + 3]! * 0x1000000;
/** Signed: a sheet index of -1 is a reference to a deleted sheet. */
const i32 = (data: Uint8Array, at: number): number => {
  const value = u32(data, at);
  return value > 0x7fffffff ? value - 0x100000000 : value;
};

/** Size of each token (with its first byte) whose size does not depend on its content. */
const PTG_SIZE_V1 = new Map<number, number>([
  [0x01, 5], // PtgExp: the shared or array formula holds the tokens
  [0x1c, 2],
  [0x1d, 2],
  [0x1e, 3],
  [0x1f, 9],
  [0x20, 15], // PtgArray (values in the extra data)
  [0x21, 3],
  [0x22, 4],
  [0x23, 5],
  [0x24, 7],
  [0x25, 13],
  [0x26, 7],
  [0x29, 3],
  [0x2a, 7],
  [0x2b, 13],
  [0x2c, 7],
  [0x2d, 13],
  [0x2e, 3],
  [0x2f, 3],
  [0x39, 7],
  [0x3a, 9], // PtgRef3d
  [0x3b, 15], // PtgArea3d
  [0x3c, 9],
  [0x3d, 15],
]);
const ATTRIBUTE_TOKENS_V1 = new Set([0x00, 0x01, 0x02, 0x08, 0x10, 0x20, 0x21, 0x40, 0x41, 0x80]);

/** The token without its class bits (reference, value or array). */
const baseTokenV1 = (ptg: number): number => (ptg >= 0x20 ? (ptg & 0x1f) | 0x20 : ptg);

/** After 0x18: PtgList (a table) and PtgSxName; anything else there is not read. */
function extendedTokenSizeV1(kind: number | undefined): number | null {
  if (kind === 0x19) return 14;
  return kind === 0x1d ? 6 : null;
}

/** PtgAttr: 4 bytes, except Choose, which carries its jump table. */
function attributeTokenSizeV1(rgce: Uint8Array, at: number): number | null {
  const kind = rgce[at + 1];
  if (kind === 0x04) return at + 4 <= rgce.length ? 4 + 2 * (u16(rgce, at + 2) + 1) : null;
  return kind !== undefined && ATTRIBUTE_TOKENS_V1.has(kind) ? 4 : null;
}

function tokenSizeV1(rgce: Uint8Array, at: number): number | null {
  const ptg = rgce[at]!;
  if (ptg >= 0x03 && ptg <= 0x16) return 1;
  if (ptg === 0x17) return at + 3 <= rgce.length ? 3 + 2 * u16(rgce, at + 1) : null;
  if (ptg === 0x18) return extendedTokenSizeV1(rgce[at + 1]);
  if (ptg === 0x19) return attributeTokenSizeV1(rgce, at);
  if (ptg >= 0x80) return null;
  return PTG_SIZE_V1.get(baseTokenV1(ptg)) ?? null;
}

type XlsbRefV1 = { readonly ixti: number; readonly area: CellAreaV1 };

/** The 3D references of a formula; incomplete when a token is unknown (the rest is skipped). */
export function xlsbFormulaRefsV1(rgce: Uint8Array): { refs: XlsbRefV1[]; complete: boolean } {
  const refs: XlsbRefV1[] = [];
  let at = 0;
  while (at < rgce.length) {
    const size = tokenSizeV1(rgce, at);
    if (size === null || at + size > rgce.length) return { refs, complete: false };
    const base = baseTokenV1(rgce[at]!);
    if (base === 0x3a) {
      const row = u32(rgce, at + 3);
      const col = u16(rgce, at + 7) & 0x3fff;
      refs.push({ ixti: u16(rgce, at + 1), area: { r1: row, r2: row, c1: col, c2: col } });
    } else if (base === 0x3b) {
      refs.push({
        ixti: u16(rgce, at + 1),
        area: {
          r1: u32(rgce, at + 3),
          r2: u32(rgce, at + 7),
          c1: u16(rgce, at + 11) & 0x3fff,
          c2: u16(rgce, at + 13) & 0x3fff,
        },
      });
    }
    at += size;
  }
  return { refs, complete: true };
}

type XlsbBooksV1 = {
  /** Part of each supporting workbook (null: this workbook or an add-in). */
  readonly books: (string | null)[];
  /** Each sheet reference: its workbook and first/last sheet index. */
  readonly xti: { book: number; first: number; last: number }[];
  /** Tokens of each defined name. */
  readonly names: Uint8Array[];
};

function wideTextV1(data: Uint8Array, at: number): string | null {
  if (at + 4 > data.length) return null;
  const length = u32(data, at);
  if (length === 0 || length === 0xffffffff || at + 4 + length * 2 > data.length) return null;
  return new TextDecoder('utf-16le').decode(data.subarray(at + 4, at + 4 + length * 2));
}

/** BrtName: flags, key, sheet, name, then the formula (cce, tokens). */
function nameTokensV1(data: Uint8Array): Uint8Array | null {
  if (data.length < 13) return null;
  const at = 13 + 2 * u32(data, 9);
  if (at + 4 > data.length) return null;
  const size = u32(data, at);
  return at + 4 + size <= data.length ? data.subarray(at + 4, at + 4 + size) : null;
}

function xlsbBooksV1(workbook: Uint8Array, rels: Map<string, string>): XlsbBooksV1 {
  const out: XlsbBooksV1 = { books: [], xti: [], names: [] };
  scanBiff12RecordsV1(workbook, (type, start, end) => {
    const data = workbook.subarray(start, end);
    if (type === 0x0163) {
      const id = wideTextV1(data, 0);
      out.books.push(id === null ? null : (rels.get(id) ?? null));
    } else if (type === 0x0165 || type === 0x0166 || type === 0x029b) out.books.push(null);
    else if (type === 0x016a && data.length >= 4) {
      const count = u32(data, 0);
      for (let i = 0; i < count && 16 + i * 12 <= data.length; i++)
        out.xti.push({
          book: u32(data, 4 + i * 12),
          first: i32(data, 8 + i * 12),
          last: i32(data, 12 + i * 12),
        });
    } else if (type === 0x0027) {
      const tokens = nameTokensV1(data);
      if (tokens) out.names.push(tokens);
    }
  });
  return out;
}

/** Cell formulas (value, flags, then the formula), shared and array formulas. */
function formulaStartV1(bytes: Uint8Array, type: number, start: number): number | null {
  switch (type) {
    case 0x0008: // BrtFmlaString: cell, text result, flags
      return start + 8 + 4 + 2 * u32(bytes, start + 8) + 2;
    case 0x0009: // BrtFmlaNum
      return start + 8 + 8 + 2;
    case 0x000a: // BrtFmlaBool
    case 0x000b: // BrtFmlaError
      return start + 8 + 1 + 2;
    case 0x01ab: // BrtShrFmla: range, formula
      return start + 16;
    case 0x01aa: // BrtArrFmla: range, flag, formula
      return start + 17;
    default:
      return null;
  }
}

function collectXlsbV1(collector: UseCollectorV1, books: XlsbBooksV1, rgce: Uint8Array): void {
  const { refs, complete } = xlsbFormulaRefsV1(rgce);
  if (!complete) collector.complete = false;
  for (const { ixti, area } of refs) {
    const xti = books.xti[ixti];
    const part = xti ? books.books[xti.book] : null;
    if (!xti || !part || xti.first < 0) continue;
    for (let sheet = xti.first; sheet <= Math.max(xti.first, xti.last); sheet++)
      collector.add(part, sheet, area);
  }
}

async function readXlsbUseV1(pkg: ZipPackageV1, collector: UseCollectorV1): Promise<void> {
  const workbook = await readZipEntryV1(pkg, 'xl/workbook.bin');
  if (!workbook) return;
  const books = xlsbBooksV1(workbook, await relationshipsV1(pkg, 'xl/workbook.bin'));
  for (const tokens of books.names) collectXlsbV1(collector, books, tokens);
  const sheets = zipEntryNamesV1(pkg).filter((name) => /^xl\/worksheets\/[^/]+\.bin$/u.test(name));
  for (const name of sheets) {
    const bytes = await readZipEntryV1(pkg, name);
    if (!bytes) continue;
    scanBiff12RecordsV1(bytes, (type, start, end) => {
      const at = formulaStartV1(bytes, type, start);
      if (at === null) return;
      if (at + 4 > end || at + 4 + u32(bytes, at) > end) {
        collector.complete = false;
        return;
      }
      const rgce = bytes.subarray(at + 4, at + 4 + u32(bytes, at));
      // A cell of a shared or array formula: that formula's own record holds the tokens.
      if (rgce[0] !== 0x01) collectXlsbV1(collector, books, rgce);
    });
  }
}

/* ---------------------------------------------------------------- .xlsx formulas */

type A1RefV1 = {
  readonly row: number | null;
  readonly col: number | null;
  readonly rowFixed: boolean;
  readonly colFixed: boolean;
};

function columnNumberV1(letters: string): number {
  let col = 0;
  for (const char of letters) col = col * 26 + (char.codePointAt(0)! - 64);
  return col - 1;
}

/** "$B$7", "B", "7" → its row and column (null when the part has none). */
function a1PartV1(text: string): A1RefV1 | null {
  const match = /^(\$?)([A-Z]{1,3})?(\$?)(\d+)?$/u.exec(text);
  if (!match || (!match[2] && !match[4])) return null;
  return {
    col: match[2] ? columnNumberV1(match[2]) : null,
    row: match[4] ? Number(match[4]) - 1 : null,
    colFixed: match[1] === '$',
    rowFixed: match[3] === '$' || (!match[2] && match[1] === '$'),
  };
}

function shiftedV1(ref: A1RefV1, rows: number, cols: number): A1RefV1 {
  return {
    ...ref,
    row: ref.row === null || ref.rowFixed ? ref.row : ref.row + rows,
    col: ref.col === null || ref.colFixed ? ref.col : ref.col + cols,
  };
}

function areaOfV1(start: A1RefV1, end: A1RefV1): CellAreaV1 {
  return {
    r1: start.row ?? 0,
    r2: end.row ?? MAX_ROW_V1,
    c1: start.col ?? 0,
    c2: end.col ?? MAX_COLUMNS_V1 - 1,
  };
}

type XlsxRefV1 = {
  readonly book: number;
  readonly sheet: string;
  readonly start: A1RefV1;
  readonly end: A1RefV1;
};

/** "'[2]Nota final'!" and "[1]Notas!": the workbook number and the sheet before a reference. */
const QUOTED_BOOK_SHEET_V1 = /'\[(\d+)\]((?:[^']|'')+)'!/gu;
const PLAIN_BOOK_SHEET_V1 = /\[(\d+)\]([^\s!'"()[\],;:&=<>*/+^%{}-]+)!/gu;
const A1_PART_V1 = /\$?[A-Z]{0,3}\$?\d*/uy;

function a1AtV1(text: string, at: number): { ref: A1RefV1; end: number } | null {
  A1_PART_V1.lastIndex = at;
  const part = A1_PART_V1.exec(text)?.[0] ?? '';
  const ref = part ? a1PartV1(part) : null;
  return ref ? { ref, end: at + part.length } : null;
}

/** "B7", "A:C", "3:5" or "B7:D9" at `at`; null for anything else (a sheet-level name). */
function a1RangeAtV1(text: string, at: number): { start: A1RefV1; end: A1RefV1 } | null {
  const start = a1AtV1(text, at);
  if (!start) return null;
  const end = text[start.end] === ':' ? a1AtV1(text, start.end + 1) : null;
  if (/[\w.]/u.test(text[end?.end ?? start.end] ?? '')) return null;
  return { start: start.ref, end: end?.ref ?? start.ref };
}

/** The references to other workbooks in a formula's text ("[1]Notas!B7", "'[2]Nota final'!A:A"). */
export function xlsxFormulaRefsV1(formula: string): XlsxRefV1[] {
  const text = formula.replaceAll(/"(?:[^"]|"")*"/gu, '""');
  const refs: XlsxRefV1[] = [];
  for (const match of [
    ...text.matchAll(QUOTED_BOOK_SHEET_V1),
    ...text.matchAll(PLAIN_BOOK_SHEET_V1),
  ]) {
    const sheet = match[0].startsWith("'") ? match[2]!.replaceAll("''", "'") : match[2]!;
    const range = a1RangeAtV1(text, match.index + match[0].length);
    if (range) refs.push({ book: Number(match[1]), sheet, ...range });
  }
  return refs;
}

function collectXlsxV1(
  collector: UseCollectorV1,
  books: readonly (string | null)[],
  formula: string,
  shift: { rows: number; cols: number } | null = null,
): void {
  for (const ref of xlsxFormulaRefsV1(formula)) {
    const part = books[ref.book - 1];
    if (!part) continue;
    const start = shift ? shiftedV1(ref.start, shift.rows, shift.cols) : ref.start;
    const end = shift ? shiftedV1(ref.end, shift.rows, shift.cols) : ref.end;
    collector.add(part, ref.sheet, areaOfV1(start, end));
  }
}

/** A cell, with its content; an empty one written as `<c r="A2" s="1"/>` has none. */
const CELL_V1 = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu;
const FORMULA_V1 = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/u;

function cellPositionV1(ref: string | null): { row: number; col: number } | null {
  const match = ref === null ? null : /^([A-Z]{1,3})(\d+)$/u.exec(ref);
  return match ? { row: Number(match[2]) - 1, col: columnNumberV1(match[1]!) } : null;
}

function collectXlsxSheetV1(
  collector: UseCollectorV1,
  books: readonly (string | null)[],
  xml: string,
): void {
  const shared: SharedFormulasV1 = new Map();
  for (const cell of xml.matchAll(CELL_V1)) {
    const formula = cell[2] === undefined ? null : FORMULA_V1.exec(cell[2]);
    if (!formula) continue;
    const text = formula[2] === undefined ? '' : decodeXmlTextV1(formula[2]);
    const moved = sharedFormulaV1(shared, formula[1]!, cell[1]!, text);
    if (moved) collectXlsxV1(collector, books, moved.formula, moved.shift);
    else if (text) collectXlsxV1(collector, books, text);
  }
}

type SharedFormulasV1 = Map<string, { formula: string; row: number; col: number }>;

/**
 * A shared formula is written once, in its first cell (remembered here); another cell of the group
 * has no text and gets that formula moved to it.
 */
function sharedFormulaV1(
  shared: SharedFormulasV1,
  formulaAttrs: string,
  cellAttrs: string,
  text: string,
): { formula: string; shift: { rows: number; cols: number } } | null {
  const group = attributeOfV1(formulaAttrs, 'si');
  const at = cellPositionV1(attributeOfV1(cellAttrs, 'r'));
  if (attributeOfV1(formulaAttrs, 't') !== 'shared' || group === null || !at) return null;
  if (text) {
    shared.set(group, { formula: text, row: at.row, col: at.col });
    return null;
  }
  const master = shared.get(group);
  return master
    ? { formula: master.formula, shift: { rows: at.row - master.row, cols: at.col - master.col } }
    : null;
}

async function readXlsxUseV1(pkg: ZipPackageV1, collector: UseCollectorV1): Promise<void> {
  const workbook = await readZipEntryV1(pkg, 'xl/workbook.xml');
  if (!workbook) return;
  const xml = new TextDecoder().decode(workbook);
  const rels = await relationshipsV1(pkg, 'xl/workbook.xml');
  const books = [...xml.matchAll(/<(?:\w+:)?externalReference\b([^>]*?)\/?>/gu)].map(
    (match) => rels.get(attributeOfV1(match[1]!, 'id') ?? '') ?? null,
  );
  for (const name of xml.matchAll(/<(?:\w+:)?definedName\b[^>]*>([^<]*)</gu))
    collectXlsxV1(collector, books, decodeXmlTextV1(name[1]!));
  const sheets = zipEntryNamesV1(pkg).filter((name) => /^xl\/worksheets\/[^/]+\.xml$/u.test(name));
  for (const name of sheets) {
    const bytes = await readZipEntryV1(pkg, name);
    if (bytes) collectXlsxSheetV1(collector, books, new TextDecoder().decode(bytes));
  }
}

/** What the formulas (and defined names) of the destination use of each link's sources. */
export async function readLinkUseV1(
  pkg: ZipPackageV1,
  format: 'xlsb' | 'xlsx',
  sheets: LinkSheetsV1,
): Promise<LinkUseV1> {
  const collector = new UseCollectorV1(sheets);
  if (format === 'xlsb') await readXlsbUseV1(pkg, collector);
  else await readXlsxUseV1(pkg, collector);
  return { byPart: collector.byPart, complete: collector.complete };
}
