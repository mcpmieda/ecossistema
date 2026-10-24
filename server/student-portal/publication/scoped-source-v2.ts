import { z } from 'zod';
import { scopeV1, versionV1, type ScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import { academicVersionSchemaV1 } from '../../../shared/gradebook-contracts/student-portal/academic-revision-v1';
import type { StudentPortalPostgresQueryV1 } from '../persistence/postgres-persistence-v1';
import { PERIODS_V1, publicationDigestV1 } from './state-v1';
import { LEGACY_ALLOWED_SQL_V1, releaseSelectionSqlV1 } from './release-selection-v1';

export const scopedKeyV2 = (scope: ScopeV1) => {
  if (scope.kind === 'school') {
    return 'school:2026';
  }
  if (scope.kind === 'class') {
    return `class:2026:${scope.classId}`;
  }
  return `account:2026:${scope.accountId.toLowerCase()}`;
};
const sourceAccountIdV2 = z.uuid();

export async function scopedPublicationEnabledV2(sql: StudentPortalPostgresQueryV1): Promise<boolean> {
  const rows = await sql.unsafe('SELECT enabled FROM student_portal.publication_control_v2 WHERE academic_year=2026');
  if (rows.length !== 1 || typeof rows[0]!.enabled !== 'boolean') throw new Error('student-portal-scoped-publication-unavailable');
  return rows[0]!.enabled;
}

/** The target CTE is trusted server context. A scope decision is never an account list or a queued job. */
const TARGETS_V2 = `SELECT s.student_id,b.class_id,a.id AS account_id
  FROM student_portal.academic_student_v1 s
  JOIN LATERAL (SELECT min(class_id) AS class_id,count(*) AS matches,
    bool_and(status IS NULL OR status IN(1,2,7)) AS eligible
    FROM student_portal.academic_binding_v1 WHERE academic_year=2026 AND student_id=s.student_id AND status IS DISTINCT FROM 6) b
    ON b.matches=1 AND b.eligible
  LEFT JOIN student_portal.account a ON a.academic_year=2026 AND a.gradebook_student_id=s.student_id AND a.closed_at IS NULL
  WHERE s.academic_year=2026 AND ($1='school' OR ($1='class' AND b.class_id=$3::integer) OR ($1='account' AND a.id=$2::uuid))`;

// Identical per-student resolution in admin summaries and Self. New decisions override the legacy floor,
// including explicit withdrawals. Among overlapping active scopes the last committed decision wins.
export const SCOPED_SELECTION_V2 = `SELECT p.period,p.mask,r.version AS decision_version,
  CASE WHEN r.scope_key IS NOT NULL THEN r.target_revision ELSE legacy.published_revision END AS approved_revision,
  chosen.target_revision,edition.payload_json,edition.class_id AS edition_class_id,edition.revision::text AS edition_revision,
  COALESCE(latest.period_mask,0) AS available_mask,latest.revision::text AS latest_revision
  FROM (VALUES('T1',1),('T2',2),('T3',4),('REC1',8),('REC2',16),('REC3',32)) p(period,mask)
  LEFT JOIN LATERAL (${releaseSelectionSqlV1()}) r ON true
  LEFT JOIN student_portal.publication legacy ON legacy.account_id=t.account_id AND legacy.period=p.period
    AND ${LEGACY_ALLOWED_SQL_V1}
  LEFT JOIN student_portal.publication_auto_approval_v2 automatic ON automatic.academic_year=2026
    AND automatic.student_id=t.student_id AND automatic.class_id=t.class_id AND automatic.generation=h.generation
  LEFT JOIN student_portal.setting sa ON sa.scope_key='account:2026:'||t.account_id::text AND sa.field_key='autoUpdate'
  LEFT JOIN student_portal.setting sc ON sc.scope_key='class:2026:'||t.class_id::text AND sc.field_key='autoUpdate'
  -- Turnos (28/09/2026): the class's shift wins over the class, the account still over both.
  LEFT JOIN student_portal.academic_class_v1 tcs ON tcs.academic_year=2026 AND tcs.class_id=t.class_id
  LEFT JOIN student_portal.setting sh ON sh.scope_key='shift:2026:'||tcs.shift AND sh.field_key='autoUpdate'
  LEFT JOIN student_portal.setting ss ON ss.scope_key='school:2026' AND ss.field_key='autoUpdate'
  CROSS JOIN LATERAL (SELECT CASE WHEN r.scope_key IS NOT NULL THEN r.target_revision ELSE legacy.published_revision END AS revision) base
  CROSS JOIN LATERAL (SELECT CASE WHEN base.revision IS NULL THEN NULL
    WHEN split_part(base.revision,':',1)<>h.generation::text THEN NULL
    ELSE h.generation||':'||GREATEST(split_part(base.revision,':',2)::numeric,
      COALESCE(automatic.revision,0),CASE WHEN COALESCE(sa.value_json,sh.value_json,sc.value_json,ss.value_json,'false'::jsonb)='true'::jsonb
        THEN h.revision ELSE 0 END)::text END AS target_revision) chosen
  LEFT JOIN LATERAL (SELECT payload_json,class_id,revision FROM student_portal.publication_source_v2
    WHERE academic_year=2026 AND student_id=t.student_id AND generation=h.generation
      AND revision<=split_part(chosen.target_revision,':',2)::numeric
    ORDER BY revision DESC LIMIT 1) edition ON true
  LEFT JOIN LATERAL (SELECT period_mask,revision FROM student_portal.publication_source_v2
    WHERE academic_year=2026 AND student_id=t.student_id AND generation=h.generation AND revision<=h.revision
    ORDER BY revision DESC LIMIT 1) latest ON true`;

export async function readScopedSourcesV2(tx: StudentPortalPostgresQueryV1, accountId: string, studentId: number, classId: number) {
  return tx.unsafe(`WITH target AS (SELECT $1::uuid AS account_id,$2::integer AS student_id,$3::integer AS class_id)
    SELECT selected.* FROM target t CROSS JOIN student_portal.publication_source_head_v2 h
    CROSS JOIN LATERAL (${SCOPED_SELECTION_V2}) selected WHERE h.academic_year=2026`, [accountId, studentId, classId]);
}

const sourceTargetsV2 = z
  .array(
    z.object({
      accountId: z.uuid(),
      studentId: z.number().int().positive().safe(),
      classId: z.number().int().positive().safe(),
    }),
  )
  .max(200);
export type SourceTargetV2 = z.infer<typeof sourceTargetsV2>[number];

/** Request-local batch of the same per-student release selection, limited to caller-validated targets. */
export async function readScopedSourceBatchV2(
  tx: StudentPortalPostgresQueryV1,
  input: readonly SourceTargetV2[],
) {
  const targets = sourceTargetsV2.parse(input);
  if (!targets.length) return new Map<string, Awaited<ReturnType<typeof readScopedSourcesV2>>>();
  const rows = await tx.unsafe(
    `WITH target AS (
      SELECT account_id,student_id,class_id FROM jsonb_to_recordset($1::text::jsonb)
        AS x(account_id uuid,student_id integer,class_id integer)
    ) SELECT t.account_id,selected.* FROM target t CROSS JOIN student_portal.publication_source_head_v2 h
    CROSS JOIN LATERAL (${SCOPED_SELECTION_V2}) selected WHERE h.academic_year=2026`,
    [
      JSON.stringify(
        targets.map((target) => ({
          account_id: target.accountId,
          student_id: target.studentId,
          class_id: target.classId,
        })),
      ),
    ],
  );
  const byAccount = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const id = sourceAccountIdV2.parse(row.account_id);
    const existing = byAccount.get(id) ?? [];
    existing.push(row);
    byAccount.set(id, existing);
  }
  return byAccount;
}

