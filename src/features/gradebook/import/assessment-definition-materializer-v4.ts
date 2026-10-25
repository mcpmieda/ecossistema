import { SNAPSHOT_ASSESSMENT_RULE_V5 } from '../../../../shared/gradebook-contracts/source/source-values-contract-v5';
import type {
  AcademicYearId,
  EnrollmentId,
  StudentId,
  TeachingAssignmentId,
} from '../../../../shared/gradebook-contracts/entities';
import {
  assessmentComponentSourceStableKeyV3,
  type AssessmentComponentSourceStableKeyV3,
  type AssessmentComponentV3,
} from '../../../../shared/gradebook-contracts/results/results-contract-v3';
import type {
  AcademicGradeValueV1,
  AcademicTermV1,
  AssessmentComponentId,
  GradeEntryId,
  GradeEntryV1,
  SourceEvidenceSetV1,
} from '../../../../shared/gradebook-contracts/results/results-contract-v1';
import {
  SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2,
  SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2,
  type SourceAssessmentDefinitionV2,
  type SourceAssessmentSlotV2,
  type SourceQualitativeActivitySlotV2,
  type SourceQuantitativeAssessmentSlotV2,
} from '../../../../shared/gradebook-contracts/source/source-contract-v2';
import {
  resolveSourceAssessmentDefinitionV4,
  type SourceAssessmentDefinitionResolutionV4,
} from '../../../../shared/gradebook-contracts/source/source-contract-v4';
import type { CompatibleSourceCellEvidenceV5 as SourceCellEvidenceV1 } from '../../../../shared/gradebook-contracts/source/source-values-contract-v5';
import type {
  GradeSheetRecognition,
  NoteValue,
  StudentRecognition,
} from './spreadsheet-recognizer';

export const ASSESSMENT_IMPORT_RULE_VERSION_V3 = 'source-contract-v4-assessment-entry-v3' as const;

export interface AssessmentImportStudentResolutionV4 {
  readonly row: number;
  readonly studentId: StudentId;
  readonly enrollmentId: EnrollmentId;
}

export interface AssessmentDefinitionMaterializationContextV4 {
  readonly logicalSourceReference: string;
  readonly academicYearId: AcademicYearId;
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly term: AcademicTermV1;
  readonly students: readonly AssessmentImportStudentResolutionV4[];
}

export interface MaterializedAssessmentComponentV4 {
  readonly stableKey: AssessmentComponentSourceStableKeyV3;
  readonly sourceDefinition: SourceAssessmentDefinitionV2;
  readonly value: AssessmentComponentV3;
}

export interface BlockedAssessmentDefinitionV4 {
  readonly stableKey: AssessmentComponentSourceStableKeyV3;
  readonly sourceDefinition: SourceAssessmentDefinitionV2;
  readonly resolution: Extract<
    SourceAssessmentDefinitionResolutionV4,
    { readonly state: 'insufficient-data' }
  >;
  readonly gradeEntriesMaterialized: 0;
}

export interface AssessmentDefinitionMaterializationV4 {
  readonly components: readonly MaterializedAssessmentComponentV4[];
  readonly gradeEntries: readonly GradeEntryV1[];
  readonly blockedDefinitions: readonly BlockedAssessmentDefinitionV4[];
}

function requireContext(context: AssessmentDefinitionMaterializationContextV4): void {
  if (
    context.logicalSourceReference.trim().length === 0 ||
    context.academicYearId.trim().length === 0 ||
    context.teachingAssignmentId.trim().length === 0 ||
    ![1, 2, 3].includes(context.term)
  ) {
    throw new TypeError('assessment-materialization-context-invalid');
  }
  const rows = new Set<number>();
  for (const student of context.students) {
    if (
      !Number.isInteger(student.row) ||
      student.row < 5 ||
      student.studentId.trim().length === 0 ||
      student.enrollmentId.trim().length === 0 ||
      rows.has(student.row)
    ) {
      throw new TypeError('assessment-materialization-student-resolution-invalid');
    }
    rows.add(student.row);
  }
}

