import { scanBiff12RecordsV1 } from '../biff12-records-v1';
import { readZipEntryV1, type ZipPackageV1 } from '../zip-package-v1';

/**
 * What the recalculation needs of an .xlsb workbook, read straight from its parts (MS-XLSB): the
 * sheets in order, the defined names, how 3D references and names point to sheets and other
 * workbooks, the shared strings and, per sheet, every cell's stored value and every formula with
 * the bounds of its record (to rewrite only the result later). Nothing here knows any particular
 * workbook: names of sheets, cells and files all come from the file itself.
 */

/** Excel error codes (BErr). */
export const ERR_V1 = {
  NULL: 0x00,
  DIV0: 0x07,
  VALUE: 0x0f,
  REF: 0x17,
  NAME: 0x1d,
  NUM: 0x24,
  NA: 0x2a,
  GETTING_DATA: 0x2b,
} as const;

/** An Excel error value. */
export class ExcelErrorV1 {
  constructor(readonly code: number) {}
}

/** A cell value: number, text, logical, error, or null for an empty cell. */
export type ScalarV1 = number | string | boolean | ExcelErrorV1 | null;

export const errorV1 = (code: number): ExcelErrorV1 => new ExcelErrorV1(code);
export const isErrorV1 = (value: unknown): value is ExcelErrorV1 => value instanceof ExcelErrorV1;

/** A formula as stored: its tokens (rgce) and, for array or shared groups, the group's range. */
export type FormulaRecordV1 = {
  /** BrtFmlaNum / String / Bool / Error. */
  readonly recordType: number;
  /** Bounds of the record data inside the sheet part (the value sits at data + 8). */
  readonly dataStart: number;
  readonly dataEnd: number;
  /** Where the whole record (header included) starts and ends, for a rewrite. */
  readonly recordStart: number;
  /** The tokens; a cell of an array or shared formula holds only PtgExp. */
  readonly rgce: Uint8Array;
  /** Extra data of the formula (array constants), in order after rgce. */
  readonly rgcb: Uint8Array;
  /** grbitFlags of the cell formula (fAlwaysCalc and others). */
  readonly flags: number;
};

export type CellV1 = {
  readonly row: number;
  readonly col: number;
  /** The value stored in the file (the last result Excel saved, for a formula). */
  readonly value: ScalarV1;
  readonly formula: FormulaRecordV1 | null;
};

/** An array formula (CSE or dynamic) or a shared formula: its range and its own tokens. */
export type FormulaGroupV1 = {
  readonly kind: 'array' | 'shared';
  readonly r1: number;
  readonly r2: number;
  readonly c1: number;
  readonly c2: number;
  readonly rgce: Uint8Array;
  readonly rgcb: Uint8Array;
};

export type SheetModelV1 = {
  readonly index: number;
  readonly name: string;
  readonly part: string;
  /** The decompressed part (cells are rewritten in place of their records). */
  readonly bytes: Uint8Array;
  /** row × 16384 + column → cell. */
  readonly cells: Map<number, CellV1>;
  readonly groups: FormulaGroupV1[];
};

export type DefinedNameV1 = {
  readonly name: string;
  /** Sheet index for a sheet-scoped name, null for a workbook name. */
  readonly sheet: number | null;
  readonly rgce: Uint8Array;
  readonly rgcb: Uint8Array;
  readonly hidden: boolean;
};

/** A supporting book: this workbook, or an external one by its link part. */
export type SupBookV1 =
  { readonly kind: 'self' } | { readonly kind: 'external'; readonly part: string | null };

export type XtiV1 = { readonly book: number; readonly first: number; readonly last: number };

export type WorkbookModelV1 = {
  readonly sheets: SheetModelV1[];
  readonly sheetByName: Map<string, SheetModelV1>;
  /** 1-based in formulas (PtgName); index 0 here is name 1. */
  readonly names: DefinedNameV1[];
  readonly books: SupBookV1[];
  readonly xti: XtiV1[];
};

export const MAX_COLUMNS_V1 = 16_384;
export const cellKeyV1 = (row: number, col: number): number => row * MAX_COLUMNS_V1 + col;

const u16 = (d: Uint8Array, at: number): number => d[at]! | (d[at + 1]! << 8);
const u32 = (d: Uint8Array, at: number): number =>
  (d[at]! | (d[at + 1]! << 8) | (d[at + 2]! << 16)) + d[at + 3]! * 0x1000000;
const i32 = (d: Uint8Array, at: number): number => {
  const value = u32(d, at);
  return value > 0x7fffffff ? value - 0x100000000 : value;
};
const f64 = (d: Uint8Array, at: number): number =>
  new DataView(d.buffer, d.byteOffset + at, 8).getFloat64(0, true);

export class WorkbookModelError extends Error {
  constructor(message: string) {
    super(`Recalculation model: ${message}`);
  }
}

