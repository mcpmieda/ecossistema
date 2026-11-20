import {
  arrayOfV1,
  cellsOfRefV1,
  liftV1,
  refSizeV1,
  scalarOfV1,
  type EvalContextV1,
} from './evaluate-v1';
import {
  compareV1,
  ERR_V1,
  errorV1,
  isArrayV1,
  isErrorV1,
  isMissingV1,
  isRefV1,
  numberResultV1,
  numberTextLengthV1,
  parseNumberTextV1,
  roundV1,
  sameTextV1,
  toBooleanV1,
  toNumberV1,
  toTextV1,
  unsupportedV1,
  VALUE_ERROR_V1,
  type ArrayV1,
  type EvalValueV1,
  type ExcelErrorV1,
  type RefV1,
  type ScalarV1,
} from './values-v1';

/**
 * The worksheet functions this engine calculates. A function missing here makes the formula
 * unsupported (it is left for Excel), never guessed.
 */
export type FunctionV1 = (args: EvalValueV1[], ctx: EvalContextV1) => EvalValueV1;

/**
 * Excel's built-in function numbers (iftab) for the functions below, and for some common ones the
 * engine leaves aside, so the panel names them.
 */
const TAB_NAMES_V1: ReadonlyMap<number, string> = new Map([
  [0, 'COUNT'],
  [1, 'IF'],
  [2, 'ISNA'],
  [3, 'ISERROR'],
  [4, 'SUM'],
  [5, 'AVERAGE'],
  [6, 'MIN'],
  [7, 'MAX'],
  [8, 'ROW'],
  [10, 'NA'],
  [24, 'ABS'],
  [25, 'INT'],
  [27, 'ROUND'],
  [29, 'INDEX'],
  [31, 'MID'],
  [32, 'LEN'],
  [33, 'VALUE'],
  [34, 'TRUE'],
  [35, 'FALSE'],
  [36, 'AND'],
  [37, 'OR'],
  [38, 'NOT'],
  [39, 'MOD'],
  [48, 'TEXT'],
  [64, 'MATCH'],
  [74, 'NOW'],
  [78, 'OFFSET'],
  [100, 'CHOOSE'],
  [102, 'VLOOKUP'],
  [112, 'LOWER'],
  [113, 'UPPER'],
  [115, 'LEFT'],
  [116, 'RIGHT'],
  [118, 'TRIM'],
  [126, 'ISERR'],
  [127, 'ISTEXT'],
  [128, 'ISNUMBER'],
  [129, 'ISBLANK'],
  [148, 'INDIRECT'],
  [169, 'COUNTA'],
  [190, 'ISNONTEXT'],
  [198, 'ISLOGICAL'],
  [212, 'ROUNDUP'],
  [213, 'ROUNDDOWN'],
  [221, 'TODAY'],
  [228, 'SUMPRODUCT'],
  [325, 'LARGE'],
  [326, 'SMALL'],
  [336, 'CONCATENATE'],
  [345, 'SUMIF'],
  [346, 'COUNTIF'],
  [359, 'HYPERLINK'],
  [347, 'COUNTBLANK'],
  [480, 'IFERROR'],
  [481, 'COUNTIFS'],
  [482, 'SUMIFS'],
]);

export const functionNameV1 = (tab: number): string | null => TAB_NAMES_V1.get(tab) ?? null;

/* ---------------------------------------------------------------- argument helpers */

/** A value argument: in an array formula an area becomes an array, elsewhere one value. */
function valueArgV1(ctx: EvalContextV1, arg: EvalValueV1 | undefined): ScalarV1 | ArrayV1 {
  if (arg === undefined || isMissingV1(arg)) return null;
  if (isArrayV1(arg)) return arg;
  if (isRefV1(arg) && ctx.array && refSizeV1(arg) > 1) return arrayOfV1(ctx, arg);
  return scalarOfV1(ctx, arg);
}

