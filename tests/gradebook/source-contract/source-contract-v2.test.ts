// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { type SourceCellProvenanceV1 } from '../../../shared/gradebook-contracts/source/source-contract-v1';
import { SOURCE_CONTRACT_V2, SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2, SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2, classifySourceAssessmentMaximumConfigurationV2 } from '../../../shared/gradebook-contracts/source/source-contract-v2';

function provenance(cellAddress: string): SourceCellProvenanceV1 {
  return {
    fileName: 'professor-sintetico.xlsx',
    fileSha256: '1'.repeat(64),
    sheetName: '6A1ºD2',
    cellAddress,
  };
}

describe('SourceContractV2 — definições trimestrais de avaliação', () => {
  it('SRC2-001: separa R3/S3 dos valores R/S dos estudantes a partir da linha 5', () => {
    expect(SOURCE_CONTRACT_V2.cells.term.studentStartRow).toBe(5);
    expect(SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2).toEqual([
      {
        sourceSlot: 'R',
        order: 1,
        structuralLabel: 'Avaliação quantitativa 1',
        maximumCell: 'R3',
        studentValueColumn: 'R',
      },
      {
        sourceSlot: 'S',
        order: 2,
        structuralLabel: 'Avaliação quantitativa 2',
        maximumCell: 'S3',
        studentValueColumn: 'S',
      },
    ]);
  });

  it('SRC2-002: formaliza AA3:AJ3, AA4:AJ4 e AA5+ sem misturar suas naturezas', () => {
    expect(SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2).toHaveLength(10);
    expect(SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2[0]).toEqual({
      sourceSlot: 'AA',
      order: 1,
      maximumCell: 'AA3',
      nameCell: 'AA4',
      studentValueColumn: 'AA',
    });
    expect(SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2[9]).toEqual({
      sourceSlot: 'AJ',
      order: 10,
      maximumCell: 'AJ3',
      nameCell: 'AJ4',
      studentValueColumn: 'AJ',
    });
  });

  it('SRC2-003: preserva número, vazio e * do máximo/configuração sem coerção destrutiva', () => {
    expect(classifySourceAssessmentMaximumConfigurationV2(8, provenance('AA3'))).toMatchObject({
      state: 'numeric',
      rawValue: 8,
    });
    expect(classifySourceAssessmentMaximumConfigurationV2('', provenance('AB3'))).toMatchObject({
      state: 'ambiguous-empty',
      rawValue: '',
    });
    expect(classifySourceAssessmentMaximumConfigurationV2(null, provenance('AC3'))).toMatchObject({
      state: 'ambiguous-empty',
      rawValue: null,
    });
    expect(classifySourceAssessmentMaximumConfigurationV2('*', provenance('AD3'))).toMatchObject({
      state: 'ambiguous-marker',
      rawValue: '*',
    });
  });

  it('SRC2-008: T/Z/AK/AM/AN permanecem importados e não são recalculados pelos slots', () => {
    expect(SOURCE_CONTRACT_V2.authoritativeImportedAggregates).toEqual({
      quantitativeTotal: 'T',
      parallelAssessment: 'Z',
      qualitativeTotal: 'AK',
      officialTermGrade: 'AM',
      annualAccumulatedTotal: 'AN',
      recalculateFromAssessmentDefinitions: false,
    });
  });
});
