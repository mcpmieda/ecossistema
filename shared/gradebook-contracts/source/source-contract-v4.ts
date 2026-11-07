import type { AssessmentMaximumV3 } from '../results/results-contract-v3';
import {
  SOURCE_CONTRACT_V3,
  SOURCE_CONTRACT_VERSION_V3,
  type SourceAssessmentDefinitionEvidenceV3,
} from './source-contract-v3';
import {
  resolveSourceAssessmentDefinitionV2,
  type SourceAssessmentDefinitionV2,
  type SourceAssessmentInsufficientReasonV2,
} from './source-contract-v2';

const SOURCE_CONTRACT_VERSION_V4 = 4 as const;

export type SourceAssessmentDefinitionResolutionV4 =
  | {
      readonly state: 'resolved';
      readonly kind: SourceAssessmentDefinitionV2['kind'];
      readonly sourceSlot: SourceAssessmentDefinitionV2['sourceSlot'];
      readonly order: number;
      readonly name: string;
      readonly maximum: AssessmentMaximumV3;
      readonly applicability: { readonly state: 'applicable' };
    }
  | {
      readonly state: 'insufficient-data';
      readonly kind: 'quantitative-assessment';
      readonly sourceSlot: Extract<
        SourceAssessmentDefinitionV2,
        { readonly kind: 'quantitative-assessment' }
      >['sourceSlot'];
      readonly order: number;
      readonly observedName: string | null;
      readonly reason: SourceAssessmentInsufficientReasonV2;
    };

function qualitativeDisplayName(
  definition: Extract<SourceAssessmentDefinitionV2, { readonly kind: 'qualitative-activity' }>,
): string {
  if (definition.name.state === 'text' && definition.name.rawValue.trim().length > 0) {
    return definition.name.rawValue;
  }
  return `Atividade qualitativa ${definition.order}`;
}

/** Evidence is retained in the signature for compatibility, but never blocks a qualitative slot. */
export function resolveSourceAssessmentDefinitionV4(
  definition: SourceAssessmentDefinitionV2,
  _evidence: SourceAssessmentDefinitionEvidenceV3,
): SourceAssessmentDefinitionResolutionV4 {
  if (definition.kind === 'quantitative-assessment') {
    const historical = resolveSourceAssessmentDefinitionV2(definition);
    if (historical.state === 'insufficient-data') {
      return {
        state: 'insufficient-data',
        kind: definition.kind,
        sourceSlot: definition.sourceSlot,
        order: definition.order,
        observedName: definition.structuralLabel,
        reason: historical.reason,
      };
    }
    return {
      ...historical,
      maximum: { state: 'defined', value: historical.maximum },
    };
  }

  const configured =
    definition.maximumConfiguration.state === 'numeric' &&
    Number.isFinite(definition.maximumConfiguration.rawValue) &&
    definition.maximumConfiguration.rawValue > 0;
  return {
    state: 'resolved',
    kind: definition.kind,
    sourceSlot: definition.sourceSlot,
    order: definition.order,
    name: qualitativeDisplayName(definition),
    maximum: configured
      ? { state: 'defined', value: definition.maximumConfiguration.rawValue }
      : { state: 'not-defined' },
    applicability: { state: 'applicable' },
  };
}

export const SOURCE_CONTRACT_V4 = {
  version: SOURCE_CONTRACT_VERSION_V4,
  predecessorVersion: SOURCE_CONTRACT_VERSION_V3,
  compatibility: {
    historicalV1Semantics: 'preserve-as-v1',
    historicalV2Semantics: 'preserve-as-v2',
    historicalV3Semantics: 'preserve-as-v3',
    observationShape: 'source-contract-v2',
  },
  cells: SOURCE_CONTRACT_V3.cells,
  assessmentDefinitionSemantics: {
    quantitativeRS: 'source-contract-v2-unchanged',
    qualitativeMaximumCells: 'AA3:AJ3',
    qualitativeNameCells: 'AA4:AJ4',
    positiveNumericMaximum: 'defined',
    otherMaximumStates: 'not-defined-nonblocking',
    materializeComponentWithoutMaximum: true,
    materializeGradeEntriesWithoutMaximum: true,
    rawGradeAvailableAcrossGradebook: true,
    denominatorDependentIndicatorsWithoutMaximum: 'unavailable',
    laterDefinedMaximum: 'append-version-to-same-stable-component-identity',
    unknownMaximumAsZero: 'forbidden',
    sourceNameAsIdentity: 'forbidden',
  },
  authoritativeImportedAggregates: SOURCE_CONTRACT_V3.authoritativeImportedAggregates,
} as const;
