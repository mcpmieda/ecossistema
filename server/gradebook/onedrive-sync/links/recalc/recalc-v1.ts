import {
  utf16UnitsV1,
  type ExternalLinkCacheV1,
  type LinkValueV1,
} from '../external-link-cache-v1';
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
  for (const [part, next] of after) {
    const previous = before.get(part);
    for (const [sheet, cells] of next.bySheet) {
      const old = previous?.bySheet.get(sheet);
      const keys = new Set([...cells.keys(), ...(old?.keys() ?? [])]);
      const list: number[] = [];
      for (const key of keys)
        if (!old || !sameScalarV1(old.get(key) ?? null, cells.get(key) ?? null)) list.push(key);
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
    for (const cell of sheet.cells.values())
      if (cell.formula) addFormulaCellV1(units, arrayUnits, sheet, cell, cell.formula.rgce);
  }
  return units;
}

/** A formula cell becomes a unit, or joins the unit of its array formula. */
function addFormulaCellV1(
  units: UnitV1[],
  arrayUnits: Map<FormulaGroupV1, UnitV1>,
  sheet: SheetModelV1,
  cell: CellV1,
  rgce: Uint8Array,
): void {
  const isExp = rgce[0] === 0x01;
  const group = isExp ? groupOfV1(sheet, cell) : undefined;
  const base = { id: units.length, sheet: sheet.index };
  if (isExp && !group) {
    const problem = 'array or shared formula without its group';
    units.push(newUnitV1({ ...base, at: cell, cells: [cell], rgce: null, problem }));
    return;
  }
  if (group?.kind !== 'array') {
    const relative = group?.kind === 'shared';
    units.push(
      newUnitV1({ ...base, at: cell, cells: [cell], rgce: group?.rgce ?? rgce, relative }),
    );
    return;
  }
  let unit = arrayUnits.get(group);
  if (!unit) {
    const area = { r1: group.r1, r2: group.r2, c1: group.c1, c2: group.c2 };
    unit = newUnitV1({
      ...base,
      at: { row: group.r1, col: group.c1 },
      cells: [],
      rgce: group.rgce,
      area,
    });
    arrayUnits.set(group, unit);
    units.push(unit);
  }
  (unit.cells as CellV1[]).push(cell);
}

type UnitSpecV1 = {
  readonly id: number;
  readonly sheet: number;
  /** The cell where it is evaluated. */
  readonly at: { readonly row: number; readonly col: number };
  readonly cells: CellV1[];
  readonly rgce: Uint8Array | null;
  /** The area of an array formula (absent for a single cell). */
  readonly area?: AreaV1;
  readonly problem?: string;
  /** Read the tokens as a shared formula stores them. */
  readonly relative?: boolean;
};

function newUnitV1(spec: UnitSpecV1): UnitV1 {
  const { at } = spec;
  let tokens: TokenV1[] | null = null;
  let issue = spec.problem ?? null;
  if (spec.rgce && !issue) {
    try {
      tokens = decodeFormulaV1(spec.rgce, spec.relative ?? false);
    } catch (cause) {
      issue = cause instanceof UnsupportedFormulaError ? cause.reason : 'formula could not be read';
    }
  }
  return {
    id: spec.id,
    sheet: spec.sheet,
    row: at.row,
    col: at.col,
    cells: spec.cells,
    area: spec.area ?? { r1: at.row, r2: at.row, c1: at.col, c2: at.col },
    array: spec.area !== undefined,
    tokens,
    precedents: [],
    external: false,
    externalReads: [],
    problem: issue,
  };
}

/** "Folha", "'Nota final'" → the sheet's name; null when it cannot be one. */
function sheetNameV1(text: string): string | null {
  const quoted = /^'((?:[^']|'')+)'$/u.exec(text);
  if (quoted) return quoted[1]!.replaceAll("''", "'");
  return /^[^'!]+$/u.test(text) ? text : null;
}

/** "$B$7", "A1:B2". */
const CELL_AREA_V1 = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/iu;

/** Zero-based column of "A", "AB"… */
const columnOfLettersV1 = (letters: string): number =>
  [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.codePointAt(0)! - 64, 0) - 1;

