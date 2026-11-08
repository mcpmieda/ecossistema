// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type {
  AcademicYearId,
  ClassGroupId,
  EnrollmentId,
  StudentId,
  SubjectId,
  TeacherId,
  TeachingAssignmentId,
  TeachingAssignmentV1,
} from '../../../shared/gradebook-contracts/entities';
import { ACADEMIC_RESULT_STATES_V1, AUTHORITY_MODES_V1, GRADE_VALUE_STATES_V1, type AcademicGradeValueV1, type AnnualResultId, type AnnualResultV1, type ApplicabilityV1, type AssessmentComponentId, type AssessmentComponentV1, type ComparedApplicabilityV1, type ComparedGradeValueV1, type FinalRecoveryId, type FinalRecoveryV1, type GradeEntryId, type GradeEntryV1, type ResultCoverageV1, type TermResultId, type TermResultV1 } from '../../../shared/gradebook-contracts/results/results-contract-v1';
import type { SourceCellEvidenceV1 } from '../../../shared/gradebook-contracts/source/source-contract-v1';

const academicYearId = 'academic-year:2026' as AcademicYearId;
const teacherId = 'teacher:synthetic' as TeacherId;
const classGroupId = 'class:2026:6A' as ClassGroupId;
const subjectId = 'subject:synthetic' as SubjectId;
const assignmentId = 'assignment:2026:synthetic' as TeachingAssignmentId;
const studentId = 'student:synthetic' as StudentId;
const enrollmentId = 'enrollment:2026:synthetic' as EnrollmentId;

const assignment = {
  id: assignmentId,
  academicYearId,
  teacherId,
  classGroupId,
  subjectId,
  sourceDisciplineIndex: 'D2',
  effectivePeriod: { startsOn: '2026-02-01' },
  confirmationOrigin: 'imported-source',
} satisfies TeachingAssignmentV1;

const component = {
  id: 'component:2026:t1:written' as AssessmentComponentId,
  academicYearId,
  teachingAssignmentId: assignment.id,
  term: 1,
  type: 'written',
  name: 'Avaliação sintética',
  maximum: 10,
  order: 1,
  applicability: { state: 'applicable' },
} satisfies AssessmentComponentV1;

function provenance(cellAddress: string) {
  return {
    fileName: 'synthetic-gradebook.xlsx',
    fileSha256: 'synthetic-sha256',
    sheetName: '6A1ºD2',
    cellAddress,
  };
}

const numericEvidence = {
  provenance: provenance('R10'),
  classification: 'manual-positive-number',
  rawValue: 6,
} satisfies SourceCellEvidenceV1;

const officialZeroEvidence = {
  provenance: provenance('S10'),
  classification: 'manual-official-zero-marker',
  rawValue: 0.1,
} satisfies SourceCellEvidenceV1;

const legacyZeroEvidence = {
  provenance: provenance('T10'),
  classification: 'manual-legacy-zero',
  rawValue: 0,
} satisfies SourceCellEvidenceV1;

const emptyEvidence = {
  provenance: provenance('AM10'),
  classification: 'empty',
  rawValue: '',
} satisfies SourceCellEvidenceV1;

const notApplicableEvidence = {
  provenance: provenance('AA10'),
  classification: 'not-applicable',
  rawValue: '*',
} satisfies SourceCellEvidenceV1;

const insufficientEvidence = {
  provenance: provenance('AN10'),
  classification: 'formula-error-or-missing-cache',
  rawValue: null,
  formula: '=SUM(R10:T10)',
  cachedValue: null,
  sourceError: '#VALUE!',
} satisfies SourceCellEvidenceV1;

function comparedGrade(
  imported: AcademicGradeValueV1,
  evidence: SourceCellEvidenceV1,
  calculated: AcademicGradeValueV1,
): ComparedGradeValueV1 {
  return {
    imported: { value: imported, evidence: [evidence] },
    calculated: { value: calculated },
  };
}

