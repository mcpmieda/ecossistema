import {
  decodeFormulaV1,
  UnsupportedFormulaError,
  type BinaryOpV1,
  type TokenV1,
} from './formula-tokens-v1';
import { functionByNameV1, functionNameV1 } from './functions-v1';
import {
  compareV1,
  ERR_V1,
  errorV1,
  isArrayV1,
  isErrorV1,
  isMissingV1,
  isRefV1,
  MISSING_V1,
  numberResultV1,
  toNumberV1,
  toTextV1,
  unsupportedV1,
  type ArrayV1,
  type EvalValueV1,
  type RefV1,
  type ScalarV1,
} from './values-v1';
import type { WorkbookModelV1 } from './workbook-model-v1';

/** Where a formula is evaluated and how it reads cells of this and of linked workbooks. */
export type EvalContextV1 = {
  readonly model: WorkbookModelV1;
  /** Current value of a cell of this workbook (the new one once recalculated). */
  readonly cellValue: (sheet: number, row: number, col: number) => ScalarV1;
  /** Non-empty cells of an area of this workbook, with their current values. */
  readonly cellsIn: (
    sheet: number,
    area: AreaV1,
  ) => Iterable<{ row: number; col: number; value: ScalarV1 }>;
  /** A linked workbook's cell from the link's copy; undefined when the sheet is not in it. */
  readonly externalValue: (
    part: string,
    sheet: string,
    row: number,
    col: number,
  ) => ScalarV1 | undefined;
  readonly externalCellsIn: (
    part: string,
    sheet: string,
    area: AreaV1,
  ) => Iterable<{ row: number; col: number; value: ScalarV1 }> | undefined;
  /** The area a linked workbook's name points to; null when unknown. */
  readonly externalName: (part: string, index: number) => RefV1 | null;
  /** The name of a linked workbook's sheet by its position in the link. */
  readonly externalSheet: (part: string, index: number) => string | null;
  readonly sheet: number;
  readonly row: number;
  readonly col: number;
  /** An array formula: areas and operations give arrays. */
  readonly array: boolean;
};

export type AreaV1 = {
  readonly r1: number;
  readonly r2: number;
  readonly c1: number;
  readonly c2: number;
};

/** A future function's name on the stack (PtgName to "_xlfn.IFS" before PtgFuncVar 255). */
type FunctionNameV1 = { readonly kind: 'fname'; readonly name: string };
type StackValueV1 = EvalValueV1 | FunctionNameV1;
const isFunctionNameV1 = (value: unknown): value is FunctionNameV1 =>
  typeof value === 'object' && value !== null && (value as FunctionNameV1).kind === 'fname';

const MAX_AREA_CELLS_V1 = 1_048_576;

/* ---------------------------------------------------------------- references */

function refFromXtiV1(ctx: EvalContextV1, ixti: number, area: AreaV1): RefV1 {
  const xti = ctx.model.xti[ixti];
  if (!xti) return unsupportedV1('sheet reference outside the list');
  const book = ctx.model.books[xti.book];
  if (!book) return unsupportedV1('workbook reference outside the list');
  if (xti.first < 0) return unsupportedV1('reference to a deleted sheet');
  if (xti.first !== xti.last) return unsupportedV1('reference to several sheets');
  if (book.kind === 'self') return { kind: 'ref', book: 'self', sheet: xti.first, ...area };
  if (!book.part) return unsupportedV1('add-in reference');
  const sheet = ctx.externalSheet(book.part, xti.first);
  if (sheet === null) return unsupportedV1('linked sheet not in the link');
  return { kind: 'ref', book: book.part, sheet, ...area };
}

/** Value of one cell of a reference. */
export function cellOfRefV1(ctx: EvalContextV1, ref: RefV1, row: number, col: number): ScalarV1 {
  if (ref.book === 'self') return ctx.cellValue(ref.sheet as number, row, col);
  const value = ctx.externalValue(ref.book, ref.sheet as string, row, col);
  return value === undefined ? errorV1(ERR_V1.REF) : value;
}