/** "Folha!$B$7", "B7", "'Nota final'!A1:B2" → sheet (or the formula's) and area; null otherwise. */
function addressV1(
  text: string,
  model: WorkbookModelV1,
  sheet: number,
): { sheet: number; area: AreaV1 } | null {
  const trimmed = text.trim();
  // A cell address has no "!", so the last one ends the sheet's name.
  const bang = trimmed.lastIndexOf('!');
  const match = CELL_AREA_V1.exec(trimmed.slice(bang + 1));
  if (!match) return null;
  const sheetName = bang < 0 ? undefined : sheetNameV1(trimmed.slice(0, bang));
  if (sheetName === null) return null;
  const target =
    sheetName === undefined
      ? model.sheets[sheet]
      : model.sheetByName.get(sheetName.toLocaleUpperCase('pt-BR'));
  if (!target) return null;
  const r1 = Number(match[2]) - 1;
  const c1 = columnOfLettersV1(match[1]!);
  const r2 = match[4] ? Number(match[4]) - 1 : r1;
  const c2 = match[3] ? columnOfLettersV1(match[3]) : c1;
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

/** One unit's walk through its tokens (and those of the names it uses). */
type DependencyWalkV1 = {
  readonly unit: UnitV1;
  readonly model: WorkbookModelV1;
  readonly links: Map<string, LinkIndexV1> | null;
  readonly seenNames: Set<number>;
};

const wrapV1 = (value: number, size: number) => ((value % size) + size) % size;

/** The area a relative reference points to from the unit's cell. */
function relativeAreaV1(unit: UnitV1, token: Extract<TokenV1, { k: 'areaN' }>): AreaV1 {
  return {
    r1: token.r1Rel ? wrapV1(unit.row + token.r1, 1_048_576) : token.r1,
    r2: token.r2Rel ? wrapV1(unit.row + token.r2, 1_048_576) : token.r2,
    c1: token.c1Rel ? wrapV1(unit.col + token.c1, MAX_COLUMNS_V1) : token.c1,
    c2: token.c2Rel ? wrapV1(unit.col + token.c2, MAX_COLUMNS_V1) : token.c2,
  };
}

/** A reference through a sheet list entry: other sheets of this workbook, or a link. */
function sheetReferenceV1(
  { unit, model, links }: DependencyWalkV1,
  token: Extract<TokenV1, { k: 'area3d' }>,
): void {
  const xti = model.xti[token.ixti];
  const book = xti ? model.books[xti.book] : undefined;
  if (!xti || !book || xti.first < 0) return;
  if (book.kind !== 'external') {
    for (let s = xti.first; s <= xti.last; s++) unit.precedents.push({ sheet: s, area: token });
    return;
  }
  unit.external = true;
  const sheet = book.part ? links?.get(book.part)?.sheetNames[xti.first] : undefined;
  if (book.part && sheet !== undefined && xti.first === xti.last)
    unit.externalReads?.push({ part: book.part, sheet, area: token });
  else unit.externalReads = null;
}

/** A name of a linked workbook (its area is in the link). */
function linkedNameReferenceV1(
  { unit, model, links }: DependencyWalkV1,
  token: Extract<TokenV1, { k: 'nameX' }>,
): void {
  unit.external = true;
  const xti = model.xti[token.ixti];
  const book = xti ? model.books[xti.book] : undefined;
  const part = book?.kind === 'external' ? book.part : null;
  const name = part ? links?.get(part)?.names[token.index - 1] : undefined;
  if (part && name?.sheet && name.area)
    unit.externalReads?.push({ part, sheet: name.sheet, area: name.area });
  else unit.externalReads = null;
}

/** A defined name of this workbook: what its formula reads counts as read by the unit. */
function definedNameReferenceV1(walk: DependencyWalkV1, index: number): void {
  const name = walk.model.names[index - 1];
  if (!name || /^_xl(fn|ws)\./iu.test(name.name) || walk.seenNames.has(index)) return;
  walk.seenNames.add(index);
  try {
    visitTokensV1(walk, decodeFormulaV1(name.rgce, true), true);
  } catch (cause) {
    walk.unit.problem ??=
      cause instanceof UnsupportedFormulaError ? cause.reason : 'name could not be read';
  }
}

/** OFFSET and INDIRECT: only INDIRECT of a written address can be followed. */
function functionReferenceV1(
  { unit, model }: DependencyWalkV1,
  token: Extract<TokenV1, { k: 'func' }>,
  previous: TokenV1 | undefined,
): void {
  if (token.tab === OFFSET_TAB_V1) unit.problem ??= 'OFFSET (address decided while calculating)';
  if (token.tab !== INDIRECT_TAB_V1) return;
  const target =
    previous?.k === 'str' && token.argc === 1 ? addressV1(previous.v, model, unit.sheet) : null;
  if (target) unit.precedents.push(target);
  else unit.problem ??= 'INDIRECT with a computed address';
}

function visitTokensV1(walk: DependencyWalkV1, tokens: readonly TokenV1[], inName: boolean) {
  const { unit } = walk;
  tokens.forEach((token, i) => {
    switch (token.k) {
      case 'area':
        unit.precedents.push({ sheet: unit.sheet, area: token });
        break;
      case 'areaN':
        if (inName) unit.problem ??= 'name with a relative reference';
        else unit.precedents.push({ sheet: unit.sheet, area: relativeAreaV1(unit, token) });
        break;
      case 'area3d':
        sheetReferenceV1(walk, token);
        break;
      case 'nameX':
        linkedNameReferenceV1(walk, token);
        break;
      case 'name':
        definedNameReferenceV1(walk, token.index);
        break;
      case 'func':
        functionReferenceV1(walk, token, tokens[i - 1]);
        break;
      default:
        break;
    }
  });
}

/** What a unit reads: areas of this workbook, whether it reads a link, and anything unknowable. */
function dependenciesV1(
  unit: UnitV1,
  model: WorkbookModelV1,
  links: Map<string, LinkIndexV1> | null,
): void {
  if (unit.tokens) visitTokensV1({ unit, model, links, seenNames: new Set() }, unit.tokens, false);
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

/** The values an array or single formula gives to each of its cells (an empty result is 0). */
function spreadV1(unit: UnitV1, result: EvalValueV1): Map<CellV1, ScalarV1> | string {
  if (isRefV1(result) || isMissingV1(result)) return 'reference as a result';
  const out = new Map<CellV1, ScalarV1>();
  if (!isArrayV1(result)) {
    for (const cell of unit.cells) out.set(cell, result ?? 0);
    return out;
  }
  if (!unit.array) {
    out.set(unit.cells[0]!, result.data[0] ?? 0);
    return out;
  }
  const fits = (size: number, wanted: number) => size === wanted || size === 1;
  if (
    !fits(result.rows, unit.area.r2 - unit.area.r1 + 1) ||
    !fits(result.cols, unit.area.c2 - unit.area.c1 + 1)
  )
    return 'array result of another size';
  for (const cell of unit.cells) {
    const r = result.rows === 1 ? 0 : cell.row - unit.area.r1;
    const c = result.cols === 1 ? 0 : cell.col - unit.area.c1;
    out.set(cell, result.data[r * result.cols + c] ?? 0);
  }
  return out;
}

/** Why a unit is not calculated in this pass; null when it is. */
function skipReasonV1(
  unit: UnitV1,
  dependsOn: Map<number, Set<number>>,
  excluded: ReadonlyMap<number, string>,
  failed: ReadonlyMap<number, string>,
): string | null {
  const reason = excluded.get(unit.id);
  if (reason !== undefined) return reason;
  const deps = dependsOn.get(unit.id) ?? [];
  if ([...deps].some((id) => failed.has(id) || excluded.has(id)))
    return 'depends on a cell left as it is';
  if (unit.problem || !unit.tokens) return unit.problem ?? 'formula could not be read';
  return null;
}

/** The values a unit gives to its cells, or why it could not be calculated. */
function calculateUnitV1(
  model: WorkbookModelV1,
  links: Map<string, LinkIndexV1>,
  values: Map<string, ScalarV1>,
  unit: UnitV1,
): Map<CellV1, ScalarV1> | string {
  let result: EvalValueV1;
  try {
    result = evaluateTokensV1(unit.tokens!, contextV1(model, links, values, unit));
  } catch (cause) {
    return cause instanceof UnsupportedFormulaError ? cause.reason : 'calculation failed';
  }
  return spreadV1(unit, result);
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
    const outcome =
      skipReasonV1(unit, dependsOn, excluded, failed) ??
      calculateUnitV1(model, links, values, unit);
    if (typeof outcome === 'string') failed.set(unit.id, outcome);
    else
      for (const [cell, value] of outcome)
        values.set(cellIdV1(unit.sheet, cell.row, cell.col), value);
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

/** Longest text shown in an audit sample (the panel's note has a size limit). */
const SAMPLE_TEXT_V1 = 40;

/**
 * A value for the audit samples in the panel, close to how the Portuguese Excel shows it: a number
 * in full (to show why it did not match), a long text cut.
 */
const describeV1 = (value: ScalarV1): string => {
  if (isErrorV1(value)) return ERROR_TEXT_V1[value.code] ?? `#${value.code}`;
  if (value === null) return 'vazio';
  if (typeof value === 'boolean') return value ? 'VERDADEIRO' : 'FALSO';
  if (typeof value === 'number') return String(value).replace('.', ',');
  if (value.length <= SAMPLE_TEXT_V1) return `"${value}"`;
  return `"${value.slice(0, SAMPLE_TEXT_V1)}…"`;
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

/** Size of the result a formula record holds: number, text (count and units), logical or error. */
function storedValueSizeV1(recordType: number, data: Uint8Array): number {
  if (recordType === 0x09) return 8;
  if (recordType === 0x08)
    return 4 + 2 * new DataView(data.buffer, data.byteOffset + 8, 4).getUint32(0, true);
  return 1;
}

/** A result as a formula record's type (BrtFmlaNum, String, Bool, Error) and value bytes. */
function resultBytesV1(value: ScalarV1): { type: number; bytes: Uint8Array } {
  if (typeof value === 'string') {
    const units = utf16UnitsV1(value);
    const bytes = new Uint8Array(4 + units.length * 2);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, units.length, true);
    units.forEach((unit, i) => view.setUint16(4 + i * 2, unit, true));
    return { type: 0x08, bytes };
  }
  if (typeof value === 'boolean') return { type: 0x0a, bytes: Uint8Array.of(value ? 1 : 0) };
  if (isErrorV1(value)) return { type: 0x0b, bytes: Uint8Array.of(value.code) };
  const bytes = new Uint8Array(8);
  if (typeof value === 'number') new DataView(bytes.buffer).setFloat64(0, value, true);
  return { type: 0x09, bytes };
}

/** A formula cell record with a new result; the cell, flags and formula bytes are kept. */
function rewrittenRecordV1(bytes: Uint8Array, cell: CellV1, value: ScalarV1): Uint8Array {
  const formula = cell.formula!;
  const data = bytes.subarray(formula.dataStart, formula.dataEnd);
  const tail = data.subarray(8 + storedValueSizeV1(formula.recordType, data));
  const { type, bytes: valueBytes } = resultBytesV1(value);
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
    parts.push(
      sheet.bytes.subarray(at, cell.formula!.recordStart),
      rewrittenRecordV1(sheet.bytes, cell, value),
    );
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

/** A report of nothing recalculated, and why (null: no formula depends on what changed). */
export function blockedRecalcReportV1(blocked: string | null, dependent = 0): RecalcReportV1 {
  return {
    dependent,
    writtenCells: 0,
    skipped: 0,
    reasons: {},
    reasonSamples: {},
    mismatches: 0,
    mismatchSamples: [],
    blocked,
  };
}

const nothingRecalculatedV1 = (blocked: string | null, dependent = 0): RecalcResultV1 => ({
  replacements: new Map(),
  report: blockedRecalcReportV1(blocked, dependent),
});

const insideV1 = (area: AreaV1, row: number, col: number): boolean =>
  row >= area.r1 && row <= area.r2 && col >= area.c1 && col <= area.c2;

/** The chain: the units it starts from, then every unit that reads their cells. */
function chainV1(units: readonly UnitV1[], starts: readonly number[]): Set<number> {
  const index = new ReadersIndexV1();
  for (const unit of units) index.add(unit);
  const inChain = new Set(starts);
  const queue = [...starts];
  while (queue.length) {
    const unit = units[queue.pop()!]!;
    for (const cell of unit.cells)
      for (const reader of index.readers(unit.sheet, cell.row, cell.col)) {
        if (inChain.has(reader)) continue;
        inChain.add(reader);
        queue.push(reader);
      }
  }
  return inChain;
}

/** For each chain unit, the other chain units whose cells it reads. */
function dependsOnV1(units: readonly UnitV1[], inChain: Set<number>): Map<number, Set<number>> {
  const owner = new Map<string, number>();
  for (const id of inChain)
    for (const cell of units[id]!.cells)
      owner.set(cellIdV1(units[id]!.sheet, cell.row, cell.col), id);
  // Small areas cell by cell; large ones by looking at every chain unit.
  function* ownersOf(sheet: number, area: AreaV1): Iterable<number> {
    if ((area.r2 - area.r1 + 1) * (area.c2 - area.c1 + 1) > 4096) {
      for (const other of inChain) {
        const unit = units[other]!;
        if (unit.sheet === sheet && unit.cells.some((cell) => insideV1(area, cell.row, cell.col)))
          yield other;
      }
      return;
    }
    for (let r = area.r1; r <= area.r2; r++)
      for (let c = area.c1; c <= area.c2; c++) {
        const other = owner.get(cellIdV1(sheet, r, c));
        if (other !== undefined) yield other;
      }
  }
  const dependsOn = new Map<number, Set<number>>();
  for (const id of inChain) {
    const deps = new Set<number>();
    for (const { sheet, area } of units[id]!.precedents)
      for (const other of ownersOf(sheet, area)) if (other !== id) deps.add(other);
    dependsOn.set(id, deps);
  }
  return dependsOn;
}

/** Calculation order: a unit after every chain unit it reads; the units of a cycle are marked. */
function orderV1(
  units: readonly UnitV1[],
  inChain: Set<number>,
  dependsOn: Map<number, Set<number>>,
): { order: UnitV1[]; cyclic: Set<number> } {
  const order: UnitV1[] = [];
  const state = new Map<number, 'visiting' | 'done'>();
  const cyclic = new Set<number>();
  const frame = (id: number) => ({ id, deps: [...(dependsOn.get(id) ?? [])], i: 0 });
  for (const id of inChain) {
    if (state.has(id)) continue;
    const stack = [frame(id)];
    state.set(id, 'visiting');
    while (stack.length) {
      const top = stack.at(-1)!;
      if (top.i >= top.deps.length) {
        state.set(top.id, 'done');
        order.push(units[top.id]!);
        stack.pop();
        continue;
      }
      const next = top.deps[top.i++]!;
      const seen = state.get(next);
      if (seen === 'visiting') {
        cyclic.add(next);
        cyclic.add(top.id);
      } else if (seen === undefined) {
        state.set(next, 'visiting');
        stack.push(frame(next));
      }
    }
  }
  return { order, cyclic };
}

/** The proof: with the old link values, the units whose result is not what Excel saved. */
function proofV1(
  model: WorkbookModelV1,
  linksBefore: Map<string, LinkIndexV1>,
  order: readonly UnitV1[],
  dependsOn: Map<number, Set<number>>,
  circular: ReadonlyMap<number, string>,
): { mismatched: Set<number>; samples: string[] } {
  const proof = runPassV1(model, linksBefore, order, dependsOn, circular);
  const mismatched = new Set<number>();
  const samples: string[] = [];
  for (const unit of order) {
    if (proof.failed.has(unit.id)) continue;
    for (const cell of unit.cells) {
      const computed = proof.values.get(cellIdV1(unit.sheet, cell.row, cell.col)) ?? null;
      if (sameScalarV1(computed, cell.value)) continue;
      mismatched.add(unit.id);
      if (samples.length < 5)
        samples.push(
          `${model.sheets[unit.sheet]!.name}!${a1V1(cell.row, cell.col)}: Excel ${describeV1(cell.value)}, motor ${describeV1(computed)}`,
        );
    }
  }
  return { mismatched, samples };
}

/** How many units were left as they are for each reason, with some of their cells. */
function reasonsV1(
  failed: ReadonlyMap<number, string>,
  units: readonly UnitV1[],
  model: WorkbookModelV1,
  traceAll: boolean,
): Pick<RecalcReportV1, 'reasons' | 'reasonSamples'> {
  const reasons: Record<string, number> = {};
  const reasonSamples: Record<string, string[]> = {};
  const limit = traceAll ? Number.POSITIVE_INFINITY : 5;
  for (const [id, reason] of failed) {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    const list = (reasonSamples[reason] ??= []);
    if (list.length >= limit) continue;
    const unit = units[id]!;
    list.push(`${model.sheets[unit.sheet]!.name}!${a1V1(unit.row, unit.col)}`);
  }
  return { reasons, reasonSamples };
}

/** The cells whose result changed, by sheet. */
function cellChangesV1(
  model: WorkbookModelV1,
  order: readonly UnitV1[],
  pass: PassV1,
): Map<SheetModelV1, { cell: CellV1; value: ScalarV1 }[]> {
  const changes = new Map<SheetModelV1, { cell: CellV1; value: ScalarV1 }[]>();
  for (const unit of order) {
    if (pass.failed.has(unit.id)) continue;
    const sheet = model.sheets[unit.sheet]!;
    for (const cell of unit.cells) {
      const value = pass.values.get(cellIdV1(unit.sheet, cell.row, cell.col));
      if (value === undefined || sameScalarV1(value, cell.value)) continue;
      const list = changes.get(sheet) ?? [];
      list.push({ cell, value });
      changes.set(sheet, list);
    }
  }
  return changes;
}

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
  if (!(await readZipEntryV1(input.pkg, 'xl/workbook.bin')))
    return nothingRecalculatedV1('only .xlsb files are recalculated');
  const model = await readWorkbookModelV1(input.pkg);
  if (!model) return nothingRecalculatedV1('workbook could not be read');
  const units = unitsV1(model);
  if (units.length > MAX_UNITS_V1) return nothingRecalculatedV1('too many formulas');
  const linksBefore = linkIndexV1(input.before);
  const linksAfter = linkIndexV1(input.after);
  for (const unit of units) dependenciesV1(unit, model, linksAfter);

  // The chain starts at the units that read a changed link cell.
  const changed = changedLinkCellsV1(linksBefore, linksAfter);
  const readsChange = (unit: UnitV1) =>
    unit.externalReads === null ||
    unit.externalReads.some((read) => changed.touches(read.part, read.sheet, read.area));
  const starts = units
    .filter((unit) => input.proveAll || (unit.external && readsChange(unit)))
    .map((unit) => unit.id);
  const inChain = chainV1(units, starts);
  if (inChain.size === 0) return nothingRecalculatedV1(null);
  const dependsOn = dependsOnV1(units, inChain);
  const { order, cyclic } = orderV1(units, inChain, dependsOn);

  // Formulas outside the chain whose address is computed cannot be proved unaffected.
  const unknowable = units.filter(
    (u) =>
      !inChain.has(u.id) && (u.problem?.startsWith('INDIRECT') || u.problem?.startsWith('OFFSET')),
  ).length;
  if (unknowable > 0)
    return nothingRecalculatedV1(
      `${unknowable} formula(s) with INDIRECT/OFFSET whose address cannot be checked`,
      inChain.size,
    );

  // Proof: the old link values must give back exactly what Excel saved.
  const circular = new Map([...cyclic].map((id) => [id, 'circular reference'] as const));
  const { mismatched, samples } = proofV1(model, linksBefore, order, dependsOn, circular);
  const excluded = new Map([
    ...circular,
    ...[...mismatched].map((id) => [id, 'did not match Excel with the old values'] as const),
  ]);
  // A unit that reads a mismatched one is left as it is too (it would follow a wrong value).
  const result = runPassV1(model, linksAfter, order, dependsOn, excluded);
  const changes = cellChangesV1(model, order, result);
  const replacements = new Map<string, Uint8Array>();
  let writtenCells = 0;
  for (const [sheet, list] of changes) {
    replacements.set(sheet.part, rewriteSheetV1(sheet, list));
    writtenCells += list.length;
  }
  return {
    replacements,
    report: {
      dependent: inChain.size,
      writtenCells,
      skipped: result.failed.size,
      ...reasonsV1(result.failed, units, model, input.traceAll ?? false),
      mismatches: mismatched.size,
      mismatchSamples: samples,
      blocked: null,
    },
  };
}

export { ERR_V1 };
