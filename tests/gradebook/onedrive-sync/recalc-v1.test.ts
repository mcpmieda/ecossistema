// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  readBiff12RecordsV1,
  writeBiff12RecordsV1,
} from '../../../server/gradebook/onedrive-sync/links/biff12-records-v1';
import { readXlsbLinkCacheV1 } from '../../../server/gradebook/onedrive-sync/links/external-link-cache-v1';
import {
  readDestinationLinksV1,
  refreshDestinationLinksV1,
} from '../../../server/gradebook/onedrive-sync/links/refresh-links-v1';
import {
  decodeFormulaV1,
  UnsupportedFormulaError,
} from '../../../server/gradebook/onedrive-sync/links/recalc/formula-tokens-v1';
import {
  recalculateLinkedCellsV1,
  type LinkCachesV1,
  type RecalcReportV1,
} from '../../../server/gradebook/onedrive-sync/links/recalc/recalc-v1';
import {
  expiredLinkResultV1,
  finishLinkRefreshV1,
  newLinkFileV1,
  recalculateOnThisTryV1,
  startLinkRefreshV1,
} from '../../../server/gradebook/onedrive-sync/links/link-rules-v1';
import {
  pendingForVersionV1,
  recalcSummaryV1,
} from '../../../server/gradebook/onedrive-sync/links/run-link-refresh-v1';
import { readSourceValuesV1 } from '../../../server/gradebook/onedrive-sync/links/source-values-v1';
import {
  readZipEntryV1,
  readZipPackageV1,
  rewriteZipPackageV1,
} from '../../../server/gradebook/onedrive-sync/links/zip-package-v1';
import {
  RECALC_DESTINO_V1,
  RECALC_EXPECTED_V1,
  RECALC_FUNCOES_V1,
  RECALC_ORIGEM_V1,
} from '../fixtures/recalc-excel-v1';
import { loadRealSheetJsV1 } from '../fixtures/sheetjs-real-v1';

/* ------------------------------------------------------------------ helpers */

const TURMA = 'xl/worksheets/sheet1.bin';
const ROW_HEADER = 0x00;
const FORMULA_NUMBER = 0x09;

async function refresh(bytes: Uint8Array, recalculate: boolean) {
  const xlsx = await loadRealSheetJsV1();
  return refreshDestinationLinksV1({
    bytes,
    resolve: () => [{ kind: 'path', path: 'origem.xlsb' }],
    loadSource: async (_candidates, sheets) =>
      readSourceValuesV1(xlsx, RECALC_ORIGEM_V1.slice().buffer, sheets),
    recalculate,
  });
}

/** Every cell value, as SheetJS reads it, by "Sheet!A1". */
async function valuesOf(bytes: Uint8Array): Promise<Map<string, unknown>> {
  const xlsx = await loadRealSheetJsV1();
  const workbook = xlsx.read(bytes.slice().buffer, { type: 'array' });
  const values = new Map<string, unknown>();
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name] as Record<string, { v?: unknown }>;
    for (const [ref, cell] of Object.entries(sheet))
      if (!ref.startsWith('!')) values.set(`${name}!${ref}`, cell.v);
  }
  return values;
}

/** Replaces the data of one formula record (found by row and column) in a sheet part. */
async function editFormulaCell(
  bytes: Uint8Array,
  part: string,
  row: number,
  col: number,
  edit: (data: Uint8Array, type: number) => Uint8Array,
): Promise<Uint8Array> {
  const pkg = readZipPackageV1(bytes);
  const records = readBiff12RecordsV1((await readZipEntryV1(pkg, part))!);
  let currentRow = -1;
  let found = false;
  const edited = records.map((record) => {
    const view = new DataView(record.data.buffer, record.data.byteOffset, record.data.byteLength);
    if (record.type === ROW_HEADER) currentRow = view.getUint32(0, true);
    else if (
      record.type >= 0x08 &&
      record.type <= 0x0b &&
      currentRow === row &&
      view.getUint32(0, true) === col
    ) {
      found = true;
      return { type: record.type, data: edit(record.data, record.type) };
    }
    return record;
  });
  expect(found).toBe(true);
  return rewriteZipPackageV1(pkg, new Map([[part, writeBiff12RecordsV1(edited)]]));
}

