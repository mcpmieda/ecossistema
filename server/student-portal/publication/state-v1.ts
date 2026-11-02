import { createHash } from 'node:crypto';
import { z } from 'zod';
import { scopeV1, versionV1, type ScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import { academicVersionSchemaV1 } from '../../../shared/gradebook-contracts/student-portal/academic-revision-v1';
import type { StudentPortalPostgresQueryV1 } from '../persistence/postgres-persistence-v1';

/** The query's one parameter: the account or the class; the whole school has none. */
function scopeParametersV1(scope: { kind: string; accountId?: unknown; classId?: unknown }) {
  if (scope.kind === 'account') return [scope.accountId];
  return scope.kind === 'class' ? [scope.classId] : [];
}

export const PERIODS_V1 = ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'] as const;
export const publicationDigestV1 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function currentRevisionV1(tx: StudentPortalPostgresQueryV1): Promise<string> {
  const rows = await tx.unsafe("SELECT academic_generation||':'||academic_counter::text AS revision FROM student_portal.academic_revision WHERE academic_year=2026");
  if (rows.length !== 1) throw new Error('student-portal-publication-unavailable');
  return academicVersionSchemaV1.parse(rows[0]!.revision);
}
export async function publicationScopeVersionV1(tx: StudentPortalPostgresQueryV1): Promise<number> {
  // Monotonic across roster changes: never sum only the members of a changing class.
  const rows = await tx.unsafe(`SELECT (r.academic_counter+r.portal_link_counter+
    COALESCE((SELECT sum(version) FROM student_portal.account WHERE academic_year=2026),0)+
    COALESCE((SELECT sum(version) FROM student_portal.publication WHERE academic_year=2026),0)+
    COALESCE((SELECT max(version) FROM student_portal.setting WHERE scope_key='school:2026'),0))::text AS version
    FROM student_portal.academic_revision r WHERE r.academic_year=2026`);
  if (rows.length !== 1) throw new Error('student-portal-publication-unavailable');
  return versionV1.parse(Number(rows[0]!.version));
}
export async function publicationAccountsV1(tx: StudentPortalPostgresQueryV1, input: ScopeV1) {
  const scope = scopeV1.parse(input);
  let predicate: 'a.id=$1::uuid' | 'b.class_id=$1' | 'true';
  if (scope.kind === 'account') {
    predicate = 'a.id=$1::uuid';
  } else if (scope.kind === 'class') {
    predicate = 'b.class_id=$1';
  } else {
    predicate = 'true';
  }
  const rows = await tx.unsafe(`SELECT a.id,a.version::text AS version,b.class_id
    FROM student_portal.account a JOIN LATERAL (SELECT min(class_id) AS class_id,count(*)::integer AS matches,
      bool_and(status IS NULL OR status IN (1,2,7)) AS eligible FROM student_portal.academic_binding_v1
      WHERE student_id=a.gradebook_student_id AND academic_year=2026 AND status IS DISTINCT FROM 6) b ON b.matches=1 AND b.eligible
    WHERE a.academic_year=2026 AND a.closed_at IS NULL AND ${predicate} ORDER BY a.id LIMIT 1001`,
  scopeParametersV1(scope));
  if (rows.length > 1000) throw new Error('student-portal-publication-scope-too-large');
  return rows.map((row) => ({ id: z.uuid().parse(row.id), version: versionV1.parse(Number(row.version)), classId: z.number().int().positive().parse(row.class_id) }));
}
/** Exact per-period provenance within the V1 128-character revision bound; no hidden academic values. */
export function dataVectorV1(revisions: readonly (string | null)[]): string {
  if (revisions.length !== 6) throw new Error('student-portal-publication-vector-invalid');
  const generations = new Set(revisions.filter((value) => value !== null).map((value) => academicVersionSchemaV1.parse(value).split(':')[0]));
  if (generations.size > 1) throw new Error('student-portal-publication-generation-conflict');
  const generation = [...generations][0] ?? '0'.repeat(32);
  const value = `data:${generation}:${revisions.map((revision) => revision === null ? '0' : BigInt(revision.split(':')[1]!).toString(36)).join('_')}`;
  if (value.length > 128) throw new Error('student-portal-publication-vector-invalid');
  return value;
}