/** The values of an area (its non-empty cells, in order) or of an array. */
function* areaValuesV1(ctx: EvalContextV1, arg: RefV1 | ArrayV1): Iterable<ScalarV1> {
  if (isArrayV1(arg)) {
    yield* arg.data;
    return;
  }
  for (const cell of cellsOfRefV1(ctx, arg)) yield cell.value;
}

/** Adds the numbers among `values` to `numbers`; the first error found stops it and is returned. */
function pushNumbersV1(numbers: number[], values: Iterable<ScalarV1>): ExcelErrorV1 | null {
  for (const value of values) {
    if (isErrorV1(value)) return value;
    if (typeof value === 'number') numbers.push(value);
  }
  return null;
}

/** Numbers of an aggregate's arguments: in areas and arrays only numbers count; given values are converted. */
function numbersOfV1(args: readonly EvalValueV1[], ctx: EvalContextV1): number[] | ScalarV1 {
  const numbers: number[] = [];
  for (const arg of args) {
    if (isMissingV1(arg)) continue;
    if (isRefV1(arg) || isArrayV1(arg)) {
      const error = pushNumbersV1(numbers, areaValuesV1(ctx, arg));
      if (error) return error;
      continue;
    }
    const value = toNumberV1(arg);
    if (isErrorV1(value)) return value;
    numbers.push(value);
  }
  return numbers;
}

function lastArgIsOmittedV1(args: readonly EvalValueV1[], index: number): boolean {
  return args.length <= index;
}

/* ---------------------------------------------------------------- criteria (COUNTIF and friends) */

type MatcherV1 = (value: ScalarV1) => boolean;

const escapeRegExpV1 = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

function wildcardV1(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '~' && i + 1 < pattern.length) source += escapeRegExpV1(pattern[++i]!);
    else if (char === '*') source += String.raw`[\s\S]*`;
    else if (char === '?') source += String.raw`[\s\S]`;
    else source += escapeRegExpV1(char);
  }
  return new RegExp(`^${source}$`, 'iu');
}

/** A criteria that is a number ("7", ">=5", "<>2,5"). */
function numberCriteriaV1(op: string, n: number): MatcherV1 {
  const equal = (value: ScalarV1) =>
    (typeof value === 'number' && value === n) ||
    (typeof value === 'string' && parseNumberTextV1(value) === n);
  switch (op) {
    case '':
    case '=':
      return equal;
    case '<>':
      return (value) => !equal(value);
    case '<':
      return (value) => typeof value === 'number' && value < n;
    case '<=':
      return (value) => typeof value === 'number' && value <= n;
    case '>':
      return (value) => typeof value === 'number' && value > n;
    default:
      return (value) => typeof value === 'number' && value >= n;
  }
}

/** An empty criteria ("", "=", "<>"). */
function emptyCriteriaV1(op: string): MatcherV1 {
  if (op === '') return (value) => value === null || value === '';
  if (op === '=') return (value) => value === null;
  if (op === '<>') return (value) => value !== null;
  return unsupportedV1('empty criteria with an order');
}

/** A text criteria: equal (with wildcards), different, or an order. */
function textCriteriaV1(op: string, operand: string): MatcherV1 {
  if (op === '' || op === '=' || op === '<>') {
    const pattern = /[*?~]/u.test(operand) ? wildcardV1(operand) : null;
    const equal = (value: ScalarV1) =>
      typeof value === 'string' && (pattern ? pattern.test(value) : sameTextV1(value, operand));
    return op === '<>' ? (value) => !equal(value) : equal;
  }
  return (value) => {
    if (typeof value !== 'string') return false;
    const order = compareV1(value, operand);
    if (op === '<') return order < 0;
    if (op === '<=') return order <= 0;
    if (op === '>') return order > 0;
    return order >= 0;
  };
}

