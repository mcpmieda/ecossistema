import {
  SOURCE_CELL_CLASSIFICATIONS_V1,
  SOURCE_CELL_MAP_V1,
  SOURCE_CONTRACT_V1,
  SOURCE_FILE_EXTENSIONS_V1,
  SOURCE_STAGES_V1,
  type SourceCellProvenanceV1,
  type SourceCellRawValueV1,
} from './source-contract-v1';

export const SOURCE_CONTRACT_VERSION_V2 = 2 as const;

const SOURCE_TERM_STAGES_V2 = ['1º', '2º', '3º'] as const;

export const SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2 = [
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
] as const;

export const SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2 = [
  { sourceSlot: 'AA', order: 1, maximumCell: 'AA3', nameCell: 'AA4', studentValueColumn: 'AA' },
  { sourceSlot: 'AB', order: 2, maximumCell: 'AB3', nameCell: 'AB4', studentValueColumn: 'AB' },
  { sourceSlot: 'AC', order: 3, maximumCell: 'AC3', nameCell: 'AC4', studentValueColumn: 'AC' },
  { sourceSlot: 'AD', order: 4, maximumCell: 'AD3', nameCell: 'AD4', studentValueColumn: 'AD' },
  { sourceSlot: 'AE', order: 5, maximumCell: 'AE3', nameCell: 'AE4', studentValueColumn: 'AE' },
  { sourceSlot: 'AF', order: 6, maximumCell: 'AF3', nameCell: 'AF4', studentValueColumn: 'AF' },
  { sourceSlot: 'AG', order: 7, maximumCell: 'AG3', nameCell: 'AG4', studentValueColumn: 'AG' },
  { sourceSlot: 'AH', order: 8, maximumCell: 'AH3', nameCell: 'AH4', studentValueColumn: 'AH' },
  { sourceSlot: 'AI', order: 9, maximumCell: 'AI3', nameCell: 'AI4', studentValueColumn: 'AI' },
  { sourceSlot: 'AJ', order: 10, maximumCell: 'AJ3', nameCell: 'AJ4', studentValueColumn: 'AJ' },
] as const;

export type SourceQuantitativeAssessmentSlotV2 =
  (typeof SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2)[number]['sourceSlot'];
export type SourceQualitativeActivitySlotV2 =
  (typeof SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2)[number]['sourceSlot'];
export type SourceAssessmentSlotV2 =
  | SourceQuantitativeAssessmentSlotV2
  | SourceQualitativeActivitySlotV2;

export const SOURCE_ASSESSMENT_DEFINITION_KINDS_V2 = [
  'quantitative-assessment',
  'qualitative-activity',
] as const;

export const SOURCE_ASSESSMENT_MAXIMUM_CONFIGURATION_STATES_V2 = [
  'numeric',
  'ambiguous-empty',
  'ambiguous-marker',
  'missing-field',
  'unrecognized',
] as const;

type SourceAssessmentMaximumConfigurationV2 =
  | {
      readonly state: 'numeric';
      readonly rawValue: number;
      readonly provenance: SourceCellProvenanceV1;
    }
  | {
      readonly state: 'ambiguous-empty';
      readonly rawValue: null | '';
      readonly provenance: SourceCellProvenanceV1;
    }
  | {
      readonly state: 'ambiguous-marker';
      readonly rawValue: '*';
      readonly provenance: SourceCellProvenanceV1;
    }
  | {
      readonly state: 'missing-field';
      readonly rawValue: undefined;
      readonly provenance: SourceCellProvenanceV1;
    }
  | {
      readonly state: 'unrecognized';
      readonly rawValue: string | boolean;
      readonly provenance: SourceCellProvenanceV1;
    };

export const SOURCE_ASSESSMENT_NAME_STATES_V2 = [
  'text',
  'empty',
  'missing-field',
  'unrecognized',
] as const;

type SourceAssessmentNameV2 =
  | {
      readonly state: 'text';
      readonly rawValue: string;
      readonly provenance: SourceCellProvenanceV1;
    }
  | {
      readonly state: 'empty';
      readonly rawValue: null | '';
      readonly provenance: SourceCellProvenanceV1;
    }
  | {
      readonly state: 'missing-field';
      readonly rawValue: undefined;
      readonly provenance: SourceCellProvenanceV1;
    }
  | {
      readonly state: 'unrecognized';
      readonly rawValue: number | boolean;
      readonly provenance: SourceCellProvenanceV1;
    };