/** A numeric formula record (BrtFmlaNum) with another formula: cell, value and flags are kept. */
const numberFormula =
  (rgce: Uint8Array) =>
  (data: Uint8Array, type: number): Uint8Array => {
    expect(type).toBe(FORMULA_NUMBER);
    const head = 8 + 8 + 2;
    const out = new Uint8Array(head + 4 + rgce.length + 4);
    out.set(data.subarray(0, head));
    new DataView(out.buffer).setUint32(head, rgce.length, true);
    out.set(rgce, head + 4);
    return out;
  };

/** The link copies as they are in the workbook (before = after: nothing changed). */
async function cachesOf(bytes: Uint8Array): Promise<LinkCachesV1> {
  const { links } = await readDestinationLinksV1(bytes);
  const pkg = readZipPackageV1(bytes);
  const caches = new Map<string, ReturnType<typeof readXlsbLinkCacheV1>>();
  for (const link of links)
    caches.set(link.part, readXlsbLinkCacheV1((await readZipEntryV1(pkg, link.part))!));
  return caches;
}

const report = (overrides: Partial<RecalcReportV1>): RecalcReportV1 => ({
  dependent: 0,
  writtenCells: 0,
  skipped: 0,
  reasons: {},
  reasonSamples: {},
  mismatches: 0,
  mismatchSamples: [],
  blocked: null,
  ...overrides,
});

/* ------------------------------------------------------------------ tests */

/** What the functions workbook has that the engine leaves aside (see the fixture). */
const EXPECTED_LEFT_ASIDE = {
  'function TEXT': 1,
  'function VALUE': 1,
  'function XLOOKUP': 1,
  'function MAXIFS': 1,
  'volatile function': 1,
};

