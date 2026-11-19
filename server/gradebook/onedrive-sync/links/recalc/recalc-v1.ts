import type { ExternalLinkCacheV1, LinkValueV1 } from '../external-link-cache-v1';
import { readZipEntryV1, type ZipPackageV1 } from '../zip-package-v1';
import { evaluateTokensV1, type AreaV1, type EvalContextV1 } from './evaluate-v1';
import { decodeFormulaV1, UnsupportedFormulaError, type TokenV1 } from './formula-tokens-v1';
import {
  ERR_V1,
  errorV1,
  isArrayV1,
  isErrorV1,
  isMissingV1,
  isRefV1,
  type EvalValueV1,
  toTextV1,
  type RefV1,
} from './values-v1';
import {
  cellKeyV1,
  MAX_COLUMNS_V1,
  readWorkbookModelV1,
  type CellV1,
  type FormulaGroupV1,
  type ScalarV1,
  type SheetModelV1,
  type WorkbookModelV1,
} from './workbook-model-v1';

/**
 * Recalculation of the cells that depend on a workbook's links (#1541, "Recalcular células"):
 * after the link copies are refreshed, the formulas that read them, and every formula that reads
 * those, are calculated again and their stored results rewritten, so a closed file already holds
 * what Excel would show. Formulas are never changed.
 *
 * Safety:
 * - a chain with anything this engine does not calculate with certainty is left as it is, with the
 *   reason in the report (the panel shows it);
 * - before trusting the engine with the new values, it recalculates the same cells with the old
 *   link values and compares with what Excel saved: a cell that does not match (and everything that
 *   depends on it) is left as it is;
 * - Excel still recalculates everything when the file is opened (the flag stays on).
 */

/** The link copies of a workbook, before and after the refresh, by link part. */
export type LinkCachesV1 = ReadonlyMap<string, ExternalLinkCacheV1>;

export type RecalcReportV1 = {
  /** Formulas (or array groups) that depend on the links. */
  readonly dependent: number;
  /** Cells whose stored result changed and were rewritten. */
  readonly writtenCells: number;
  /** Formulas left as they are (and why, with how many). */
  readonly skipped: number;
  readonly reasons: Readonly<Record<string, number>>;
  /** A few cells left as they are for each reason (sheet!cell), for the audit. */
  readonly reasonSamples: Readonly<Record<string, readonly string[]>>;
  /** Cells whose recalculation with the old link values did not match what Excel saved. */
  readonly mismatches: number;
  readonly mismatchSamples: readonly string[];
  /** Why nothing was written at all (null when the cells were handled one by one). */
  readonly blocked: string | null;
};

export type RecalcResultV1 = {
  /** New sheet parts (only those with a rewritten cell). */
  readonly replacements: Map<string, Uint8Array>;
  readonly report: RecalcReportV1;
};

const INDIRECT_TAB_V1 = 148;
const OFFSET_TAB_V1 = 78;

/** One calculation: a formula cell, or an array formula with all its cells. */
type UnitV1 = {
  readonly id: number;
  readonly sheet: number;
  /** The cell where it is evaluated (the first cell for an array group). */
  readonly row: number;
  readonly col: number;
  readonly cells: readonly CellV1[];
  readonly area: AreaV1;
  readonly array: boolean;
  tokens: TokenV1[] | null;
  /** Areas of this workbook it reads (sheet index + area). */
  precedents: { sheet: number; area: AreaV1 }[];
  external: boolean;
  /** What it reads of linked workbooks: link part, sheet name and area (null: not known exactly). */
  externalReads: { part: string; sheet: string; area: AreaV1 }[] | null;
  /** Why it cannot be calculated (decoding, INDIRECT with a computed address…); null when it can. */
  problem: string | null;
};

/* ---------------------------------------------------------------- link values */

function linkScalarV1(value: LinkValueV1): ScalarV1 {
  switch (value.kind) {
    case 'blank':
      return null;
    case 'number':
    case 'string':
    case 'boolean':
      return value.value;
    case 'error':
      return errorV1(value.code);
  }
}

type LinkIndexV1 = {
  readonly sheetNames: readonly string[];
  readonly bySheet: Map<string, Map<number, ScalarV1>>;
  readonly names: ExternalLinkCacheV1['names'];
};

