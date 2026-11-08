export const SOURCE_FILE_EXTENSIONS_V1 = ['xlsb', 'xlsx', 'xls'] as const;
export type SourceFileExtensionV1 = (typeof SOURCE_FILE_EXTENSIONS_V1)[number];

export const SOURCE_STAGES_V1 = ['VG', '1º', '2º', '3º', 'REC'] as const;

export type SourceDisciplineIndexV1 = `D${number}`;

export const SOURCE_CELL_MAP_V1 = {
  metadata: {
    declaredStudentCount: 'J1',
    subject: 'K2',
    classGroup: 'K3',
    stage: 'K4',
  },
  studentColumns: {
    status: 'G',
    number: 'J',
    name: 'K',
  },
  termColumns: {
    writtenAssessment: 'R',
    secondAssessment: 'S',
    quantitativeTotal: 'T',
    parallelAssessment: 'Z',
    qualitativeActivities: ['AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ'],
    qualitativeActivityRange: {
      start: 'AA',
      end: 'AJ',
    },
    qualitativeTotal: 'AK',
    officialTermGrade: 'AM',
    annualAccumulatedTotal: 'AN',
  },
  recoveryColumns: {
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
  },
} as const;

export const SOURCE_CELL_CLASSIFICATIONS_V1 = [
  'missing-field',
  'not-applicable',
  'empty',
  'manual-positive-number',
  'manual-negative-number',
  'manual-legacy-zero',
  'manual-official-zero-marker',
  'formula-nonzero',
  'formula-zero',
  'formula-error-or-missing-cache',
  'invalid-text',
] as const;
export type SourceCellRawValueV1 = string | number | boolean | null;

export type SourceCellProvenanceV1 = {
  fileName: string;
  fileSha256: string;
  sheetName: string;
  cellAddress: string;
};

type SourceCellEvidenceBaseV1 = {
  provenance: SourceCellProvenanceV1;
};

export type SourceCellEvidenceV1 =
  | (SourceCellEvidenceBaseV1 & {
      classification: 'missing-field';
      rawValue: undefined;
    })
  | (SourceCellEvidenceBaseV1 & {
      classification: 'not-applicable';
      rawValue: SourceCellRawValueV1;
    })
  | (SourceCellEvidenceBaseV1 & {
      classification: 'empty';
      rawValue: null | '';
    })
  | (SourceCellEvidenceBaseV1 & {
      classification: 'manual-positive-number';
      rawValue: number;
    })
  | (SourceCellEvidenceBaseV1 & {
      classification: 'manual-negative-number';
      rawValue: number;
    })
  | (SourceCellEvidenceBaseV1 & {
      classification: 'manual-legacy-zero';
      rawValue: 0;
    })
  | (SourceCellEvidenceBaseV1 & {
      classification: 'manual-official-zero-marker';
      rawValue: 0.1;
    })
  | (SourceCellEvidenceBaseV1 & {
      classification: 'formula-nonzero';
      rawValue: SourceCellRawValueV1;
      formula: string;
      cachedValue: number;
    })
  | (SourceCellEvidenceBaseV1 & {
      classification: 'formula-zero';
      rawValue: SourceCellRawValueV1;
      formula: string;
      cachedValue: 0;
    })
  | (SourceCellEvidenceBaseV1 & {
      classification: 'formula-error-or-missing-cache';
      rawValue: SourceCellRawValueV1;
      formula: string;
      cachedValue: null;
      sourceError: string | null;
    })
  | (SourceCellEvidenceBaseV1 & {
      classification: 'invalid-text';
      rawValue: string;
    });

export const SOURCE_CONTRACT_V1 = {
  version: 1,
  acceptedExtensions: SOURCE_FILE_EXTENSIONS_V1,
  stages: SOURCE_STAGES_V1,
  disciplineIndex: {
    implicitWithoutSuffix: 'D1',
    firstExplicitSuffix: 'D2',
  },
  cells: SOURCE_CELL_MAP_V1,
  cellClassifications: SOURCE_CELL_CLASSIFICATIONS_V1,
  semantics: {
    empty: 'absence',
    officialZeroMarker: {
      sourceValue: 0.1,
      semanticValue: 0,
    },
    legacyManualZero: {
      sourceValue: 0,
      semanticValue: 0,
    },
    formulaZero: 'absence',
    notApplicable: 'not-applicable',
    missingField: 'missing-field',
  },
} as const;

export type SourceContractV1 = typeof SOURCE_CONTRACT_V1;