/** Excel's criteria: a number, a logical, or text with an optional operator and wildcards. */
function criteriaV1(criteria: ScalarV1): MatcherV1 {
  if (isErrorV1(criteria)) return unsupportedV1('error as criteria');
  if (criteria === null) return unsupportedV1('empty cell as criteria');
  if (typeof criteria === 'number')
    return (value) => typeof value === 'number' && value === criteria;
  if (typeof criteria === 'boolean')
    return (value) => typeof value === 'boolean' && value === criteria;
  const match = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/u.exec(criteria)!;
  const op = match[1] ?? '';
  const operand = match[2]!;
  if (/^(TRUE|FALSE|VERDADEIRO|FALSO)$/iu.test(operand) || operand.startsWith('#'))
    return unsupportedV1('logical or error written as criteria');
  const n = parseNumberTextV1(operand);
  if (n !== null) return numberCriteriaV1(op, n);
  if (/^[+-]?[\d.,]+$/u.test(operand)) return unsupportedV1('decimal number written as criteria');
  if (operand === '') return emptyCriteriaV1(op);
  return textCriteriaV1(op, operand);
}

/** The cells of a criteria range, empty ones included, in order. */
function rangeValuesV1(ctx: EvalContextV1, arg: EvalValueV1): ArrayV1 {
  if (!isRefV1(arg) && !isArrayV1(arg)) return unsupportedV1('criteria range is not an area');
  if (isRefV1(arg) && refSizeV1(arg) > 200_000) return unsupportedV1('criteria range too large');
  return arrayOfV1(ctx, arg);
}

/** The ranges and criteria of (range, criteria) pairs. */
function criteriaPairsV1(
  args: readonly EvalValueV1[],
  ctx: EvalContextV1,
): { ranges: ArrayV1[]; matchers: MatcherV1[] } {
  const ranges: ArrayV1[] = [];
  const matchers: MatcherV1[] = [];
  for (let i = 0; i < args.length; i += 2) {
    ranges.push(rangeValuesV1(ctx, args[i]!));
    const criteria = valueArgV1(ctx, args[i + 1]);
    if (isArrayV1(criteria)) return unsupportedV1('array of criteria');
    matchers.push(criteriaV1(criteria));
  }
  return { ranges, matchers };
}

/** How many positions match (no sum range), or the sum of the sum range at those positions. */
function totalOfMatchesV1(
  size: number,
  matches: (index: number) => boolean,
  sums: ArrayV1 | null,
): ScalarV1 {
  let total = 0;
  for (let i = 0; i < size; i++) {
    if (!matches(i)) continue;
    const value = sums ? (sums.data[i] ?? null) : 1;
    if (isErrorV1(value)) return value;
    if (typeof value === 'number') total += value;
  }
  return total;
}

function countIfsV1(
  args: EvalValueV1[],
  ctx: EvalContextV1,
  sumRange: EvalValueV1 | null,
): ScalarV1 {
  if (args.length === 0 || args.length % 2 !== 0) return VALUE_ERROR_V1();
  const { ranges, matchers } = criteriaPairsV1(args, ctx);
  const first = ranges[0]!;
  const sameSize = (range: ArrayV1) => range.rows === first.rows && range.cols === first.cols;
  if (!ranges.every(sameSize)) return VALUE_ERROR_V1();
  const sums = sumRange === null ? null : rangeValuesV1(ctx, sumRange);
  if (sums && !sameSize(sums)) return unsupportedV1('sum range of another size');
  return totalOfMatchesV1(
    first.data.length,
    (i) => matchers.every((match, k) => match(ranges[k]!.data[i] ?? null)),
    sums,
  );
}

/* ---------------------------------------------------------------- lookups */

function lookupEqualV1(a: ScalarV1, b: ScalarV1): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    if (/[*?~]/u.test(a)) return wildcardV1(a).test(b);
    return sameTextV1(a, b);
  }
  return typeof a === typeof b && a === b;
}

function sortedAscendingV1(values: readonly ScalarV1[]): boolean {
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1] ?? null;
    const b = values[i] ?? null;
    if (a === null || b === null || isErrorV1(a) || isErrorV1(b)) continue;
    if (compareV1(a, b) > 0) return false;
  }
  return true;
}

