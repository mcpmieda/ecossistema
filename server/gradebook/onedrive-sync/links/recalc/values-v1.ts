import { UnsupportedFormulaError } from './formula-tokens-v1';
import { ERR_V1, errorV1, ExcelErrorV1, isErrorV1, type ScalarV1 } from './workbook-model-v1';

/**
 * Values during a calculation and Excel's rules to convert and compare them. Where Excel's result
 * depends on the language of the installation (decimal separator, TRUE/FALSE words, text order),
 * the formula is reported as unsupported instead of guessed.
 */

/** A reference: an area of this workbook's sheet, or of a sheet of another workbook (a link). */
export type RefV1 = {
  readonly kind: 'ref';
  /** 'self' for this workbook, or the link part of another one. */
  readonly book: string;
  /** Sheet index (this workbook) or sheet name (an external workbook). */
  readonly sheet: number | string;
  readonly r1: number;
  readonly r2: number;
  readonly c1: number;
  readonly c2: number;
};

/** An array value (row-major). */
export type ArrayV1 = {
  readonly kind: 'array';
  readonly rows: number;
  readonly cols: number;
  readonly data: ScalarV1[];
};

export const MISSING_V1 = { kind: 'missing' } as const;
export type MissingV1 = typeof MISSING_V1;

export type EvalValueV1 = ScalarV1 | RefV1 | ArrayV1 | MissingV1;

export const isRefV1 = (value: unknown): value is RefV1 =>
  typeof value === 'object' && value !== null && (value as RefV1).kind === 'ref';
export const isArrayV1 = (value: unknown): value is ArrayV1 =>
  typeof value === 'object' && value !== null && (value as ArrayV1).kind === 'array';
export const isMissingV1 = (value: unknown): value is MissingV1 => value === MISSING_V1;

export const unsupportedV1 = (reason: string): never => {
  throw new UnsupportedFormulaError(reason);
};

export const VALUE_ERROR_V1 = (): ExcelErrorV1 => errorV1(ERR_V1.VALUE);

/** Text of an integer-or-not number as Excel converts it in a formula, ignoring the separator. */
function generalTextV1(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (Number.isInteger(value) && abs < 1e15) return String(value);
  if (abs < 1e-4 || abs >= 1e15) return null;
  // Up to 15 significant digits, without trailing zeros.
  const text = value.toPrecision(15);
  if (!text.includes('.')) return text;
  let end = text.length;
  while (text[end - 1] === '0') end--;
  if (text[end - 1] === '.') end--;
  return text.slice(0, end);
}

/**
 * The language the school's workbooks are calculated in. Where Excel's text depends on it (a decimal
 * number or a logical value turned into text, a number read from text), this engine writes what
 * Excel in Portuguese (Brazil) writes. The proof of each file (old link values must give back what
 * Excel saved) catches a workbook last calculated in another language: its cells are left as they are.
 */
const DECIMAL_SEPARATOR_V1 = ',';
const TRUE_TEXT_V1 = 'VERDADEIRO';
const FALSE_TEXT_V1 = 'FALSO';

/** Number of characters of a number turned into text (LEN). */
export function numberTextLengthV1(value: number): number {
  const text = generalTextV1(value);
  if (text === null) return unsupportedV1('number shown in scientific notation');
  return text.length;
}

/** A number as text, as Excel writes it with the General format in a formula. */
export function numberToTextV1(value: number): string {
  const text = generalTextV1(value);
  if (text === null) return unsupportedV1('number shown in scientific notation');
  return text.replace('.', DECIMAL_SEPARATOR_V1);
}

export function toTextV1(value: ScalarV1): string | ExcelErrorV1 {
  if (isErrorV1(value)) return value;
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return numberToTextV1(value);
  return value ? TRUE_TEXT_V1 : FALSE_TEXT_V1;
}

/** A number written as text ("7", "-2,5"), as Excel reads it; null when it is not one. */
export function parseNumberTextV1(text: string): number | null {
  const trimmed = text.trim();
  if (/^[+-]?\d+$/u.test(trimmed)) return Number(trimmed);
  if (/^[+-]?\d*,\d+$/u.test(trimmed)) return Number(trimmed.replace(',', '.'));
  return null;
}

