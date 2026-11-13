// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { BatchSuccess } from '../../../src/features/gradebook/import/import-batch';
import {
  actionableGradebookImportDiagnosticsV1,
  blockingGradebookImportDiagnosticsV1,
  collectGradebookImportDiagnosticsV1,
  gradebookImportDiagnosticsAuditRequestV1,
  sourceUnavailableGradebookImportDiagnosticsV1,
} from '../../../src/features/gradebook/import/import-diagnostics-v1';

function syntheticResult(): BatchSuccess {
  const qualitativeDefinitions = Array.from({ length: 10 }, (_, index) => {
    const column = String.fromCharCode('A'.charCodeAt(0) + index);
    const sourceSlot = `A${column}`;
    return {
      contractVersion: 2,
      kind: 'qualitative-activity' as const,
      sourceSlot,
      order: index + 1,
      maximumConfiguration: {
        state: 'numeric' as const,
        rawValue: 3,
        provenance: {
          fileName: 'NOTAS DOCENTE 2026.xlsb',
          fileSha256: 'a'.repeat(64),
          sheetName: '7D2º',
          cellAddress: `${sourceSlot}3`,
        },
      },
      name: {
        state: 'text' as const,
        rawValue: index === 3 ? 'Ciclo da água' : `Atividade ${index + 1}`,
        provenance: {
          fileName: 'NOTAS DOCENTE 2026.xlsb',
          fileSha256: 'a'.repeat(64),
          sheetName: '7D2º',
          cellAddress: `${sourceSlot}4`,
        },
      },
    };
  });
  const quantitative = [
    {
      contractVersion: 2,
      kind: 'quantitative-assessment' as const,
      sourceSlot: 'R' as const,
      order: 1 as const,
      structuralLabel: 'Avaliação quantitativa 1' as const,
      maximumConfiguration: {
        state: 'numeric' as const,
        rawValue: 6,
        provenance: {
          fileName: 'NOTAS DOCENTE 2026.xlsb',
          fileSha256: 'a'.repeat(64),
          sheetName: '7D2º',
          cellAddress: 'R3',
        },
      },
    },
    {
      contractVersion: 2,
      kind: 'quantitative-assessment' as const,
      sourceSlot: 'S' as const,
      order: 2 as const,
      structuralLabel: 'Avaliação quantitativa 2' as const,
      maximumConfiguration: {
        state: 'numeric' as const,
        rawValue: 6,
        provenance: {
          fileName: 'NOTAS DOCENTE 2026.xlsb',
          fileSha256: 'a'.repeat(64),
          sheetName: '7D2º',
          cellAddress: 'S3',
        },
      },
    },
  ];

  return {
    id: 'synthetic:diagnostics',
    manifest: {
      fileName: 'NOTAS DOCENTE 2026.xlsb',
      extension: 'xlsb',
      reportedMimeType: null,
      sizeBytes: 100,
      lastModifiedAt: null,
      sha256: 'a'.repeat(64),
      sourceContractVersion: 2,
      parserVersion: 'synthetic',
      readAt: '2026-09-09T00:00:00.000Z',
    },
    summary: {
      fileName: 'NOTAS DOCENTE 2026.xlsb',
      format: 'XLSB',
      size: 100,
      parserVersion: 'synthetic',
      academicYear: 2026,
      teacherName: 'DOCENTE',
      sheets: [],
      gradeSheets: [
        {
          name: '7D2º',
          range: 'A1:AN50',
          rows: 50,
          columns: 40,
          className: '7D',
          discipline: 'CIÊNCIAS',
          disciplineIndex: 'D1',
          stage: 'trimester-2',
          declaredStage: '2º trimestre',
          declaredStudents: 1,
          assessmentDefinitions: [...quantitative, ...qualitativeDefinitions],
          students: [
            {
              row: 21,
              number: '17',
              name: 'ALUNO TESTE',
              status: '',
              quantitativeAssessments: [null, null],
              quantitativeTotal: null,
              parallel: null,
              qualitative: Array.from({ length: 10 }, () => null),
              qualitativeTotal: null,
              official: null,
              annual: null,
              termResultObservations: {
                quantitativeTotal: { classification: 'empty', rawValue: null },
                parallelAssessment: { classification: 'empty', rawValue: null },
                qualitativeTotal: { classification: 'empty', rawValue: null },
                officialTermGrade: {
                  classification: 'formula-error-or-missing-cache',
                  rawValue: null,
                  formula: 'SUM(R21:S21)',
                  cachedValue: null,
                  sourceError: '#VALUE!',
                },
                annualAccumulatedTotal: { classification: 'empty', rawValue: null },
              },
              recovery: null,
            },
          ],
          formulas: 0,
          officialZeros: 0,
          snapshotCellsV8: {
            AD21: 'TEXTO INDEVIDO',
            AE21: ['u'],
            R21: 7.25,
          },
        },
      ],
      classes: [],
      auxiliarySheets: [],
      unrecognizedSheets: [],
    },
  } as unknown as BatchSuccess;
}

