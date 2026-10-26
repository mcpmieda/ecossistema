import type {
  AcademicYearId,
  EnrollmentId,
  StudentId,
  TeachingAssignmentId,
} from '../../../../shared/gradebook-contracts/entities';
import {
  assessmentComponentSourceStableKeyV2,
  type AssessmentComponentSourceStableKeyV2,
  type AssessmentComponentV2,
} from '../../../../shared/gradebook-contracts/results/results-contract-v2';
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
  resolveSourceAssessmentDefinitionV2,
  type SourceAssessmentDefinitionResolutionV2,
  type SourceAssessmentDefinitionV2,
  type SourceAssessmentSlotV2,
  type SourceQualitativeActivitySlotV2,
  type SourceQuantitativeAssessmentSlotV2,
} from '../../../../shared/gradebook-contracts/source/source-contract-v2';
import type { SourceCellEvidenceV1 } from '../../../../shared/gradebook-contracts/source/source-contract-v1';
import type {
  GradeSheetRecognition,
  NoteValue,
  StudentRecognition,
} from './spreadsheet-recognizer';

export const ASSESSMENT_IMPORT_RULE_VERSION_V2 = 'source-contract-v2-assessment-entry-v1' as const;

export interface AssessmentImportStudentResolutionV2 {
  readonly row: number;
  readonly studentId: StudentId;
  readonly enrollmentId: EnrollmentId;
}

export interface AssessmentDefinitionMaterializationContextV2 {
  readonly logicalSourceReference: string;
  readonly academicYearId: AcademicYearId;
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly term: AcademicTermV1;
  readonly students: readonly AssessmentImportStudentResolutionV2[];
}

export interface MaterializedAssessmentComponentV2 {
  readonly stableKey: AssessmentComponentSourceStableKeyV2;
  readonly sourceDefinition: SourceAssessmentDefinitionV2;
  readonly value: AssessmentComponentV2;
}

export interface BlockedAssessmentDefinitionV2 {
  readonly stableKey: AssessmentComponentSourceStableKeyV2;
  readonly sourceDefinition: SourceAssessmentDefinitionV2;
  readonly resolution: Extract<
    SourceAssessmentDefinitionResolutionV2,
    { readonly state: 'insufficient-data' }
  >;
  readonly gradeEntriesMaterialized: 0;
}

export interface AssessmentDefinitionMaterializationV2 {
  readonly components: readonly MaterializedAssessmentComponentV2[];
  readonly gradeEntries: readonly GradeEntryV1[];
  readonly blockedDefinitions: readonly BlockedAssessmentDefinitionV2[];
}

function requireContext(context: AssessmentDefinitionMaterializationContextV2): void {
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
  switch (stage) {
    case 'trimester-1':
      return 1;
    case 'trimester-2':
      return 2;
    case 'trimester-3':
      return 3;
    case 'overview':
    case 'recovery':
      return null;
  }
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
  switch (note.kind) {
    case 'official-zero':
      return { state: 'official-zero', value: 0, sourceMarker: 0.1 };
    case 'legacy-zero':
      return { state: 'legacy-zero', value: 0 };
    case 'manual':
    case 'formula':
    case 'negative':
      return { state: 'numeric', value: note.value };
  }
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
  switch (note.kind) {
    case 'official-zero':
      return { classification: 'manual-official-zero-marker', rawValue: 0.1, provenance };
    case 'legacy-zero':
      return { classification: 'manual-legacy-zero', rawValue: 0, provenance };
    case 'negative':
      return { classification: 'manual-negative-number', rawValue: note.source, provenance };
    case 'manual':
      return { classification: 'manual-positive-number', rawValue: note.source, provenance };
    case 'formula':
      return {
        classification: 'formula-nonzero',
        rawValue: note.source,
        formula: note.formula ?? '',
        cachedValue: note.value,
        provenance,
      };
  }
}

function fileProvenance(definition: SourceAssessmentDefinitionV2): {
  readonly fileName: string;
  readonly fileSha256: string;
} {
  const provenance = definition.maximumConfiguration.provenance;
  return { fileName: provenance.fileName, fileSha256: provenance.fileSha256 };
}

async function gradeEntry(
  component: AssessmentComponentV2,
  definition: SourceAssessmentDefinitionV2,
  sheet: GradeSheetRecognition,
  student: StudentRecognition,
  resolution: AssessmentImportStudentResolutionV2,
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
    ruleVersion: ASSESSMENT_IMPORT_RULE_VERSION_V2,
    version: 1,
  };
}

export async function materializeAssessmentDefinitionsV2(
  sheet: GradeSheetRecognition,
  context: AssessmentDefinitionMaterializationContextV2,
): Promise<AssessmentDefinitionMaterializationV2> {
  requireContext(context);
  if (termForStage(sheet.stage) !== context.term) {
    throw new TypeError('assessment-materialization-term-mismatch');
  }

  const studentsByRow = new Map(sheet.students.map((student) => [student.row, student]));
  const resolutionsByRow = new Map(context.students.map((student) => [student.row, student]));
  const components: MaterializedAssessmentComponentV2[] = [];
  const blockedDefinitions: BlockedAssessmentDefinitionV2[] = [];
  const gradeEntries: GradeEntryV1[] = [];

  for (const sourceDefinition of sheet.assessmentDefinitions) {
    const identity = {
      logicalSourceReference: context.logicalSourceReference,
      academicYearId: context.academicYearId,
      teachingAssignmentId: context.teachingAssignmentId,
      term: context.term,
      sourceSlot: sourceDefinition.sourceSlot,
    } as const;
    const stableKey = assessmentComponentSourceStableKeyV2(identity);
    const resolution = resolveSourceAssessmentDefinitionV2(sourceDefinition);
    if (resolution.state === 'insufficient-data') {
      blockedDefinitions.push({
        stableKey,
        sourceDefinition,
        resolution,
        gradeEntriesMaterialized: 0,
      });
      continue;
    }

    const component: AssessmentComponentV2 = {
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
