// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SOURCE_CONTRACT_V1 } from '../../../shared/gradebook-contracts/source/source-contract-v1';
import { type SourceAssessmentSlotV2 } from '../../../shared/gradebook-contracts/source/source-contract-v2';
import {
  recognizeWorkbook,
  type GradeSheetRecognition,
  type StudentRecognition,
} from '../../../src/features/gradebook/import/spreadsheet-recognizer';
import {
  SYNTHETIC_ACTIVITY_CASES,
  SYNTHETIC_EXPECTATIONS,
  SYNTHETIC_FILES,
  SYNTHETIC_SHEET_CONTROLS,
  SYNTHETIC_TEACHER_WORKBOOK,
  createSyntheticFile,
  createSyntheticSheetJs,
} from '../fixtures/synthetic-teacher-workbooks';

const SYNTHETIC_SHA256 = 'a'.repeat(64);

function recognizeSyntheticWorkbook() {
  return recognizeWorkbook(
    createSyntheticFile(SYNTHETIC_FILES.xlsx),
    SYNTHETIC_TEACHER_WORKBOOK,
    createSyntheticSheetJs(),
    { fileSha256: SYNTHETIC_SHA256 },
  );
}

function requiredDefinition(sheetName: string, sourceSlot: SourceAssessmentSlotV2) {
  const definition = requiredSheet(sheetName).assessmentDefinitions.find(
    (candidate) => candidate.sourceSlot === sourceSlot,
  );
  if (!definition) throw new Error(`Fixture sintética perdeu a definição ${sourceSlot}.`);
  return definition;
}

function requiredSheet(name: string): GradeSheetRecognition {
  const sheet = recognizeSyntheticWorkbook().gradeSheets.find(
    (candidate) => candidate.name === name,
  );
  if (!sheet) throw new Error(`Fixture sintética perdeu a guia obrigatória ${name}.`);
  return sheet;
}

function requiredStudent(sheetName: string, row: number): StudentRecognition {
  const student = requiredSheet(sheetName).students.find((candidate) => candidate.row === row);
  if (!student) {
    throw new Error(`Fixture sintética perdeu o estudante da linha ${row} na guia ${sheetName}.`);
  }
  return student;
}

describe('massa sintética — contrato e guias da fonte', () => {
  it('SRC-001/SRC-002: reconhece D1 implícito, D2 e D3 explícitos', () => {
    expect(requiredSheet('6A1º').disciplineIndex).toBe('D1');
    expect(requiredSheet('6A2ºD2').disciplineIndex).toBe('D2');
    expect(requiredSheet('6A3ºD3').disciplineIndex).toBe('D3');
  });

  it('SRC-003: lê VG, 1º, 2º, 3º, REC e os metadados J1/K2/K3/K4', () => {
    const summary = recognizeSyntheticWorkbook();
    expect(summary.gradeSheets.map((sheet) => sheet.name)).toEqual(
      SYNTHETIC_EXPECTATIONS.source.gradeSheetNames,
    );
    expect(new Set(summary.gradeSheets.map((sheet) => sheet.stage))).toEqual(
      new Set(['overview', 'trimester-1', 'trimester-2', 'trimester-3', 'recovery']),
    );

    expect(requiredSheet('6A1º')).toMatchObject({
      declaredStudents: SYNTHETIC_EXPECTATIONS.source.d1DeclaredStudents,
      discipline: 'Matemática Sintética',
      className: '6A',
      declaredStage: '1º trimestre',
    });
  });

  it('SRC-005/SRC-008: lê a guia marcada como protegida sem modificar a fonte sintética', () => {
    const before = structuredClone(SYNTHETIC_TEACHER_WORKBOOK);
    const summary = recognizeSyntheticWorkbook();

    expect(SYNTHETIC_SHEET_CONTROLS.protectedSheetNames).toContain('6A1º');
    expect(summary.gradeSheets.map((sheet) => sheet.name)).toContain('6A1º');
    expect(SYNTHETIC_TEACHER_WORKBOOK).toEqual(before);
  });

  it('SRC-006/SRC-007: separa auxiliares ocultas e guia inesperada sem descarte silencioso', () => {
    const summary = recognizeSyntheticWorkbook();

    expect(SYNTHETIC_SHEET_CONTROLS.hiddenSheetNames).toEqual(['CONFIGURAÇÃO', 'AUXILIAR OCULTA']);
    expect(summary.auxiliarySheets).toEqual(SYNTHETIC_EXPECTATIONS.source.auxiliarySheetNames);
    expect(summary.unrecognizedSheets).toEqual(
      SYNTHETIC_EXPECTATIONS.source.unrecognizedSheetNames,
    );
  });

  it('lê ano e professor da guia CONFIGURAÇÃO', () => {
    expect(recognizeSyntheticWorkbook()).toMatchObject({
      academicYear: 2026,
      teacherName: 'Docente Sintético da Configuração',
    });
  });
});