/** Closing editions and stable phrase keys use the same frozen head and account key as Self. */
export async function readClosingSourceBatchV2(
  tx: StudentPortalPostgresQueryV1,
  input: readonly SourceTargetV2[],
) {
  const targets = sourceTargetsV2.parse(input);
  if (!targets.length) return [];
  return tx.unsafe(
    `WITH target AS (
      SELECT account_id,student_id FROM jsonb_to_recordset($1::text::jsonb)
        AS x(account_id uuid,student_id integer)
    ) SELECT t.account_id,t.student_id,to_jsonb(a)->>'student_uid' AS uid,
      s.payload_json,s.class_id,h.generation||':'||s.revision::text AS revision
    FROM target t CROSS JOIN student_portal.publication_source_head_v2 h
    JOIN student_portal.account a ON a.id=t.account_id
    LEFT JOIN LATERAL (SELECT payload_json,class_id,revision FROM student_portal.publication_source_v2
      WHERE academic_year=2026 AND student_id=t.student_id AND generation=h.generation AND revision<=h.revision
      ORDER BY revision DESC LIMIT 1) s ON true WHERE h.academic_year=2026`,
    [
      JSON.stringify(
        targets.map((target) => ({ account_id: target.accountId, student_id: target.studentId })),
      ),
    ],
  );
}

