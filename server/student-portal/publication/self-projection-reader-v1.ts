import { z } from 'zod';
import { STUDENT_NAME_MAX_LENGTH_V1 } from '../../../shared/student-identity/student-identity-v1';
import {
  assessmentLabelV1,
  assessmentNamesSchemaV1,
} from '../../../shared/gradebook-contracts/settings/assessment-names-v1';
import { type SelfResponseV1 } from '../../../shared/student-portal-contracts/self-v1';
import type {
  AccountRecordV1,
  PublishedProjectionPortV1,
  PortalTransactionV1,
} from '../../../shared/student-portal-contracts/ports-v1';
import { revisionsV1, type RevisionsV1 } from '../../../shared/student-portal-contracts/core-v1';
import {
  StudentPortalPostgresPersistenceV1,
  type StudentPortalPostgresQueryV1,
  type StudentPortalPostgresSqlV1,
} from '../persistence/postgres-persistence-v1';
import { accountScopeV1, authNowV1 } from '../auth/transaction-v1';
import { readPortalSnapshotV2 } from '../auth/read-snapshot-v2';
import { sessionExpiryV1 } from '../policies/calendar-v1';
import { PolicyServiceV1 } from '../policies/policy-service-v1';
import { AcademicEligibilityReaderPostgresV1 } from '../integration/lifecycle/academic-eligibility-v1';
import { scopedSelfV2 } from './scoped-self-v2';
import type { EligibilityV1 } from '../../../shared/gradebook-contracts/student-portal/eligibility-v1';

/** Fresh names/status come from the BN; the lifecycle snapshot proves the projection scope.
 * lockAccount=false is reserved for a caller-owned REPEATABLE READ READ ONLY transaction.
 */
export async function publicationContextV1(
  sql: StudentPortalPostgresSqlV1,
  tx: StudentPortalPostgresQueryV1,
  store: PortalTransactionV1,
  accountId: string,
  requireAccess = true,
  lockAccount = true,
) {
  if (lockAccount) await store.lockAccounts([accountId]);
  const account = await store.findAccount(accountId);
  if (
    !account?.link ||
    account.closedAt !== null ||
    account.blocked ||
    account.eligibility !== 'eligible'
  )
    return null;
  const eligibility = await new AcademicEligibilityReaderPostgresV1(tx).readInTransaction(
    tx,
    account.link,
  );
  if (eligibility.state !== 'eligible') return null;
  const policy = await new PolicyServiceV1(sql).readSnapshotInTransaction(
    tx,
    accountScopeV1(accountId),
  );
  const now = await authNowV1(tx);
  if (requireAccess && sessionExpiryV1(policy.enforcedValue, now, false) === null) return null;
  const context = { account, eligibility, policy, now };
  const rows = await tx.unsafe(
    `SELECT s.name,b.class_name,b.status,l.class_id AS observed_class,
    COALESCE(to_jsonb(y)->'assessment_names','{}'::jsonb) AS assessment_names,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.assessment_id,'term',i.term,'slot',i.slot,'label',i.label))
      FROM student_portal.academic_offer_v1 o JOIN student_portal.academic_instrument_v1 i ON i.offer_id=o.offer_id
      WHERE o.academic_year=a.academic_year AND o.class_id=b.class_id AND i.slot IN (1,2)), '[]'::jsonb) AS assessments
    FROM student_portal.account a JOIN student_portal.academic_student_v1 s
      ON s.student_id=a.gradebook_student_id AND s.academic_year=a.academic_year
    JOIN student_portal.academic_binding_v1 b ON b.student_id=s.student_id AND b.academic_year=s.academic_year
    JOIN student_portal.academic_year_policy_v1 y ON y.academic_year=a.academic_year
    LEFT JOIN student_portal.lifecycle_snapshot l ON l.account_id=a.id
    WHERE a.id=$1::uuid AND b.status IS DISTINCT FROM 6`,
    [accountId],
  );
  return publicationContextFromRowsV1(context, rows);
}

// Built once: a schema created for each student costs more than the validation it performs.
const profileNameV1 = z.string().min(1).max(STUDENT_NAME_MAX_LENGTH_V1);
const profileClassLabelV1 = z.string().min(1).max(80);
const profileAssessmentsV1 = z
  .array(
    z.object({
      id: z.number().int().positive(),
      term: z.number().int().min(1).max(3),
      slot: z.union([z.literal(1), z.literal(2)]),
      label: z.string().nullable(),
    }),
  )
  .max(600);