describe('massa sintética — semântica observável das células', () => {
  it('CELL-001/CELL-010: vazio e campo ausente não viram zero no leitor atual', () => {
    const student = requiredStudent('6A1º', 5);
    expect(student.qualitative[3]).toBeNull();
    expect(student.qualitative[5]).toBeNull();
    expect(SOURCE_CONTRACT_V1.semantics.empty).toBe('absence');
    expect(SOURCE_CONTRACT_V1.semantics.notApplicable).toBe('not-applicable');
    expect(SOURCE_CONTRACT_V1.semantics.missingField).toBe('missing-field');
  });

  it('CELL-002/#837: preserva 0,1 como nota decimal comum no leitor atual', () => {
    expect(requiredStudent('6A1º', 5).quantitativeAssessments[0]).toEqual(
      { source: 0.1, value: 0.1, kind: 'manual' },
    );
  });

  it('CELL-003: mantém zero manual legado distinto', () => {
    expect(requiredStudent('6A1º', 5).quantitativeAssessments[1]).toEqual(
      SYNTHETIC_EXPECTATIONS.cells.legacyZero,
    );
  });

  it('CELL-004/CELL-005: preserva números manuais positivos e negativos', () => {
    const student = requiredStudent('6A1º', 5);
    expect(student.qualitativeTotal).toEqual(SYNTHETIC_EXPECTATIONS.cells.manualPositive);
    expect(student.qualitative[0]).toEqual(SYNTHETIC_EXPECTATIONS.cells.manualNegative);
  });

  it('CELL-006: conserva fórmula e cache não zero', () => {
    expect(requiredStudent('6A1º', 5).quantitativeTotal).toEqual(
      SYNTHETIC_EXPECTATIONS.cells.formulaNonzero,
    );
  });

  it('CELL-007: fórmula com cache zero permanece ausência', () => {
    expect(requiredStudent('6A1º', 5).parallel).toBeNull();
  });

  it('CELL-008/CELL-009: fórmula sem cache e texto inválido não inventam nota', () => {
    const student = requiredStudent('6A1º', 5);
    expect(student.qualitative[2]).toBeNull();
    expect(student.qualitative[1]).toBeNull();
  });
});