/** XLWideString: a 4-byte count of UTF-16 units, then the units. */
function wideV1(d: Uint8Array, at: number): { text: string; end: number } {
  if (at + 4 > d.length) throw new WorkbookModelError('string is truncated');
  const count = u32(d, at);
  if (count === 0xffffffff) return { text: '', end: at + 4 };
  const end = at + 4 + count * 2;
  if (end > d.length) throw new WorkbookModelError('string is truncated');
  return { text: new TextDecoder('utf-16le').decode(d.subarray(at + 4, end)), end };
}

/** RkNumber: 30 bits of an integer or the high bits of a double, possibly divided by 100. */
function rkV1(raw: number): number {
  const cents = (raw & 1) === 1;
  let value: number;
  if (raw & 2) value = (raw | 0) >> 2;
  else {
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setUint32(4, raw & 0xfffffffc, true);
    value = buffer.getFloat64(0, true);
  }
  return cents ? value / 100 : value;
}

/** Relationship id → part path, for the relationships of `owner`. */
async function relationshipsV1(pkg: ZipPackageV1, owner: string): Promise<Map<string, string>> {
  const folder = owner.slice(0, owner.lastIndexOf('/') + 1);
  const rels = await readZipEntryV1(pkg, `${folder}_rels/${owner.slice(folder.length)}.rels`);
  const targets = new Map<string, string>();
  if (!rels) return targets;
  for (const match of new TextDecoder().decode(rels).matchAll(/<Relationship\b([^>]*)\/?>/gu)) {
    const id = /\bId="([^"]*)"/u.exec(match[1]!)?.[1];
    const target = /\bTarget="([^"]*)"/u.exec(match[1]!)?.[1];
    if (!id || !target || /TargetMode="External"/u.test(match[1]!)) continue;
    const pieces: string[] = [];
    for (const piece of (target.startsWith('/') ? target.slice(1) : folder + target).split('/')) {
      if (piece === '..') pieces.pop();
      else if (piece && piece !== '.') pieces.push(piece);
    }
    targets.set(id, pieces.join('/'));
  }
  return targets;
}

/** Shared strings (BrtSSTItem: flags, then the text; rich and phonetic runs are ignored). */
async function sharedStringsV1(pkg: ZipPackageV1, rels: Map<string, string>): Promise<string[]> {
  const partName =
    [...rels.values()].find((part) => /sharedStrings\.bin$/u.test(part)) ?? 'xl/sharedStrings.bin';
  const bytes = await readZipEntryV1(pkg, partName);
  const strings: string[] = [];
  if (!bytes) return strings;
  scanBiff12RecordsV1(bytes, (type, start) => {
    if (type === 0x13) strings.push(wideV1(bytes, start + 1).text);
  });
  return strings;
}

type WorkbookPartsV1 = {
  sheets: { name: string; part: string }[];
  names: DefinedNameV1[];
  books: SupBookV1[];
  xti: XtiV1[];
};

/** Formula bytes: cce, rgce, cb, rgcb (CellParsedFormula and friends). */
function parsedFormulaV1(d: Uint8Array, at: number): { rgce: Uint8Array; rgcb: Uint8Array } {
  if (at + 4 > d.length) throw new WorkbookModelError('formula is truncated');
  const cce = u32(d, at);
  const rgceEnd = at + 4 + cce;
  if (rgceEnd > d.length) throw new WorkbookModelError('formula is truncated');
  const cb = rgceEnd + 4 <= d.length ? u32(d, rgceEnd) : 0;
  return {
    rgce: d.subarray(at + 4, rgceEnd),
    rgcb: d.subarray(rgceEnd + 4, Math.min(d.length, rgceEnd + 4 + cb)),
  };
}

function workbookPartsV1(workbook: Uint8Array, rels: Map<string, string>): WorkbookPartsV1 {
  const out: WorkbookPartsV1 = { sheets: [], names: [], books: [], xti: [] };
  scanBiff12RecordsV1(workbook, (type, start, end) => {
    const d = workbook.subarray(start, end);
    switch (type) {
      case 0x9c: {
        // BrtBundleSh: hsState, iTabID, then the relationship id and the sheet name.
        const rid = wideV1(d, 8);
        const name = wideV1(d, rid.end);
        out.sheets.push({ name: name.text, part: rels.get(rid.text) ?? '' });
        break;
      }
      case 0x27: {
        // BrtName: flags, chKey, itab, name, then the formula.
        const flags = u32(d, 0);
        const itab = u32(d, 5);
        const name = wideV1(d, 9);
        const formula = parsedFormulaV1(d, name.end);
        out.names.push({
          name: name.text,
          sheet: itab === 0xffffffff ? null : itab,
          hidden: (flags & 1) === 1,
          ...formula,
        });
        break;
      }
      case 0x165: // BrtSupSelf
      case 0x166: // BrtSupSame
        out.books.push({ kind: 'self' });
        break;
      case 0x29b: // BrtSupAddin: nothing a cell can be read from
        out.books.push({ kind: 'external', part: null });
        break;
      case 0x163: // BrtSupBookSrc: the external link part by its relationship id
        out.books.push({ kind: 'external', part: rels.get(wideV1(d, 0).text) ?? null });
        break;
      case 0x16a: {
        const count = u32(d, 0);
        for (let i = 0; i < count && 16 + i * 12 <= d.length; i++)
          out.xti.push({
            book: u32(d, 4 + i * 12),
            first: i32(d, 8 + i * 12),
            last: i32(d, 12 + i * 12),
          });
        break;
      }
      default:
        break;
    }
  });
  return out;
}

