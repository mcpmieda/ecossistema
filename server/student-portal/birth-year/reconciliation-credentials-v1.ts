import { z } from 'zod';
import { studentUidV1 } from '../../../shared/student-identity/student-identity-v1';
import type {
  CryptoPortV1,
  ReconciliationCredentialResultV1,
} from '../../../shared/student-portal-contracts/ports-v1';
import type { StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';

export const reconciliationCredentialRequestV1 = z
  .object({
    contractVersion: z.literal(1),
    batchId: studentUidV1,
    generation: studentUidV1,
    expectedScopeRevision: z.number().int().nonnegative().safe(),
  })
  .strict();
const progressV1 = z
  .object({
    state: z.enum(['ready', 'preparing']),
    preparedCount: z.number().int().nonnegative().safe(),
    remainingCount: z.number().int().nonnegative().safe(),
    targets: z
      .array(z.object({ accountId: studentUidV1, year: z.string().regex(/^[0-9]{4}$/u) }).strict())
      .max(4),
  })
  .strict();

/** Only the private Portal capability has this crypto port. No credential is returned to its caller. */
export async function prepareReconciliationCredentialsV1(
  sql: StudentPortalPostgresSqlV1,
  cryptoPort: CryptoPortV1,
  pepperVersion: number,
  actorId: string,
  input: unknown,
): Promise<ReconciliationCredentialResultV1> {
  const request = reconciliationCredentialRequestV1.parse(input);
  const actor = studentUidV1.parse(actorId);
  z.number().int().positive().safe().parse(pepperVersion);
  const progress = async (limit: number) => {
    const rows = await sql.begin((tx) =>
      Promise.resolve(
        tx.unsafe(
          'SELECT student_portal.reconciliation_credential_targets_v1($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::integer) AS progress',
          [request.batchId, actor, request.generation, request.expectedScopeRevision, limit],
        ),
      ),
    );
    return progressV1.parse(rows[0]?.progress);
  };
  try {
    const pending = await progress(4);
    for (const target of pending.targets) {
      // Sequential, outside a database transaction. Keep the existing KDF, pepper and individual salt.
      const verifier = await cryptoPort.deriveVerifier(target.year, pepperVersion);
      await sql.begin((tx) =>
        Promise.resolve(
          tx.unsafe(
            'SELECT student_portal.stage_reconciliation_credential_v1($1::uuid,$2::uuid,$3::uuid,$4::text::jsonb)',
            [request.batchId, actor, target.accountId, JSON.stringify(verifier)],
          ),
        ),
      );
    }
    const completed = pending.targets.length ? await progress(0) : pending;
    return {
      state: completed.state,
      preparedCount: completed.preparedCount,
      remainingCount: completed.remainingCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('student-reconciliation-credential-expired'))
      return { state: 'expired', preparedCount: 0, remainingCount: 0 };
    if (
      /student-reconciliation-credential-(?:conflict|profile-conflict|incomplete)/u.test(message)
    ) {
      return { state: 'conflict', preparedCount: 0, remainingCount: 0 };
    }
    throw new Error('student-reconciliation-credentials-unavailable', { cause: error });
  }
}