/** Position (0-based) of `lookup` in `values`: exact, or the last one not greater when sorted. */
function findV1(lookup: ScalarV1, values: readonly ScalarV1[], exact: boolean): number | null {
  if (exact) {
    const index = values.findIndex((value) => value !== null && lookupEqualV1(lookup, value));
    return index < 0 ? null : index;
  }
  if (!sortedAscendingV1(values)) return unsupportedV1('approximate lookup on an unsorted range');
  let found: number | null = null;
  values.forEach((value, index) => {
    if (value === null || isErrorV1(value) || typeof value !== typeof lookup) return;
    if (compareV1(value, lookup) <= 0) found = index;
  });
  return found;
}

/* ---------------------------------------------------------------- the functions */

const ok = (value: number): ScalarV1 => numberResultV1(value);

const FUNCTIONS_V1 = new Map<string, FunctionV1>();
const define = (name: string, fn: FunctionV1) => FUNCTIONS_V1.set(name, fn);

/** A function of values, applied element by element in array formulas. */
const scalarFn =
  (fn: (values: ScalarV1[]) => ScalarV1): FunctionV1 =>
  (args, ctx) =>
    liftV1(
      args.map((arg) => valueArgV1(ctx, arg)),
      fn,
    );

define('SUM', (args, ctx) => {
  const numbers = numbersOfV1(args, ctx);
  return Array.isArray(numbers) ? ok(numbers.reduce((sum, n) => sum + n, 0)) : numbers;
});
define('AVERAGE', (args, ctx) => {
  const numbers = numbersOfV1(args, ctx);
  if (!Array.isArray(numbers)) return numbers;
  return numbers.length === 0
    ? errorV1(ERR_V1.DIV0)
    : ok(numbers.reduce((sum, n) => sum + n, 0) / numbers.length);
});
define('MIN', (args, ctx) => {
  const numbers = numbersOfV1(args, ctx);
  if (!Array.isArray(numbers)) return numbers;
  return numbers.length === 0 ? 0 : Math.min(...numbers);
});
define('MAX', (args, ctx) => {
  const numbers = numbersOfV1(args, ctx);
  if (!Array.isArray(numbers)) return numbers;
  return numbers.length === 0 ? 0 : Math.max(...numbers);
});
/** COUNT of a value given directly (not in an area): numbers, logical values and numbers as text. */
function countsAsNumberV1(value: ScalarV1): boolean {
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  return typeof value === 'string' && !isErrorV1(toNumberV1(value));
}
define('COUNT', (args, ctx) => {
  let count = 0;
  for (const arg of args) {
    if (isMissingV1(arg)) continue;
    if (isRefV1(arg) || isArrayV1(arg)) {
      for (const value of areaValuesV1(ctx, arg)) if (typeof value === 'number') count++;
    } else if (countsAsNumberV1(arg)) count++;
  }
  return count;
});
define('COUNTA', (args, ctx) => {
  let count = 0;
  for (const arg of args) {
    if (isMissingV1(arg)) continue;
    if (isRefV1(arg)) {
      for (const cell of cellsOfRefV1(ctx, arg)) if (cell.value !== null) count++;
    } else if (isArrayV1(arg)) count += arg.data.filter((value) => value !== null).length;
    else count++;
  }
  return count;
});
define('COUNTBLANK', (args, ctx) => {
  const range = rangeValuesV1(ctx, args[0]!);
  return range.data.filter((value) => value === null || value === '').length;
});

/** Adds a value to AND/OR's list; returns what stops them (an error, or text given directly). */
function takeLogicalV1(values: boolean[], value: ScalarV1, direct: boolean): ScalarV1 | null {
  if (isErrorV1(value)) return value;
  if (typeof value === 'boolean') values.push(value);
  else if (typeof value === 'number') values.push(value !== 0);
  else if (direct && typeof value === 'string') return unsupportedV1('text given to AND/OR');
  return null;
}