describe('massa sintética — posições, movimentações e recuperação', () => {
  it('ID-001: preserva posições históricas além da quantidade declarada em J1', () => {
    const sheet = requiredSheet('6A1º');
    expect(sheet.declaredStudents).toBe(SYNTHETIC_EXPECTATIONS.source.d1DeclaredStudents);
    expect(sheet.students).toHaveLength(SYNTHETIC_EXPECTATIONS.source.d1HistoricalPositions);
  });

  it('ID-002/ID-003: preserva FOI PARA/ESTAVA NO e notas replicadas nas duas posições', () => {
    const origin = requiredStudent('6A1º', 7);
    const destination = requiredStudent('6B1º', 5);

    expect(origin.status).toBe(SYNTHETIC_EXPECTATIONS.transfer.originStatus);
    expect(destination.status).toBe(SYNTHETIC_EXPECTATIONS.transfer.destinationStatus);
    expect(origin.official?.value).toBe(SYNTHETIC_EXPECTATIONS.transfer.replicatedOfficialValue);
    expect(destination.official?.value).toBe(
      SYNTHETIC_EXPECTATIONS.transfer.replicatedOfficialValue,
    );
  });

  it('ID-004/ID-005: mantém notas de novato e de posição histórica', () => {
    expect(requiredStudent('6A1º', 6)).toMatchObject({
      status: 'NOVATO',
      official: { value: 7 },
      annual: { value: 18 },
    });
    expect(requiredStudent('6A1º', 8)).toMatchObject({
      status: 'TRANSFERIDO',
      official: { value: 5.5 },
      annual: { value: 14 },
    });
  });

  it('ID-006: preserva o ponto inicial usado para distinguir homônimos', () => {
    expect(requiredStudent('6A1º', 9).name).toBe('.Estudante Fictício Homônimo');
    expect(requiredStudent('6A1º', 10).name).toBe('Estudante Fictício Homônimo');
  });

  it('ID-007: mantém leituras de arquivos anuais independentes sem associação aproximada', () => {
    const first = recognizeWorkbook(
      { ...createSyntheticFile(SYNTHETIC_FILES.xlsx), name: 'massa-sintetica-ano-a.xlsx' },
      SYNTHETIC_TEACHER_WORKBOOK,
      createSyntheticSheetJs(),
      { fileSha256: SYNTHETIC_SHA256 },
    );
    const second = recognizeWorkbook(
      { ...createSyntheticFile(SYNTHETIC_FILES.xlsx), name: 'massa-sintetica-ano-b.xlsx' },
      SYNTHETIC_TEACHER_WORKBOOK,
      createSyntheticSheetJs(),
      { fileSha256: SYNTHETIC_SHA256 },
    );

    expect(first.fileName).not.toBe(second.fileName);
    expect(
      first.classes.map(
        ({ name, students, declaredStudents, disciplines, trimesters, recovery }) => ({
          name,
          students,
          declaredStudents,
          disciplines,
          trimesters,
          recovery,
        }),
      ),
    ).toEqual(
      second.classes.map(
        ({ name, students, declaredStudents, disciplines, trimesters, recovery }) => ({
          name,
          students,
          declaredStudents,
          disciplines,
          trimesters,
          recovery,
        }),
      ),
    );
  });

  it('REC-001/REC-002/REC-003/REC-004: lê originais, aplicabilidade, REC e total pós-REC', () => {
    const recovery = requiredStudent('6AREC', 5).recovery;
    if (!recovery) throw new Error('Fixture sintética perdeu a leitura de recuperação da linha 5.');

    expect([
      recovery.originalTrimester1?.value,
      recovery.originalTrimester2?.value,
      recovery.originalTrimester3?.value,
      recovery.originalAnnual?.value,
    ]).toEqual(SYNTHETIC_EXPECTATIONS.recovery.original);
    expect([
      recovery.trimester1?.value,
      recovery.trimester2?.value,
      recovery.trimester3?.value,
      recovery.totalAfterRecovery?.value,
    ]).toEqual(SYNTHETIC_EXPECTATIONS.recovery.replacement);
    expect([
      recovery.eligibleTrimester1,
      recovery.eligibleTrimester2,
      recovery.eligibleTrimester3,
    ]).toEqual(SYNTHETIC_EXPECTATIONS.recovery.eligible);
    expect([
      recovery.applicabilityTrimester1,
      recovery.applicabilityTrimester2,
      recovery.applicabilityTrimester3,
    ]).toEqual([
      { classification: 'numeric', rawValue: 1 },
      { classification: 'numeric', rawValue: 0 },
      { classification: 'numeric', rawValue: 1 },
    ]);
  });

  it('REC-005: ausência de nota REC permanece ausência, não zero', () => {
    const recovery = requiredStudent('6AREC', 6).recovery;
    if (!recovery) throw new Error('Fixture sintética perdeu a leitura de recuperação da linha 6.');
    expect(recovery.trimester2).toBeNull();
    expect(recovery.applicabilityTrimester2).toEqual({
      classification: 'empty',
      rawValue: null,
    });
  });

  it('preserva fórmula AC/AD/AE sem cache como observação V3, sem inferir aplicabilidade', () => {
    const workbook = structuredClone(SYNTHETIC_TEACHER_WORKBOOK);
    workbook.Sheets['6AREC']!.AD6 = { f: '1+0' };
    const summary = recognizeWorkbook(
      createSyntheticFile(SYNTHETIC_FILES.xlsx),
      workbook,
      createSyntheticSheetJs(),
      { fileSha256: SYNTHETIC_SHA256 },
    );
    const recovery = summary.gradeSheets
      .find((sheet) => sheet.name === '6AREC')
      ?.students.find((student) => student.row === 6)?.recovery;
    expect(recovery?.applicabilityTrimester2).toEqual({
      classification: 'formula',
      rawValue: null,
      formula: '1+0',
      cachedValue: null,
    });
    expect(recovery?.eligibleTrimester2).toBe(false);
  });
});

describe('massa sintética — definições trimestrais V2', () => {

  it('separa AA3, AA4 e AA5 sem normalizar destrutivamente o nome livre', () => {
    const definition = requiredDefinition('6A1º', 'AA');
    if (definition.kind !== 'qualitative-activity')
      throw new Error('AA deixou de ser qualitativa.');
    expect(definition.maximumConfiguration).toMatchObject({
      state: 'numeric',
      rawValue: 3,
      provenance: { cellAddress: 'AA3', fileSha256: SYNTHETIC_SHA256 },
    });
    expect(definition.name).toMatchObject({
      state: 'text',
      rawValue: 'Pesquisa sobre frações',
      provenance: { cellAddress: 'AA4' },
    });
    expect(requiredStudent('6A1º', 5).qualitative[0]).toEqual(
      SYNTHETIC_EXPECTATIONS.cells.manualNegative,
    );
  });

  it('preserva T, AK, AM e AN do estudante sem recomposição pelos novos detalhes', () => {
    const student = requiredStudent('6A1º', 5);
    expect(student.quantitativeTotal).toEqual(SYNTHETIC_EXPECTATIONS.cells.formulaNonzero);
    expect(student.qualitativeTotal).toEqual(SYNTHETIC_EXPECTATIONS.cells.manualPositive);
    expect(student.official?.value).toBe(9.5);
    expect(student.annual?.value).toBe(20);
  });
});