/** Non-empty cells of a reference, in order (row by row). */
export function cellsOfRefV1(
  ctx: EvalContextV1,
  ref: RefV1,
): Iterable<{ row: number; col: number; value: ScalarV1 }> {
  if (ref.book === 'self') return ctx.cellsIn(ref.sheet as number, ref);
  const cells = ctx.externalCellsIn(ref.book, ref.sheet as string, ref);
  return cells ?? [{ row: ref.r1, col: ref.c1, value: errorV1(ERR_V1.REF) }];
}

export const refSizeV1 = (ref: AreaV1): number => (ref.r2 - ref.r1 + 1) * (ref.c2 - ref.c1 + 1);

/** All cells of a reference as an array (empty cells as null). */
export function arrayOfRefV1(ctx: EvalContextV1, ref: RefV1): ArrayV1 {
  const rows = ref.r2 - ref.r1 + 1;
  const cols = ref.c2 - ref.c1 + 1;
  if (rows * cols > MAX_AREA_CELLS_V1) return unsupportedV1('area too large for an array');
  const data: ScalarV1[] = new Array(rows * cols).fill(null);
  for (const cell of cellsOfRefV1(ctx, ref))
    data[(cell.row - ref.r1) * cols + (cell.col - ref.c1)] = cell.value;
  return { kind: 'array', rows, cols, data };
}

/** A value used where one value is expected: implicit intersection of an area with the formula's cell. */
export function scalarOfV1(ctx: EvalContextV1, value: EvalValueV1): ScalarV1 {
  if (isMissingV1(value)) return null;
  if (isArrayV1(value)) return value.data[0] ?? null;
  if (!isRefV1(value)) return value;
  if (value.r1 === value.r2 && value.c1 === value.c2)
    return cellOfRefV1(ctx, value, value.r1, value.c1);
  if (value.c1 === value.c2 && ctx.row >= value.r1 && ctx.row <= value.r2)
    return cellOfRefV1(ctx, value, ctx.row, value.c1);
  if (value.r1 === value.r2 && ctx.col >= value.c1 && ctx.col <= value.c2)
    return cellOfRefV1(ctx, value, value.r1, ctx.col);
  return errorV1(ERR_V1.VALUE);
}

/** A value as an array: references are read whole, a single value is a 1×1 array. */
export function arrayOfV1(ctx: EvalContextV1, value: EvalValueV1): ArrayV1 {
  if (isArrayV1(value)) return value;
  if (isRefV1(value)) return arrayOfRefV1(ctx, value);
  return { kind: 'array', rows: 1, cols: 1, data: [isMissingV1(value) ? null : value] };
}

/** In an array formula an area is an array; elsewhere one value (implicit intersection). */
function operandV1(ctx: EvalContextV1, value: EvalValueV1): ScalarV1 | ArrayV1 {
  if (isArrayV1(value)) return value;
  if (isRefV1(value) && ctx.array && refSizeV1(value) > 1) return arrayOfRefV1(ctx, value);
  return scalarOfV1(ctx, value);
}

/* ---------------------------------------------------------------- element-wise */

/** Applies `fn` element by element; arrays of different sizes broadcast like Excel (#N/A outside). */
export function liftV1(
  args: readonly (ScalarV1 | ArrayV1)[],
  fn: (values: ScalarV1[]) => ScalarV1,
): ScalarV1 | ArrayV1 {
  const arrays = args.filter(isArrayV1);
  if (arrays.length === 0) return fn(args as ScalarV1[]);
  const rows = Math.max(...arrays.map((a) => a.rows));
  const cols = Math.max(...arrays.map((a) => a.cols));
  const data: ScalarV1[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const values = args.map((arg) => {
        if (!isArrayV1(arg)) return arg;
        const rr = arg.rows === 1 ? 0 : r;
        const cc = arg.cols === 1 ? 0 : c;
        if (rr >= arg.rows || cc >= arg.cols) return errorV1(ERR_V1.NA);
        return arg.data[rr * arg.cols + cc] ?? null;
      });
      data.push(fn(values));
    }
  return { kind: 'array', rows, cols, data };
}

/* ---------------------------------------------------------------- operators */

