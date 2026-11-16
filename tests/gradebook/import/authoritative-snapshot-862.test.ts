// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { inspectGradebookImportPersistenceRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { createGradebookCanonicalImportRequestV9 } from '../../../src/features/gradebook/import/canonical-import-v9';
import { collectGradebookImportDiagnosticsV1 } from '../../../src/features/gradebook/import/import-diagnostics-v1';
import type { BatchSuccess } from '../../../src/features/gradebook/import/import-batch';

function termSheet(
  trimester: 1 | 2 | 3,
  maximumState: 'empty' | 'missing' | 'numeric',
): Record<string, unknown> {
  const maximumConfiguration =
    maximumState === 'numeric'
      ? {
          state: 'numeric',
          rawValue: 5,
          provenance: { sheetName: `6A${trimester}º`, cellAddress: 'AA3' },
        }
      : maximumState === 'empty'
        ? {
            state: 'ambiguous-empty',
            rawValue: '',
            provenance: { sheetName: `6A${trimester}º`, cellAddress: 'AA3' },
          }
        : {
            state: 'missing-field',
            rawValue: undefined,
            provenance: { sheetName: `6A${trimester}º`, cellAddress: 'AA3' },
          };
  const aaSnapshot = maximumState === 'numeric' ? null : null;
  return {
    name: `6A${trimester}º`,
    range: 'A1:AN50',
    rows: 50,
    columns: 40,
    className: '6A',
    discipline: 'SINTETICA',
    disciplineIndex: 'D1',
    stage: `trimester-${trimester}`,
    declaredStage: `${trimester}º trimestre`,
    declaredStudents: 1,
    assessmentDefinitions: [
      {
        sourceSlot: 'R',
        maximumConfiguration: {
          state: 'numeric',
          rawValue: 6.75,
          provenance: { sheetName: `6A${trimester}º`, cellAddress: 'R3' },
        },
      },
      {
        sourceSlot: 'S',
        maximumConfiguration: {
          state: 'numeric',
          rawValue: 6.75,
          provenance: { sheetName: `6A${trimester}º`, cellAddress: 'S3' },
        },
      },
      {
        contractVersion: 2,
        kind: 'qualitative-activity',
        sourceSlot: 'AA',
        order: 1,
        maximumConfiguration,
        name: {
          state: 'empty',
          rawValue: '',
          provenance: { sheetName: `6A${trimester}º`, cellAddress: 'AA4' },
        },
      },
    ],
    students: [
      {
        row: 5,
        number: '1',
        name: 'ALUNO SINTETICO',
        status: '',
        quantitativeAssessments: [null, null],
        quantitativeTotal: null,
        parallel: null,
        qualitative: [],
        qualitativeTotal: null,
        official: null,
        annual: null,
        termResultObservations: {
          quantitativeTotal: { classification: 'empty', rawValue: null },
          parallelAssessment: { classification: 'empty', rawValue: null },
          qualitativeTotal: { classification: 'empty', rawValue: null },
          officialTermGrade: { classification: 'empty', rawValue: null },
          annualAccumulatedTotal: { classification: 'empty', rawValue: null },
        },
        recovery: null,
      },
    ],
    formulas: 0,
    officialZeros: 0,
    snapshotCellsV8: { R5: 2, S5: 3, Z5: null, AA5: aaSnapshot, AM5: null },
  };
}

function result(): BatchSuccess {
  return {
    id: 'synthetic-authoritative-862',
    manifest: {
      fileName: 'NOTAS SINTETICAS 2026.xlsb',
      extension: 'xlsb',
      reportedMimeType: null,
      sizeBytes: 512,
      lastModifiedAt: null,
      sha256: 'a'.repeat(64),
      sourceContractVersion: 2,
      parserVersion: 'synthetic',
      readAt: '2026-09-18T00:00:00.000Z',
    },
    summary: {
      fileName: 'NOTAS SINTETICAS 2026.xlsb',
      format: 'XLSB',
      size: 512,
      parserVersion: 'synthetic',
      academicYear: 2026,
      teacherName: 'DOCENTE SINTETICO',
      sheets: [],
      gradeSheets: [termSheet(1, 'empty'), termSheet(2, 'missing'), termSheet(3, 'numeric')],
      classes: [],
      auxiliarySheets: [],
      unrecognizedSheets: [],
    },
  } as unknown as BatchSuccess;
}

describe('authoritative import snapshot #862', () => {
  it('leaves a truly erased qualitative column in the browser and keeps active blank semantics', () => {
    const request = createGradebookCanonicalImportRequestV9(result());
    if (request.operation !== 'persist-notas') throw new Error('notes expected');
    const [t1, t2, t3] = request.ofertas[0]!.trimestres;
    expect(t1.definitionSnapshotVersion).toBe(1);
    expect(t1.instrumentos.map(([slot]) => slot)).toEqual([1, 2, 3]);
    expect(t1.alunos[0]![1]).toEqual([2000, 3000, null]);

    expect(t2.instrumentos.map(([slot]) => slot)).toEqual([1, 2, 3]);
    expect(t2.unavailableMaximumSlots).toContain(11);

    expect(t3.instrumentos.map(([slot]) => slot)).toEqual([1, 2, 3, 11]);
    expect(t3.alunos[0]![1][3]).toBeNull();
    expect(inspectGradebookImportPersistenceRequestV9(request)).toBe('ready');
  });

  it('does not delete a blank-looking slot when a student cell was unreadable', () => {
    const value = result();
    const sheet = value.summary.gradeSheets[0] as unknown as {
      snapshotCellsV8: Record<string, unknown>;
    };
    sheet.snapshotCellsV8.AA5 = ['synthetic-unavailable'];
    const request = createGradebookCanonicalImportRequestV9(value);
    if (request.operation !== 'persist-notas') throw new Error('notes expected');
    const t1 = request.ofertas[0]!.trimestres[0];
    expect(t1.instrumentos.map(([slot]) => slot)).toEqual([1, 2, 3]);
    expect(t1.unavailableValueSlots).toContain(11);
  });

  it('explains an unread qualitative maximum with exact sheet and cell', () => {
    const diagnostics = collectGradebookImportDiagnosticsV1(result());
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'source-unavailable',
          classCode: '6A',
          subject: 'SINTETICA',
          period: '2º trimestre',
          sheetName: '6A2º',
          cellAddress: 'AA3',
          cause: expect.stringMatching(/não foi encontrada/iu),
        }),
      ]),
    );
    expect(diagnostics.some((item) => item.period === '1º trimestre' && item.slot === 11)).toBe(
      false,
    );
  });

  it('rejects unavailable-definition lists without snapshot version', () => {
    const request = createGradebookCanonicalImportRequestV9(result());
    if (request.operation !== 'persist-notas') throw new Error('notes expected');
    const clone = structuredClone(request) as unknown as {
      ofertas: Array<{ trimestres: Array<{ definitionSnapshotVersion?: 1 }> }>;
    };
    delete clone.ofertas[0]!.trimestres[1]!.definitionSnapshotVersion;
    expect(inspectGradebookImportPersistenceRequestV9(clone)).toBe('invalid-request');
  });
});
