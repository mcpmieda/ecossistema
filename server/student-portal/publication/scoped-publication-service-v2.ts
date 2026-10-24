import { z } from 'zod';
import { adminCommandV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { versionV1, type ScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import { StudentPortalPostgresPersistenceV1, type StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
import { authNowV1 } from '../auth/transaction-v1';
import { publicationDigestV1 } from './state-v1';
import { scopedKeyV2, scopedSummaryV2 } from './scoped-source-v2';

/** Release state, receipt and audit commit together. No account loop, job or academic-year lock. */
export class ScopedPublicationServiceV2 {
  constructor(private readonly sql: StudentPortalPostgresSqlV1) {}
  async read(scope: ScopeV1) {
    // All fields come from one SELECT snapshot. No isolation upgrade after the audit wrapper's SET LOCAL.
    return scopedSummaryV2(this.sql, scope);
  }
  async command(actorId: string, input: unknown) {
    const actor = z.uuid().parse(actorId).toLowerCase();
    const command = adminCommandV1.parse(input);
    if (!['publish', 'publish-update', 'unpublish'].includes(command.operation)
      || !('period' in command) || !('scope' in command)) throw new Error('student-portal-publication-command-invalid');
    const scope = command.scope.kind === 'account' ? { ...command.scope, accountId: command.scope.accountId.toLowerCase() } : command.scope;
    const digest = publicationDigestV1({ ...command, scope });
    const receiptActor = `${command.operation}:${actor}`;
    return this.sql.begin(async (tx) => {
      // This mutex serializes only brief publication decisions, never login, imports or student reads.
      const control = await tx.unsafe('SELECT enabled,version::text FROM student_portal.publication_control_v2 WHERE academic_year=2026 FOR UPDATE');
      if (control.length !== 1 || control[0]!.enabled !== true) throw new Error('student-portal-scoped-publication-unavailable');
      const bound: StudentPortalPostgresSqlV1 = { unsafe: (query, values) => tx.unsafe(query, values), begin: (run) => run(tx) };
      return new StudentPortalPostgresPersistenceV1(bound).transaction(async (store) => {
        const now = await authNowV1(tx);
        // Use the existing namespace and canonical digest so a retry across the deployment cannot duplicate a decision.
        const receipt = await store.readIdempotency(command.idempotencyKey, receiptActor);
        if (receipt && Date.parse(receipt.expiresAt) > now.getTime()) {
          if (receipt.requestDigest !== digest) throw new Error('student-portal-publication-idempotency-conflict');
          return { operationId: receipt.operationId, version: receipt.version };
        }
        if (receipt) await tx.unsafe('DELETE FROM student_portal.operation_receipt WHERE idempotency_key=$1 AND actor_id=$2',
          [command.idempotencyKey, receiptActor]);
        const current = versionV1.parse(Number(control[0]!.version));
        if (current !== command.expectedVersion) throw new Error('student-portal-publication-version-conflict');
        const summary = await scopedSummaryV2(tx, scope);
        if (summary.count === 0) throw new Error('student-portal-publication-forbidden');
        const removed = command.operation === 'unpublish';
        if (!removed && 'targetDataVersion' in command && command.targetDataVersion !== summary.dataVersion)
          throw new Error('student-portal-publication-source-conflict');
        const periodState = summary.items.find((item) => item.period === command.period);
        if (!periodState) throw new Error('student-portal-publication-no-data-conflict');
        if (!removed && !periodState.availableRevision)
          throw new Error('student-portal-publication-no-data-conflict');
        if (command.operation === 'publish-update') {
          if (!summary.allPublished.has(command.period))
            throw new Error('student-portal-publication-not-published');
          if (periodState.state !== 'update-pending')
            throw new Error('student-portal-publication-no-update-conflict');
        }
        const version = versionV1.parse(current + 1);
        await tx.unsafe(`INSERT INTO student_portal.publication_release_v2
          (scope_key,scope_kind,academic_year,class_id,account_id,bound_class_id,period,target_revision,version,released_at)
          VALUES($1,$2,2026,$3,$4::uuid,$5,$6,$7,$8,$9::timestamptz)
          ON CONFLICT(scope_key,period) DO UPDATE SET target_revision=EXCLUDED.target_revision,
            bound_class_id=EXCLUDED.bound_class_id,version=EXCLUDED.version,released_at=EXCLUDED.released_at`,
        [scopedKeyV2(scope), scope.kind, scope.kind === 'class' ? scope.classId : null,
          scope.kind === 'account' ? scope.accountId : null, scope.kind === 'account' ? summary.classId : null,
          command.period, removed ? null : summary.dataVersion, version, now.toISOString()]);
        await tx.unsafe('UPDATE student_portal.publication_control_v2 SET version=$1 WHERE academic_year=2026', [version]);
        const operationId = crypto.randomUUID();
        await store.appendAudit({ eventId: crypto.randomUUID(), at: now.toISOString(), actorId: actor,
          accountId: scope.kind === 'account' ? scope.accountId : null, scope,
          kind: removed ? 'unpublished' : 'published', result: 'success', requestId: command.idempotencyKey, version, maskedIp: null });
        await store.saveIdempotency({ key: command.idempotencyKey, actorId: receiptActor, requestDigest: digest,
          operationId, version, expiresAt: new Date(now.getTime() + 86_400_000).toISOString() });
        return { operationId, version };
      });
    });
  }
}
