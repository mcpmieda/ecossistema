import { adminReadResponseV2, type AdminReadQueryV2 } from '../../../shared/student-portal-contracts/admin-read-v2';
import {
  StudentPortalPostgresPersistenceV1,
  type StudentPortalPostgresQueryV1,
  type StudentPortalPostgresSqlV1,
} from '../persistence/postgres-persistence-v1';
import { publicationContextV1 } from '../publication/self-projection-reader-v1';
import { termClosingPreviewV2 } from '../publication/scoped-self-v2';

/**
 * Fechamento do trimestre preview in the student's record (D12, R7). Same engine and
 * variants as the student page, inside the caller's read-only snapshot; like the other record
 * reads it writes nothing. Unresolved, closed, blocked or ineligible links return `available: false`.
 */
export async function readClosingPreviewV2(
  tx: StudentPortalPostgresQueryV1,
  query: AdminReadQueryV2,
  requestId: string,
  now: Date,
) {
  if (query.scope.kind !== 'account') throw new Error('student-portal-closing-preview-invalid-request');
  const accountId = query.scope.accountId.toLowerCase();
  const sql: StudentPortalPostgresSqlV1 = { unsafe: (text, values) => tx.unsafe(text, values), begin: (run) => run(tx) };
  const context = await new StudentPortalPostgresPersistenceV1(sql).transaction((store) =>
    publicationContextV1(sql, tx, store, accountId, false, false),
  );
  const preview = context
    ? await termClosingPreviewV2(tx, context)
    : { mode: 'conclusion' as const, closedPeriods: [], visibleToStudent: false, subjects: [], summary: undefined };
  return adminReadResponseV2.parse({
    contractVersion: 2,
    requestId,
    observedAt: now.toISOString(),
    state: 'closing-preview',
    scope: query.scope,
    available: context !== null,
    visibleToStudent: preview.visibleToStudent,
    mode: preview.mode,
    closedPeriods: preview.closedPeriods,
    subjects: preview.subjects,
    ...(preview.summary ? { summary: preview.summary } : {}),
  });
}