const FORMULA_TYPES_V1 = new Set([0x08, 0x09, 0x0a, 0x0b]);

/** The value field of a cell record, after Cell (column, style). */
function cellValueV1(
  type: number,
  d: Uint8Array,
  strings: readonly string[],
): {
  value: ScalarV1;
  end: number;
} {
  switch (type) {
    case 0x01:
      return { value: null, end: 8 };
    case 0x02:
      return { value: rkV1(u32(d, 8)), end: 12 };
    case 0x03:
    case 0x0b:
      return { value: errorV1(d[8]!), end: 9 };
    case 0x04:
    case 0x0a:
      return { value: d[8] !== 0, end: 9 };
    case 0x05:
    case 0x09:
      return { value: f64(d, 8), end: 16 };
    case 0x06:
    case 0x08: {
      const text = wideV1(d, 8);
      return { value: text.text, end: text.end };
    }
    case 0x07:
      return { value: strings[u32(d, 8)] ?? '', end: 12 };
    default:
      throw new WorkbookModelError(`cell record ${type}`);
  }
}

const CELL_TYPES_V1 = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);

function sheetModelV1(
  index: number,
  name: string,
  part: string,
  bytes: Uint8Array,
  strings: readonly string[],
): SheetModelV1 {
  const cells = new Map<number, CellV1>();
  const groups: FormulaGroupV1[] = [];
  let row = 0;
  let at = 0;
  scanBiff12RecordsV1(bytes, (type, start, end) => {
    const recordStart = at;
    at = end;
    if (type === 0x00) {
      row = u32(bytes, start);
      return;
    }
    const d = bytes.subarray(start, end);
    if (CELL_TYPES_V1.has(type)) {
      const col = u32(d, 0) & 0x3fff;
      const { value, end: valueEnd } = cellValueV1(type, d, strings);
      let formula: FormulaRecordV1 | null = null;
      if (FORMULA_TYPES_V1.has(type)) {
        const flags = u16(d, valueEnd);
        const parsed = parsedFormulaV1(d, valueEnd + 2);
        formula = {
          recordType: type,
          dataStart: start,
          dataEnd: end,
          recordStart,
          flags,
          ...parsed,
        };
      }
      cells.set(cellKeyV1(row, col), { row, col, value, formula });
      return;
    }
    if (type === 0x1aa || type === 0x1ab) {
      const parsed = parsedFormulaV1(d, type === 0x1aa ? 17 : 16);
      groups.push({
        kind: type === 0x1aa ? 'array' : 'shared',
        r1: u32(d, 0),
        r2: u32(d, 4),
        c1: u32(d, 8),
        c2: u32(d, 12),
        ...parsed,
      });
    }
  });
  return { index, name, part, bytes, cells, groups };
}

/** The whole model of an .xlsb package; null for anything that is not one. */
export async function readWorkbookModelV1(pkg: ZipPackageV1): Promise<WorkbookModelV1 | null> {
  const workbook = await readZipEntryV1(pkg, 'xl/workbook.bin');
  if (!workbook) return null;
  const rels = await relationshipsV1(pkg, 'xl/workbook.bin');
  const parts = workbookPartsV1(workbook, rels);
  const strings = await sharedStringsV1(pkg, rels);
  const sheets: SheetModelV1[] = [];
  for (const [index, sheet] of parts.sheets.entries()) {
    const bytes = sheet.part ? await readZipEntryV1(pkg, sheet.part) : null;
    // A chart sheet or a macro sheet has no cells here: an empty model keeps the indexes right.
    sheets.push(
      bytes && /worksheets\//u.test(sheet.part)
        ? sheetModelV1(index, sheet.name, sheet.part, bytes, strings)
        : {
            index,
            name: sheet.name,
            part: sheet.part,
            bytes: new Uint8Array(0),
            cells: new Map(),
            groups: [],
          },
    );
  }
  return {
    sheets,
    sheetByName: new Map(sheets.map((sheet) => [sheet.name.toLocaleUpperCase('pt-BR'), sheet])),
    names: parts.names,
    books: parts.books,
    xti: parts.xti,
  };
}