function linkIndexV1(caches: LinkCachesV1): Map<string, LinkIndexV1> {
  const out = new Map<string, LinkIndexV1>();
  for (const [part, cache] of caches) {
    const bySheet = new Map<string, Map<number, ScalarV1>>();
    for (const name of cache.sheetNames) bySheet.set(name.toLocaleUpperCase('pt-BR'), new Map());
    for (const cell of cache.cells)
      bySheet
        .get(cell.sheet.toLocaleUpperCase('pt-BR'))
        ?.set(cellKeyV1(cell.row, cell.col), linkScalarV1(cell.value));
    out.set(part, { sheetNames: cache.sheetNames, bySheet, names: cache.names });
  }
  return out;
}

/** The link cells whose value differs between two copies (added or removed cells included). */
function changedLinkCellsV1(before: Map<string, LinkIndexV1>, after: Map<string, LinkIndexV1>) {
  const changed = new Map<string, number[]>();
  const sameValue = (a: ScalarV1 | undefined, b: ScalarV1 | undefined) => {
    const x = a ?? null;
    const y = b ?? null;
    if (isErrorV1(x) || isErrorV1(y)) return isErrorV1(x) && isErrorV1(y) && x.code === y.code;
    return x === y;
  };
  for (const [part, next] of after) {
    const previous = before.get(part);
    for (const [sheet, cells] of next.bySheet) {
      const old = previous?.bySheet.get(sheet);
      const keys = new Set([...cells.keys(), ...(old?.keys() ?? [])]);
      const list: number[] = [];
      for (const key of keys) if (!old || !sameValue(old.get(key), cells.get(key))) list.push(key);
      if (list.length > 0) changed.set(`${part}\u0000${sheet}`, list);
    }
  }
  return {
    touches(part: string, sheet: string, area: AreaV1): boolean {
      const keys = changed.get(`${part}\u0000${sheet.toLocaleUpperCase('pt-BR')}`);
      if (!keys) return false;
      return keys.some((key) => {
        const row = Math.floor(key / MAX_COLUMNS_V1);
        const col = key % MAX_COLUMNS_V1;
        return row >= area.r1 && row <= area.r2 && col >= area.c1 && col <= area.c2;
      });
    },
  };
}

/* ---------------------------------------------------------------- units and dependencies */

const groupOfV1 = (sheet: SheetModelV1, cell: CellV1): FormulaGroupV1 | undefined =>
  sheet.groups.find(
    (g) => cell.row >= g.r1 && cell.row <= g.r2 && cell.col >= g.c1 && cell.col <= g.c2,
  );

function unitsV1(model: WorkbookModelV1): UnitV1[] {
  const units: UnitV1[] = [];
  for (const sheet of model.sheets) {
    const arrayUnits = new Map<FormulaGroupV1, UnitV1>();
    for (const cell of sheet.cells.values()) {
      if (!cell.formula) continue;
      const isExp = cell.formula.rgce[0] === 0x01;
      const group = isExp ? groupOfV1(sheet, cell) : undefined;
      if (isExp && !group) {
        units.push(
          newUnitV1(
            units.length,
            sheet.index,
            cell,
            [cell],
            null,
            false,
            'array or shared formula without its group',
          ),
        );
        continue;
      }
      if (group?.kind === 'array') {
        let unit = arrayUnits.get(group);
        if (!unit) {
          unit = newUnitV1(
            units.length,
            sheet.index,
            { ...cell, row: group.r1, col: group.c1 },
            [],
            group.rgce,
            true,
            null,
          );
          (unit as { area: AreaV1 }).area = {
            r1: group.r1,
            r2: group.r2,
            c1: group.c1,
            c2: group.c2,
          };
          arrayUnits.set(group, unit);
          units.push(unit);
        }
        (unit.cells as CellV1[]).push(cell);
        continue;
      }
      units.push(
        newUnitV1(
          units.length,
          sheet.index,
          cell,
          [cell],
          group ? group.rgce : cell.formula.rgce,
          false,
          null,
          group?.kind === 'shared',
        ),
      );
    }
  }
  return units;
}