function concatenateV1(a: ScalarV1, b: ScalarV1): ScalarV1 {
  const x = toTextV1(a);
  if (isErrorV1(x)) return x;
  const y = toTextV1(b);
  if (isErrorV1(y)) return y;
  return x + y;
}

const COMPARISONS_V1: Readonly<Partial<Record<BinaryOpV1, (order: number) => boolean>>> = {
  '=': (order) => order === 0,
  '<>': (order) => order !== 0,
  '<': (order) => order < 0,
  '<=': (order) => order <= 0,
  '>': (order) => order > 0,
  '>=': (order) => order >= 0,
};

function arithmeticV1(op: BinaryOpV1, a: ScalarV1, b: ScalarV1): ScalarV1 {
  if (isErrorV1(a)) return a;
  if (isErrorV1(b)) return b;
  if (op === '&') return concatenateV1(a, b);
  const comparison = COMPARISONS_V1[op];
  if (comparison) return comparison(compareV1(a, b));
  const x = toNumberV1(a);
  if (isErrorV1(x)) return x;
  const y = toNumberV1(b);
  if (isErrorV1(y)) return y;
  return numericV1(op, x, y);
}

function numericV1(op: BinaryOpV1, x: number, y: number): ScalarV1 {
  switch (op) {
    case '+':
      return numberResultV1(x + y);
    case '-':
      return numberResultV1(x - y);
    case '*':
      return numberResultV1(x * y);
    case '/':
      return y === 0 ? errorV1(ERR_V1.DIV0) : numberResultV1(x / y);
    case '^':
      if (x === 0 && y === 0) return errorV1(ERR_V1.NUM);
      return numberResultV1(x ** y);
    default:
      return unsupportedV1(`operator ${op}`);
  }
}

function unaryV1(op: 'u+' | 'u-' | '%', a: ScalarV1): ScalarV1 {
  if (op === 'u+') return a;
  const x = toNumberV1(a);
  if (isErrorV1(x)) return x;
  return op === 'u-' ? -x : x / 100;
}

/* ---------------------------------------------------------------- evaluation */

function resolveAreaNV1(ctx: EvalContextV1, token: Extract<TokenV1, { k: 'areaN' }>): AreaV1 {
  const wrapRow = (value: number) => ((value % 1_048_576) + 1_048_576) % 1_048_576;
  const wrapCol = (value: number) => ((value % 16_384) + 16_384) % 16_384;
  return {
    r1: token.r1Rel ? wrapRow(ctx.row + token.r1) : token.r1,
    r2: token.r2Rel ? wrapRow(ctx.row + token.r2) : token.r2,
    c1: token.c1Rel ? wrapCol(ctx.col + token.c1) : token.c1,
    c2: token.c2Rel ? wrapCol(ctx.col + token.c2) : token.c2,
  };
}

/** The value of a defined name (a reference or a value), evaluated where the formula is. */
function nameValueV1(ctx: EvalContextV1, index: number): StackValueV1 {
  const name = ctx.model.names[index - 1];
  if (!name) return unsupportedV1('name outside the list');
  if (/^_xl(fn|ws)\./iu.test(name.name))
    return { kind: 'fname', name: name.name.replace(/^_xl(fn|ws)\./iu, '').toUpperCase() };
  const tokens = decodeFormulaV1(name.rgce, true);
  if (tokens.some((token) => token.k === 'areaN'))
    return unsupportedV1('name with a relative reference');
  return evaluateTokensV1(tokens, { ...ctx, array: true }, true);
}

function popArgsV1(stack: StackValueV1[], count: number): StackValueV1[] {
  if (stack.length < count) throw new UnsupportedFormulaError('malformed formula');
  return stack.splice(stack.length - count, count);
}

type ReferenceTokenV1 = Extract<TokenV1, { k: 'area' | 'areaN' | 'area3d' }>;

function referenceOfTokenV1(ctx: EvalContextV1, token: ReferenceTokenV1): RefV1 {
  if (token.k === 'area3d') return refFromXtiV1(ctx, token.ixti, token);
  const area =
    token.k === 'area'
      ? { r1: token.r1, r2: token.r2, c1: token.c1, c2: token.c2 }
      : resolveAreaNV1(ctx, token);
  return { kind: 'ref', book: 'self', sheet: ctx.sheet, ...area };
}

