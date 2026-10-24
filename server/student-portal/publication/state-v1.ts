import { createHash } from 'node:crypto';
import { z } from 'zod';
import { periodV1, scopeV1, versionV1, type ScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import { academicVersionSchemaV1 } from '../../../shared/gradebook-contracts/student-portal/academic-revision-v1';
import type { StudentPortalPostgresQueryV1 } from '../persistence/postgres-persistence-v1';

export const PERIODS_V1 = ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'] as const;
export type PeriodV1 = typeof PERIODS_V1[number];
export const publicationKeyV1 = (accountId: string) => `account:2026:${accountId}`;
export const publicationMaskV1 = (period: PeriodV1) => 1 << PERIODS_V1.indexOf(period);
export const publicationDigestV1 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type PublicationRowV1 = { period: PeriodV1; state: 'no-data' | 'available' | 'published' | 'update-pending';
  availableRevision: string | null; publishedRevision: string | null; version: number };

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
  scope.kind === 'account' ? [scope.accountId] : scope.kind === 'class' ? [scope.classId] : []);
  if (rows.length > 1000) throw new Error('student-portal-publication-scope-too-large');
  return rows.map((row) => ({ id: z.uuid().parse(row.id), version: versionV1.parse(Number(row.version)), classId: z.number().int().positive().parse(row.class_id) }));
}
export async function publicationRowsV1(tx: StudentPortalPostgresQueryV1, accountId: string): Promise<PublicationRowV1[]> {
  const rows = await tx.unsafe(`SELECT period,state,available_revision,published_revision,version::text
    FROM student_portal.publication WHERE scope_key=$1 ORDER BY period`, [publicationKeyV1(accountId)]);
  return normalizePublicationRowsV1(rows);
}
export function normalizePublicationRowsV1(rows: readonly Record<string, unknown>[]): PublicationRowV1[] {
  return PERIODS_V1.map((period) => {
    const row = rows.find((item) => item.period === period);
    if (!row) return { period, state: 'no-data', availableRevision: null, publishedRevision: null, version: 0 };
    return { period: periodV1.parse(row.period), state: z.enum(['no-data', 'available', 'published', 'update-pending']).parse(row.state),
      availableRevision: academicVersionSchemaV1.nullable().parse(row.available_revision),
      publishedRevision: academicVersionSchemaV1.nullable().parse(row.published_revision), version: versionV1.parse(Number(row.version)) };
  });
}
/** Fences administrative intent; availability and successful background materialization do not advance consent. */
export function jobPublicationVersionV1(mask: number, rows: readonly PublicationRowV1[]): string {
  z.number().int().min(0).max(63).parse(mask);
  return `job:${mask}:${PERIODS_V1.map((period) => rows.find((row) => row.period === period)?.version ?? 0).join(':')}`;
}
export function jobMaskV1(value: string): number {
  if (!/^job:(?:\d|[1-5]\d|6[0-3])(?::\d+){6}$/u.test(value)) throw new Error('student-portal-publication-job-invalid');
  return Number(value.split(':')[1]);
}
export async function jobPolicyVersionV1(tx: StudentPortalPostgresQueryV1, accountId: string): Promise<string> {
  const rows = await tx.unsafe(`SELECT a.version::text AS version,min(s.version)::text AS epoch,count(*)::integer AS fields,
    count(DISTINCT s.version)::integer AS epochs FROM student_portal.account a CROSS JOIN student_portal.setting s
    WHERE a.id=$1::uuid AND s.scope_key='school:2026' GROUP BY a.version`, [accountId]);
  const row = rows[0];
  // 7 fields before migration 0020 (#1132), 9 after it.
  if (!row || Number(row.fields) < 7 || Number(row.fields) > 9 || row.epochs !== 1) throw new Error('student-portal-policy-defaults-unavailable');
  return `epoch:${versionV1.parse(Number(row.epoch))}:account:${versionV1.parse(Number(row.version))}`;
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
export function parseDataVectorV1(value: string): (string | null)[] {
  if (!/^data:[a-f0-9]{32}:[0-9a-z]+(?:_[0-9a-z]+){5}$/u.test(value)) throw new Error('student-portal-publication-vector-invalid');
  const [, generation, counters] = value.split(':');
  return counters!.split('_').map((counter) => {
    let n = 0n;
    for (const character of counter) n = n * 36n + BigInt(Number.parseInt(character, 36));
    return n === 0n ? null : academicVersionSchemaV1.parse(`${generation}:${n}`);
  });
}