function newUnitV1(
  id: number,
  sheet: number,
  at: { row: number; col: number },
  cells: CellV1[],
  rgce: Uint8Array | null,
  array: boolean,
  problem: string | null,
  relative = false,
): UnitV1 {
  let tokens: TokenV1[] | null = null;
  let issue = problem;
  if (rgce && !issue) {
    try {
      tokens = decodeFormulaV1(rgce, relative);
    } catch (cause) {
      issue = cause instanceof UnsupportedFormulaError ? cause.reason : 'formula could not be read';
    }
  }
  return {
    id,
    sheet,
    row: at.row,
    col: at.col,
    cells,
    area: { r1: at.row, r2: at.row, c1: at.col, c2: at.col },
    array,
    tokens,
    precedents: [],
    external: false,
    externalReads: [],
    problem: issue,
  };
}

/** "Folha!$B$7", "B7", "'Nota final'!A1:B2" → sheet (or the formula's) and area; null otherwise. */
function addressV1(
  text: string,
  model: WorkbookModelV1,
  sheet: number,
): { sheet: number; area: AreaV1 } | null {
  const match =
    /^(?:(?:'((?:[^']|'')+)'|([^'!]+))!)?\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/iu.exec(
      text.trim(),
    );
  if (!match) return null;
  const sheetName = match[1]?.replaceAll("''", "'") ?? match[2];
  const target =
    sheetName === undefined
      ? model.sheets[sheet]
      : model.sheetByName.get(sheetName.toLocaleUpperCase('pt-BR'));
  if (!target) return null;
  const col = (letters: string) =>
    [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const r1 = Number(match[4]) - 1;
  const c1 = col(match[3]!);
  const r2 = match[6] ? Number(match[6]) - 1 : r1;
  const c2 = match[5] ? col(match[5]) : c1;
  return {
    sheet: target.index,
    area: {
      r1: Math.min(r1, r2),
      r2: Math.max(r1, r2),
      c1: Math.min(c1, c2),
      c2: Math.max(c1, c2),
    },
  };
}

/** What a unit reads: areas of this workbook, whether it reads a link, and anything unknowable. */
function dependenciesV1(
  unit: UnitV1,
  model: WorkbookModelV1,
  links: Map<string, LinkIndexV1> | null,
  seenNames = new Set<number>(),
): void {
  const visit = (tokens: readonly TokenV1[], inName: boolean) => {
    tokens.forEach((token, i) => {
      switch (token.k) {
        case 'area':
          unit.precedents.push({ sheet: unit.sheet, area: token });
          break;
        case 'areaN': {
          if (inName) {
            unit.problem ??= 'name with a relative reference';
            break;
          }
          const wrap = (v: number, n: number) => ((v % n) + n) % n;
          unit.precedents.push({
            sheet: unit.sheet,
            area: {
              r1: token.r1Rel ? wrap(unit.row + token.r1, 1_048_576) : token.r1,
              r2: token.r2Rel ? wrap(unit.row + token.r2, 1_048_576) : token.r2,
              c1: token.c1Rel ? wrap(unit.col + token.c1, MAX_COLUMNS_V1) : token.c1,
              c2: token.c2Rel ? wrap(unit.col + token.c2, MAX_COLUMNS_V1) : token.c2,
            },
          });
          break;
        }
        case 'area3d': {
          const xti = model.xti[token.ixti];
          const book = xti ? model.books[xti.book] : undefined;
          if (!xti || !book || xti.first < 0) break;
          if (book.kind === 'external') {
            unit.external = true;
            const sheet = book.part ? links?.get(book.part)?.sheetNames[xti.first] : undefined;
            if (book.part && sheet !== undefined && xti.first === xti.last)
              unit.externalReads?.push({ part: book.part, sheet, area: token });
            else unit.externalReads = null;
          } else
            for (let s = xti.first; s <= xti.last; s++)
              unit.precedents.push({ sheet: s, area: token });
          break;
        }
        case 'nameX': {
          unit.external = true;
          const xti = model.xti[token.ixti];
          const book = xti ? model.books[xti.book] : undefined;
          const name =
            book?.kind === 'external' && book.part
              ? links?.get(book.part)?.names[token.index - 1]
              : undefined;
          if (book?.kind === 'external' && book.part && name?.sheet && name.area)
            unit.externalReads?.push({ part: book.part, sheet: name.sheet, area: name.area });
          else unit.externalReads = null;
          break;
        }
        case 'name': {
          const name = model.names[token.index - 1];
          if (!name || /^_xl(fn|ws)\./iu.test(name.name) || seenNames.has(token.index)) break;
          seenNames.add(token.index);
          try {
            visit(decodeFormulaV1(name.rgce, true), true);
          } catch (cause) {
            unit.problem ??=
              cause instanceof UnsupportedFormulaError ? cause.reason : 'name could not be read';
          }
          break;
        }
        case 'func':
          if (token.tab === OFFSET_TAB_V1)
            unit.problem ??= 'OFFSET (address decided while calculating)';
          if (token.tab === INDIRECT_TAB_V1) {
            const previous = tokens[i - 1];
            const target =
              previous?.k === 'str' && token.argc === 1
                ? addressV1(previous.v, model, unit.sheet)
                : null;
            if (target) unit.precedents.push(target);
            else unit.problem ??= 'INDIRECT with a computed address';
          }
          break;
        default:
          break;
      }
    });
  };
  if (unit.tokens) visit(unit.tokens, false);
}