function syntheticRecoveryResult(): BatchSuccess {
  const source = syntheticResult();
  const term = source.summary.gradeSheets[0]!;
  const observation = (rawValue: string) => ({ classification: 'invalid-text' as const, rawValue });
  return {
    ...source,
    summary: {
      ...source.summary,
      gradeSheets: [
        {
          ...term,
          name: '7DREC',
          stage: 'recovery',
          declaredStage: 'REC',
          assessmentDefinitions: [],
          snapshotCellsV8: { R21: 'R/R', S21: 'nc', T21: 'OUTRO', U21: 'R/R' },
          students: [
            {
              ...term.students[0]!,
              termResultObservations: null,
              recovery: {
                resultObservations: {
                  trimester1: observation('R/R'),
                  trimester2: observation('nc'),
                  trimester3: observation('OUTRO'),
                  totalAfterRecovery: observation('R/R'),
                },
              },
            },
          ],
        },
      ],
    },
  } as unknown as BatchSuccess;
}

describe('import diagnostics v1', () => {
  it('presents blocking invalid text by student, class, period and activity', () => {
    const diagnostics = collectGradebookImportDiagnosticsV1(syntheticResult());
    const invalidText = diagnostics.find(
      (value) => value.code === 'invalid-text' && value.cellAddress === 'AD21',
    );

    expect(invalidText).toMatchObject({
      severity: 'blocking-error',
      message: 'Existe texto onde uma nota é esperada.',
      classCode: '7D',
      subject: 'CIÊNCIAS',
      period: '2º trimestre',
      studentNumber: 17,
      studentName: 'ALUNO TESTE',
      fieldLabel: 'Atividade 4 — Ciclo da água',
      foundValue: 'TEXTO INDEVIDO',
      sheetName: '7D2º',
      cellAddress: 'AD21',
    });
    expect(blockingGradebookImportDiagnosticsV1(diagnostics)).toContain(invalidText);
  });

  it('accepts R/R and N/C only in the three recovery fields', () => {
    const invalid = collectGradebookImportDiagnosticsV1(syntheticRecoveryResult()).filter(
      (value) => value.code === 'invalid-text',
    );

    expect(invalid.map((value) => value.cellAddress)).toEqual(['T21', 'U21']);
    expect(invalid.map((value) => value.foundValue)).toEqual(['OUTRO', 'R/R']);
  });

  it('details unavailable source values even when a formula has no cached snapshot', () => {
    const diagnostics = collectGradebookImportDiagnosticsV1(syntheticResult());
    const unavailable = sourceUnavailableGradebookImportDiagnosticsV1(diagnostics);

    expect(unavailable).toHaveLength(2);
    expect(unavailable.every((value) => value.severity === 'warning')).toBe(true);
    expect(unavailable.find((value) => value.cellAddress === 'AE21')).toMatchObject({
      fieldLabel: 'Atividade 5 — Atividade 5',
      message: 'Um valor de origem está indisponível.',
    });
    expect(unavailable.find((value) => value.cellAddress === 'AM21')).toMatchObject({
      fieldLabel: 'Nota do trimestre',
      cause: 'Erro salvo pela planilha: #VALUE!',
    });
    expect(JSON.stringify(unavailable)).not.toContain('semanticValue');
  });

  it('shows operators only blocking errors and above-maximum warnings', () => {
    const diagnostics = collectGradebookImportDiagnosticsV1(syntheticResult());
    const technicalMaximum = {
      key: 'invalid-maximum|7D|CIÊNCIAS|2º trimestre||configuration|15|7D2º|AE3',
      severity: 'warning' as const,
      code: 'invalid-maximum' as const,
      message: 'O máximo de uma atividade está ausente ou inválido.',
      recommendedAction: 'Confira a origem.',
      classCode: '7D',
      subject: 'CIÊNCIAS',
      period: '2º trimestre',
      fieldKind: 'configuration' as const,
      slot: 15,
      fieldLabel: 'Máximo de Atividade 5',
      foundValue: '*',
      sheetName: '7D2º',
      cellAddress: 'AE3',
    };
    const visible = actionableGradebookImportDiagnosticsV1([
      ...diagnostics,
      technicalMaximum,
    ]);

    expect(visible.some((value) => value.code === 'source-unavailable')).toBe(false);
    expect(
      visible.some(
        (value) => value.code === 'invalid-maximum' && value.severity === 'warning',
      ),
    ).toBe(false);
    expect(visible).toContainEqual(
      // BN-DEC-046: a grade above its maximum is held, so it is a blocking item.
      expect.objectContaining({ code: 'above-maximum', severity: 'blocking-error' }),
    );
    expect(visible).toContainEqual(
      expect.objectContaining({ code: 'invalid-text', severity: 'blocking-error' }),
    );
  });

  it('reports above-maximum as blocking (BN-DEC-046) with functional location', () => {
    const diagnostics = collectGradebookImportDiagnosticsV1(syntheticResult());
    expect(diagnostics.find((value) => value.code === 'above-maximum')).toMatchObject({
      severity: 'blocking-error',
      fieldLabel: 'Avaliação quantitativa 1',
      studentNumber: 17,
      foundValue: '7.25',
      cause: 'Máximo configurado: 6.',
    });
  });

  it('does not persist the student name in the audit payload', () => {
    const result = syntheticResult();
    const diagnostics = collectGradebookImportDiagnosticsV1(result);
    const request = gradebookImportDiagnosticsAuditRequestV1(result, diagnostics);

    expect(request.academicYear).toBe(2026);
    expect(request.fileName).toBe('NOTAS DOCENTE 2026.xlsb');
    expect(JSON.stringify(request)).not.toContain('ALUNO TESTE');
    expect(request.diagnostics.some((value) => value.studentNumber === 17)).toBe(true);
  });
});
