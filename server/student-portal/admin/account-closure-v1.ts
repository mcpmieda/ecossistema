import {
  adminReadResponseV2,
  type AdminReadQueryV2,
} from '../../../shared/student-portal-contracts/admin-read-v2';
import type { AdminCommandV1 } from '../../../shared/student-portal-contracts/admin-v1';
import type {
  StudentPortalPostgresQueryV1,
  StudentPortalPostgresSqlV1,
} from '../persistence/postgres-persistence-v1';
import { authNowV1, authTransactionV1 } from '../auth/transaction-v1';
import { adminDigestV1 } from './common-v1';

/**
 * Why a record has no class (owner request 10/11/2026), from the records only: when the account
 * was created, whether it was ever used, how many classes its student has this year, and other
 * students with the same name who do have a class. Closable only when it has no class this year
 * and was never used, the same rule the command checks again under lock.
 */
export async function readAccountOriginV1(
  tx: StudentPortalPostgresQueryV1,
  query: AdminReadQueryV2,
  requestId: string,
  now: Date,
) {
  if (query.scope.kind !== 'account') throw new Error('student-portal-account-origin-invalid-request');
  const found = await tx.unsafe(
    `SELECT a.id,a.version,a.created_at,a.auth_state,a.closed_at,a.gradebook_student_id,
        (SELECT count(*) FROM student_portal.academic_binding_v1 b
          WHERE b.academic_year=a.academic_year AND b.student_id=a.gradebook_student_id) AS classes,
        EXISTS(SELECT 1 FROM student_portal.audit_event e WHERE e.account_id=a.id
          AND e.kind IN ('login','activated') AND e.result='success') AS used,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('classLabel',other.class_name,
            'accountActive',other_account.auth_state='active') ORDER BY other.class_name)
          FROM student_portal.academic_student_v1 me
          JOIN student_portal.academic_student_v1 twin ON twin.academic_year=me.academic_year
            AND twin.student_id<>me.student_id
            AND lower(regexp_replace(twin.name,'\\s+',' ','g'))=lower(regexp_replace(me.name,'\\s+',' ','g'))
          JOIN student_portal.academic_binding_v1 other ON other.academic_year=twin.academic_year
            AND other.student_id=twin.student_id AND other.status IS DISTINCT FROM 6
          LEFT JOIN student_portal.account other_account ON other_account.gradebook_student_id=twin.student_id
            AND other_account.academic_year=twin.academic_year AND other_account.closed_at IS NULL
          WHERE me.academic_year=a.academic_year AND me.student_id=a.gradebook_student_id),'[]'::jsonb) AS same_name
      FROM student_portal.account a WHERE a.id=$1::uuid AND a.academic_year=2026`,
    [query.scope.accountId],
  );
  const row = found[0];
  if (!row) throw new Error('student-portal-account-origin-invalid-request');
  const classes = Number(row.classes);
  const everAccessed = row.used === true;
  const closable =
    row.closed_at === null &&
    row.gradebook_student_id !== null &&
    row.auth_state === 'pending-activation' &&
    classes === 0 &&
    !everAccessed;
  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at));
  const sameName = (Array.isArray(row.same_name) ? row.same_name : JSON.parse(String(row.same_name)))
    .slice(0, 10)
    .map((item: { classLabel: string; accountActive: boolean | null }) => ({
      classLabel: item.classLabel,
      accountActive: item.accountActive === true,
    }));
  return adminReadResponseV2.parse({
    contractVersion: 2,
    requestId,
    observedAt: now.toISOString(),
    state: 'account-origin',
    accountId: String(row.id),
    version: Number(row.version),
    createdAt: createdAt.toISOString(),
    everAccessed,
    classesThisYear: classes,
    closable,
    sameName,
  });
}

/** Encerrar conta: idempotent like the yearly closure, recorded in the audit as a closed link. */
export async function closeUnusedAccountV1(
  sql: StudentPortalPostgresSqlV1,
  actor: string,
  command: Extract<AdminCommandV1, { operation: 'account-close' }>,
) {
  return authTransactionV1(sql, async (tx, store) => {
    const now = await authNowV1(tx);
    const digest = adminDigestV1(command);
    const receiptActor = `account-close:${actor}`;
    const receipt = await store.readIdempotency(command.idempotencyKey, receiptActor);
    if (receipt && Date.parse(receipt.expiresAt) > now.getTime()) {
      if (receipt.requestDigest !== digest) throw new Error('student-portal-account-close-conflict');
      return { operationId: receipt.operationId, version: receipt.version };
    }
    if (receipt)
      await tx.unsafe(
        'DELETE FROM student_portal.operation_receipt WHERE idempotency_key=$1 AND actor_id=$2',
        [command.idempotencyKey, receiptActor],
      );
    const accountId = command.accountId.toLowerCase();
    const closedAt = now.toISOString();
    const result = await store.closeUnusedAccountLink(accountId, command.expectedVersion, closedAt);
    await store.appendAudit({
      eventId: crypto.randomUUID(),
      at: closedAt,
      actorId: actor,
      accountId,
      scope: { kind: 'account', academicYear: 2026, accountId },
      kind: 'links-closed',
      result: 'success',
      requestId: command.idempotencyKey,
      version: result.version,
      maskedIp: null,
    });
    const operationId = crypto.randomUUID();
    await store.saveIdempotency({
      key: command.idempotencyKey,
      actorId: receiptActor,
      requestDigest: digest,
      operationId,
      version: result.version,
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    });
    return { operationId, version: result.version };
  });
}