/* ---------------------------------------------------------------- dependency index */

/** Which units read a cell: single cells by key, narrow areas by column, wide areas in a list. */
class ReadersIndexV1 {
  private readonly singles = new Map<string, number[]>();
  private readonly columns = new Map<string, { r1: number; r2: number; unit: number }[]>();
  private readonly wide = new Map<number, { area: AreaV1; unit: number }[]>();

  add(unit: UnitV1) {
    for (const { sheet, area } of unit.precedents) {
      if (area.r1 === area.r2 && area.c1 === area.c2) {
        const key = `${sheet}:${cellKeyV1(area.r1, area.c1)}`;
        const list = this.singles.get(key) ?? [];
        list.push(unit.id);
        this.singles.set(key, list);
      } else if (area.c2 - area.c1 <= 64) {
        for (let c = area.c1; c <= area.c2; c++) {
          const key = `${sheet}:${c}`;
          const list = this.columns.get(key) ?? [];
          list.push({ r1: area.r1, r2: area.r2, unit: unit.id });
          this.columns.set(key, list);
        }
      } else {
        const list = this.wide.get(sheet) ?? [];
        list.push({ area, unit: unit.id });
        this.wide.set(sheet, list);
      }
    }
  }

  readers(sheet: number, row: number, col: number): number[] {
    const out = [...(this.singles.get(`${sheet}:${cellKeyV1(row, col)}`) ?? [])];
    for (const entry of this.columns.get(`${sheet}:${col}`) ?? [])
      if (row >= entry.r1 && row <= entry.r2) out.push(entry.unit);
    for (const entry of this.wide.get(sheet) ?? [])
      if (
        row >= entry.area.r1 &&
        row <= entry.area.r2 &&
        col >= entry.area.c1 &&
        col <= entry.area.c2
      )
        out.push(entry.unit);
    return out;
  }
}

/* ---------------------------------------------------------------- calculation */

type PassV1 = {
  /** New value of each recalculated cell (sheet:key). */
  readonly values: Map<string, ScalarV1>;
  /** Units that could not be calculated, with the reason. */
  readonly failed: Map<number, string>;
};

const cellIdV1 = (sheet: number, row: number, col: number) => `${sheet}:${cellKeyV1(row, col)}`;

function contextV1(
  model: WorkbookModelV1,
  links: Map<string, LinkIndexV1>,
  values: Map<string, ScalarV1>,
  unit: UnitV1,
): EvalContextV1 {
  const cellValue = (sheet: number, row: number, col: number): ScalarV1 => {
    const fresh = values.get(cellIdV1(sheet, row, col));
    if (fresh !== undefined) return fresh;
    return model.sheets[sheet]?.cells.get(cellKeyV1(row, col))?.value ?? null;
  };
  return {
    model,
    sheet: unit.sheet,
    row: unit.row,
    col: unit.col,
    array: unit.array,
    cellValue,
    cellsIn: (sheet, area) => cellsInSheetV1(model, values, sheet, area),
    externalValue: (part, sheet, row, col) => {
      const cells = links.get(part)?.bySheet.get(sheet.toLocaleUpperCase('pt-BR'));
      return cells ? (cells.get(cellKeyV1(row, col)) ?? null) : undefined;
    },
    externalCellsIn: (part, sheet, area) => {
      const cells = links.get(part)?.bySheet.get(sheet.toLocaleUpperCase('pt-BR'));
      if (!cells) return undefined;
      const out: { row: number; col: number; value: ScalarV1 }[] = [];
      for (const [key, value] of cells) {
        const row = Math.floor(key / MAX_COLUMNS_V1);
        const col = key % MAX_COLUMNS_V1;
        if (value !== null && row >= area.r1 && row <= area.r2 && col >= area.c1 && col <= area.c2)
          out.push({ row, col, value });
      }
      return out.sort((a, b) => a.row - b.row || a.col - b.col);
    },
    externalName: (part, index) => {
      const name = links.get(part)?.names[index - 1];
      if (!name?.sheet || !name.area) return null;
      const ref: RefV1 = { kind: 'ref', book: part, sheet: name.sheet, ...name.area };
      return ref;
    },
    externalSheet: (part, index) => links.get(part)?.sheetNames[index] ?? null,
  };
}

