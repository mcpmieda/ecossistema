import { assessmentComponentSourceStableKeyV2 } from '../../../../shared/gradebook-contracts/results/results-contract-v2';
import {
  SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2,
  SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2,
  type SourceAssessmentDefinitionV2,
  type SourceAssessmentSlotV2,
} from '../../../../shared/gradebook-contracts/source/source-contract-v2';
import {
  resolveSourceAssessmentDefinitionV3,
  type SourceAssessmentDefinitionResolutionV3,
} from '../../../../shared/gradebook-contracts/source/source-contract-v3';
import {
  materializeAssessmentDefinitionsV2,
  type AssessmentDefinitionMaterializationContextV2,
  type AssessmentDefinitionMaterializationV2,
} from './assessment-definition-materializer-v2';
import type { GradeSheetRecognition, StudentRecognition } from './spreadsheet-recognizer';

type InsufficientResolutionV3 = Extract<
  SourceAssessmentDefinitionResolutionV3,
  { readonly state: 'insufficient-data' }
>;
type UnconfiguredResolutionV3 = Extract<
  SourceAssessmentDefinitionResolutionV3,
  { readonly state: 'maximum-not-defined' }
>;
type ConfiguredResolutionV3 = Extract<
  SourceAssessmentDefinitionResolutionV3,
  { readonly maximum: number }
>;

export interface BlockedAssessmentDefinitionV3 {
  readonly stableKey: ReturnType<typeof assessmentComponentSourceStableKeyV2>;
  readonly sourceDefinition: SourceAssessmentDefinitionV2;
  readonly resolution: InsufficientResolutionV3;
  readonly gradeEntriesMaterialized: 0;
}

export interface UnconfiguredAssessmentDefinitionV3 {
  readonly stableKey: ReturnType<typeof assessmentComponentSourceStableKeyV2>;
  readonly sourceDefinition: SourceAssessmentDefinitionV2;
  readonly resolution: UnconfiguredResolutionV3;
  readonly assessmentComponentsMaterialized: 0;
  readonly gradeEntriesMaterialized: 0;
}

export interface AssessmentDefinitionMaterializationV3 extends Omit<
  AssessmentDefinitionMaterializationV2,
  'blockedDefinitions'
> {
  readonly blockedDefinitions: readonly BlockedAssessmentDefinitionV3[];
  readonly unconfiguredDefinitions: readonly UnconfiguredAssessmentDefinitionV3[];
}

function noteForSlot(student: StudentRecognition, slot: SourceAssessmentSlotV2): unknown {
  const quantitativeIndex = SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2.findIndex(
    (candidate) => candidate.sourceSlot === slot,
  );
  if (quantitativeIndex >= 0) return student.quantitativeAssessments[quantitativeIndex] ?? null;
  const qualitativeIndex = SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.findIndex(
    (candidate) => candidate.sourceSlot === slot,
  );
  return qualitativeIndex >= 0 ? (student.qualitative[qualitativeIndex] ?? null) : null;
}

function stableKey(
  definition: SourceAssessmentDefinitionV2,
  context: AssessmentDefinitionMaterializationContextV2,
) {
  return assessmentComponentSourceStableKeyV2({
    logicalSourceReference: context.logicalSourceReference,
    academicYearId: context.academicYearId,
    teachingAssignmentId: context.teachingAssignmentId,
    term: context.term,
    sourceSlot: definition.sourceSlot,
  });
}

function withResolvedDisplayName(
  definition: SourceAssessmentDefinitionV2,
  resolution: ConfiguredResolutionV3,
): SourceAssessmentDefinitionV2 {
  if (definition.kind === 'quantitative-assessment') return definition;
  if (definition.name.state === 'text' && definition.name.rawValue.trim().length > 0) {
    return definition;
  }
  return {
    ...definition,
    name: {
      state: 'text',
      rawValue: resolution.name,
      provenance: definition.name.provenance,
    },
  };
}

/** Reuses the V2 component/entry materializer after V3 has classified each source slot. */
export async function materializeAssessmentDefinitionsV3(
  sheet: GradeSheetRecognition,
  context: AssessmentDefinitionMaterializationContextV2,
): Promise<AssessmentDefinitionMaterializationV3> {
  const originals = new Map(
    sheet.assessmentDefinitions.map((definition) => [definition.sourceSlot, definition]),
  );
  const configuredDefinitions: SourceAssessmentDefinitionV2[] = [];
  const blockedDefinitions: BlockedAssessmentDefinitionV3[] = [];
  const unconfiguredDefinitions: UnconfiguredAssessmentDefinitionV3[] = [];

  for (const definition of sheet.assessmentDefinitions) {
    const hasObservedStudentValue = sheet.students.some(
      (student) => noteForSlot(student, definition.sourceSlot) !== null,
    );
    const resolution = resolveSourceAssessmentDefinitionV3(definition, {
      hasObservedStudentValue,
    });
    const definitionStableKey = stableKey(definition, context);

    if (resolution.state === 'insufficient-data') {
      blockedDefinitions.push({
        stableKey: definitionStableKey,
        sourceDefinition: definition,
        resolution,
        gradeEntriesMaterialized: 0,
      });
      continue;
    }
    if (resolution.state === 'maximum-not-defined') {
      unconfiguredDefinitions.push({
        stableKey: definitionStableKey,
        sourceDefinition: definition,
        resolution,
        assessmentComponentsMaterialized: 0,
        gradeEntriesMaterialized: 0,
      });
      continue;
    }
    configuredDefinitions.push(withResolvedDisplayName(definition, resolution));
  }

  const materialized = await materializeAssessmentDefinitionsV2(
    { ...sheet, assessmentDefinitions: configuredDefinitions },
    context,
  );
  if (materialized.blockedDefinitions.length > 0) {
    throw new TypeError('assessment-materialization-v3-configured-definition-blocked');
  }

  blockedDefinitions.sort((left, right) => left.stableKey.localeCompare(right.stableKey));
  unconfiguredDefinitions.sort((left, right) => left.stableKey.localeCompare(right.stableKey));
  return {
    components: materialized.components.map((component) => ({
      ...component,
      sourceDefinition:
        originals.get(component.sourceDefinition.sourceSlot) ?? component.sourceDefinition,
    })),
    gradeEntries: materialized.gradeEntries,
    blockedDefinitions,
    unconfiguredDefinitions,
  };
}