function logicalsOfV1(args: readonly EvalValueV1[], ctx: EvalContextV1): boolean[] | ScalarV1 {
  const values: boolean[] = [];
  for (const arg of args) {
    if (isMissingV1(arg)) continue;
    const area = isRefV1(arg) || isArrayV1(arg);
    const items: Iterable<ScalarV1> = area ? areaValuesV1(ctx, arg) : [arg];
    for (const value of items) {
      const stop = takeLogicalV1(values, value, !area);
      if (stop !== null) return stop;
    }
  }
  return values;
}
define('AND', (args, ctx) => {
  const values = logicalsOfV1(args, ctx);
  if (!Array.isArray(values)) return values;
  return values.length === 0 ? VALUE_ERROR_V1() : values.every(Boolean);
});
define('OR', (args, ctx) => {
  const values = logicalsOfV1(args, ctx);
  if (!Array.isArray(values)) return values;
  return values.length === 0 ? VALUE_ERROR_V1() : values.some(Boolean);
});
define(
  'NOT',
  scalarFn(([value]) => {
    const b = toBooleanV1(value!);
    return isErrorV1(b) ? b : !b;
  }),
);
define('TRUE', () => true);
define('FALSE', () => false);
define('NA', () => errorV1(ERR_V1.NA));

define('IF', (args, ctx) => {
  const condition = valueArgV1(ctx, args[0]);
  const pick = (yes: boolean): EvalValueV1 => {
    const index = yes ? 1 : 2;
    if (lastArgIsOmittedV1(args, index)) return yes ? 0 : false;
    const chosen = args[index]!;
    return isMissingV1(chosen) ? 0 : chosen;
  };
  if (!isArrayV1(condition)) {
    const yes = toBooleanV1(condition);
    if (isErrorV1(yes)) return yes;
    return pick(yes);
  }
  const yesValue = valueArgV1(ctx, pick(true));
  const noValue = valueArgV1(ctx, pick(false));
  return liftV1([condition, yesValue, noValue], ([c, y, n]) => {
    const yes = toBooleanV1(c!);
    if (isErrorV1(yes)) return yes;
    return yes ? y! : n!;
  });
});
define('IFERROR', (args, ctx) => {
  const alternative = isMissingV1(args[1]!) ? 0 : args[1]!;
  return liftV1([valueArgV1(ctx, args[0]), valueArgV1(ctx, alternative)], ([value, alt]) =>
    isErrorV1(value) ? alt! : (value ?? 0),
  );
});
define('IFNA', (args, ctx) => {
  const alternative = isMissingV1(args[1]!) ? 0 : args[1]!;
  return liftV1([valueArgV1(ctx, args[0]), valueArgV1(ctx, alternative)], ([value, alt]) =>
    isErrorV1(value) && value.code === ERR_V1.NA ? alt! : (value ?? 0),
  );
});
define('IFS', (args, ctx) => {
  if (args.length < 2 || args.length % 2 !== 0) return unsupportedV1('IFS without pairs');
  for (let i = 0; i < args.length; i += 2) {
    const condition = valueArgV1(ctx, args[i]);
    if (isArrayV1(condition)) return unsupportedV1('IFS in an array formula');
    const yes = toBooleanV1(condition);
    if (isErrorV1(yes)) return yes;
    if (yes) return isMissingV1(args[i + 1]!) ? 0 : args[i + 1]!;
  }
  return errorV1(ERR_V1.NA);
});

define(
  'ISBLANK',
  scalarFn(([value]) => value === null),
);
define(
  'ISNUMBER',
  scalarFn(([value]) => typeof value === 'number'),
);
define(
  'ISTEXT',
  scalarFn(([value]) => typeof value === 'string'),
);
define(
  'ISNONTEXT',
  scalarFn(([value]) => typeof value !== 'string'),
);
define(
  'ISLOGICAL',
  scalarFn(([value]) => typeof value === 'boolean'),
);
define(
  'ISERROR',
  scalarFn(([value]) => isErrorV1(value)),
);
define(
  'ISERR',
  scalarFn(([value]) => isErrorV1(value) && value.code !== ERR_V1.NA),
);
define(
  'ISNA',
  scalarFn(([value]) => isErrorV1(value) && value.code === ERR_V1.NA),
);

const numeric1 = (fn: (x: number) => ScalarV1): FunctionV1 =>
  scalarFn(([value]) => {
    const x = toNumberV1(value!);
    return isErrorV1(x) ? x : fn(x);
  });
