import type { PortalTransactionV1 } from '../../../shared/student-portal-contracts/ports-v1';
import {
  StudentPortalPostgresPersistenceV1,
  type StudentPortalPostgresQueryV1,
  type StudentPortalPostgresSqlV1,
} from '../persistence/postgres-persistence-v1';

/** Authorization and data share one committed snapshot. Never use this helper for commands.
 * A revocation committed before the snapshot is visible; bytes already in flight cannot be revoked.
 * PostgreSQL enforces READ ONLY, so accidental writes and FOR UPDATE locks fail instead of leaking in.
 */
export function readPortalSnapshotV2<T>(
  sql: StudentPortalPostgresSqlV1,
  run: (tx: StudentPortalPostgresQueryV1, store: PortalTransactionV1) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return new StudentPortalPostgresPersistenceV1({
      unsafe: (query, values) => tx.unsafe(query, values),
      begin: (operation) => operation(tx),
    }).transaction((store) => run(tx, store));
  });
}