/** Text that holds a number, as Excel reads it in arithmetic. */
function textToNumberV1(text: string): number | ExcelErrorV1 {
  if (text.trim() === '') return VALUE_ERROR_V1();
  const number = parseNumberTextV1(text);
  if (number !== null) return number;
  if (/^[+-]?[\d.,]+%?$/u.test(text.trim()))
    return unsupportedV1('number written as text with separators');
  return VALUE_ERROR_V1();
}

export function toNumberV1(value: ScalarV1): number | ExcelErrorV1 {
  if (isErrorV1(value)) return value;
  if (value === null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return textToNumberV1(value);
}

export function toBooleanV1(value: ScalarV1): boolean | ExcelErrorV1 {
  if (isErrorV1(value)) return value;
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return unsupportedV1('text used as a logical value');
}

/** A result Excel would turn into #NUM! (infinite or not a number). */
export function numberResultV1(value: number): number | ExcelErrorV1 {
  return Number.isFinite(value) ? value : errorV1(ERR_V1.NUM);
}

/** Excel's text order: case does not matter, accents do; checked by each file's proof. */
const TEXT_ORDER_V1 = new Intl.Collator('pt-BR', { sensitivity: 'accent', numeric: false });

/** Excel's order of kinds: numbers, then text, then logical values (and errors). */
function kindRankV1(value: ScalarV1): number {
  if (typeof value === 'number') return 0;
  if (typeof value === 'string') return 1;
  return 2;
}

function compareTextV1(a: string, b: string): number {
  const x = a.toLocaleUpperCase('pt-BR');
  const y = b.toLocaleUpperCase('pt-BR');
  if (x === y) return 0;
  const order = TEXT_ORDER_V1.compare(x, y);
  if (order === 0) return x < y ? -1 : 1;
  return order < 0 ? -1 : 1;
}

/** Equality as Excel tests it: text ignores case; an empty cell equals 0, "" and FALSE. */
export function compareV1(a: ScalarV1, b: ScalarV1): number {
  const left = a ?? emptyLikeV1(b);
  const right = b ?? emptyLikeV1(a);
  const kinds = kindRankV1(left) - kindRankV1(right);
  if (kinds !== 0) return kinds;
  if (typeof left === 'number' && typeof right === 'number') {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }
  if (typeof left === 'string' && typeof right === 'string') return compareTextV1(left, right);
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  // Errors never get here (every caller returns them first); logical values come before them.
  const code = (value: ScalarV1) => (isErrorV1(value) ? value.code : -1);
  return code(left) - code(right);
}

function emptyLikeV1(other: ScalarV1): ScalarV1 {
  if (typeof other === 'string') return '';
  if (typeof other === 'boolean') return false;
  return 0;
}

/** Text equality only (no order needed): ignores case. */
export function sameTextV1(a: string, b: string): boolean {
  return a.toLocaleUpperCase('pt-BR') === b.toLocaleUpperCase('pt-BR');
}

/** ROUND as Excel does it: half away from zero, on the number's 15-digit decimal form. */
export function roundV1(value: number, digits: number, mode: 'half' | 'up' | 'down'): number {
  const d = Math.trunc(digits);
  if (!Number.isFinite(value)) return value;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  // The 15-digit form drops binary noise (2.675 is 2.67499999… in binary, 2.675 for Excel).
  const clean = Number(abs.toPrecision(15));
  const factor = 10 ** Math.abs(d);
  const scaled = d >= 0 ? clean * factor : clean / factor;
  const scaledClean = Number(scaled.toPrecision(15));
  let rounded: number;
  if (mode === 'half') rounded = Math.floor(scaledClean + 0.5);
  else if (mode === 'up') rounded = Math.ceil(scaledClean);
  else rounded = Math.floor(scaledClean);
  const result = d >= 0 ? rounded / factor : rounded * factor;
  return sign * Number(result.toPrecision(15));
}

export { ERR_V1, errorV1, ExcelErrorV1, isErrorV1 };
export type { ScalarV1 };
