import type { RealSheetJsV1 } from './sheetjs-real-v1';

/**
 * SheetJS cannot write formulas to `.xlsb`. These helpers rewrite cell records of a
 * SheetJS-written synthetic workbook into BIFF12 formula records ([MS-XLSB] 2.4.655 BrtFmlaNum,
 * 2.4.750 BrtShrFmla, 2.4.6 BrtArrFmla), so tests can compare readers on real binary formulas.
 * Every injected value is synthetic.
 */
export type XlsbFormulaInjectionV1 =
  | { kind: 'plain'; sheet: string; row: number; column: number; value: number }
  | {
      kind: 'shared' | 'array';
      sheet: string;
      firstRow: number;
      lastRow: number;
      column: number;
      value: number;
    };

type CfbV1 = {
  read: (data: Uint8Array, options: { type: 'array' }) => unknown;
  find: (container: unknown, path: string) => { content: Uint8Array | number[] } | null;
  write: (container: unknown, options: { type: 'array'; fileType: 'zip' }) => ArrayLike<number>;
};

function varintV1(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0);
  return bytes;
}

function recordV1(type: number, payload: number[]): number[] {
  const typeBytes = type < 0x80 ? [type] : [(type & 0x7f) | 0x80, type >> 7];
  return [...typeBytes, ...varintV1(payload.length), ...payload];
}

function u32V1(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function f64V1(value: number): number[] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return [...new Uint8Array(view.buffer)];
}

/** CellParsedFormula/SharedParsedFormula/ArrayParsedFormula: cce, rgce, cb, rgcb. */
function parsedFormulaV1(rgce: number[], rgcb: number[] = []): number[] {
  return [...u32V1(rgce.length), ...rgce, ...u32V1(rgcb.length), ...rgcb];
}

/** `=<small integer>`: one PtgInt token. */
function constantFormulaV1(value: number): number[] {
  return parsedFormulaV1([0x1e, value & 0xff, (value >> 8) & 0xff]);
}

/** PtgExp to the anchor; in BIFF12 the anchor column travels in the extra data. */
function anchorReferenceV1(row: number, column: number): number[] {
  return parsedFormulaV1([0x01, ...u32V1(row)], u32V1(column));
}

function formulaCellV1(column: number, style: number[], value: number, formula: number[]): number[] {
  return recordV1(0x0009, [...u32V1(column), ...style, ...f64V1(value), 0, 0, ...formula]);
}

function rfxV1(firstRow: number, lastRow: number, column: number): number[] {
  return [...u32V1(firstRow), ...u32V1(lastRow), ...u32V1(column), ...u32V1(column)];
}

function readU32V1(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function rewriteSheetV1(bytes: Uint8Array, injections: readonly XlsbFormulaInjectionV1[]): Uint8Array {
  const out: number[] = [];
  let position = 0;
  let row = -1;
  let column = -1;
  while (position < bytes.length) {
    const start = position;
    let type = bytes[position++]!;
    if (type & 0x80) type = (type & 0x7f) | ((bytes[position++]! & 0x7f) << 7);
    let size = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = bytes[position++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    const payload = bytes.subarray(position, position + size);
    position += size;
    if (type === 0x0000) {
      row = readU32V1(payload, 0);
      column = -1;
    }
    const isCell = (type >= 0x0001 && type <= 0x0012) || type === 0x003e;
    const isShort = type >= 0x000c && type <= 0x0012;
    if (isCell) column = isShort ? column + 1 : readU32V1(payload, 0);
    const target = isCell
      ? injections.find((item) =>
          item.kind === 'plain'
            ? item.row === row && item.column === column
            : item.column === column && row >= item.firstRow && row <= item.lastRow,
        )
      : undefined;
    if (!target) {
      out.push(...bytes.subarray(start, position));
      continue;
    }
    const style = [...payload.subarray(isShort ? 0 : 4, isShort ? 4 : 8)];
    if (target.kind === 'plain') {
      out.push(...formulaCellV1(column, style, target.value, constantFormulaV1(target.value)));
      continue;
    }
    out.push(...formulaCellV1(column, style, target.value, anchorReferenceV1(target.firstRow, column)));
    if (row !== target.firstRow) continue;
    const range = rfxV1(target.firstRow, target.lastRow, column);
    if (target.kind === 'shared') out.push(...recordV1(0x01ab, [...range, ...constantFormulaV1(target.value)]));
    else out.push(...recordV1(0x01aa, [...range, 0, ...constantFormulaV1(target.value)]));
  }
  return Uint8Array.from(out);
}

/** Rewrites the listed cells of a SheetJS-written `.xlsb` into formula records. */
export function injectXlsbFormulasV1(
  xlsx: RealSheetJsV1,
  bytes: ArrayBuffer,
  injections: readonly XlsbFormulaInjectionV1[],
): ArrayBuffer {
  const cfb = (xlsx as unknown as { CFB: CfbV1 }).CFB;
  const container = cfb.read(new Uint8Array(bytes), { type: 'array' });
  const book = xlsx.read(bytes, { type: 'array', sheetRows: 1 }) as unknown as {
    SheetNames: string[];
    Workbook?: { Sheets?: Array<{ id?: string; strRelID?: string }> };
  };
  const rels = cfb.find(container, '/xl/_rels/workbook.bin.rels');
  if (!rels) throw new Error('synthetic-xlsb-without-rels');
  const xml = new TextDecoder().decode(Uint8Array.from(rels.content));
  for (const sheet of new Set(injections.map((item) => item.sheet))) {
    const index = book.SheetNames.indexOf(sheet);
    const relation = book.Workbook?.Sheets?.[index];
    const id = relation?.id ?? relation?.strRelID;
    const target = id ? new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`, 'u').exec(xml)?.[1] : undefined;
    if (!target) throw new Error('synthetic-xlsb-sheet-not-found');
    const entry = cfb.find(container, `/xl/${target.replace(/^\/?xl\//u, '')}`);
    if (!entry) throw new Error('synthetic-xlsb-part-not-found');
    entry.content = rewriteSheetV1(Uint8Array.from(entry.content), injections.filter((item) => item.sheet === sheet));
  }
  return Uint8Array.from(cfb.write(container, { type: 'array', fileType: 'zip' })).buffer;
}