function cellsInSheetV1(
  model: WorkbookModelV1,
  values: Map<string, ScalarV1>,
  sheetIndex: number,
  area: AreaV1,
): { row: number; col: number; value: ScalarV1 }[] {
  const sheet = model.sheets[sheetIndex];
  if (!sheet) return [];
  const out: { row: number; col: number; value: ScalarV1 }[] = [];
  const size = (area.r2 - area.r1 + 1) * (area.c2 - area.c1 + 1);
  const read = (row: number, col: number) => {
    const fresh = values.get(cellIdV1(sheetIndex, row, col));
    const value =
      fresh !== undefined ? fresh : (sheet.cells.get(cellKeyV1(row, col))?.value ?? null);
    if (value !== null) out.push({ row, col, value });
  };
  if (size <= 4096) {
    for (let r = area.r1; r <= area.r2; r++) for (let c = area.c1; c <= area.c2; c++) read(r, c);
    return out;
  }
  for (const cell of sheet.cells.values())
    if (cell.row >= area.r1 && cell.row <= area.r2 && cell.col >= area.c1 && cell.col <= area.c2)
      read(cell.row, cell.col);
  return out.sort((a, b) => a.row - b.row || a.col - b.col);
}

/** The values an array or single formula gives to each of its cells. */
function spreadV1(unit: UnitV1, result: EvalValueV1): Map<CellV1, ScalarV1> | string {
  const out = new Map<CellV1, ScalarV1>();
  const asScalar = (value: ScalarV1): ScalarV1 => (value === null ? 0 : value);
  if (!unit.array) {
    if (isArrayV1(result)) out.set(unit.cells[0]!, asScalar(result.data[0] ?? null));
    else if (isRefV1(result) || isMissingV1(result)) return 'reference as a result';
    else out.set(unit.cells[0]!, asScalar(result));
    return out;
  }
  const rows = unit.area.r2 - unit.area.r1 + 1;
  const cols = unit.area.c2 - unit.area.c1 + 1;
  if (isRefV1(result) || isMissingV1(result)) return 'reference as a result';
  if (
    isArrayV1(result) &&
    ((result.rows !== rows && result.rows !== 1) || (result.cols !== cols && result.cols !== 1))
  )
    return 'array result of another size';
  for (const cell of unit.cells) {
    const r = cell.row - unit.area.r1;
    const c = cell.col - unit.area.c1;
    if (!isArrayV1(result)) out.set(cell, asScalar(result));
    else
      out.set(
        cell,
        asScalar(
          result.data[(result.rows === 1 ? 0 : r) * result.cols + (result.cols === 1 ? 0 : c)] ??
            null,
        ),
      );
  }
  return out;
}

