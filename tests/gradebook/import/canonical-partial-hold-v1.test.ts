import { describe, expect, it } from 'vitest';
import type { SourceFileManifestV1 } from '../../../shared/gradebook-contracts/imports/import-contract-v1';
import {
  isGradebookImportPersistenceRequestV9,
  type GradebookNotesImportRequestV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import {
  createGradebookCanonicalImportRequestV9,
  type CanonicalImportHeldV9,
} from '../../../src/features/gradebook/import/canonical-import-v9';
import { readWorkbookData } from '../../../src/features/gradebook/import/workbook-reader';
import {
  WORKBOOK_READER_EQUIVALENCE_CASES_V1,
  createFixtureSheetJsV1,
  syntheticResultV1,
  type WorkbookFixtureV1,
} from '../fixtures/workbook-reader-equivalence-v1';

const bytes = Uint8Array.of(1, 2, 3, 4).buffer;
const file = new File([bytes], 'Notas - Docente Fictício - 2026.xlsx', { lastModified: Date.UTC(2026, 0, 5) });
const manifest: SourceFileManifestV1 = {
  id: 'source-file-manifest:partial-hold' as SourceFileManifestV1['id'],
  fileName: file.name,
  extension: 'xlsx',
  reportedMimeType: null,
  sizeBytes: bytes.byteLength,
  lastModifiedAt: new Date(file.lastModified).toISOString(),
  sha256: 'b'.repeat(64),
  sourceContractVersion: 2,
  parserVersion: 'functional-fixture-adapter',
  readAt: '2026-10-02T12:00:00.000Z',
};

function teacher(mutate: (workbook: WorkbookFixtureV1) => void = () => {}): WorkbookFixtureV1 {
  const workbook = structuredClone(WORKBOOK_READER_EQUIVALENCE_CASES_V1.find((item) => item.id === 'teacher')!.workbook);
  mutate(workbook);
  return workbook;
}

function build(workbook: WorkbookFixtureV1) {
  const summary = readWorkbookData(file, bytes, createFixtureSheetJsV1(workbook), manifest, undefined, true);
  const held: CanonicalImportHeldV9[] = [];
  const request = createGradebookCanonicalImportRequestV9(syntheticResultV1(manifest, summary), {
    onHeld: (item) => held.push(item),
  });
  expect(isGradebookImportPersistenceRequestV9(request)).toBe(true);
  if (request.operation !== 'persist-notas') throw new Error('unexpected operation');
  return { request: request as GradebookNotesImportRequestV9, held };
}

/** A second class/subject: the same synthetic sheets under another subject (D2). */
function withSecondOffer(workbook: WorkbookFixtureV1, keepThirdTerm = true): void {
  for (const stage of ['1º', '2º', '3º']) {
    if (stage === '3º' && !keepThirdTerm) continue;
    const copy = structuredClone(workbook.Sheets[`6A${stage}`]!);
    copy.K2 = { t: 's', v: 'Ciências Sintéticas' };
    workbook.SheetNames.push(`6A${stage}D2`);
    workbook.Sheets[`6A${stage}D2`] = copy;
  }
}

describe('partial hold (BN-DEC-045)', () => {
  it('holds only the invalid grade and that student’s AM; everything else is written', () => {
    const baseline = build(teacher()).request;
    const { request, held } = build(teacher((workbook) => {
      workbook.Sheets['6A1º']!.R5 = { t: 's', v: 'texto inválido sintético' };
    }));
    const [before, after] = [baseline.ofertas[0]!, request.ofertas[0]!];
    const [, values, am] = after.trimestres[0].alunos[0]!;
    expect(values[0]).toEqual(['u']);
    expect(am).toEqual(['u']);
    // The student's other grades, the other students and the other terms are unchanged.
    expect(values.slice(1)).toEqual(before.trimestres[0].alunos[0]![1].slice(1));
    expect(after.trimestres[0].alunos.slice(1)).toEqual(before.trimestres[0].alunos.slice(1));
    expect(after.trimestres[1]).toEqual(before.trimestres[1]);
    expect(after.trimestres[2]).toEqual(before.trimestres[2]);
    expect(held).toEqual(expect.arrayContaining([
      { kind: 'cell', sheetName: '6A1º', cellAddress: 'R5', reason: 'invalid-cell' },
      { kind: 'cell', sheetName: '6A1º', cellAddress: 'AM5', reason: 'depends-on-held-cell' },
    ]));
  });

  it('holds a negative grade the same way', () => {
    const { request } = build(teacher((workbook) => {
      workbook.Sheets['6A1º']!.S5 = { t: 'n', v: -1 };
    }));
    const [, values, am] = request.ofertas[0]!.trimestres[0].alunos[0]!;
    expect(values[1]).toEqual(['u']);
    expect(am).toEqual(['u']);
  });

  it('a held AM or recovery grade holds the final result U, and only it', () => {
    const baseline = build(teacher()).request.ofertas[0]!;
    const recovered = baseline.recuperacao?.[0];
    if (!recovered) throw new Error('the synthetic teacher has a recovery student');
    const { request } = build(teacher((workbook) => {
      workbook.Sheets['6AREC']!.R5 = { t: 's', v: 'texto inválido sintético' };
    }));
    const row = request.ofertas[0]!.recuperacao!.find(([numero]) => numero === recovered[0])!;
    expect(row[1]).toEqual(['u']);
    expect(row[4]).toEqual(['u']);
    expect(row.slice(2, 4)).toEqual(recovered.slice(2, 4));

    const fromTerm = build(teacher((workbook) => {
      workbook.Sheets['6A1º']!.R5 = { t: 's', v: 'texto inválido sintético' };
    })).request.ofertas[0]!;
    const termNumber = fromTerm.trimestres[0].alunos[0]![0];
    const recoveryRow = fromTerm.recuperacao?.find(([numero]) => numero === termNumber);
    if (recoveryRow) expect(recoveryRow[4]).toEqual(['u']);
  });

  it('holds a whole class/subject only when it cannot be read as a whole', () => {
    const { request, held } = build(teacher((workbook) => withSecondOffer(workbook, false)));
    expect(request.ofertas.map((offer) => offer.disciplina)).toEqual([build(teacher()).request.ofertas[0]!.disciplina]);
    expect(held).toEqual([expect.objectContaining({ kind: 'offer', sheetNames: ['6A1ºD2', '6A2ºD2'] })]);
    expect(build(teacher((workbook) => withSecondOffer(workbook))).request.ofertas).toHaveLength(2);
  });

  it('a file is refused only when no class can be written', () => {
    const workbook = teacher((value) => {
      value.SheetNames = value.SheetNames.filter((name) => name !== '6A3º');
      delete value.Sheets['6A3º'];
    });
    expect(() => build(workbook)).toThrow(/Nenhuma turma desta planilha pôde ser lançada/u);
  });

  it('a clean workbook reports nothing held', () => {
    expect(build(teacher()).held).toEqual([]);
  });
});
