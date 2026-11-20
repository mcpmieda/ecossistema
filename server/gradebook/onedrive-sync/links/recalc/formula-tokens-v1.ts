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

/** Where a token is read: the formula bytes, its offset, class and reading mode. */
type CursorV1 = {
  readonly d: Uint8Array;
  readonly at: number;
  readonly cls: TokenClassV1;
  readonly relative: boolean;
};

/**
 * A token reader: checks the bytes it needs, then gives the token (or null for a token that only
 * guides Excel) and how many bytes it takes.
 */
type ReaderV1 = (c: CursorV1) => { token: TokenV1 | null; size: number };

function needV1(c: CursorV1, size: number): void {
  if (c.at + size > c.d.length) throw new UnsupportedFormulaError('truncated tokens');
}

/** A reader of a fixed-size token. */
const fixedV1 =
  (size: number, read: (c: CursorV1) => TokenV1 | null): ReaderV1 =>
  (c) => {
    needV1(c, size);
    return { token: read(c), size };
  };

const rowV1 = (d: Uint8Array, at: number, rel: boolean): number => (rel ? i32(d, at) : u32(d, at));

function areaNTokenV1(
  cls: TokenClassV1,
  r1: number,
  r2: number,
  first: ReturnType<typeof relColumnV1>,
  last: ReturnType<typeof relColumnV1>,
): TokenV1 {
  return {
    k: 'areaN',
    cls,
    r1,
    r2,
    c1: first.col,
    c2: last.col,
    r1Rel: first.rowRel,
    r2Rel: last.rowRel,
    c1Rel: first.rel,
    c2Rel: last.rel,
  };
}

/** PtgRefN (or a relative PtgRef in a shared formula or name). */
function refNV1({ d, at, cls }: CursorV1): TokenV1 {
  const col = relColumnV1(u16(d, at + 5));
  const row = rowV1(d, at + 1, col.rowRel);
  return areaNTokenV1(cls, row, row, col, col);
}

/** PtgAreaN (or a relative PtgArea in a shared formula or name). */
function areaNV1({ d, at, cls }: CursorV1): TokenV1 {
  const first = relColumnV1(u16(d, at + 9));
  const last = relColumnV1(u16(d, at + 11));
  return areaNTokenV1(
    cls,
    rowV1(d, at + 1, first.rowRel),
    rowV1(d, at + 5, last.rowRel),
    first,
    last,
  );
}

function refV1(c: CursorV1): TokenV1 {
  const colRaw = u16(c.d, c.at + 5);
  if (c.relative && (colRaw & 0xc000) !== 0) return refNV1(c);
  const row = u32(c.d, c.at + 1);
  return { k: 'area', cls: c.cls, r1: row, r2: row, c1: colRaw & 0x3fff, c2: colRaw & 0x3fff };
}

function areaTokenV1(c: CursorV1): TokenV1 {
  if (c.relative && ((u16(c.d, c.at + 9) | u16(c.d, c.at + 11)) & 0xc000) !== 0) return areaNV1(c);
  return { k: 'area', ...areaV1(c.cls, c.d, c.at + 1) };
}

function ref3dV1({ d, at, cls, relative }: CursorV1): TokenV1 {
  const colRaw = u16(d, at + 7);
  if (relative && (colRaw & 0xc000) !== 0)
    throw new UnsupportedFormulaError('relative 3D reference');
  const row = u32(d, at + 3);
  const col = colRaw & 0x3fff;
  return { k: 'area3d', cls, ixti: u16(d, at + 1), r1: row, r2: row, c1: col, c2: col };
}

function area3dV1({ d, at, cls, relative }: CursorV1): TokenV1 {
  if (relative && ((u16(d, at + 11) | u16(d, at + 13)) & 0xc000) !== 0)
    throw new UnsupportedFormulaError('relative 3D reference');
  return { k: 'area3d', ixti: u16(d, at + 1), ...areaV1(cls, d, at + 3) };
}

/** PtgStr: a count of UTF-16 units, then the units. */
const stringV1: ReaderV1 = (c) => {
  needV1(c, 3);
  const count = u16(c.d, c.at + 1);
  needV1(c, 3 + count * 2);
  const text = new TextDecoder('utf-16le').decode(c.d.subarray(c.at + 3, c.at + 3 + count * 2));
  return { token: { k: 'str', v: text }, size: 3 + count * 2 };
};

/** Attributes that only guide Excel (if/goto jumps, spaces, PtgAttrBaxcel). */
const IGNORED_ATTRIBUTES_V1: readonly number[] = [0x02, 0x08, 0x20, 0x40, 0x41, 0x80];