const numeric2 = (fn: (x: number, y: number) => ScalarV1): FunctionV1 =>
  scalarFn(([a, b]) => {
    const x = toNumberV1(a!);
    if (isErrorV1(x)) return x;
    const y = toNumberV1(b!);
    return isErrorV1(y) ? y : fn(x, y);
  });

define(
  'INT',
  numeric1((x) => Math.floor(x)),
);
define(
  'ABS',
  numeric1((x) => Math.abs(x)),
);
define(
  'MOD',
  numeric2((n, d) => (d === 0 ? errorV1(ERR_V1.DIV0) : ok(n - d * Math.floor(n / d)))),
);
define(
  'ROUND',
  numeric2((x, d) => roundV1(x, d, 'half')),
);
define(
  'ROUNDUP',
  numeric2((x, d) => roundV1(x, d, 'up')),
);
define(
  'ROUNDDOWN',
  numeric2((x, d) => roundV1(x, d, 'down')),
);

define(
  'LEN',
  scalarFn(([value]) => {
    if (isErrorV1(value)) return value;
    if (value === null) return 0;
    if (typeof value === 'string') return value.length;
    if (typeof value === 'number') return numberTextLengthV1(value);
    const text = toTextV1(value!);
    return isErrorV1(text) ? text : text.length;
  }),
);
const text1 = (fn: (text: string) => ScalarV1): FunctionV1 =>
  scalarFn(([value]) => {
    const text = toTextV1(value!);
    return isErrorV1(text) ? text : fn(text);
  });
/** TRIM: spaces at both ends removed, runs of spaces inside made one (other blanks are kept). */
function trimSpacesV1(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === ' ') start++;
  while (end > start && text[end - 1] === ' ') end--;
  return text.slice(start, end).replace(/ {2,}/gu, ' ');
}
define('TRIM', text1(trimSpacesV1));
define(
  'UPPER',
  text1((text) => text.toLocaleUpperCase('pt-BR')),
);
define(
  'LOWER',
  text1((text) => text.toLocaleLowerCase('pt-BR')),
);
define('LEFT', (args, ctx) =>
  liftV1(
    [valueArgV1(ctx, args[0]), lastArgIsOmittedV1(args, 1) ? 1 : valueArgV1(ctx, args[1])],
    ([value, count]) => {
      const text = toTextV1(value!);
      if (isErrorV1(text)) return text;
      const n = toNumberV1(count!);
      if (isErrorV1(n)) return n;
      return n < 0 ? VALUE_ERROR_V1() : text.slice(0, Math.floor(n));
    },
  ),
);
define('RIGHT', (args, ctx) =>
  liftV1(
    [valueArgV1(ctx, args[0]), lastArgIsOmittedV1(args, 1) ? 1 : valueArgV1(ctx, args[1])],
    ([value, count]) => {
      const text = toTextV1(value!);
      if (isErrorV1(text)) return text;
      const n = toNumberV1(count!);
      if (isErrorV1(n)) return n;
      if (n < 0) return VALUE_ERROR_V1();
      const k = Math.floor(n);
      return k === 0 ? '' : text.slice(-k);
    },
  ),
);
define(
  'MID',
  scalarFn(([value, start, count]) => {
    const text = toTextV1(value!);
    if (isErrorV1(text)) return text;
    const s = toNumberV1(start!);
    if (isErrorV1(s)) return s;
    const n = toNumberV1(count!);
    if (isErrorV1(n)) return n;
    if (s < 1 || n < 0) return VALUE_ERROR_V1();
    return text.slice(Math.floor(s) - 1, Math.floor(s) - 1 + Math.floor(n));
  }),
);
define('CONCATENATE', (args, ctx) =>
  liftV1(
    args.map((arg) => valueArgV1(ctx, arg)),
    (values) => {
      let out = '';
      for (const value of values) {
        const text = toTextV1(value);
        if (isErrorV1(text)) return text;
        out += text;
      }
      return out;
    },
  ),
);