export async function scopedSummaryV2(tx: StudentPortalPostgresQueryV1, input: ScopeV1) {
  const scope = scopeV1.parse(input);
  const rows = await tx.unsafe(`WITH target AS (${TARGETS_V2}), head AS (
      SELECT h.*,c.version FROM student_portal.publication_source_head_v2 h
      JOIN student_portal.publication_control_v2 c USING(academic_year)
      JOIN student_portal.academic_revision r ON r.academic_year=h.academic_year
        AND r.academic_generation=h.generation AND r.academic_counter=h.revision
      WHERE h.academic_year=2026 AND c.enabled
    ), selected AS (SELECT t.student_id,t.class_id,s.* FROM target t CROSS JOIN head h
      CROSS JOIN LATERAL (${SCOPED_SELECTION_V2}) s)
    SELECT h.generation||':'||h.revision::text AS data_version,h.version::text,
      (SELECT count(*)::integer FROM target) AS targets,(SELECT min(class_id) FROM target) AS class_id,
      COALESCE((SELECT jsonb_agg(summary) FROM (SELECT period,
        bool_or((available_mask & mask)<>0) AS available,bool_and(target_revision IS NOT NULL) AS all_published,
        bool_or(target_revision IS NOT NULL AND (edition_revision IS NULL OR edition_revision<>latest_revision)) AS pending,
        COALESCE(jsonb_agg(DISTINCT target_revision) FILTER(WHERE target_revision IS NOT NULL),'[]'::jsonb) AS revisions
        FROM selected GROUP BY period) summary),'[]'::jsonb) AS periods
    FROM head h`, [scope.kind, scope.kind === 'account' ? scope.accountId : null, scope.kind === 'class' ? scope.classId : null]);
  if (rows.length !== 1) throw new Error('student-portal-preparation-unavailable');
  const row = rows[0]!;
  const dataVersion = academicVersionSchemaV1.parse(row.data_version);
  const version = versionV1.parse(Number(row.version));
  const periods = z.array(z.object({ period: z.enum(PERIODS_V1), available: z.boolean(), all_published: z.boolean(),
    pending: z.boolean().nullable(), revisions: z.array(academicVersionSchemaV1) })).parse(row.periods);
  return {
    version, dataVersion, count: z.number().int().nonnegative().parse(row.targets),
    classId: z.number().int().positive().nullable().parse(row.class_id),
    allPublished: new Set(periods.filter((period) => period.all_published).map((period) => period.period)),
    items: PERIODS_V1.map((period) => {
      const value = periods.find((item) => item.period === period);
      const revisions = value?.revisions ?? [];
      return { period, version, state: revisions.length ? value?.pending ? 'update-pending' as const : 'published' as const
        : value?.available ? 'available' as const : 'no-data' as const,
        availableRevision: value?.available ? dataVersion : null,
        publishedRevision: revisions.length === 1 ? revisions[0]! : revisions.length > 1 ? `mixed:${publicationDigestV1([...revisions].sort((left, right) => left.localeCompare(right)))}` : null };
    }),
  };
}

/** Newest prepared edition of one student (spec D3: the closing reads every recorded fact). */
export async function readLatestSourceV2(tx: StudentPortalPostgresQueryV1, studentId: number) {
  const rows = await tx.unsafe(`SELECT s.payload_json,s.class_id,h.generation||':'||s.revision::text AS revision
    FROM student_portal.publication_source_head_v2 h
    JOIN LATERAL (SELECT payload_json,class_id,revision FROM student_portal.publication_source_v2
      WHERE academic_year=2026 AND student_id=$1::integer AND generation=h.generation AND revision<=h.revision
      ORDER BY revision DESC LIMIT 1) s ON true
    WHERE h.academic_year=2026`, [studentId]);
  const row = rows[0];
  return row ? { payload_json: row.payload_json, class_id: Number(row.class_id), revision: String(row.revision) } : null;
}

/** Durable student key for stable phrase variants (spec decision 7). */
export async function readStudentKeyV2(tx: StudentPortalPostgresQueryV1, accountId: string) {
  // to_jsonb keeps older disposable schemas (before 0018) readable; production always has the column.
  const rows = await tx.unsafe("SELECT to_jsonb(a)->>'student_uid' AS uid FROM student_portal.account a WHERE a.id=$1::uuid", [accountId]);
  const uid = rows[0]?.uid;
  return typeof uid === 'string' && uid.length > 0 ? uid : `account:${accountId}`;
}