export type SourceQuantitativeAssessmentDefinitionV2 = {
  readonly contractVersion: typeof SOURCE_CONTRACT_VERSION_V2;
  readonly kind: 'quantitative-assessment';
  readonly sourceSlot: SourceQuantitativeAssessmentSlotV2;
  readonly order: 1 | 2;
  readonly structuralLabel: 'Avaliação quantitativa 1' | 'Avaliação quantitativa 2';
  readonly maximumConfiguration: SourceAssessmentMaximumConfigurationV2;
};

export type SourceQualitativeActivityDefinitionV2 = {
  readonly contractVersion: typeof SOURCE_CONTRACT_VERSION_V2;
  readonly kind: 'qualitative-activity';
  readonly sourceSlot: SourceQualitativeActivitySlotV2;
  readonly order: number;
  readonly maximumConfiguration: SourceAssessmentMaximumConfigurationV2;
  readonly name: SourceAssessmentNameV2;
};

export type SourceAssessmentDefinitionV2 =
  | SourceQuantitativeAssessmentDefinitionV2
  | SourceQualitativeActivityDefinitionV2;

export const SOURCE_ASSESSMENT_INSUFFICIENT_REASONS_V2 = [
  'maximum-ambiguous-empty',
  'maximum-ambiguous-marker',
  'maximum-missing-field',
  'maximum-unrecognized',
  'maximum-not-positive',
  'name-empty',
  'name-missing-field',
  'name-unrecognized',
] as const;

const SOURCE_CELL_MAP_V2 = {
  metadata: SOURCE_CELL_MAP_V1.metadata,
  studentColumns: SOURCE_CELL_MAP_V1.studentColumns,
  term: {
    studentStartRow: 5,
    quantitativeAssessments: SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2,
    quantitativeTotal: 'T',
    parallelAssessment: 'Z',
    qualitativeActivities: SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2,
    qualitativeTotal: 'AK',
    officialTermGrade: 'AM',
    annualAccumulatedTotal: 'AN',
  },
  recoveryColumns: SOURCE_CELL_MAP_V1.recoveryColumns,
} as const;

export const SOURCE_CONTRACT_V2 = {
  version: SOURCE_CONTRACT_VERSION_V2,
  predecessorVersion: SOURCE_CONTRACT_V1.version,
  compatibility: {
    historicalV1Semantics: 'preserve-as-v1',
    reinterpretHistoricalV1: false,
  },
  acceptedExtensions: SOURCE_FILE_EXTENSIONS_V1,
  stages: SOURCE_STAGES_V1,
  termStages: SOURCE_TERM_STAGES_V2,
  cells: SOURCE_CELL_MAP_V2,
  cellClassifications: SOURCE_CELL_CLASSIFICATIONS_V1,
  assessmentDefinitionSemantics: {
    positiveNumericMaximum: 'resolved-when-other-evidence-is-sufficient',
    ambiguousEmptyMaximum: 'insufficient-data',
    ambiguousMarkerMaximum: 'insufficient-data',
    nonPositiveNumericMaximum: 'insufficient-data',
    notApplicable: 'requires-explicit-evidence',
    unknownMaximumAsZero: 'forbidden',
    sourceNameAsIdentity: 'forbidden',
  },
  authoritativeImportedAggregates: {
    quantitativeTotal: 'T',
    parallelAssessment: 'Z',
    qualitativeTotal: 'AK',
    officialTermGrade: 'AM',
    annualAccumulatedTotal: 'AN',
    recalculateFromAssessmentDefinitions: false,
  },
} as const;

export type SourceContractV2 = typeof SOURCE_CONTRACT_V2;

export function classifySourceAssessmentMaximumConfigurationV2(
  rawValue: SourceCellRawValueV1 | undefined,
  provenance: SourceCellProvenanceV1,
): SourceAssessmentMaximumConfigurationV2 {
  if (rawValue === undefined) return { state: 'missing-field', rawValue, provenance };
  if (rawValue === null || rawValue === '') {
    return { state: 'ambiguous-empty', rawValue, provenance };
  }
  if (rawValue === '*') return { state: 'ambiguous-marker', rawValue, provenance };
  if (typeof rawValue === 'number') return { state: 'numeric', rawValue, provenance };
  return { state: 'unrecognized', rawValue, provenance };
}

export function classifySourceAssessmentNameV2(
  rawValue: SourceCellRawValueV1 | undefined,
  provenance: SourceCellProvenanceV1,
): SourceAssessmentNameV2 {
  if (rawValue === undefined) return { state: 'missing-field', rawValue, provenance };
  if (rawValue === null || rawValue === '') return { state: 'empty', rawValue, provenance };
  if (typeof rawValue === 'string') return { state: 'text', rawValue, provenance };
  return { state: 'unrecognized', rawValue, provenance };
}
