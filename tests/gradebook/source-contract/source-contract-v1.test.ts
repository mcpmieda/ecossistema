// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SOURCE_CELL_CLASSIFICATIONS_V1, SOURCE_CONTRACT_V1, SOURCE_STAGES_V1, type SourceCellEvidenceV1, type SourceCellProvenanceV1 } from '../../../shared/gradebook-contracts/source/source-contract-v1';

const provenance: SourceCellProvenanceV1 = {
  fileName: 'professor-sintetico.xlsx',
  fileSha256: '0'.repeat(64),
  sheetName: '6A1º',
  cellAddress: 'AM8',
};

describe('SourceContractV1 — estrutura da fonte', () => {

  it('SRC-003: codifica metadados, alunos, trimestres e REC nos locais confirmados', () => {
    expect(SOURCE_STAGES_V1).toEqual(['VG', '1º', '2º', '3º', 'REC']);
    expect(SOURCE_CONTRACT_V1.cells.metadata).toEqual({
      declaredStudentCount: 'J1',
      subject: 'K2',
      classGroup: 'K3',
      stage: 'K4',
    });
    expect(SOURCE_CONTRACT_V1.cells.studentColumns).toEqual({
      status: 'G',
      number: 'J',
      name: 'K',
    });
    expect(SOURCE_CONTRACT_V1.cells.termColumns).toMatchObject({
      writtenAssessment: 'R',
      secondAssessment: 'S',
      quantitativeTotal: 'T',
      parallelAssessment: 'Z',
      qualitativeActivityRange: { start: 'AA', end: 'AJ' },
      qualitativeTotal: 'AK',
      officialTermGrade: 'AM',
      annualAccumulatedTotal: 'AN',
    });
    expect(SOURCE_CONTRACT_V1.cells.recoveryColumns).toEqual({
      recoveryTerm1: 'R',
      recoveryTerm2: 'S',
      recoveryTerm3: 'T',
      annualTotalAfterRecovery: 'U',
      originalTerm1: 'X',
      originalTerm2: 'Y',
      originalTerm3: 'AA',
      originalAnnualTotal: 'AB',
      recoveryAppliesToTerm1: 'AC',
      recoveryAppliesToTerm2: 'AD',
      recoveryAppliesToTerm3: 'AE',
    });
  });
});

describe('SourceContractV1 — vocabulário semântico das células', () => {
  it('CELL-001: vazio é ausência, não zero', () => {
    const evidence: SourceCellEvidenceV1 = { classification: 'empty', provenance, rawValue: null };
    expect(evidence.classification).toBe('empty');
    expect(SOURCE_CONTRACT_V1.semantics.empty).toBe('absence');
  });

  it('CELL-002: 0,1 manual preserva a origem e representa zero oficial', () => {
    const evidence: SourceCellEvidenceV1 = {
      classification: 'manual-official-zero-marker',
      provenance,
      rawValue: 0.1,
    };
    expect(evidence.rawValue).toBe(0.1);
    expect(SOURCE_CONTRACT_V1.semantics.officialZeroMarker).toEqual({
      sourceValue: 0.1,
      semanticValue: 0,
    });
  });

  it('CELL-003: zero manual legado é um zero real distinto', () => {
    const evidence: SourceCellEvidenceV1 = {
      classification: 'manual-legacy-zero',
      provenance,
      rawValue: 0,
    };
    expect(evidence.classification).toBe('manual-legacy-zero');
    expect(SOURCE_CONTRACT_V1.semantics.legacyManualZero.semanticValue).toBe(0);
  });

  it('CELL-004: número manual positivo possui classificação própria', () => {
    const evidence: SourceCellEvidenceV1 = {
      classification: 'manual-positive-number',
      provenance,
      rawValue: 7.5,
    };
    expect(evidence.rawValue).toBe(7.5);
  });

  it('CELL-005: número manual negativo é preservado separadamente', () => {
    const evidence: SourceCellEvidenceV1 = {
      classification: 'manual-negative-number',
      provenance,
      rawValue: -1,
    };
    expect(evidence.classification).toBe('manual-negative-number');
    expect(evidence.rawValue).toBe(-1);
  });

  it('CELL-006: fórmula não zero preserva fórmula e cache', () => {
    const evidence: SourceCellEvidenceV1 = {
      classification: 'formula-nonzero',
      provenance,
      rawValue: 8,
      formula: 'SUM(R8:S8)',
      cachedValue: 8,
    };
    expect(evidence.formula).toBe('SUM(R8:S8)');
    expect(evidence.cachedValue).toBe(8);
  });

  it('CELL-007: fórmula zero é ausência no contrato vigente', () => {
    const evidence: SourceCellEvidenceV1 = {
      classification: 'formula-zero',
      provenance,
      rawValue: 0,
      formula: 'SUM(R8:S8)',
      cachedValue: 0,
    };
    expect(evidence.classification).toBe('formula-zero');
    expect(SOURCE_CONTRACT_V1.semantics.formulaZero).toBe('absence');
  });

  it('CELL-008: fórmula sem cache ou com erro não inventa nota', () => {
    const evidence: SourceCellEvidenceV1 = {
      classification: 'formula-error-or-missing-cache',
      provenance,
      rawValue: null,
      formula: 'SUM(R8:S8)',
      cachedValue: null,
      sourceError: 'missing-cache',
    };
    expect(evidence.cachedValue).toBeNull();
    expect(evidence.classification).toBe('formula-error-or-missing-cache');
  });

  it('CELL-009: texto inválido permanece texto inválido', () => {
    const evidence: SourceCellEvidenceV1 = {
      classification: 'invalid-text',
      provenance,
      rawValue: 'texto-sintetico',
    };
    expect(evidence.rawValue).toBe('texto-sintetico');
  });

  it('CELL-010: não aplicável, não lançada e campo inexistente permanecem distintos', () => {
    const classifications = new Set(SOURCE_CELL_CLASSIFICATIONS_V1);
    expect(classifications.has('not-applicable')).toBe(true);
    expect(classifications.has('empty')).toBe(true);
    expect(classifications.has('missing-field')).toBe(true);
    expect(SOURCE_CONTRACT_V1.semantics.notApplicable).not.toBe(
      SOURCE_CONTRACT_V1.semantics.empty,
    );
    expect(SOURCE_CONTRACT_V1.semantics.missingField).not.toBe(
      SOURCE_CONTRACT_V1.semantics.empty,
    );
  });
});
