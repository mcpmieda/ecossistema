// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type {
  AcademicYearId,
  AcademicYearV1,
  ClassGroupId,
  ClassGroupV1,
  EnrollmentId,
  EnrollmentV1,
  SchoolId,
  StudentId,
  StudentStatusEventId,
  StudentStatusEventV1,
  StudentV1,
  SubjectId,
  TeacherId,
  TeachingAssignmentId,
  TeachingAssignmentV1,
} from '../../../shared/gradebook-contracts/entities';

const academicYearId = 'academic-year:2026' as AcademicYearId;
const schoolId = 'school:main' as SchoolId;
const class6AId = 'class:2026:6A' as ClassGroupId;
const class6BId = 'class:2026:6B' as ClassGroupId;
const teacherId = 'teacher:001' as TeacherId;
const subjectId = 'subject:mat' as SubjectId;
const studentId = 'student:001' as StudentId;

const academicYear = {
  id: academicYearId,
  schoolId,
  year: 2026,
  status: 'active',
  activeEvaluationProfileId: 'evaluation-profile:2026',
  configurationVersion: '1',
} satisfies AcademicYearV1;

const class6A = {
  id: class6AId,
  academicYearId,
  code: '6A',
  grade: '6',
  section: 'A',
} satisfies ClassGroupV1;

const class6B = {
  id: class6BId,
  academicYearId,
  code: '6B',
  grade: '6',
  section: 'B',
} satisfies ClassGroupV1;

describe('academic entity contracts v1', () => {
  it('keeps the academic year explicit on annual entities', () => {
    const assignment = {
      id: 'assignment:2026:001' as TeachingAssignmentId,
      academicYearId,
      teacherId,
      classGroupId: class6A.id,
      subjectId,
      sourceDisciplineIndex: 'D2',
      effectivePeriod: { startsOn: '2026-02-01', endsOn: '2026-12-18' },
      confirmationOrigin: 'imported-source',
    } satisfies TeachingAssignmentV1;

    const enrollment = {
      id: 'enrollment:2026:001' as EnrollmentId,
      academicYearId,
      studentId,
      classGroupId: class6A.id,
      effectivePeriod: { startsOn: '2026-02-01' },
      position: 'current',
      sourcePosition: 12,
    } satisfies EnrollmentV1;

    const statusEvent = {
      id: 'student-status:2026:001' as StudentStatusEventId,
      academicYearId,
      enrollmentId: enrollment.id,
      status: 'active',
      sourceText: 'ATIVO',
    } satisfies StudentStatusEventV1;

    expect(academicYear.year).toBe(2026);
    expect(class6A.academicYearId).toBe(academicYear.id);
    expect(assignment.academicYearId).toBe(academicYear.id);
    expect(enrollment.academicYearId).toBe(academicYear.id);
    expect(statusEvent.academicYearId).toBe(academicYear.id);
  });

  it('models teacher, subject, class and assignment as separate identities', () => {
    const assignment = {
      id: 'assignment:2026:math:6A' as TeachingAssignmentId,
      academicYearId,
      teacherId,
      classGroupId: class6A.id,
      subjectId,
      sourceDisciplineIndex: 'D1',
      effectivePeriod: { startsOn: '2026-02-01' },
      confirmationOrigin: 'user-confirmed',
    } satisfies TeachingAssignmentV1;

    expect(assignment).toMatchObject({
      academicYearId,
      teacherId,
      classGroupId: class6AId,
      subjectId,
      sourceDisciplineIndex: 'D1',
    });
    expect(
      new Set([assignment.teacherId, assignment.classGroupId, assignment.subjectId]).size,
    ).toBe(3);
  });

  it('preserves a transfer trajectory without recreating the student', () => {
    const previousEnrollment = {
      id: 'enrollment:2026:6A:001' as EnrollmentId,
      academicYearId,
      studentId,
      classGroupId: class6A.id,
      effectivePeriod: { startsOn: '2026-02-01', endsOn: '2026-05-10' },
      position: 'historical',
      sourcePosition: 8,
    } satisfies EnrollmentV1;

    const currentEnrollment = {
      id: 'enrollment:2026:6B:001' as EnrollmentId,
      academicYearId,
      studentId,
      classGroupId: class6B.id,
      effectivePeriod: { startsOn: '2026-05-11' },
      position: 'current',
      sourcePosition: 4,
    } satisfies EnrollmentV1;

    const outgoing = {
      id: 'student-status:2026:outgoing' as StudentStatusEventId,
      academicYearId,
      enrollmentId: previousEnrollment.id,
      status: 'transferred',
      sourceText: 'FOI PARA 6B',
      transfer: { destinationClassGroupCode: class6B.code },
    } satisfies StudentStatusEventV1;

    const incoming = {
      id: 'student-status:2026:incoming' as StudentStatusEventId,
      academicYearId,
      enrollmentId: currentEnrollment.id,
      status: 'active',
      sourceText: 'ESTAVA NO 6A',
      transfer: { originClassGroupCode: class6A.code },
    } satisfies StudentStatusEventV1;

    expect(previousEnrollment.studentId).toBe(currentEnrollment.studentId);
    expect(previousEnrollment.id).not.toBe(currentEnrollment.id);
    expect(previousEnrollment.position).toBe('historical');
    expect(currentEnrollment.position).toBe('current');
    expect(outgoing.sourceText).toBe('FOI PARA 6B');
    expect(outgoing.transfer?.destinationClassGroupCode).toBe('6B');
    expect(incoming.sourceText).toBe('ESTAVA NO 6A');
    expect(incoming.transfer?.originClassGroupCode).toBe('6A');
  });

  it('keeps names and source identity marks separate from the technical student id', () => {
    const firstStudent = {
      id: 'student:homonym:001' as StudentId,
      displayName: 'Aluno Exemplo',
      sourceNames: ['Aluno Exemplo'],
      sourceIdentityMarks: ['initial-position:3', 'mark:A'],
    } satisfies StudentV1;

    const secondStudent = {
      id: 'student:homonym:002' as StudentId,
      displayName: 'Aluno Exemplo',
      sourceNames: ['Aluno Exemplo'],
      sourceIdentityMarks: ['initial-position:17', 'mark:B'],
    } satisfies StudentV1;

    expect(firstStudent.id).not.toBe(secondStudent.id);
    expect(firstStudent.displayName).toBe(secondStudent.displayName);
    expect(firstStudent.sourceNames).toEqual(secondStudent.sourceNames);
    expect(firstStudent.sourceIdentityMarks).not.toEqual(secondStudent.sourceIdentityMarks);
    expect(firstStudent).not.toHaveProperty('cpf');
    expect(firstStudent).not.toHaveProperty('inep');
  });
});