define('COUNTIF', (args, ctx) => {
  const criteria = valueArgV1(ctx, args[1]);
  if (isArrayV1(criteria)) return unsupportedV1('array of criteria');
  return countIfsV1([args[0]!, criteria], ctx, null);
});
define('COUNTIFS', (args, ctx) => countIfsV1(args, ctx, null));
define('SUMIF', (args, ctx) => {
  const criteria = valueArgV1(ctx, args[1]);
  if (isArrayV1(criteria)) return unsupportedV1('array of criteria');
  const sumRange = lastArgIsOmittedV1(args, 2) || isMissingV1(args[2]!) ? args[0]! : args[2]!;
  return countIfsV1([args[0]!, criteria], ctx, sumRange);
});
define('SUMIFS', (args, ctx) => countIfsV1(args.slice(1), ctx, args[0]!));

define('VLOOKUP', (args, ctx) => {
  const lookup = valueArgV1(ctx, args[0]);
  if (isArrayV1(lookup)) return unsupportedV1('VLOOKUP of an array');
  if (isErrorV1(lookup)) return lookup;
  const table = arrayOfV1(ctx, args[1]!);
  const column = toNumberV1(scalarOfV1(ctx, args[2]!));
  if (isErrorV1(column)) return column;
  const col = Math.floor(column);
  if (col < 1) return VALUE_ERROR_V1();
  if (col > table.cols) return errorV1(ERR_V1.REF);
  const exact = lastArgIsOmittedV1(args, 3) ? false : !toBooleanV1(scalarOfV1(ctx, args[3]!));
  const firstColumn = Array.from(
    { length: table.rows },
    (_, r) => table.data[r * table.cols] ?? null,
  );
  const row = findV1(lookup, firstColumn, exact);
  if (row === null) return errorV1(ERR_V1.NA);
  return table.data[row * table.cols + col - 1] ?? 0;
});
define('MATCH', (args, ctx) => {
  const lookup = valueArgV1(ctx, args[0]);
  if (isArrayV1(lookup)) return unsupportedV1('MATCH of an array');
  if (isErrorV1(lookup)) return lookup;
  const range = arrayOfV1(ctx, args[1]!);
  if (range.rows !== 1 && range.cols !== 1) return errorV1(ERR_V1.NA);
  const type = lastArgIsOmittedV1(args, 2) ? 1 : toNumberV1(scalarOfV1(ctx, args[2]!));
  if (isErrorV1(type)) return type;
  if (type < 0) return unsupportedV1('MATCH in descending order');
  const index = findV1(lookup, range.data, type === 0);
  return index === null ? errorV1(ERR_V1.NA) : index + 1;
});
/** INDEX of a reference: the cell (or the single column) at row `r` and column `c` (0: whole). */
function indexOfRefV1(source: RefV1, r: number, c: number): EvalValueV1 {
  const rows = source.r2 - source.r1 + 1;
  const cols = source.c2 - source.c1 + 1;
  if (r < 0 || c < 0 || r > rows || c > cols) return errorV1(ERR_V1.REF);
  if (r === 0 && c === 0) return source;
  if (r === 0 && cols === 1) return { ...source, c1: source.c1, c2: source.c1 };
  const rr = r === 0 ? null : source.r1 + r - 1;
  let cc: number | null = source.c1 + c - 1;
  if (c === 0) cc = cols === 1 ? source.c1 : null;
  if (rr !== null && cc === null && rows === 1)
    return { ...source, c1: source.c1 + r - 1, c2: source.c1 + r - 1 };
  if (rr === null || cc === null) return unsupportedV1('INDEX of a whole row or column');
  const ref: RefV1 = { ...source, r1: rr, r2: rr, c1: cc, c2: cc };
  return ref;
}

/** INDEX of an array: a one-row array takes a lone index as its column. */
function indexOfArrayV1(array: ArrayV1, r: number, c: number): ScalarV1 {
  let rr = r;
  let cc = c === 0 ? 1 : c;
  if (array.rows === 1 && c === 0) {
    rr = 1;
    cc = r;
  }
  if (rr < 1 || cc < 1 || rr > array.rows || cc > array.cols) return errorV1(ERR_V1.REF);
  return array.data[(rr - 1) * array.cols + cc - 1] ?? null;
}

