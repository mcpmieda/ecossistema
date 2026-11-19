/**
 * BIFF12 formula tokens (rgce, MS-XLSB 2.5.97) decoded into reverse-Polish tokens. Anything not
 * listed here is reported as unsupported, so a formula is either read whole or not at all.
 */
export type TokenClassV1 = 'R' | 'V' | 'A' | null;

export type TokenV1 =
  | { readonly k: 'num'; readonly v: number }
  | { readonly k: 'str'; readonly v: string }
  | { readonly k: 'bool'; readonly v: boolean }
  | { readonly k: 'err'; readonly v: number }
  | { readonly k: 'miss' }
  | { readonly k: 'bin'; readonly op: BinaryOpV1 }
  | { readonly k: 'unary'; readonly op: 'u+' | 'u-' | '%' }
  | { readonly k: 'paren' }
  | { readonly k: 'exp'; readonly row: number }
  /** A cell or area of the formula's own sheet (rows and columns absolute). */
  | {
      readonly k: 'area';
      readonly cls: TokenClassV1;
      readonly r1: number;
      readonly r2: number;
      readonly c1: number;
      readonly c2: number;
    }
  /** A cell or area relative to the formula's cell (shared formulas and relative names). */
  | {
      readonly k: 'areaN';
      readonly cls: TokenClassV1;
      readonly r1: number;
      readonly r2: number;
      readonly c1: number;
      readonly c2: number;
      readonly r1Rel: boolean;
      readonly r2Rel: boolean;
      readonly c1Rel: boolean;
      readonly c2Rel: boolean;
    }
  /** A cell or area through a sheet reference (XTI): another sheet or another workbook. */
  | {
      readonly k: 'area3d';
      readonly cls: TokenClassV1;
      readonly ixti: number;
      readonly r1: number;
      readonly r2: number;
      readonly c1: number;
      readonly c2: number;
    }
  | { readonly k: 'refErr'; readonly cls: TokenClassV1 }
  | { readonly k: 'name'; readonly cls: TokenClassV1; readonly index: number }
  | {
      readonly k: 'nameX';
      readonly cls: TokenClassV1;
      readonly ixti: number;
      readonly index: number;
    }
  /** A function with a fixed number of arguments (iftab), or a variable one (argc given). */
  | {
      readonly k: 'func';
      readonly cls: TokenClassV1;
      readonly tab: number;
      readonly argc: number | null;
    }
  /** SUM of the single argument on the stack (PtgAttrSum). */
  | { readonly k: 'attrSum' }
  /** A volatile formula (PtgAttrSemi). */
  | { readonly k: 'volatile' };

export type BinaryOpV1 =
  | '+'
  | '-'
  | '*'
  | '/'
  | '^'
  | '&'
  | '<'
  | '<='
  | '='
  | '>='
  | '>'
  | '<>'
  | 'isect'
  | 'union'
  | ':';

export class UnsupportedFormulaError extends Error {
  constructor(readonly reason: string) {
    super(`Unsupported formula: ${reason}`);
  }
}

const u16 = (d: Uint8Array, at: number): number => d[at]! | (d[at + 1]! << 8);
const u32 = (d: Uint8Array, at: number): number =>
  (d[at]! | (d[at + 1]! << 8) | (d[at + 2]! << 16)) + d[at + 3]! * 0x1000000;
const i32 = (d: Uint8Array, at: number): number => {
  const value = u32(d, at);
  return value > 0x7fffffff ? value - 0x100000000 : value;
};

const BINARY_V1: Readonly<Record<number, BinaryOpV1>> = {
  0x03: '+',
  0x04: '-',
  0x05: '*',
  0x06: '/',
  0x07: '^',
  0x08: '&',
  0x09: '<',
  0x0a: '<=',
  0x0b: '=',
  0x0c: '>=',
  0x0d: '>',
  0x0e: '<>',
  0x0f: 'isect',
  0x10: 'union',
  0x11: ':',
};

const CLASS_V1: readonly TokenClassV1[] = [null, 'R', 'V', 'A'];

/**
 * Number of arguments of the fixed-argument functions this engine knows (PtgFunc carries only the
 * function number). A fixed function not listed cannot be read, so the formula is unsupported.
 */
export const FIXED_ARGC_V1: ReadonlyMap<number, number> = new Map([
  [2, 1], // ISNA
  [3, 1], // ISERROR
  [10, 0], // NA
  [24, 1], // ABS
  [25, 1], // INT
  [27, 2], // ROUND
  [31, 3], // MID
  [32, 1], // LEN
  [33, 1], // VALUE
  [34, 0], // TRUE
  [35, 0], // FALSE
  [38, 1], // NOT
  [39, 2], // MOD
  [48, 2], // TEXT
  [65, 3], // DATE
  [67, 1], // DAY
  [68, 1], // MONTH
  [69, 1], // YEAR
  [74, 0], // NOW
  [112, 1], // LOWER
  [113, 1], // UPPER
  [117, 2], // EXACT
  [118, 1], // TRIM
  [126, 1], // ISERR
  [127, 1], // ISTEXT
  [128, 1], // ISNUMBER
  [129, 1], // ISBLANK
  [190, 1], // ISNONTEXT
  [198, 1], // ISLOGICAL
  [212, 2], // ROUNDUP
  [213, 2], // ROUNDDOWN
  [221, 0], // TODAY
  [325, 2], // LARGE
  [326, 2], // SMALL
  [346, 2], // COUNTIF
  [347, 1], // COUNTBLANK
  [480, 2], // IFERROR
]);