describe('recalculation of what depends on the links (#1541)', () => {
  const textCells = new Set(['Turma!K1', 'Turma!L1']);

  it('gives what Excel gives after updating, except a TEXT formula and what reads it', async () => {
    const before = await valuesOf(RECALC_DESTINO_V1);
    const result = await refresh(RECALC_DESTINO_V1, true);
    expect(result.outcome).toBe('changed');
    expect(result.recalc).toMatchObject({
      blocked: null,
      mismatches: 0,
      skipped: 2,
      reasons: { 'function TEXT': 1, 'depends on a cell left as it is': 1 },
      reasonSamples: { 'function TEXT': ['Turma!K1'] },
    });
    expect(result.recalc!.writtenCells).toBeGreaterThan(30);
    const after = await valuesOf(result.bytes!);
    for (const { cell, value } of RECALC_EXPECTED_V1) {
      if (textCells.has(cell)) expect(after.get(cell), cell).toBe(before.get(cell));
      else expect(after.get(cell), cell).toBe(value);
    }
    // The spilled cells of the dynamic array follow too (Resumo!C1# = Turma!D1:D6*2).
    expect(after.get('Resumo!C4')).toBe(15);
    // Excel is still asked to recalculate everything when the file is opened.
    const pkg = readZipPackageV1(result.bytes!);
    const calc = readBiff12RecordsV1((await readZipEntryV1(pkg, 'xl/workbook.bin'))!).find(
      (record) => record.type === 0x9d,
    )!.data;
    expect(calc[24]! & 1).toBe(1);
  });

  it('switched off: only the link copy changes, the formulas keep their saved values', async () => {
    const before = await valuesOf(RECALC_DESTINO_V1);
    const result = await refresh(RECALC_DESTINO_V1, false);
    expect(result.outcome).toBe('changed');
    expect(result.recalc).toBeNull();
    const after = await valuesOf(result.bytes!);
    for (const { cell } of RECALC_EXPECTED_V1) expect(after.get(cell), cell).toBe(before.get(cell));
  });

  it('a saved result the engine cannot reproduce stays as it is, with what reads it', async () => {
    // Turma!C1 = MIN(10,SUM(B1,5)) saved as 99: Excel's value is no longer explained by the formula.
    const tampered = await editFormulaCell(RECALC_DESTINO_V1, TURMA, 0, 2, (data) => {
      const copy = data.slice();
      new DataView(copy.buffer).setFloat64(8, 99, true);
      return copy;
    });
    const before = await valuesOf(tampered);
    const result = await refresh(tampered, true);
    expect(result.recalc!.mismatches).toBe(1);
    expect(result.recalc!.mismatchSamples).toEqual(['Turma!C1: Excel 99, motor 9,5']);
    // Each formula left aside counts once, under its own reason.
    const { reasons, skipped } = result.recalc!;
    expect(reasons['did not match Excel with the old values']).toBe(1);
    expect(Object.values(reasons).reduce((sum, count) => sum + count, 0)).toBe(skipped);
    const after = await valuesOf(result.bytes!);
    const expected = new Map(RECALC_EXPECTED_V1.map(({ cell, value }) => [cell, value]));
    // C1 and everything that reads it keep the saved values…
    for (const cell of ['Turma!C1', 'Turma!D1', 'Turma!E1', 'Turma!F1', 'Turma!H1', 'Resumo!A1'])
      expect(after.get(cell), cell).toBe(before.get(cell));
    // …while the other rows are recalculated as Excel did.
    for (const cell of ['Turma!B1', 'Turma!C2', 'Turma!D2', 'Turma!E3', 'Resumo!A2'])
      expect(after.get(cell), cell).toBe(expected.get(cell));
    expect(recalcSummaryV1(result.recalc)!.note).toBe(
      '1 fórmula(s) não bateram com o Excel nos valores antigos (ex.: Turma!C1: Excel 99, motor 9,5)',
    );
  });

  it('the note fits the status contract, even with a long sample', () => {
    const long = `Turma!B2: Excel "${'x'.repeat(2000)}", motor "y"`;
    const summary = recalcSummaryV1({
      dependent: 1,
      writtenCells: 0,
      skipped: 0,
      reasons: {},
      reasonSamples: {},
      mismatches: 1,
      mismatchSamples: [long],
      blocked: null,
    })!;
    expect(summary.note!.length).toBeLessThanOrEqual(500);
    expect(summary.note!.endsWith('…')).toBe(true);
  });

  it('one formula per function: the engine gives back each result Excel saved', async () => {
    const caches = await cachesOf(RECALC_FUNCOES_V1);
    const { report: proof } = await recalculateLinkedCellsV1({
      pkg: readZipPackageV1(RECALC_FUNCOES_V1),
      before: caches,
      after: caches,
      proveAll: true,
    });
    expect(proof).toMatchObject({ blocked: null, mismatches: 0, writtenCells: 0 });
    expect(proof.dependent).toBeGreaterThan(60);
    // Only what the engine does not calculate is left aside, each one named.
    expect(proof.reasons).toEqual(EXPECTED_LEFT_ASIDE);
  });

  it('a computed INDIRECT: left as it is in the chain, stops the whole workbook outside it', async () => {
    // Turma!J1 (a VLOOKUP) becomes INDIRECT(B1) or INDIRECT(A1): the cell read is only known
    // while calculating.
    const indirect = (col: number) => Uint8Array.from([0x24, 0, 0, 0, 0, col, 0, 0x42, 1, 148, 0]);
    expect(decodeFormulaV1(indirect(1))).toHaveLength(2);
    // B1 is fed by the changed link: J1 is in the chain and only J1 is left as it is.
    const inChain = await refresh(
      await editFormulaCell(RECALC_DESTINO_V1, TURMA, 0, 9, numberFormula(indirect(1))),
      true,
    );
    expect(inChain.recalc).toMatchObject({ blocked: null, mismatches: 0 });
    expect(inChain.recalc!.reasons['INDIRECT with a computed address']).toBe(1);
    expect(inChain.recalc!.writtenCells).toBeGreaterThan(30);

    // A1 reads a link cell that did not change: J1 is outside the chain and might still read a
    // changed cell, so nothing is recalculated (the link copy is still refreshed).
    const outside = await refresh(
      await editFormulaCell(RECALC_DESTINO_V1, TURMA, 0, 9, numberFormula(indirect(0))),
      true,
    );
    expect(outside.outcome).toBe('changed');
    expect(outside.recalc).toMatchObject({
      blocked: '1 formula(s) with INDIRECT/OFFSET whose address cannot be checked',
      writtenCells: 0,
    });
    expect(recalcSummaryV1(outside.recalc)!.note).toBe(
      'Nada recalculado: 1 fórmula(s) com INDIRETO/DESLOC sem endereço verificável',
    );
    const before = await valuesOf(RECALC_DESTINO_V1);
    const after = await valuesOf(outside.bytes!);
    for (const cell of ['Turma!B1', 'Turma!D1', 'Resumo!B1'])
      expect(after.get(cell), cell).toBe(before.get(cell));
  });

  it('a token the decoder does not know is refused, never guessed', () => {
    expect(() => decodeFormulaV1(Uint8Array.from([0xff]))).toThrow(UnsupportedFormulaError);
  });
});

