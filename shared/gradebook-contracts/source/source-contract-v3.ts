import {
  SOURCE_CONTRACT_V2,
  SOURCE_CONTRACT_VERSION_V2,
  resolveSourceAssessmentDefinitionV2,
  type SourceAssessmentDefinitionResolutionV2,
  type SourceAssessmentDefinitionV2,
  type SourceAssessmentInsufficientReasonV2,
} from './source-contract-v2';

export const SOURCE_CONTRACT_VERSION_V3 = 3 as const;

export interface SourceAssessmentDefinitionEvidenceV3 {
  /** True only when at least one academic value was observed in this slot on this term sheet. */
  readonly hasObservedStudentValue: boolean;
}

export type SourceAssessmentUnconfiguredMaximumStateV3 =
  SourceAssessmentDefinitionV2['maximumConfiguration']['state'];

export type SourceAssessmentDefinitionResolutionV3 =
  | Extract<SourceAssessmentDefinitionResolutionV2, { readonly state: 'resolved' }>
  | {
      readonly state: 'configured';
      readonly kind: 'qualitative-activity';
      readonly sourceSlot: Extract<
        SourceAssessmentDefinitionV2,
        { readonly kind: 'qualitative-activity' }
      >['sourceSlot'];
      readonly order: number;
      readonly name: string;
      readonly maximum: number;
      readonly applicability: { readonly state: 'applicable' };
    }
  | {
      /** The activity may exist, but its maximum has not been configured in this snapshot. */
      readonly state: 'maximum-not-defined';
      readonly kind: 'qualitative-activity';
      readonly sourceSlot: Extract<
        SourceAssessmentDefinitionV2,
        { readonly kind: 'qualitative-activity' }
      >['sourceSlot'];
      readonly order: number;
      readonly observedName: string | null;
      readonly maximumConfigurationState: SourceAssessmentUnconfiguredMaximumStateV3;
      readonly reason: 'maximum-not-defined';
    }
  | {
      readonly state: 'insufficient-data';
      readonly kind: SourceAssessmentDefinitionV2['kind'];
      readonly sourceSlot: SourceAssessmentDefinitionV2['sourceSlot'];
      readonly order: number;
      readonly observedName: string | null;
      readonly reason: SourceAssessmentInsufficientReasonV2;
    };

function observedName(definition: SourceAssessmentDefinitionV2): string | null {
  if (definition.kind === 'quantitative-assessment') return definition.structuralLabel;
  return definition.name.state === 'text' ? definition.name.rawValue : null;
}

function insufficientMaximumReason(
  definition: Extract<SourceAssessmentDefinitionV2, { readonly kind: 'qualitative-activity' }>,
): SourceAssessmentInsufficientReasonV2 {
  switch (definition.maximumConfiguration.state) {
    case 'numeric':
      return 'maximum-not-positive';
    case 'ambiguous-empty':
      return 'maximum-ambiguous-empty';
    case 'ambiguous-marker':
      return 'maximum-ambiguous-marker';
    case 'missing-field':
      return 'maximum-missing-field';
    case 'unrecognized':
      return 'maximum-unrecognized';
  }
}

function qualitativeDisplayName(
  definition: Extract<SourceAssessmentDefinitionV2, { readonly kind: 'qualitative-activity' }>,
): string {
  if (definition.name.state === 'text' && definition.name.rawValue.trim().length > 0) {
    return definition.name.rawValue;
  }
  return `Atividade qualitativa ${definition.order}`;
}

/**
 * V3 keeps the V2 observation shape and changes only its server-side interpretation. The evidence
 * needed for the distinction already travels in Transport V4: the definition plus student values.
 */
export function resolveSourceAssessmentDefinitionV3(
  definition: SourceAssessmentDefinitionV2,
  evidence: SourceAssessmentDefinitionEvidenceV3,
): SourceAssessmentDefinitionResolutionV3 {
  if (definition.kind === 'quantitative-assessment') {
    return resolveSourceAssessmentDefinitionV2(definition);
  }

  const maximum = definition.maximumConfiguration;
  if (maximum.state === 'numeric' && Number.isFinite(maximum.rawValue) && maximum.rawValue > 0) {
    return {
      state: 'configured',
      kind: definition.kind,
      sourceSlot: definition.sourceSlot,
      order: definition.order,
      name: qualitativeDisplayName(definition),
      maximum: maximum.rawValue,
      applicability: { state: 'applicable' },
    };
  }

  if (evidence.hasObservedStudentValue) {
    return {
      state: 'insufficient-data',
      kind: definition.kind,
      sourceSlot: definition.sourceSlot,
      order: definition.order,
      observedName: observedName(definition),
      reason: insufficientMaximumReason(definition),
    };
  }

  return {
    state: 'maximum-not-defined',
    kind: definition.kind,
    sourceSlot: definition.sourceSlot,
    order: definition.order,
    observedName: observedName(definition),
    maximumConfigurationState: maximum.state,
    reason: 'maximum-not-defined',
  };
}

export const SOURCE_CONTRACT_V3 = {
  version: SOURCE_CONTRACT_VERSION_V3,
  predecessorVersion: SOURCE_CONTRACT_VERSION_V2,
  compatibility: {
    historicalV1Semantics: 'preserve-as-v1',
    historicalV2Semantics: 'preserve-as-v2',
    observationShape: 'source-contract-v2',
    transportV4ObservationsSufficient: true,
  },
  cells: SOURCE_CONTRACT_V2.cells,
  assessmentDefinitionSemantics: {
    quantitativeRS: 'source-contract-v2-unchanged',
    qualitativeMaximumCells: 'AA3:AJ3',
    qualitativeNameCells: 'AA4:AJ4',
    positiveNumericMaximum: 'configured-applicable',
    maximumNotPositiveOrNonNumericWithoutStudentValue: 'maximum-not-defined',
    maximumNotPositiveOrNonNumericWithStudentValue: 'insufficient-data-conflict',
    qualitativeName: 'display-only-with-structural-fallback',
    unknownMaximumAsZero: 'forbidden',
    sourceNameAsIdentity: 'forbidden',
    termSlots: 'independent-source-observations',
  },
  authoritativeImportedAggregates: SOURCE_CONTRACT_V2.authoritativeImportedAggregates,
} as const;