function termForStage(stage: GradeSheetRecognition['stage']): AcademicTermV1 | null {
  if (stage === 'trimester-1') return 1;
  if (stage === 'trimester-2') return 2;
  if (stage === 'trimester-3') return 3;
  return null;
}

async function opaqueId(prefix: string, stableValue: string): Promise<string> {
  const bytes = new TextEncoder().encode(stableValue);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hexadecimal = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${prefix}:${hexadecimal.slice(0, 32)}`;
}

function componentOrder(definition: SourceAssessmentDefinitionV2): number {
  return definition.kind === 'quantitative-assessment' ? definition.order : definition.order + 2;
}

function noteForSlot(student: StudentRecognition, slot: SourceAssessmentSlotV2): NoteValue | null {
  const quantitativeIndex = SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2.findIndex(
    (candidate) => candidate.sourceSlot === slot,
  );
  if (quantitativeIndex >= 0) return student.quantitativeAssessments[quantitativeIndex] ?? null;
  const qualitativeIndex = SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.findIndex(
    (candidate) => candidate.sourceSlot === slot,
  );
  return qualitativeIndex >= 0 ? (student.qualitative[qualitativeIndex] ?? null) : null;
}

function valueColumn(slot: SourceAssessmentSlotV2): string {
  const quantitative = SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2.find(
    (candidate) => candidate.sourceSlot === (slot as SourceQuantitativeAssessmentSlotV2),
  );
  if (quantitative) return quantitative.studentValueColumn;
  const qualitative = SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.find(
    (candidate) => candidate.sourceSlot === (slot as SourceQualitativeActivitySlotV2),
  );
  if (!qualitative) throw new TypeError('assessment-materialization-slot-invalid');
  return qualitative.studentValueColumn;
}

function academicValue(note: NoteValue): AcademicGradeValueV1 {
  if (note.snapshotState === 'unavailable')
    return { state: 'insufficient-data', reason: 'snapshot-value-unavailable' };
  if (note.snapshotState === 'value' && note.source === 0) return { state: 'absent' };
  if (note.kind === 'official-zero') {
    return { state: 'official-zero', value: 0, sourceMarker: 0.1 };
  }
  if (note.kind === 'legacy-zero') return { state: 'legacy-zero', value: 0 };
  return { state: 'numeric', value: note.value };
}

function sourceEvidence(
  note: NoteValue,
  input: {
    readonly fileName: string;
    readonly fileSha256: string;
    readonly sheetName: string;
    readonly cellAddress: string;
  },
): SourceCellEvidenceV1 {
  const provenance = input;
  if (note.snapshotState)
    return note.snapshotState === 'unavailable'
      ? { classification: 'snapshot-unavailable', rawValue: null, provenance }
      : { classification: 'snapshot-value', rawValue: note.source, provenance };
  if (note.kind === 'official-zero') {
    return { classification: 'manual-official-zero-marker', rawValue: 0.1, provenance };
  }
  if (note.kind === 'legacy-zero') {
    return { classification: 'manual-legacy-zero', rawValue: 0, provenance };
  }
  if (note.kind === 'negative') {
    return { classification: 'manual-negative-number', rawValue: note.source, provenance };
  }
  if (note.kind === 'manual') {
    return { classification: 'manual-positive-number', rawValue: note.source, provenance };
  }
  return {
    classification: 'formula-nonzero',
    rawValue: note.source,
    formula: note.formula ?? '',
    cachedValue: note.value,
    provenance,
  };
}

function fileProvenance(definition: SourceAssessmentDefinitionV2): {
  readonly fileName: string;
  readonly fileSha256: string;
} {
  const provenance = definition.maximumConfiguration.provenance;
  return { fileName: provenance.fileName, fileSha256: provenance.fileSha256 };
}

async function gradeEntry(
  component: AssessmentComponentV3,
  definition: SourceAssessmentDefinitionV2,
  sheet: GradeSheetRecognition,
  student: StudentRecognition,
  resolution: AssessmentImportStudentResolutionV4,
): Promise<GradeEntryV1 | null> {
  const note = noteForSlot(student, definition.sourceSlot);
  if (note === null) return null;
  const stableIdentity = JSON.stringify([
    component.academicYearId,
    resolution.studentId,
    resolution.enrollmentId,
    component.id,
  ]);
  const id = (await opaqueId('grade-entry:v2', stableIdentity)) as GradeEntryId;
  const semanticValue = academicValue(note);
  const source = fileProvenance(definition);
  const evidence = [
    sourceEvidence(note, {
      ...source,
      sheetName: sheet.name,
      cellAddress: `${valueColumn(definition.sourceSlot)}${student.row}`,
    }),
  ] as SourceEvidenceSetV1;
  return {
    id,
    academicYearId: component.academicYearId,
    studentId: resolution.studentId,
    enrollmentId: resolution.enrollmentId,
    assessmentComponentId: component.id,
    value: {
      imported: { value: semanticValue, evidence },
      calculated: { value: semanticValue },
    },
    authorityMode: 'imported-source',
    ruleVersion: note.snapshotState
      ? SNAPSHOT_ASSESSMENT_RULE_V5
      : ASSESSMENT_IMPORT_RULE_VERSION_V3,
    version: 1,
  };
}

export async function materializeAssessmentDefinitionsV4(
  sheet: GradeSheetRecognition,
  context: AssessmentDefinitionMaterializationContextV4,
): Promise<AssessmentDefinitionMaterializationV4> {
  requireContext(context);
  if (termForStage(sheet.stage) !== context.term) {
    throw new TypeError('assessment-materialization-term-mismatch');
  }

  const studentsByRow = new Map(sheet.students.map((student) => [student.row, student]));
  const resolutionsByRow = new Map(context.students.map((student) => [student.row, student]));
  const components: MaterializedAssessmentComponentV4[] = [];
  const blockedDefinitions: BlockedAssessmentDefinitionV4[] = [];
  const gradeEntries: GradeEntryV1[] = [];

  for (const sourceDefinition of sheet.assessmentDefinitions) {
    const stableKey = assessmentComponentSourceStableKeyV3({
      logicalSourceReference: context.logicalSourceReference,
      academicYearId: context.academicYearId,
      teachingAssignmentId: context.teachingAssignmentId,
      term: context.term,
      sourceSlot: sourceDefinition.sourceSlot,
    });
    const resolution = resolveSourceAssessmentDefinitionV4(sourceDefinition, {
      hasObservedStudentValue: sheet.students.some(
        (student) => noteForSlot(student, sourceDefinition.sourceSlot) !== null,
      ),
    });
    if (resolution.state === 'insufficient-data') {
      blockedDefinitions.push({
        stableKey,
        sourceDefinition,
        resolution,
        gradeEntriesMaterialized: 0,
      });
      continue;
    }

    const component: AssessmentComponentV3 = {
      id: (await opaqueId('assessment-component:v2', stableKey)) as AssessmentComponentId,
      academicYearId: context.academicYearId,
      teachingAssignmentId: context.teachingAssignmentId,
      term: context.term,
      type: resolution.kind,
      name: resolution.name,
      maximum: resolution.maximum,
      order: componentOrder(sourceDefinition),
      applicability: resolution.applicability,
    };
    components.push({ stableKey, sourceDefinition, value: component });

    for (const [row, studentResolution] of resolutionsByRow) {
      const student = studentsByRow.get(row);
      if (!student) continue;
      const entry = await gradeEntry(
        component,
        sourceDefinition,
        sheet,
        student,
        studentResolution,
      );
      if (entry) gradeEntries.push(entry);
    }
  }

  components.sort(
    (left, right) =>
      left.value.order - right.value.order || left.value.id.localeCompare(right.value.id),
  );
  gradeEntries.sort(
    (left, right) =>
      left.assessmentComponentId.localeCompare(right.assessmentComponentId) ||
      left.studentId.localeCompare(right.studentId),
  );
  blockedDefinitions.sort((left, right) => left.stableKey.localeCompare(right.stableKey));
  return { components, gradeEntries, blockedDefinitions };
}
