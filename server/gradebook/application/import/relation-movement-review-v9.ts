import type { GradebookRelationImportRequestV9 } from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { GradebookPostgresReadPortV1 } from '../../persistence/postgres/postgres-database-v1';
import { yearResetDigestV1 } from '../../../student-portal/integration/year-reset/proof-v1';

/** A compare-and-swap proof, not permission to bypass identity checks. No preview state is written. */
export async function relationMovementDigestV9(
  database: GradebookPostgresReadPortV1,
  request: GradebookRelationImportRequestV9,
  actorId: string,
  classes: readonly Record<string, unknown>[],
  bindings: readonly Record<string, unknown>[],
): Promise<string> {
  const revisions = await database.query(
    `SELECT student_portal.reconciliation_revision_v1($1::smallint) AS academic_revision,
      (SELECT generation::text FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=$1) AS generation,
      (SELECT revision::text FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=$1) AS revision`,
    [request.ano],
  );
  return yearResetDigestV1(JSON.stringify({
    version: 1, actorId,
    request: { transportVersion: request.transportVersion, operation: request.operation,
      manifest: request.manifest, ano: request.ano, turmas: request.turmas },
    classes, bindings, revisions,
  }));
}
