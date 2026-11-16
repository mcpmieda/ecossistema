import {
  adminReadResponseV2,
  type AdminReadQueryV2,
} from '../../../shared/student-portal-contracts/admin-read-v2';
import { SHIFTS_V1 } from '../../../shared/student-portal-contracts/core-v1';
import { POLICY_FIELDS_V1 } from '../../../shared/student-portal-contracts/policy-v1';
import type { StudentPortalPostgresQueryV1 } from '../persistence/postgres-persistence-v1';

/**
 * Turnos: the shifts that have classes this year, from the Relação
 * (INICIO!I7:I28 → gradebook.turma.turno), each with the options it sets itself and its classes with
 * the options they set themselves. A shift with no class (Noturno this year) is not listed, so the
 * panel never offers it. Read-only, inside the admin dispatcher's repeatable-read transaction.
 */
export async function readShiftsV1(
  tx: StudentPortalPostgresQueryV1,
  query: AdminReadQueryV2,
  requestId: string,
  now: Date,
) {
  if (query.scope.kind !== 'school') throw new Error('student-portal-shifts-invalid-request');
  const rows = await tx.unsafe(
    `WITH classes AS (
      SELECT c.class_id,c.shift,COALESCE(NULLIF(c.class_code,''),c.class_name) AS label
      FROM student_portal.academic_class_v1 c WHERE c.academic_year=2026 AND c.shift IS NOT NULL
    ), own AS (
      SELECT st.scope_key,st.field_key FROM student_portal.setting st
      WHERE st.academic_year=2026 AND st.scope_kind IN ('class','shift')
        AND st.source_scope_json->>'kind'=st.scope_kind
    ) SELECT cl.shift,cl.class_id,cl.label,
      COALESCE((SELECT jsonb_agg(o.field_key ORDER BY o.field_key) FROM own o
        WHERE o.scope_key='class:2026:'||cl.class_id::text),'[]'::jsonb) AS class_fields,
      COALESCE((SELECT jsonb_agg(o.field_key ORDER BY o.field_key) FROM own o
        WHERE o.scope_key='shift:2026:'||cl.shift),'[]'::jsonb) AS shift_fields
    FROM classes cl ORDER BY cl.label COLLATE "C",cl.class_id`,
  );
  const known = (fields: unknown) =>
    (Array.isArray(fields) ? fields : []).filter((field): field is (typeof POLICY_FIELDS_V1)[number] =>
      (POLICY_FIELDS_V1 as readonly unknown[]).includes(field),
    );
  const items = SHIFTS_V1.map((shift) => {
    const mine = rows.filter((row) => row.shift === shift);
    return {
      shift,
      ownFields: mine.length ? known(mine[0]!.shift_fields) : [],
      classes: mine.map((row) => ({
        classId: Number(row.class_id),
        label: String(row.label).slice(0, 80),
        ownFields: known(row.class_fields),
      })),
    };
  }).filter((item) => item.classes.length > 0);
  return adminReadResponseV2.parse({
    contractVersion: 2,
    state: 'shifts-read',
    requestId,
    observedAt: now.toISOString(),
    items,
  });
}