function runPassV1(
  model: WorkbookModelV1,
  links: Map<string, LinkIndexV1>,
  order: readonly UnitV1[],
  dependsOn: Map<number, Set<number>>,
  /** Units left as they are before calculating, with the reason. */
  excluded: ReadonlyMap<number, string>,
): PassV1 {
  const values = new Map<string, ScalarV1>();
  const failed = new Map<number, string>();
  for (const unit of order) {
    const reason = excluded.get(unit.id);
    if (reason !== undefined) {
      failed.set(unit.id, reason);
      continue;
    }
    const blockedBy = [...(dependsOn.get(unit.id) ?? [])].find(
      (id) => failed.has(id) || excluded.has(id),
    );
    if (blockedBy !== undefined) {
      failed.set(unit.id, 'depends on a cell left as it is');
      continue;
    }
    if (unit.problem || !unit.tokens) {
      failed.set(unit.id, unit.problem ?? 'formula could not be read');
      continue;
    }
    let result: EvalValueV1;
    try {
      result = evaluateTokensV1(unit.tokens, contextV1(model, links, values, unit));
    } catch (cause) {
      failed.set(
        unit.id,
        cause instanceof UnsupportedFormulaError ? cause.reason : 'calculation failed',
      );
      continue;
    }
    const spread = spreadV1(unit, result);
    if (typeof spread === 'string') {
      failed.set(unit.id, spread);
      continue;
    }
    for (const [cell, value] of spread) values.set(cellIdV1(unit.sheet, cell.row, cell.col), value);
  }
  return { values, failed };
}

/** Same value for Excel: numbers exactly, text exactly, errors by code. */
function sameScalarV1(a: ScalarV1, b: ScalarV1): boolean {
  if (isErrorV1(a) || isErrorV1(b)) return isErrorV1(a) && isErrorV1(b) && a.code === b.code;
  return a === b;
}

const ERROR_TEXT_V1: Readonly<Record<number, string>> = {
  [ERR_V1.NULL]: '#NULO!',
  [ERR_V1.DIV0]: '#DIV/0!',
  [ERR_V1.VALUE]: '#VALOR!',
  [ERR_V1.REF]: '#REF!',
  [ERR_V1.NAME]: '#NOME?',
  [ERR_V1.NUM]: '#NÚM!',
  [ERR_V1.NA]: '#N/D',
  [ERR_V1.GETTING_DATA]: '#OBTENDO_DADOS',
};

/** A value as the Portuguese Excel shows it, for the audit samples in the panel. */
const describeV1 = (value: ScalarV1): string => {
  if (isErrorV1(value)) return ERROR_TEXT_V1[value.code] ?? `#${value.code}`;
  if (value === null) return 'vazio';
  const text = toTextV1(value) as string;
  return typeof value === 'string' ? `"${text}"` : text;
};

/** "AB12" from a zero-based row and column. */
function a1V1(row: number, col: number): string {
  let letters = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCodePoint(65 + ((n - 1) % 26)) + letters;
  return `${letters}${row + 1}`;
}

/* ---------------------------------------------------------------- rewriting cell results */

function headerV1(type: number, size: number): number[] {
  const header = type < 0x80 ? [type] : [(type & 0x7f) | 0x80, type >> 7];
  let rest = size;
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    header.push(rest ? byte | 0x80 : byte);
  } while (rest);
  return header;
}