define('INDEX', (args, ctx) => {
  const source = args[0]!;
  const row = lastArgIsOmittedV1(args, 1) ? 0 : toNumberV1(scalarOfV1(ctx, args[1]!));
  const col = lastArgIsOmittedV1(args, 2) ? 0 : toNumberV1(scalarOfV1(ctx, args[2]!));
  if (isErrorV1(row)) return row;
  if (isErrorV1(col)) return col;
  const r = Math.floor(row);
  const c = Math.floor(col);
  if (isRefV1(source)) return indexOfRefV1(source, r, c);
  return indexOfArrayV1(arrayOfV1(ctx, source), r, c);
});
const nth =
  (largest: boolean): FunctionV1 =>
  (args, ctx) => {
    const numbers = numbersOfV1([args[0]!], ctx);
    if (!Array.isArray(numbers)) return numbers;
    const k = toNumberV1(scalarOfV1(ctx, args[1]!));
    if (isErrorV1(k)) return k;
    const position = Math.ceil(k);
    if (position < 1 || position > numbers.length) return errorV1(ERR_V1.NUM);
    const sorted = [...numbers].sort((a, b) => (largest ? b - a : a - b));
    return sorted[position - 1]!;
  };
define('LARGE', nth(true));
define('SMALL', nth(false));
define('CHOOSE', (args, ctx) => {
  const index = toNumberV1(scalarOfV1(ctx, args[0]!));
  if (isErrorV1(index)) return index;
  const i = Math.floor(index);
  if (i < 1 || i >= args.length) return VALUE_ERROR_V1();
  const chosen = args[i]!;
  return isMissingV1(chosen) ? 0 : chosen;
});
define('SUMPRODUCT', (args, ctx) => {
  const arrays = args.map((arg) => arrayOfV1(ctx, arg));
  const first = arrays[0];
  if (!first) return VALUE_ERROR_V1();
  if (arrays.some((a) => a.rows !== first.rows || a.cols !== first.cols)) return VALUE_ERROR_V1();
  let total = 0;
  for (let i = 0; i < first.data.length; i++) {
    let product = 1;
    for (const array of arrays) {
      const value = array.data[i] ?? null;
      if (isErrorV1(value)) return value;
      product *= typeof value === 'number' ? value : 0;
    }
    total += product;
  }
  return ok(total);
});
define('ANCHORARRAY', (args, ctx) => {
  const ref = args[0];
  if (!isRefV1(ref) || ref.book !== 'self' || ref.r1 !== ref.r2 || ref.c1 !== ref.c2)
    return errorV1(ERR_V1.REF);
  // The spill area Excel saved for the dynamic array anchored at that cell.
  const sheet = ctx.model.sheets[ref.sheet as number];
  const group = sheet?.groups.find((g) => g.kind === 'array' && g.r1 === ref.r1 && g.c1 === ref.c1);
  if (!group) return errorV1(ERR_V1.REF);
  const spill: RefV1 = { ...ref, r1: group.r1, r2: group.r2, c1: group.c1, c2: group.c2 };
  return spill;
});
define('ROW', (args, ctx) => {
  if (args.length === 0) return ctx.row + 1;
  const ref = args[0]!;
  if (!isRefV1(ref)) return VALUE_ERROR_V1();
  if (ref.r1 !== ref.r2 && ctx.array) return unsupportedV1('ROW of an area in an array formula');
  return ref.r1 + 1;
});

/** The implementation of a worksheet function by its English name; undefined when not supported. */
export const functionByNameV1 = (name: string): FunctionV1 | undefined => FUNCTIONS_V1.get(name);

/** Names of every supported function (for the panel and the documentation). */
export const supportedFunctionsV1 = (): string[] =>
  [...FUNCTIONS_V1.keys()].sort((a, b) => a.localeCompare(b));