/** PtgAttr*: SUM of one argument, volatile, a CHOOSE jump table, or a hint. */
const attributeV1: ReaderV1 = (c) => {
  needV1(c, 4);
  const kind = c.d[c.at + 1]!;
  // AttrChoose: a jump table; CHOOSE itself follows as a function.
  if (kind === 0x04) return { token: null, size: 4 + 2 * (u16(c.d, c.at + 2) + 1) };
  if (kind === 0x10) return { token: { k: 'attrSum' }, size: 4 };
  if (kind === 0x01) return { token: { k: 'volatile' }, size: 4 };
  if (!IGNORED_ATTRIBUTES_V1.includes(kind)) throw new UnsupportedFormulaError(`attribute ${kind}`);
  return { token: null, size: 4 };
};

const refErrV1 = (size: number): ReaderV1 => fixedV1(size, ({ cls }) => ({ k: 'refErr', cls }));

/** Readers by base token (class bits removed). Binary operators are read apart. */
const READERS_V1: ReadonlyMap<number, ReaderV1> = new Map<number, ReaderV1>([
  [0x01, fixedV1(5, ({ d, at }) => ({ k: 'exp', row: u32(d, at + 1) }))],
  [0x12, fixedV1(1, () => ({ k: 'unary', op: 'u+' }))],
  [0x13, fixedV1(1, () => ({ k: 'unary', op: 'u-' }))],
  [0x14, fixedV1(1, () => ({ k: 'unary', op: '%' }))],
  [0x15, fixedV1(1, () => ({ k: 'paren' }))],
  [0x16, fixedV1(1, () => ({ k: 'miss' }))],
  [0x17, stringV1],
  [0x19, attributeV1],
  [0x1c, fixedV1(2, ({ d, at }) => ({ k: 'err', v: d[at + 1]! }))],
  [0x1d, fixedV1(2, ({ d, at }) => ({ k: 'bool', v: d[at + 1] !== 0 }))],
  [0x1e, fixedV1(3, ({ d, at }) => ({ k: 'num', v: u16(d, at + 1) }))],
  [
    0x1f,
    fixedV1(9, ({ d, at }) => ({
      k: 'num',
      v: new DataView(d.buffer, d.byteOffset + at + 1, 8).getFloat64(0, true),
    })),
  ],
  [
    0x21,
    fixedV1(3, ({ d, at, cls }) => {
      const tab = u16(d, at + 1);
      return { k: 'func', cls, tab, argc: FIXED_ARGC_V1.get(tab) ?? null };
    }),
  ],
  [
    0x22,
    fixedV1(4, ({ d, at, cls }) => ({
      k: 'func',
      cls,
      tab: u16(d, at + 2) & 0x7fff,
      argc: d[at + 1]!,
    })),
  ],
  [0x23, fixedV1(5, ({ d, at, cls }) => ({ k: 'name', cls, index: u32(d, at + 1) }))],
  [0x24, fixedV1(7, refV1)],
  [0x25, fixedV1(13, areaTokenV1)],
  // PtgMemArea / MemErr / MemNoMem: a hint before a reference subexpression.
  [0x26, fixedV1(7, () => null)],
  [0x27, fixedV1(7, () => null)],
  [0x28, fixedV1(7, () => null)],
  [0x29, fixedV1(3, () => null)],
  [0x2a, refErrV1(7)],
  [0x2b, refErrV1(13)],
  [0x2c, fixedV1(7, refNV1)],
  [0x2d, fixedV1(13, areaNV1)],
  [
    0x39,
    fixedV1(7, ({ d, at, cls }) => ({
      k: 'nameX',
      cls,
      ixti: u16(d, at + 1),
      index: u32(d, at + 3),
    })),
  ],
  [0x3a, fixedV1(9, ref3dV1)],
  [0x3b, fixedV1(15, area3dV1)],
  [0x3c, refErrV1(9)],
  [0x3d, refErrV1(15)],
]);

/** A binary operator; anything else not listed is unsupported. */
function binaryReaderV1(base: number, ptg: number): ReaderV1 {
  const op = BINARY_V1[base];
  if (!op) throw new UnsupportedFormulaError(`token 0x${ptg.toString(16)}`);
  return () => ({ token: { k: 'bin', op }, size: 1 });
}

/**
 * The tokens of a formula. `relative` reads cell references the way shared formulas and names
 * store them (offsets from the formula's cell when flagged relative).
 */
export function decodeFormulaV1(rgce: Uint8Array, relative = false): TokenV1[] {
  const tokens: TokenV1[] = [];
  let at = 0;
  while (at < rgce.length) {
    const ptg = rgce[at]!;
    const base = ptg >= 0x20 ? (ptg & 0x1f) | 0x20 : ptg;
    const cls = ptg >= 0x20 ? CLASS_V1[ptg >> 5]! : null;
    const reader = READERS_V1.get(base) ?? binaryReaderV1(base, ptg);
    const { token, size } = reader({ d: rgce, at, cls, relative });
    if (token) tokens.push(token);
    at += size;
  }
  return tokens;
}