/** A formula cell record with a new result; the cell, flags and formula bytes are kept. */
function rewrittenRecordV1(bytes: Uint8Array, cell: CellV1, value: ScalarV1): Uint8Array {
  const formula = cell.formula!;
  const data = bytes.subarray(formula.dataStart, formula.dataEnd);
  const oldValueSize =
    formula.recordType === 0x09
      ? 8
      : formula.recordType === 0x08
        ? 4 + 2 * new DataView(data.buffer, data.byteOffset + 8, 4).getUint32(0, true)
        : 1;
  const tail = data.subarray(8 + oldValueSize);
  let type: number;
  let valueBytes: Uint8Array;
  if (typeof value === 'number') {
    type = 0x09;
    valueBytes = new Uint8Array(8);
    new DataView(valueBytes.buffer).setFloat64(0, value, true);
  } else if (typeof value === 'string') {
    type = 0x08;
    valueBytes = new Uint8Array(4 + value.length * 2);
    const view = new DataView(valueBytes.buffer);
    view.setUint32(0, value.length, true);
    for (let i = 0; i < value.length; i++) view.setUint16(4 + i * 2, value.charCodeAt(i), true);
  } else if (typeof value === 'boolean') {
    type = 0x0a;
    valueBytes = Uint8Array.of(value ? 1 : 0);
  } else if (isErrorV1(value)) {
    type = 0x0b;
    valueBytes = Uint8Array.of(value.code);
  } else {
    type = 0x09;
    valueBytes = new Uint8Array(8);
  }
  const body = new Uint8Array(8 + valueBytes.length + tail.length);
  body.set(data.subarray(0, 8), 0);
  body.set(valueBytes, 8);
  body.set(tail, 8 + valueBytes.length);
  const header = headerV1(type, body.length);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

function rewriteSheetV1(
  sheet: SheetModelV1,
  changes: readonly { cell: CellV1; value: ScalarV1 }[],
): Uint8Array {
  const sorted = [...changes].sort(
    (a, b) => a.cell.formula!.recordStart - b.cell.formula!.recordStart,
  );
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const { cell, value } of sorted) {
    parts.push(sheet.bytes.subarray(at, cell.formula!.recordStart));
    parts.push(rewrittenRecordV1(sheet.bytes, cell, value));
    at = cell.formula!.dataEnd;
  }
  parts.push(sheet.bytes.subarray(at));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/* ---------------------------------------------------------------- the whole recalculation */

const MAX_UNITS_V1 = 200_000;

/**
 * Recalculates what depends on the links. `before` are the link copies Excel last calculated with
 * (the proof), `after` the refreshed ones. Returns the sheet parts to replace and a report.
 */
export async function recalculateLinkedCellsV1(input: {
  readonly pkg: ZipPackageV1;
  readonly before: LinkCachesV1;
  readonly after: LinkCachesV1;
  /** Every cell left as it is in the samples (local investigation only). */
  readonly traceAll?: boolean;
  /** Recalculate every formula of the workbook, links changed or not (to prove the engine on a file). */
  readonly proveAll?: boolean;
}): Promise<RecalcResultV1> {
  const empty = (blocked: string | null, dependent = 0): RecalcResultV1 => ({
    replacements: new Map(),
    report: {
      dependent,
      writtenCells: 0,
      skipped: 0,
      reasons: {},
      reasonSamples: {},
      mismatches: 0,
      mismatchSamples: [],
      blocked,
    },
  });
  if (!(await readZipEntryV1(input.pkg, 'xl/workbook.bin')))
    return empty('only .xlsb files are recalculated');
  const model = await readWorkbookModelV1(input.pkg);
  if (!model) return empty('workbook could not be read');
  const units = unitsV1(model);
  if (units.length > MAX_UNITS_V1) return empty('too many formulas');
  const linksBefore = linkIndexV1(input.before);
  const linksAfter = linkIndexV1(input.after);
  for (const unit of units) dependenciesV1(unit, model, linksAfter);

  // The chain: units that read a link, then everything that reads their cells.
  const index = new ReadersIndexV1();
  for (const unit of units) index.add(unit);
  const inChain = new Set<number>();
  const changed = changedLinkCellsV1(linksBefore, linksAfter);
  const reads = (unit: UnitV1) =>
    unit.externalReads === null ||
    unit.externalReads.some((read) => changed.touches(read.part, read.sheet, read.area));
  const queue = units
    .filter((unit) => input.proveAll || (unit.external && reads(unit)))
    .map((unit) => unit.id);
  queue.forEach((id) => inChain.add(id));
  while (queue.length) {
    const unit = units[queue.pop()!]!;
    for (const cell of unit.cells)
      for (const reader of index.readers(unit.sheet, cell.row, cell.col))
        if (!inChain.has(reader)) {
          inChain.add(reader);
          queue.push(reader);
        }
  }
  if (inChain.size === 0) return empty(null);

  // Order: a unit after every chain unit it reads; a cycle leaves its units out.
  const owner = new Map<string, number>();
  for (const id of inChain)
    for (const cell of units[id]!.cells)
      owner.set(cellIdV1(units[id]!.sheet, cell.row, cell.col), id);
  const dependsOn = new Map<number, Set<number>>();
  for (const id of inChain) {
    const deps = new Set<number>();
    for (const { sheet, area } of units[id]!.precedents) {
      const size = (area.r2 - area.r1 + 1) * (area.c2 - area.c1 + 1);
      if (size <= 4096) {
        for (let r = area.r1; r <= area.r2; r++)
          for (let c = area.c1; c <= area.c2; c++) {
            const other = owner.get(cellIdV1(sheet, r, c));
            if (other !== undefined && other !== id) deps.add(other);
          }
      } else {
        for (const other of inChain) {
          if (other === id) continue;
          const u = units[other]!;
          if (
            u.sheet === sheet &&
            u.cells.some(
              (cell) =>
                cell.row >= area.r1 &&
                cell.row <= area.r2 &&
                cell.col >= area.c1 &&
                cell.col <= area.c2,
            )
          )
            deps.add(other);
        }
      }
    }
    dependsOn.set(id, deps);
  }
  const order: UnitV1[] = [];
  const state = new Map<number, 'visiting' | 'done'>();
  const cyclic = new Set<number>();
  const visit = (id: number) => {
    const stack: { id: number; deps: number[]; i: number }[] = [
      { id, deps: [...(dependsOn.get(id) ?? [])], i: 0 },
    ];
    state.set(id, 'visiting');
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      if (top.i < top.deps.length) {
        const next = top.deps[top.i++]!;
        const s = state.get(next);
        if (s === 'visiting') {
          cyclic.add(next);
          cyclic.add(top.id);
        } else if (s === undefined) {
          state.set(next, 'visiting');
          stack.push({ id: next, deps: [...(dependsOn.get(next) ?? [])], i: 0 });
        }
      } else {
        state.set(top.id, 'done');
        order.push(units[top.id]!);
        stack.pop();
      }
    }
  };
  for (const id of inChain) if (!state.has(id)) visit(id);

  // Formulas outside the chain whose address is computed cannot be proved unaffected.
  const unknowable = units.filter(
    (u) =>
      !inChain.has(u.id) && (u.problem?.startsWith('INDIRECT') || u.problem?.startsWith('OFFSET')),
  );
  if (unknowable.length > 0)
    return empty(
      `${unknowable.length} formula(s) with INDIRECT/OFFSET whose address cannot be checked`,
      inChain.size,
    );

  // Proof: the old link values must give back exactly what Excel saved.
  const circular = new Map([...cyclic].map((id) => [id, 'circular reference'] as const));
  const proof = runPassV1(model, linksBefore, order, dependsOn, circular);
  const mismatched = new Set<number>();
  const samples: string[] = [];
  for (const unit of order) {
    if (proof.failed.has(unit.id)) continue;
    for (const cell of unit.cells) {
      const computed = proof.values.get(cellIdV1(unit.sheet, cell.row, cell.col)) ?? null;
      if (!sameScalarV1(computed, cell.value)) {
        mismatched.add(unit.id);
        if (samples.length < 5)
          samples.push(
            `${model.sheets[unit.sheet]!.name}!${a1V1(cell.row, cell.col)}: Excel ${describeV1(cell.value)}, motor ${describeV1(computed)}`,
          );
      }
    }
  }
  const excluded = new Map([
    ...circular,
    ...[...mismatched].map((id) => [id, 'did not match Excel with the old values'] as const),
  ]);
  // A unit that reads a mismatched one is left as it is too (it would follow a wrong value).
  const result = runPassV1(model, linksAfter, order, dependsOn, excluded);

  const reasons: Record<string, number> = {};
  const reasonSamples: Record<string, string[]> = {};
  for (const [id, reason] of result.failed) {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    const list = (reasonSamples[reason] ??= []);
    if (list.length < (input.traceAll ? Number.POSITIVE_INFINITY : 5)) {
      const unit = units[id]!;
      list.push(`${model.sheets[unit.sheet]!.name}!${a1V1(unit.row, unit.col)}`);
    }
  }

  const changes = new Map<SheetModelV1, { cell: CellV1; value: ScalarV1 }[]>();
  let writtenCells = 0;
  for (const unit of order) {
    if (result.failed.has(unit.id)) continue;
    const sheet = model.sheets[unit.sheet]!;
    for (const cell of unit.cells) {
      const value = result.values.get(cellIdV1(unit.sheet, cell.row, cell.col));
      if (value === undefined || sameScalarV1(value, cell.value)) continue;
      const list = changes.get(sheet) ?? [];
      list.push({ cell, value });
      changes.set(sheet, list);
      writtenCells++;
    }
  }
  const replacements = new Map<string, Uint8Array>();
  for (const [sheet, list] of changes) replacements.set(sheet.part, rewriteSheetV1(sheet, list));
  return {
    replacements,
    report: {
      dependent: inChain.size,
      writtenCells,
      skipped: result.failed.size,
      reasons,
      reasonSamples,
      mismatches: mismatched.size,
      mismatchSamples: samples,
      blocked: null,
    },
  };
}

export { ERR_V1 };
