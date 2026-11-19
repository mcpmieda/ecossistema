import type {
  SheetJs,
  Worksheet,
} from '../../../../src/features/gradebook/import/spreadsheet-recognizer';
import { BLANK_V1, type LinkAreaV1, type LinkValueV1 } from './external-link-cache-v1';

/**
 * The values saved in a source workbook, as Excel's "update links" reads them from a closed file:
 * the stored result of each cell (formulas are not recalculated).
 */
export type SourceValuesV1 = {
  /** undefined when the sheet does not exist in the source (renamed or removed). */
  readonly valueAt: (sheet: string, row: number, col: number) => LinkValueV1 | undefined;
  /** The cells the source holds inside an area (a large one is walked through these only). */
  readonly cellsIn: (sheet: string, area: LinkAreaV1) => Iterable<{ row: number; col: number }>;
  readonly sheetNames: readonly string[];
};

/** "AB12" → zero-based row 11 and column 27; null for a sheet's "!ref" and other keys. */
function addressV1(key: string): { row: number; col: number } | null {
  const match = /^([A-Z]{1,3})(\d+)$/u.exec(key);
  if (!match) return null;
  let col = 0;
  for (const char of match[1]!) col = col * 26 + (char.codePointAt(0)! - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}

function cellPositionsV1(sheet: Worksheet): { row: number; col: number }[] {
  const cells: { row: number; col: number }[] = [];
  for (const key of Object.keys(sheet)) {
    const at = addressV1(key);
    if (at) cells.push(at);
  }
  return cells.sort((a, b) => a.row - b.row || a.col - b.col);
}

/** The first cell at or after `row` (binary search on cells sorted by row). */
function firstRowAtV1(cells: readonly { row: number }[], row: number): number {
  let low = 0;
  let high = cells.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cells[middle]!.row < row) low = middle + 1;
    else high = middle;
  }
  return low;
}

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
  // Excel matches sheet names regardless of case ("1º tri" and "1º TRI" are the same sheet).
  const byLowerName = new Map(
    Object.keys(workbook.Sheets).map((name) => [name.toLocaleLowerCase('pt-BR'), name]),
  );
  /** The cells each sheet holds, by row, read once (a large area is walked through these). */
  const positions = new Map<Worksheet, { row: number; col: number }[]>();
  const worksheetOf = (sheet: string) => {
    const name =
      sheet in workbook.Sheets ? sheet : byLowerName.get(sheet.toLocaleLowerCase('pt-BR'));
    return name === undefined ? undefined : workbook.Sheets[name];
  };
  return {
    sheetNames: workbook.SheetNames,
    valueAt: (sheet, row, col) => {
      const worksheet = worksheetOf(sheet);
      return worksheet ? cellValueV1(worksheet, row, col) : undefined;
    },
    cellsIn: (sheet, area) => {
      const worksheet = worksheetOf(sheet);
      if (!worksheet) return [];
      let cells = positions.get(worksheet);
      if (!cells) {
        cells = cellPositionsV1(worksheet);
        positions.set(worksheet, cells);
      }
      const out: { row: number; col: number }[] = [];
      for (let at = firstRowAtV1(cells, area.r1); at < cells.length; at++) {
        const cell = cells[at]!;
        if (cell.row > area.r2) break;
        if (cell.col >= area.c1 && cell.col <= area.c2) out.push(cell);
      }
      return out;
    },
  };
}