function comparedApplicability(
  imported: ApplicabilityV1,
  evidence: SourceCellEvidenceV1,
  calculated: ApplicabilityV1,
): ComparedApplicabilityV1 {
  return {
    imported: { value: imported, evidence: [evidence] },
    calculated,
  };
}

const completeCoverage = {
  state: 'complete',
  expectedItemCount: 4,
  resolvedItemCount: 4,
  missingItemCount: 0,
  reasons: [],
} satisfies ResultCoverageV1;

describe('academic result contracts v1', () => {
  it('keeps absence, zero variants, non-applicability and insufficient data distinct', () => {
    const values = [
      { state: 'absent' },
      { state: 'official-zero', value: 0, sourceMarker: 0.1 },
      { state: 'legacy-zero', value: 0 },
      { state: 'not-applicable', reason: 'synthetic-marker' },
      { state: 'insufficient-data', reason: 'missing-formula-cache' },
    ] satisfies readonly AcademicGradeValueV1[];

    expect(values.map((value) => value.state)).toEqual([
      'absent',
      'official-zero',
      'legacy-zero',
      'not-applicable',
      'insufficient-data',
    ]);
    expect(values[1]?.value).toBe(0);
    expect(values[2]?.value).toBe(0);
    expect(values[1]?.state).not.toBe(values[2]?.state);
  });

  it('connects integrated entity ids and source evidence without losing either authority value', () => {
    const importedAuthorityEntry = {
      id: 'grade-entry:2026:synthetic:1' as GradeEntryId,
      academicYearId,
      studentId,
      enrollmentId,
      assessmentComponentId: component.id,
      value: comparedGrade(
        { state: 'official-zero', value: 0, sourceMarker: 0.1 },
        officialZeroEvidence,
        { state: 'numeric', value: 0 },
      ),
      authorityMode: 'imported-source',
      ruleVersion: '2026.1',
      version: 1,
    } satisfies GradeEntryV1;

    const engineAuthorityEntry = {
      ...importedAuthorityEntry,
      id: 'grade-entry:2026:synthetic:2' as GradeEntryId,
      authorityMode: 'native-engine',
      version: 2,
      supersedesGradeEntryId: importedAuthorityEntry.id,
    } satisfies GradeEntryV1;

    expect(component.teachingAssignmentId).toBe(assignment.id);
    expect(importedAuthorityEntry.enrollmentId).toBe(enrollmentId);
    expect(importedAuthorityEntry.value.imported.evidence[0]).toBe(officialZeroEvidence);
    expect(importedAuthorityEntry.value.calculated.value).toEqual({ state: 'numeric', value: 0 });
    expect(engineAuthorityEntry.value.imported.value.state).toBe('official-zero');
    expect(engineAuthorityEntry.value.calculated.value.state).toBe('numeric');
  });

  it('represents term composition, coverage and rule version without calculating them', () => {
    const termResult = {
      id: 'term-result:2026:synthetic:t1' as TermResultId,
      academicYearId,
      studentId,
      enrollmentId,
      teachingAssignmentId: assignment.id,
      term: 1,
      maximum: 30,
      quantitative: {
        original: comparedGrade(
          { state: 'numeric', value: 16 },
          numericEvidence,
          { state: 'numeric', value: 16 },
        ),
        parallelRecovery: comparedGrade(
          { state: 'absent' },
          emptyEvidence,
          { state: 'absent' },
        ),
        parallelRecoveryApplicability: comparedApplicability(
          { state: 'not-applicable', reason: 'threshold-not-met' },
          notApplicableEvidence,
          { state: 'not-applicable', reason: 'threshold-not-met' },
        ),
        considered: comparedGrade(
          { state: 'numeric', value: 16 },
          numericEvidence,
          { state: 'numeric', value: 16 },
        ),
      },
      qualitativeOperational: comparedGrade(
        { state: 'legacy-zero', value: 0 },
        legacyZeroEvidence,
        { state: 'numeric', value: 0 },
      ),
      officialGrade: comparedGrade(
        { state: 'numeric', value: 16 },
        numericEvidence,
        { state: 'numeric', value: 16 },
      ),
      percentage: comparedGrade(
        { state: 'numeric', value: 53.33 },
        numericEvidence,
        { state: 'numeric', value: 53.33 },
      ),
      authorityMode: 'imported-source',
      coverage: completeCoverage,
      ruleVersion: '2026.1',
    } satisfies TermResultV1;

    expect(termResult.quantitative.original.imported.value).toEqual({ state: 'numeric', value: 16 });
    expect(termResult.quantitative.considered.calculated.value).toEqual({
      state: 'numeric',
      value: 16,
    });
    expect(termResult.coverage.state).toBe('complete');
    expect(termResult.ruleVersion).toBe('2026.1');
  });

  it('preserves original grade, recovery applicability and replacement as separate values', () => {
    const recovery = {
      id: 'final-recovery:2026:synthetic:t1' as FinalRecoveryId,
      academicYearId,
      studentId,
      enrollmentId,
      teachingAssignmentId: assignment.id,
      recoveredTerm: 1,
      originalTermGrade: comparedGrade(
        { state: 'numeric', value: 50 },
        numericEvidence,
        { state: 'numeric', value: 50 },
      ),
      applicability: comparedApplicability(
        { state: 'applicable' },
        numericEvidence,
        { state: 'applicable' },
      ),
      recoveryGrade: comparedGrade(
        { state: 'numeric', value: 60 },
        numericEvidence,
        { state: 'numeric', value: 60 },
      ),
      replacementTermGrade: {
        imported: {
          value: { state: 'numeric', value: 60 },
          evidence: [numericEvidence, officialZeroEvidence],
        },
        calculated: { value: { state: 'numeric', value: 60 } },
      },
      authorityMode: 'native-engine',
      coverage: completeCoverage,
      ruleVersion: '2026.1',
    } satisfies FinalRecoveryV1;

    expect(recovery.originalTermGrade.calculated.value).toEqual({ state: 'numeric', value: 50 });
    expect(recovery.applicability.imported.value.state).toBe('applicable');
    expect(recovery.recoveryGrade.calculated.value).toEqual({ state: 'numeric', value: 60 });
    expect(recovery.replacementTermGrade.calculated.value).toEqual({
      state: 'numeric',
      value: 60,
    });
    expect(recovery.originalTermGrade).not.toBe(recovery.replacementTermGrade);
  });

  it('separates annual totals, academic state and final decision', () => {
    const annualResult = {
      id: 'annual-result:2026:synthetic' as AnnualResultId,
      academicYearId,
      studentId,
      enrollmentId,
      teachingAssignmentId: assignment.id,
      originalTotal: comparedGrade(
        { state: 'numeric', value: 55 },
        numericEvidence,
        { state: 'numeric', value: 55 },
      ),
      postRecoveryTotal: comparedGrade(
        { state: 'numeric', value: 58 },
        numericEvidence,
        { state: 'numeric', value: 58 },
      ),
      academicState: {
        imported: 'eligible-for-council',
        calculated: 'eligible-for-council',
      },
      finalDecision: {
        status: 'recorded',
        outcome: 'approved',
        basis: 'class-council',
        resultingState: 'approved-by-council',
        reference: 'synthetic-decision:001',
      },
      authorityMode: 'native-engine',
      coverage: {
        state: 'partial',
        expectedItemCount: 3,
        resolvedItemCount: 2,
        missingItemCount: 1,
        reasons: ['synthetic-missing-term'],
      },
      ruleVersion: '2026.1',
    } satisfies AnnualResultV1;

    expect(annualResult.originalTotal.calculated.value).toEqual({ state: 'numeric', value: 55 });
    expect(annualResult.postRecoveryTotal.calculated.value).toEqual({
      state: 'numeric',
      value: 58,
    });
    expect(annualResult.academicState.calculated).toBe('eligible-for-council');
    expect(annualResult.finalDecision).toMatchObject({
      status: 'recorded',
      outcome: 'approved',
      resultingState: 'approved-by-council',
    });
    expect(annualResult.postRecoveryTotal.imported.evidence[0]).toBe(numericEvidence);
  });
});
