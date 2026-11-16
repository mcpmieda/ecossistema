import { z } from 'zod';
import {
  adminCommandV1,
  type AdminCommandV1,
} from '../../../shared/student-portal-contracts/admin-v1';
import type {
  StudentPortalPostgresQueryV1,
  StudentPortalPostgresSqlV1,
} from '../persistence/postgres-persistence-v1';
import { authNowV1, authTransactionV1 } from '../auth/transaction-v1';
import { accountsScopeVersionV1, adminDigestV1 } from './common-v1';

const count = z.coerce.number().int().nonnegative().safe();

export async function readPopulationV1(tx: StudentPortalPostgresQueryV1) {
  const rows = await tx.unsafe(`WITH candidates AS (
    SELECT s.student_id,min(b.class_id) AS class_id,
      CASE WHEN min(b.status) IN (3,4,5) THEN 'exit' ELSE 'eligible' END AS eligibility
    FROM student_portal.academic_student_v1 s
    JOIN student_portal.academic_binding_v1 b
      ON b.academic_year=s.academic_year AND b.student_id=s.student_id
    WHERE b.status IS DISTINCT FROM 6
      AND NOT EXISTS (SELECT 1 FROM student_portal.link_closure c
        WHERE c.academic_year=2026 AND c.gradebook_student_id=s.student_id)
    GROUP BY s.student_id HAVING count(*)=1
  ), live_accounts AS (
    SELECT * FROM student_portal.account WHERE academic_year=2026 AND closed_at IS NULL
  ) SELECT
    COALESCE((SELECT population_enabled FROM student_portal.lifecycle_control WHERE academic_year=2026),false) AS enabled,
    (SELECT count(*) FROM candidates) AS source_profiles,
    (SELECT count(*) FROM candidates WHERE eligibility='eligible') AS eligible_source_profiles,
    (SELECT count(*) FROM candidates WHERE eligibility='exit') AS exit_source_profiles,
    (SELECT count(DISTINCT class_id) FROM candidates) AS classes,
    (SELECT count(*) FROM live_accounts) AS accounts,
    (SELECT count(*) FROM live_accounts WHERE eligibility='eligible') AS eligible_accounts,
    (SELECT count(*) FROM live_accounts WHERE eligibility<>'eligible') AS denied_accounts,
    (SELECT count(*) FROM candidates c WHERE NOT EXISTS (SELECT 1 FROM live_accounts a WHERE a.gradebook_student_id=c.student_id)) AS missing_profiles,
    (SELECT count(*) FROM student_portal.setting WHERE academic_year=2026 AND scope_kind<>'school') AS override_rows`);
  if (rows.length !== 1) throw new Error('student-portal-population-unavailable');
  const row = rows[0]!;
  return {
    enabled: z.boolean().parse(row.enabled),
    version: await accountsScopeVersionV1(tx),
    sourceProfiles: count.parse(row.source_profiles),
    eligibleSourceProfiles: count.parse(row.eligible_source_profiles),
    exitSourceProfiles: count.parse(row.exit_source_profiles),
    classes: count.parse(row.classes),
    accounts: count.parse(row.accounts),
    eligibleAccounts: count.parse(row.eligible_accounts),
    deniedAccounts: count.parse(row.denied_accounts),
    missingProfiles: count.parse(row.missing_profiles),
    overrideRows: count.parse(row.override_rows),
  };
}

export async function startPopulationV1(
  sql: StudentPortalPostgresSqlV1,
  actorId: string,
  input: Extract<AdminCommandV1, { operation: 'population-start' }>,
) {
  const actor = z.uuid().parse(actorId).toLowerCase();
  const command = adminCommandV1.parse(input);
  if (command.operation !== 'population-start')
    throw new Error('student-portal-population-invalid-request');
  return authTransactionV1(sql, async (tx, store) => {
    const now = await authNowV1(tx);
    const digest = adminDigestV1(command);
    const receiptActor = `population:${actor}`;
    const receipt = await store.readIdempotency(command.idempotencyKey, receiptActor);
    if (receipt && Date.parse(receipt.expiresAt) > now.getTime()) {
      if (receipt.requestDigest !== digest)
        throw new Error('student-portal-population-idempotency-conflict');
      return { operationId: receipt.operationId, version: receipt.version };
    }
    if (receipt)
      await tx.unsafe(
        'DELETE FROM student_portal.operation_receipt WHERE idempotency_key=$1 AND actor_id=$2',
        [command.idempotencyKey, receiptActor],
      );
    const before = await readPopulationV1(tx);
    if (before.version !== command.expectedVersion)
      throw new Error('student-portal-population-version-conflict');
    if (before.enabled) throw new Error('student-portal-population-already-enabled-conflict');
    const enabled =
      await tx.unsafe(`UPDATE student_portal.lifecycle_control SET population_enabled=true
      WHERE academic_year=2026 RETURNING academic_year`);
    if (enabled.length !== 1) throw new Error('student-portal-population-unavailable');
    const removed = await tx.unsafe(`DELETE FROM student_portal.setting
      WHERE academic_year=2026 AND scope_kind<>'school' RETURNING field_key`);
    if (removed.length > 0) {
      const advanced =
        await tx.unsafe(`UPDATE student_portal.setting SET version=version+1,updated_at=statement_timestamp()
        WHERE scope_key='school:2026' RETURNING field_key`);
      // 7 school fields before migration 0020, 9 after it.
      if (advanced.length < 7 || advanced.length > 9)
        throw new Error('student-portal-policy-defaults-unavailable');
      await tx.unsafe(
        "UPDATE student_portal.publication_job SET state='failed',lease_until=NULL,updated_at=statement_timestamp() WHERE state IN ('queued','running')",
      );
    }
    const synchronized = await tx.unsafe(
      'SELECT * FROM student_portal.synchronize_profiles_v1(true)',
    );
    if (synchronized.length !== 1) throw new Error('student-portal-population-unavailable');
    const after = await readPopulationV1(tx);
    const operationId = crypto.randomUUID();
    await store.appendAudit({
      eventId: crypto.randomUUID(),
      at: now.toISOString(),
      actorId: actor,
      accountId: null,
      scope: { kind: 'school', academicYear: 2026 },
      kind: 'settings-changed',
      result: 'success',
      requestId: command.idempotencyKey,
      version: after.version,
      maskedIp: null,
    });
    await store.saveIdempotency({
      key: command.idempotencyKey,
      actorId: receiptActor,
      requestDigest: digest,
      operationId,
      version: after.version,
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    });
    return { operationId, version: after.version };
  });
}
