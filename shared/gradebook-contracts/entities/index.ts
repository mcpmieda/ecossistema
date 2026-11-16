declare const entityIdBrand: unique symbol;

/** Opaque technical identifier owned by the Banco de Notas domain. */
export type EntityIdV1<EntityName extends string> = string & {
  readonly [entityIdBrand]: EntityName;
};

export type AcademicYearId = EntityIdV1<'AcademicYearV1'>;
export type SchoolId = EntityIdV1<'School'>;
export type TeacherId = EntityIdV1<'TeacherV1'>;
export type ClassGroupId = EntityIdV1<'ClassGroupV1'>;
export type SubjectId = EntityIdV1<'SubjectV1'>;
export type TeachingAssignmentId = EntityIdV1<'TeachingAssignmentV1'>;
export type StudentId = EntityIdV1<'StudentV1'>;
export type EnrollmentId = EntityIdV1<'EnrollmentV1'>;
export type StudentStatusEventId = EntityIdV1<'StudentStatusEventV1'>;
export type AssessmentComponentId = EntityIdV1<'AssessmentComponentV1'>;
export type GradeEntryId = EntityIdV1<'GradeEntryV1'>;
export type TermResultId = EntityIdV1<'TermResultV1'>;
export type FinalRecoveryId = EntityIdV1<'FinalRecoveryV1'>;
export type AnnualResultId = EntityIdV1<'AnnualResultV1'>;

export type AcademicYearStatusV1 = 'planned' | 'active' | 'closed';
export type EntityLifecycleStatusV1 = 'active' | 'inactive';
export type EnrollmentPositionV1 = 'current' | 'historical';
export type StudentStatusV1 = 'active' | 'transferred' | 'withdrawn' | 'deceased' | 'other';
export type TeachingAssignmentConfirmationOriginV1 =
  | 'imported-source'
  | 'user-confirmed'
  | 'administrative';

export interface EffectivePeriodV1 {
  readonly startsOn?: string;
  readonly endsOn?: string;
}

export interface AcademicYearV1 {
  readonly id: AcademicYearId;
  readonly schoolId: SchoolId;
  readonly year: number;
  readonly status: AcademicYearStatusV1;
  readonly startsOn?: string;
  readonly endsOn?: string;
  readonly activeEvaluationProfileId: string;
  readonly configurationVersion: string;
}

export interface TeacherV1 {
  readonly id: TeacherId;
  readonly displayName: string;
  readonly sourceNames: readonly string[];
  readonly status: EntityLifecycleStatusV1;
}

export interface ClassGroupV1 {
  readonly id: ClassGroupId;
  readonly academicYearId: AcademicYearId;
  readonly code: string;
  readonly grade: string;
  readonly section: string;
  readonly shift?: string;
}

export interface SubjectV1 {
  readonly id: SubjectId;
  readonly code: string;
  readonly displayName: string;
  readonly shortName: string;
  readonly status: EntityLifecycleStatusV1;
}

export interface TeachingAssignmentV1 {
  readonly id: TeachingAssignmentId;
  readonly academicYearId: AcademicYearId;
  readonly teacherId: TeacherId;
  readonly classGroupId: ClassGroupId;
  readonly subjectId: SubjectId;
  readonly sourceDisciplineIndex?: string;
  readonly effectivePeriod: EffectivePeriodV1;
  readonly confirmationOrigin: TeachingAssignmentConfirmationOriginV1;
}

export interface StudentV1 {
  readonly id: StudentId;
  readonly displayName: string;
  readonly sourceNames: readonly string[];
  readonly sourceIdentityMarks?: readonly string[];
}

export interface EnrollmentV1 {
  readonly id: EnrollmentId;
  readonly academicYearId: AcademicYearId;
  readonly studentId: StudentId;
  readonly classGroupId: ClassGroupId;
  readonly effectivePeriod: EffectivePeriodV1;
  readonly position: EnrollmentPositionV1;
  readonly sourcePosition?: number;
}

export interface StudentTransferContextV1 {
  readonly originClassGroupCode?: string;
  readonly destinationClassGroupCode?: string;
}

export interface StudentStatusEventV1 {
  readonly id: StudentStatusEventId;
  readonly academicYearId: AcademicYearId;
  readonly enrollmentId: EnrollmentId;
  readonly status: StudentStatusV1;
  readonly sourceText: string;
  readonly occurredOn?: string;
  readonly sourceReference?: string;
  readonly importBatchId?: string;
  readonly transfer?: StudentTransferContextV1;
}