function areaV1(cls: TokenClassV1, d: Uint8Array, at: number) {
  return {
    r1: u32(d, at),
    r2: u32(d, at + 4),
    c1: u16(d, at + 8) & 0x3fff,
    c2: u16(d, at + 10) & 0x3fff,
    cls,
  };
}

/** A relative column (14 bits, signed when relative) of RgceLocRel / RgceAreaRel. */
function relColumnV1(raw: number): { col: number; rel: boolean; rowRel: boolean } {
  const rel = (raw & 0x4000) !== 0;
  const rowRel = (raw & 0x8000) !== 0;
  let col = raw & 0x3fff;
  if (rel && col >= 0x2000) col -= 0x4000;
  return { col, rel, rowRel };
}

/**
 * The tokens of a formula. `relative` reads cell references the way shared formulas and names
 * store them (offsets from the formula's cell when flagged relative).
 */
export function decodeFormulaV1(rgce: Uint8Array, relative = false): TokenV1[] {
  const tokens: TokenV1[] = [];
  let at = 0;
  const need = (size: number) => {
    if (at + size > rgce.length) throw new UnsupportedFormulaError('truncated tokens');
  };
  while (at < rgce.length) {
    const ptg = rgce[at]!;
    const base = ptg >= 0x20 ? (ptg & 0x1f) | 0x20 : ptg;
    const cls = ptg >= 0x20 ? CLASS_V1[ptg >> 5]! : null;
    switch (base) {
      case 0x01:
        need(5);
        tokens.push({ k: 'exp', row: u32(rgce, at + 1) });
        at += 5;
        break;
      case 0x12:
        tokens.push({ k: 'unary', op: 'u+' });
        at += 1;
        break;
      case 0x13:
        tokens.push({ k: 'unary', op: 'u-' });
        at += 1;
        break;
      case 0x14:
        tokens.push({ k: 'unary', op: '%' });
        at += 1;
        break;
      case 0x15:
        tokens.push({ k: 'paren' });
        at += 1;
        break;
      case 0x16:
        tokens.push({ k: 'miss' });
        at += 1;
        break;
      case 0x17: {
        need(3);
        const count = u16(rgce, at + 1);
        need(3 + count * 2);
        tokens.push({
          k: 'str',
          v: new TextDecoder('utf-16le').decode(rgce.subarray(at + 3, at + 3 + count * 2)),
        });
        at += 3 + count * 2;
        break;
      }
      case 0x19: {
        need(4);
        const kind = rgce[at + 1]!;
        if (kind === 0x04) {
          // AttrChoose: a jump table; CHOOSE itself follows as a function.
          const count = u16(rgce, at + 2);
          at += 4 + 2 * (count + 1);
          break;
        }
        if (kind === 0x10) tokens.push({ k: 'attrSum' });
        else if (kind === 0x01) tokens.push({ k: 'volatile' });
        else if (![0x02, 0x08, 0x20, 0x40, 0x41, 0x80].includes(kind))
          throw new UnsupportedFormulaError(`attribute ${kind}`);
        at += 4;
        break;
      }
      case 0x1c:
        need(2);
        tokens.push({ k: 'err', v: rgce[at + 1]! });
        at += 2;
        break;
      case 0x1d:
        need(2);
        tokens.push({ k: 'bool', v: rgce[at + 1] !== 0 });
        at += 2;
        break;
      case 0x1e:
        need(3);
        tokens.push({ k: 'num', v: u16(rgce, at + 1) });
        at += 3;
        break;
      case 0x1f:
        need(9);
        tokens.push({
          k: 'num',
          v: new DataView(rgce.buffer, rgce.byteOffset + at + 1, 8).getFloat64(0, true),
        });
        at += 9;
        break;
      case 0x21: {
        need(3);
        const tab = u16(rgce, at + 1);
        tokens.push({ k: 'func', cls, tab, argc: FIXED_ARGC_V1.get(tab) ?? null });
        at += 3;
        break;
      }
      case 0x22:
        need(4);
        tokens.push({ k: 'func', cls, tab: u16(rgce, at + 2) & 0x7fff, argc: rgce[at + 1]! });
        at += 4;
        break;
      case 0x23:
        need(5);
        tokens.push({ k: 'name', cls, index: u32(rgce, at + 1) });
        at += 5;
        break;
      case 0x24: {
        need(7);
        const row = u32(rgce, at + 1);
        const colRaw = u16(rgce, at + 5);
        if (relative && (colRaw & 0xc000) !== 0) {
          const c = relColumnV1(colRaw);
          const r = c.rowRel ? i32(rgce, at + 1) : row;
          tokens.push({
            k: 'areaN',
            cls,
            r1: r,
            r2: r,
            c1: c.col,
            c2: c.col,
            r1Rel: c.rowRel,
            r2Rel: c.rowRel,
            c1Rel: c.rel,
            c2Rel: c.rel,
          });
        } else
          tokens.push({
            k: 'area',
            cls,
            r1: row,
            r2: row,
            c1: colRaw & 0x3fff,
            c2: colRaw & 0x3fff,
          });
        at += 7;
        break;
      }
      case 0x25: {
        need(13);
        const a = areaV1(cls, rgce, at + 1);
        if (relative && ((u16(rgce, at + 9) | u16(rgce, at + 11)) & 0xc000) !== 0) {
          const first = relColumnV1(u16(rgce, at + 9));
          const last = relColumnV1(u16(rgce, at + 11));
          tokens.push({
            k: 'areaN',
            cls,
            r1: first.rowRel ? i32(rgce, at + 1) : a.r1,
            r2: last.rowRel ? i32(rgce, at + 5) : a.r2,
            c1: first.col,
            c2: last.col,
            r1Rel: first.rowRel,
            r2Rel: last.rowRel,
            c1Rel: first.rel,
            c2Rel: last.rel,
          });
        } else tokens.push({ k: 'area', ...a });
        at += 13;
        break;
      }
      case 0x26:
      case 0x27:
      case 0x28:
        // PtgMemArea / MemErr / MemNoMem: a hint before a reference subexpression.
        need(7);
        at += 7;
        break;
      case 0x29:
        need(3);
        at += 3;
        break;
      case 0x2a:
        need(7);
        tokens.push({ k: 'refErr', cls });
        at += 7;
        break;
      case 0x2b:
        need(13);
        tokens.push({ k: 'refErr', cls });
        at += 13;
        break;
      case 0x2c: {
        need(7);
        const c = relColumnV1(u16(rgce, at + 5));
        const r = c.rowRel ? i32(rgce, at + 1) : u32(rgce, at + 1);
        tokens.push({
          k: 'areaN',
          cls,
          r1: r,
          r2: r,
          c1: c.col,
          c2: c.col,
          r1Rel: c.rowRel,
          r2Rel: c.rowRel,
          c1Rel: c.rel,
          c2Rel: c.rel,
        });
        at += 7;
        break;
      }
      case 0x2d: {
        need(13);
        const first = relColumnV1(u16(rgce, at + 9));
        const last = relColumnV1(u16(rgce, at + 11));
        tokens.push({
          k: 'areaN',
          cls,
          r1: first.rowRel ? i32(rgce, at + 1) : u32(rgce, at + 1),
          r2: last.rowRel ? i32(rgce, at + 5) : u32(rgce, at + 5),
          c1: first.col,
          c2: last.col,
          r1Rel: first.rowRel,
          r2Rel: last.rowRel,
          c1Rel: first.rel,
          c2Rel: last.rel,
        });
        at += 13;
        break;
      }
      case 0x39:
        need(7);
        tokens.push({ k: 'nameX', cls, ixti: u16(rgce, at + 1), index: u32(rgce, at + 3) });
        at += 7;
        break;
      case 0x3a: {
        need(9);
        const colRaw = u16(rgce, at + 7);
        if (relative && (colRaw & 0xc000) !== 0)
          throw new UnsupportedFormulaError('relative 3D reference');
        const row = u32(rgce, at + 3);
        tokens.push({
          k: 'area3d',
          cls,
          ixti: u16(rgce, at + 1),
          r1: row,
          r2: row,
          c1: colRaw & 0x3fff,
          c2: colRaw & 0x3fff,
        });
        at += 9;
        break;
      }
      case 0x3b: {
        need(15);
        if (relative && ((u16(rgce, at + 11) | u16(rgce, at + 13)) & 0xc000) !== 0)
          throw new UnsupportedFormulaError('relative 3D reference');
        tokens.push({ k: 'area3d', ixti: u16(rgce, at + 1), ...areaV1(cls, rgce, at + 3) });
        at += 15;
        break;
      }
      case 0x3c:
        need(9);
        tokens.push({ k: 'refErr', cls });
        at += 9;
        break;
      case 0x3d:
        need(15);
        tokens.push({ k: 'refErr', cls });
        at += 15;
        break;
      default: {
        const op = BINARY_V1[base];
        if (op) {
          tokens.push({ k: 'bin', op });
          at += 1;
          break;
        }
        throw new UnsupportedFormulaError(`token 0x${ptg.toString(16)}`);
      }
    }
  }
  return tokens;
}