describe('recalculation summary for the panel', () => {
  it('nothing asked: no summary', () => {
    expect(recalcSummaryV1(null)).toBeNull();
  });

  it('cells written and nothing left: no note', () => {
    expect(recalcSummaryV1(report({ writtenCells: 12, dependent: 40 }))).toEqual({
      cells: 12,
      skipped: 0,
      mismatches: 0,
      note: null,
    });
  });

  it('the main reason for what was left as it is, in Portuguese, with an example', () => {
    expect(
      recalcSummaryV1(
        report({
          writtenCells: 3,
          skipped: 4,
          reasons: { 'function TEXT': 3, 'depends on a cell left as it is': 1 },
          reasonSamples: { 'function TEXT': ['Turma!K1'] },
        }),
      )!.note,
    ).toBe(
      '4 fórmula(s) deixadas como estavam; principal motivo: função TEXT não calculada aqui (3, ex.: Turma!K1)',
    );
  });

  it('a workbook that is not .xlsb', () => {
    expect(recalcSummaryV1(report({ blocked: 'only .xlsb files are recalculated' }))!.note).toBe(
      'Nada recalculado: só arquivos .xlsb são recalculados',
    );
  });
});

describe('recalculation on each try', () => {
  it('a try that did not finish is followed by one that only updates the link', () => {
    expect(recalculateOnThisTryV1({ recalc: true }, { lastCode: null })).toBe(true);
    // The Worker stopped the try (CPU or memory) or it never answered.
    expect(recalculateOnThisTryV1({ recalc: true }, { lastCode: 'LINKS-UNREACHABLE' })).toBe(false);
    expect(recalculateOnThisTryV1({ recalc: true }, { lastCode: 'LEASE-EXPIRED' })).toBe(false);
    // An open file is not a failure of the recalculation.
    expect(recalculateOnThisTryV1({ recalc: true }, { lastCode: 'FILE-OPEN' })).toBe(true);
    expect(recalculateOnThisTryV1({ recalc: false }, { lastCode: null })).toBe(false);
    expect(recalculateOnThisTryV1({}, { lastCode: null })).toBe(false);
  });
});

/* ------------------------------------------------------- link values pending for Excel */

type SourceV1 = Awaited<ReturnType<typeof readSourceValuesV1>>;

async function origemValues(sheets: readonly string[]): Promise<SourceV1> {
  return readSourceValuesV1(await loadRealSheetJsV1(), RECALC_ORIGEM_V1.slice().buffer, sheets);
}

/** A source made of a link copy: what the link held when Excel last calculated. */
function sourceFromCache(cache: ReturnType<typeof readXlsbLinkCacheV1>): SourceV1 {
  const key = (sheet: string, row: number, col: number) => `${sheet.toUpperCase()}|${row}|${col}`;
  const values = new Map(cache.cells.map((cell) => [key(cell.sheet, cell.row, cell.col), cell]));
  const has = (sheet: string) =>
    cache.sheetNames.some((name) => name.toUpperCase() === sheet.toUpperCase());
  return {
    sheetNames: cache.sheetNames,
    valueAt: (sheet, row, col) =>
      has(sheet) ? (values.get(key(sheet, row, col))?.value ?? { kind: 'blank' }) : undefined,
    cellsIn: (sheet, area) =>
      cache.cells
        .filter(
          (cell) =>
            cell.sheet.toUpperCase() === sheet.toUpperCase() &&
            cell.row >= area.r1 &&
            cell.row <= area.r2 &&
            cell.col >= area.c1 &&
            cell.col <= area.c2,
        )
        .map(({ row, col }) => ({ row, col })),
  };
}

async function refreshWith(
  bytes: Uint8Array,
  options: {
    recalculate: boolean;
    source: (sheets: readonly string[]) => Promise<SourceV1> | SourceV1;
    pending?: Parameters<typeof refreshDestinationLinksV1>[0]['pending'];
  },
) {
  return refreshDestinationLinksV1({
    bytes,
    resolve: () => [{ kind: 'path', path: 'origem.xlsb' }],
    loadSource: async (_candidates, sheets) => options.source(sheets),
    recalculate: options.recalculate,
    pending: options.pending ?? null,
  });
}