/** Single-target and batched reads share this profile validation and presentation assembly. */
export function publicationContextFromRowsV1(
  context: {
    account: AccountRecordV1;
    eligibility: EligibilityV1;
    policy: Awaited<ReturnType<PolicyServiceV1['readSnapshotInTransaction']>>;
    now: Date;
  },
  rows: readonly Record<string, unknown>[],
) {
  const accountId = context.account.id;
  const row = rows[0];
  if (rows.length !== 1 || !row || row.observed_class !== context.policy.classId) return null;
  let academicState;
  if (row.status === 2) {
    academicState = 'assisted' as const;
  } else if (row.status === 1) {
    academicState = 'special' as const;
  } else {
    academicState = 'regular' as const;
  }
  const profile = {
    accountId,
    link: context.account.link!,
    name: profileNameV1.parse(row.name),
    classLabel: profileClassLabelV1.parse(row.class_name),
    academicState,
    result: academicState === 'assisted' ? ('not-applicable' as const) : ('in-progress' as const),
  };
  const names = assessmentNamesSchemaV1.parse(row.assessment_names ?? {});
  const assessments = profileAssessmentsV1.parse(row.assessments ?? []);
  const assessmentLabels = new Map(
    assessments.map((item) => [
      item.id,
      assessmentLabelV1(item.slot, item.term, names, item.label),
    ]),
  );
  return { ...context, profile, assessmentLabels };
}
/** Serves Self only from scoped V2 prepared editions (the legacy stored projection was removed). */
export class SelfProjectionReaderV1 implements PublishedProjectionPortV1 {
  constructor(private readonly sql: StudentPortalPostgresSqlV1) {}
  async read(accountId: string, requestId: string): Promise<SelfResponseV1 | null> {
    z.uuid().parse(accountId);
    return readPortalSnapshotV2(this.sql, (tx, store) =>
      this.authorized(tx, store, accountId, requestId, true),
    );
  }
  async readInTransaction(
    tx: StudentPortalPostgresQueryV1,
    accountId: string,
    requestId: string,
    snapshot = false,
  ) {
    return new StudentPortalPostgresPersistenceV1({
      unsafe: (query, parameters) => tx.unsafe(query, parameters),
      begin: (operation) => operation(tx),
    }).transaction(async (store) => {
      if (!snapshot) await store.lockAcademicYear(2026, 'shared');
      return this.authorized(tx, store, accountId, requestId, snapshot);
    });
  }
  async readAuthorized(accountId: string, expected: RevisionsV1): Promise<SelfResponseV1 | null> {
    revisionsV1.parse(expected);
    const result = await this.read(accountId, crypto.randomUUID());
    return result &&
      (['dataVersion', 'policyVersion', 'publicationVersion'] as const).every(
        (key) => result.revisions[key] === expected[key],
      )
      ? result
      : null;
  }
  private async authorized(
    tx: StudentPortalPostgresQueryV1,
    store: PortalTransactionV1,
    accountId: string,
    requestId: string,
    snapshot: boolean,
  ): Promise<SelfResponseV1 | null> {
    const context = await publicationContextV1(this.sql, tx, store, accountId, true, !snapshot);
    if (context?.account.state !== 'active') return null;
    return labelPublishedAssessmentsV1(
      await scopedSelfV2(tx, context, requestId),
      context.assessmentLabels,
    );
  }
}

/** Presentation-only overlay. Frozen marks, visibility, and publication revisions stay intact. */
export function labelPublishedAssessmentsV1(
  value: SelfResponseV1,
  labels: ReadonlyMap<number, string>,
): SelfResponseV1 {
  if (!labels.size || value.state !== 'ready') return value;
  return {
    ...value,
    subjects: value.subjects.map((subject) => ({
      ...subject,
      periods: subject.periods.map((period) =>
        period.partials
          ? {
              ...period,
              partials: period.partials.map((partial) => ({
                ...partial,
                label: labels.get(partial.assessmentId) ?? partial.label,
              })),
            }
          : period,
      ),
    })),
  };
}
