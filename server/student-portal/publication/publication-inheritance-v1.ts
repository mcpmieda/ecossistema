import { z } from 'zod';
import { publicationInheritCommandV1 } from '../../../shared/student-portal-contracts/customizations-v1';
import { versionV1 } from '../../../shared/student-portal-contracts/core-v1';
import { StudentPortalPostgresPersistenceV1, type StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
import { authNowV1 } from '../auth/transaction-v1';
import { publicationDigestV1 } from './state-v1';
import { scopedKeyV2 } from './scoped-source-v2';

/** Same brief publication mutex, CAS and receipt discipline as explicit releases.
 * The strict command schema excludes the school. No DELETE or privileged routine. */
export async function inheritPublicationV1(sql: StudentPortalPostgresSqlV1, actorId: string, input: unknown) {
  const actor = z.uuid().parse(actorId).toLowerCase();
  const command = publicationInheritCommandV1.parse(input);
  const scope = command.scope.kind === 'account'
    ? { ...command.scope, accountId: command.scope.accountId.toLowerCase() } : command.scope;
  const digest = publicationDigestV1({ ...command, scope });
  const receiptActor = `publication-inherit:${actor}`;
  return sql.begin(async (tx) => {
    const rows = await tx.unsafe('SELECT enabled,version::text FROM student_portal.publication_control_v2 WHERE academic_year=2026 FOR UPDATE');
    if (rows.length !== 1 || rows[0]!.enabled !== true) throw new Error('student-portal-scoped-publication-unavailable');
    const bound: StudentPortalPostgresSqlV1 = { unsafe: (q, v) => tx.unsafe(q, v), begin: (run) => run(tx) };
    return new StudentPortalPostgresPersistenceV1(bound).transaction(async (store) => {
      const now = await authNowV1(tx);
      const receipt = await store.readIdempotency(command.idempotencyKey, receiptActor);
      if (receipt && Date.parse(receipt.expiresAt) > now.getTime()) {
        if (receipt.requestDigest !== digest) throw new Error('student-portal-publication-idempotency-conflict');
        return { operationId: receipt.operationId, version: receipt.version };
      }
      if (receipt) await tx.unsafe('DELETE FROM student_portal.operation_receipt WHERE idempotency_key=$1 AND actor_id=$2', [command.idempotencyKey, receiptActor]);
      const current = versionV1.parse(Number(rows[0]!.version));
      if (current !== command.expectedVersion) throw new Error('student-portal-publication-version-conflict');
      const changed = await tx.unsafe(`UPDATE student_portal.publication_release_v2
        SET inherit_version=version
        WHERE academic_year=2026 AND scope_key=$1 AND scope_kind=$2 AND period=$3
          AND version=$4 AND inherit_version<version RETURNING version`,
      [scopedKeyV2(scope), scope.kind, command.period, command.expectedDecisionVersion]);
      if (changed.length !== 1) throw new Error('student-portal-publication-version-conflict');
      const version = versionV1.parse(current + 1);
      await tx.unsafe('UPDATE student_portal.publication_control_v2 SET version=$1 WHERE academic_year=2026', [version]);
      const operationId = crypto.randomUUID();
      await store.appendAudit({ eventId: crypto.randomUUID(), at: now.toISOString(), actorId: actor,
        accountId: scope.kind === 'account' ? scope.accountId : null, scope,
        kind: 'settings-changed', result: 'success', requestId: command.idempotencyKey, version, maskedIp: null });
      await store.saveIdempotency({ key: command.idempotencyKey, actorId: receiptActor, requestDigest: digest,
        operationId, version, expiresAt: new Date(now.getTime() + 86_400_000).toISOString() });
      return { operationId, version };
    });
  });
}