describe('link values pending for Excel (a write that did not recalculate)', () => {
  it('a link changed and changed back: the proof uses what Excel calculated with, no warning', async () => {
    const [excelCopy] = [...(await cachesOf(RECALC_DESTINO_V1)).values()];
    // Recalculation off: only the link copy changes, the saved results stay Excel's.
    const first = await refreshWith(RECALC_DESTINO_V1, {
      recalculate: false,
      source: origemValues,
    });
    expect(first.outcome).toBe('changed');
    expect(first.pending?.cells.length).toBeGreaterThan(0);
    // Back to the values Excel calculated with, now recalculating.
    const back = await refreshWith(first.bytes!, {
      recalculate: true,
      source: () => sourceFromCache(excelCopy!),
      pending: first.pending,
    });
    expect(back.outcome).toBe('changed');
    expect(back.recalc).toMatchObject({ blocked: null, mismatches: 0, writtenCells: 0 });
    expect(recalcSummaryV1(back.recalc)!.note).toBeNull();
    expect(back.pending).toBeNull();
    expect(await valuesOf(back.bytes!)).toEqual(await valuesOf(RECALC_DESTINO_V1));
    // Without the pending values, the proof would refuse what depends on the change.
    const blind = await refreshWith(first.bytes!, {
      recalculate: true,
      source: () => sourceFromCache(excelCopy!),
    });
    expect(blind.recalc!.mismatches).toBeGreaterThan(0);
  });

  it('a write without recalculation and then one with it give what a single one gives', async () => {
    const changed = async (sheets: readonly string[]): Promise<SourceV1> => {
      const values = await origemValues(sheets);
      // One grade of the source changed again after the first write (Notas!B2).
      return {
        ...values,
        valueAt: (sheet, row, col) =>
          row === 1 && col === 1
            ? { kind: 'number', value: 7.25 }
            : values.valueAt(sheet, row, col),
      };
    };
    const direct = await refreshWith(RECALC_DESTINO_V1, { recalculate: true, source: changed });
    const first = await refreshWith(RECALC_DESTINO_V1, {
      recalculate: false,
      source: origemValues,
    });
    const second = await refreshWith(first.bytes!, {
      recalculate: true,
      source: changed,
      pending: first.pending,
    });
    expect(second.recalc).toMatchObject({ blocked: null, mismatches: 0 });
    expect(second.recalc!.writtenCells).toBeGreaterThan(0);
    expect(second.pending).toBeNull();
    expect(await valuesOf(second.bytes!)).toEqual(await valuesOf(direct.bytes!));
  });

  it('too many values pending: nothing recalculated until Excel saves the workbook', async () => {
    const result = await refreshWith(RECALC_DESTINO_V1, {
      recalculate: true,
      source: origemValues,
      pending: { overflow: true, cells: [] },
    });
    expect(result.recalc!.blocked).toBe('waiting for Excel to recalculate an earlier update');
    expect(result.pending).toEqual({ overflow: true, cells: [] });
    expect(recalcSummaryV1(result.recalc)!.note).toBe(
      'Nada recalculado: a planilha espera o Excel recalcular uma atualização anterior',
    );
  });

  it('pending values belong to the version written: a save by someone drops them', () => {
    const pending = { overflow: false, cells: [], hash: 'written' };
    expect(pendingForVersionV1(pending, 'written')).toEqual({ overflow: false, cells: [] });
    expect(pendingForVersionV1(pending, 'saved-in-excel')).toBeNull();
    expect(pendingForVersionV1({ ...pending, hash: null }, null)).toBeNull();
    expect(pendingForVersionV1(null, 'written')).toBeNull();
  });

  it('the coordinator keeps them with the version written, and keeps them when nothing is written', () => {
    const file = startLinkRefreshV1(
      newLinkFileV1({ id: 'f', name: 'f.xlsb', hash: 'h0', modifiedAt: null }, 't', 0),
      'lease',
      0,
    );
    const cells = [
      { part: 'p', sheet: 'Notas', row: 1, col: 1, value: { kind: 'blank' } as const },
    ];
    const written = finishLinkRefreshV1(
      file,
      'lease',
      {
        ...expiredLinkResultV1(),
        outcome: 'written',
        code: null,
        written: { hash: 'h1', modifiedAt: null },
        pending: { overflow: false, cells },
      },
      1,
    )!;
    expect(written.pendingLinks).toEqual({ overflow: false, cells, hash: 'h1' });
    const again = finishLinkRefreshV1(
      startLinkRefreshV1(written, 'lease2', 2),
      'lease2',
      { ...expiredLinkResultV1(), outcome: 'unchanged', code: null },
      3,
    )!;
    expect(again.pendingLinks).toEqual(written.pendingLinks);
  });
});
