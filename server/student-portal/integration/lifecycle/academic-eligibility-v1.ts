import { z } from 'zod';
import {
  academicVersionSchemaV1,
  portalAcademicLinkSchemaV1,
  type PortalAcademicLinkV1,
} from '../../../../shared/gradebook-contracts/student-portal/academic-revision-v1';
import {
  academicBindingSchemaV1,
  resolveEligibilityV1,
  type AcademicEligibilityReaderV1,
  type EligibilityV1,
} from '../../../../shared/gradebook-contracts/student-portal/eligibility-v1';
import type { AcademicEligibilityPortV1 } from '../../../../shared/student-portal-contracts/ports-v1';
import type { StudentPortalPostgresQueryV1 } from '../../persistence/postgres-persistence-v1';

const academicBindingsSchemaV1 = z.array(academicBindingSchemaV1);

/** One statement keeps the revision and bindings in the same READ COMMITTED snapshot. */
export class AcademicEligibilityReaderPostgresV1
  implements AcademicEligibilityReaderV1<StudentPortalPostgresQueryV1>, AcademicEligibilityPortV1
{
  constructor(private readonly sql: StudentPortalPostgresQueryV1) {}

  async readInTransaction(
    tx: StudentPortalPostgresQueryV1,
    link: PortalAcademicLinkV1,
  ): Promise<EligibilityV1> {
    portalAcademicLinkSchemaV1.parse(link);
    const rows = await tx.unsafe(
      `SELECT r.academic_generation || ':' || r.academic_counter::text AS data_version,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'academicYear',b.academic_year,'studentId',b.student_id,
                  'classId',b.class_id,'status',b.status))
                  FROM student_portal.academic_binding_v1 b
                  JOIN student_portal.academic_student_v1 s
                    ON s.academic_year=b.academic_year AND s.student_id=b.student_id
                 WHERE b.academic_year=r.academic_year AND b.student_id=$2
              ),'[]'::jsonb) AS bindings
         FROM student_portal.academic_revision r WHERE r.academic_year=$1`,
      [link.academicYear, link.studentId],
    );
    if (rows.length !== 1) throw new Error('student-portal-academic-revision-unavailable');
    const row = rows[0]!;
    const version = academicVersionSchemaV1.parse(row.data_version);
    const bindings = academicBindingsSchemaV1.parse(row.bindings);
    return resolveEligibilityV1(link, version, bindings);
  }

  async readCurrent(link: PortalAcademicLinkV1) {
    const current = await this.readInTransaction(this.sql, link);
    return {
      state: current.state,
      classId: current.current?.classId ?? null,
      dataVersion: current.dataVersion,
    };
  }
}