/** The area a linked workbook's name points to (PtgNameX). */
function linkedNameV1(ctx: EvalContextV1, token: Extract<TokenV1, { k: 'nameX' }>): RefV1 {
  const xti = ctx.model.xti[token.ixti];
  const book = xti ? ctx.model.books[xti.book] : undefined;
  if (!book || book.kind === 'self' || !book.part)
    return unsupportedV1('name of this workbook through a link');
  const ref = ctx.externalName(book.part, token.index);
  if (!ref) return unsupportedV1('linked name without a known area');
  return ref;
}

function binaryV1(stack: StackValueV1[], ctx: EvalContextV1, op: BinaryOpV1): EvalValueV1 {
  const [left, right] = popArgsV1(stack, 2) as EvalValueV1[];
  if (op === 'isect' || op === 'union' || op === ':')
    return unsupportedV1(`reference operator ${op}`);
  return liftV1([operandV1(ctx, left!), operandV1(ctx, right!)], ([a, b]) =>
    arithmeticV1(op, a!, b!),
  );
}

function callFunctionV1(
  stack: StackValueV1[],
  ctx: EvalContextV1,
  token: Extract<TokenV1, { k: 'func' }>,
): EvalValueV1 {
  if (token.argc === null)
    return unsupportedV1(`function ${functionNameV1(token.tab) ?? token.tab}`);
  const args = popArgsV1(stack, token.argc);
  let name: string | null;
  if (token.tab === 255) {
    const first = args.shift();
    name = isFunctionNameV1(first) ? first.name : null;
  } else name = functionNameV1(token.tab);
  const fn = name ? functionByNameV1(name) : undefined;
  if (!fn) return unsupportedV1(`function ${name ?? token.tab}`);
  if (args.some(isFunctionNameV1)) return unsupportedV1('function name used as a value');
  return fn(args as EvalValueV1[], ctx);
}

/** The value a token puts on the stack (operators and functions take theirs from it first). */
function tokenValueV1(
  stack: StackValueV1[],
  ctx: EvalContextV1,
  token: Exclude<TokenV1, { k: 'paren' }>,
): StackValueV1 {
  switch (token.k) {
    case 'num':
    case 'str':
    case 'bool':
      return token.v;
    case 'err':
      return errorV1(token.v);
    case 'miss':
      return MISSING_V1;
    case 'volatile':
      return unsupportedV1('volatile function');
    case 'exp':
      return unsupportedV1('nested array or shared formula');
    case 'refErr':
      return errorV1(ERR_V1.REF);
    case 'area':
    case 'areaN':
    case 'area3d':
      return referenceOfTokenV1(ctx, token);
    case 'name':
      return nameValueV1(ctx, token.index);
    case 'nameX':
      return linkedNameV1(ctx, token);
    case 'unary': {
      const [value] = popArgsV1(stack, 1) as EvalValueV1[];
      return liftV1([operandV1(ctx, value!)], ([a]) => unaryV1(token.op, a!));
    }
    case 'bin':
      return binaryV1(stack, ctx, token.op);
    case 'attrSum': {
      const [value] = popArgsV1(stack, 1) as EvalValueV1[];
      return functionByNameV1('SUM')!([value!], ctx);
    }
    case 'func':
      return callFunctionV1(stack, ctx, token);
    default:
      return unsupportedV1('token');
  }
}

/** Evaluates tokens; `keepReference` leaves a reference result as it is (names, INDEX…). */
export function evaluateTokensV1(
  tokens: readonly TokenV1[],
  ctx: EvalContextV1,
  keepReference = false,
): EvalValueV1 {
  const stack: StackValueV1[] = [];
  for (const token of tokens) if (token.k !== 'paren') stack.push(tokenValueV1(stack, ctx, token));
  if (stack.length !== 1) return unsupportedV1('malformed formula');
  const result = stack[0]!;
  if (isFunctionNameV1(result)) return unsupportedV1('function name as a result');
  if (keepReference || !isRefV1(result)) return result;
  return ctx.array && refSizeV1(result) > 1 ? arrayOfRefV1(ctx, result) : scalarOfV1(ctx, result);
}
