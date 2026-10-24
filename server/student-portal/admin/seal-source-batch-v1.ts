import { z } from 'zod';
import { academicVersionSchemaV1 } from '../../../shared/gradebook-contracts/student-portal/academic-revision-v1';
import {
  academicBindingSchemaV1,
  resolveEligibilityV1,
} from '../../../shared/gradebook-contracts/student-portal/eligibility-v1';
import {
  accountFromRowV1,
  type StudentPortalPostgresQueryV1,
} from '../persistence/postgres-persistence-v1';
import { accountScopeV1, authNowV1 } from '../auth/transaction-v1';
import {
  createPolicyResolutionMemoV1,
  resolvePolicySnapshotRowsV1,
} from '../policies/policy-service-v1';
import {
  publicationContextFromRowsV1,
  type publicationContextV1,
} from '../publication/self-projection-reader-v1';
import {
  readClosingSourceBatchV2,
  readScopedSourceBatchV2,
  type SourceTargetV2,
} from '../publication/scoped-source-v2';
import type { ScopedSelfSourceReaderV2 } from '../publication/scoped-self-v2';
import { termClosingTargetsV1 } from '../publication/term-closing-self-v1';
import { scalarTextV1 } from '../../../shared/scalar-text-v1';

type ContextV1 = NonNullable<Awaited<ReturnType<typeof publicationContextV1>>>;
// Built once: a schema created for each account costs more than the validation it performs.
const batchIdsV1 = z.array(z.uuid()).min(1).max(200);
const bindingsV1 = z.array(academicBindingSchemaV1);
const profilesV1 = z.array(z.record(z.string(), z.unknown()));

/** Only previously selected class IDs enter this read-only request-local snapshot. */
export async function sealContextsBatchV1(
  tx: StudentPortalPostgresQueryV1,
  input: readonly string[],
  snapshotNow?: Date,
) {
  const ids = batchIdsV1.parse(input);
  const rows = await tx.unsafe(
    `SELECT a.id,a.academic_year,a.gradebook_student_id,a.auth_state,a.eligibility,a.blocked,
      a.version,a.version::text AS account_version,a.security_version,a.pin_version,a.closed_at,
      b.class_id,b.matches=1 AS resolved,c.shift,
      (SELECT academic_generation||':'||academic_counter::text FROM student_portal.academic_revision
        WHERE academic_year=a.academic_year) AS data_version,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('academicYear',bb.academic_year,'studentId',bb.student_id,
        'classId',bb.class_id,'status',bb.status)) FROM student_portal.academic_binding_v1 bb
        JOIN student_portal.academic_student_v1 ss ON ss.academic_year=bb.academic_year AND ss.student_id=bb.student_id
        WHERE bb.academic_year=a.academic_year AND bb.student_id=a.gradebook_student_id),'[]'::jsonb) AS bindings,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('scope_key',p.scope_key,'field_key',p.field_key,
        'value_json',p.value_json,'source_scope_json',p.source_scope_json,'version',p.version))
        FROM student_portal.setting p WHERE p.scope_key='school:2026'
          OR p.scope_key='class:2026:'||b.class_id::text OR p.scope_key='shift:2026:'||c.shift
          OR p.scope_key='account:2026:'||a.id::text),'[]'::jsonb) AS settings_rows,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name',s.name,'class_name',pb.class_name,'status',pb.status,
        'observed_class',l.class_id,'assessment_names',COALESCE(to_jsonb(y)->'assessment_names','{}'::jsonb),
        'assessments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.assessment_id,'term',i.term,'slot',i.slot,'label',i.label))
          FROM student_portal.academic_offer_v1 o JOIN student_portal.academic_instrument_v1 i ON i.offer_id=o.offer_id
          WHERE o.academic_year=a.academic_year AND o.class_id=pb.class_id AND i.slot IN (1,2)), '[]'::jsonb)))
        FROM student_portal.academic_student_v1 s
        JOIN student_portal.academic_binding_v1 pb ON pb.student_id=s.student_id AND pb.academic_year=s.academic_year
        JOIN student_portal.academic_year_policy_v1 y ON y.academic_year=a.academic_year
        LEFT JOIN student_portal.lifecycle_snapshot l ON l.account_id=a.id
        WHERE s.student_id=a.gradebook_student_id AND s.academic_year=a.academic_year
          AND pb.status IS DISTINCT FROM 6),'[]'::jsonb) AS profiles
    FROM student_portal.account a
    CROSS JOIN LATERAL (SELECT min(class_id) AS class_id,count(*)::integer AS matches
      FROM student_portal.academic_binding_v1 WHERE academic_year=2026 AND student_id=a.gradebook_student_id
        AND status IS DISTINCT FROM 6) b
    LEFT JOIN student_portal.academic_class_v1 c ON c.academic_year=2026 AND c.class_id=b.class_id
    WHERE a.id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::text::jsonb))
      AND a.closed_at IS NULL AND NOT a.blocked
      AND a.eligibility='eligible' AND a.gradebook_student_id IS NOT NULL ORDER BY a.id`,
    [JSON.stringify(ids)],
  );
  const now = snapshotNow ?? await authNowV1(tx);
  const contexts = new Map<string, ContextV1>();
  const policies = createPolicyResolutionMemoV1();
  for (const row of rows) {
    const account = accountFromRowV1(row);
    if (
      !account.link ||
      account.closedAt !== null ||
      account.blocked ||
      account.eligibility !== 'eligible'
    )
      continue;
    const eligibility = resolveEligibilityV1(
      account.link,
      academicVersionSchemaV1.parse(row.data_version),
      bindingsV1.parse(row.bindings),
    );
    if (eligibility.state !== 'eligible') continue;
    const policy = await resolvePolicySnapshotRowsV1(accountScopeV1(account.id), [row], policies);
    const context = publicationContextFromRowsV1(
      { account, eligibility, policy, now },
      profilesV1.parse(row.profiles),
    );
    if (context) contexts.set(account.id, context);
  }
  return contexts;
}

const sourceTargetV1 = (context: ContextV1): SourceTargetV2 => ({
  accountId: context.account.id,
  studentId: context.account.link!.studentId,
  classId: context.policy.classId!,
});

/** Canonical Self executes unchanged against prefetched rows; no query facade or persisted cache. */
export async function sealSourcesBatchV1(
  tx: StudentPortalPostgresQueryV1,
  contexts: readonly ContextV1[],
): Promise<ScopedSelfSourceReaderV2> {
  const rows = await readScopedSourceBatchV2(tx, contexts.map(sourceTargetV1));
  const closingTargets = contexts
    .filter(
      (context) =>
        termClosingTargetsV1(
          context.policy.enforcedValue,
          context.profile.academicState,
          context.now,
        ).periods.length > 0,
    )
    .map(sourceTargetV1);
  let closing: ReturnType<typeof readClosingSourceBatchV2> | undefined;
  const closingRows = () => (closing ??= readClosingSourceBatchV2(tx, closingTargets));
  return {
    scoped: async (context) => rows.get(context.account.id) ?? [],
    latest: async (studentId) => {
      const row = (await closingRows()).find((item) => Number(item.student_id) === studentId);
      return row?.revision
        ? {
            payload_json: row.payload_json,
            class_id: Number(row.class_id),
            revision: scalarTextV1(row.revision),
          }
        : null;
    },
    studentKey: async (accountId) => {
      const row = (await closingRows()).find((item) => item.account_id === accountId);
      return typeof row?.uid === 'string' && row.uid.length > 0 ? row.uid : `account:${accountId}`;
    },
  };
}
