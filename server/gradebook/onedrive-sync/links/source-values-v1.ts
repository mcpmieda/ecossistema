import type {
  SheetJs,
  Worksheet,
} from '../../../../src/features/gradebook/import/spreadsheet-recognizer';
import { BLANK_V1, type LinkValueV1 } from './external-link-cache-v1';

/**
 * The values saved in a source workbook, as Excel's "update links" reads them from a closed file:
 * the stored result of each cell (formulas are not recalculated).
 */
export type SourceValuesV1 = {
  /** undefined when the sheet does not exist in the source (renamed or removed). */
  readonly valueAt: (sheet: string, row: number, col: number) => LinkValueV1 | undefined;
  readonly sheetNames: readonly string[];
};

export function columnLettersV1(col: number): string {
  let letters = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCodePoint(65 + ((n - 1) % 26)) + letters;
  return letters;
}

/** The text of a string cell; a number or boolean stored as one is written as text. */
function cellTextV1(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function cellValueV1(sheet: Worksheet, row: number, col: number): LinkValueV1 {
  const cell = sheet[`${columnLettersV1(col)}${row + 1}`];
  if (!cell || typeof cell === 'string') return BLANK_V1;
  switch (cell.t) {
    case 'n':
      return typeof cell.v === 'number' ? { kind: 'number', value: cell.v } : BLANK_V1;
    case 's':
    case 'str':
      return { kind: 'string', value: cellTextV1(cell.v) };
    case 'b':
      return { kind: 'boolean', value: cell.v === true };
    case 'e':
      return { kind: 'error', code: typeof cell.v === 'number' ? cell.v : 0x2a };
    case 'z':
    case undefined:
      return BLANK_V1;
    default:
      if (typeof cell.v === 'number') return { kind: 'number', value: cell.v };
      if (typeof cell.v === 'string') return { kind: 'string', value: cell.v };
      if (typeof cell.v === 'boolean') return { kind: 'boolean', value: cell.v };
      return BLANK_V1;
  }
}

/** Reads only the sheets the links use, which keeps CPU and memory low on large workbooks. */
export function readSourceValuesV1(
  xlsx: SheetJs,
  bytes: ArrayBuffer,
  sheets: readonly string[],
): SourceValuesV1 {
  const workbook = xlsx.read(bytes, {
    type: 'array',
    sheets: [...new Set(sheets)],
    cellFormula: false,
    cellHTML: false,
    cellText: false,
    cellNF: false,
    cellStyles: false,
    cellDates: false,
    bookVBA: false,
  });
  return {
    sheetNames: workbook.SheetNames,
    valueAt: (sheet, row, col) => {
      const worksheet = workbook.Sheets[sheet];
      return worksheet ? cellValueV1(worksheet, row, col) : undefined;
    },
  };
}
