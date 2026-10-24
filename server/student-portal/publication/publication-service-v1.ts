import { type ScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import type { StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
import { accountTransactionV1 } from '../auth/transaction-v1';
import { currentRevisionV1, PERIODS_V1, publicationAccountsV1, publicationDigestV1, publicationScopeVersionV1 } from './state-v1';
import { scalarTextV1 } from '../../../shared/scalar-text-v1';

/** Read-only legacy publication states. Publishing is owned by ScopedPublicationServiceV2. */
export class PublicationServiceV1 {
  constructor(private readonly sql: StudentPortalPostgresSqlV1) {}

  /** Read-only consumers share the academic barrier, including calls nested in the admin facade. */
  async read(scope: ScopeV1) {
    return accountTransactionV1(this.sql, async (tx) => {
      const accounts = await publicationAccountsV1(tx, scope);
      const ids = JSON.stringify(accounts.map((account) => account.id));
      const rows = await tx.unsafe(`SELECT period,state,available_revision,published_revision,version::text FROM student_portal.publication
        WHERE account_id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::text::jsonb))`, [ids]);
      const version = await publicationScopeVersionV1(tx);
      const currentRevision = await currentRevisionV1(tx);
      return { version, count: accounts.length, items: PERIODS_V1.map((period) => {
        const selected = rows.filter((row) => row.period === period);
        const revisions = [...new Set(selected.map((row) => row.published_revision).filter((value) => value !== null))];
        const published = revisions.length > 0;
        const pending = selected.some((row) => row.state === 'update-pending'
          || (row.published_revision !== null && row.published_revision !== currentRevision));
        return { period, state: pending ? 'update-pending' as const : published ? 'published' as const
          : selected.some((row) => row.state === 'available') ? 'available' as const : 'no-data' as const,
        availableRevision: selected.some((row) => row.available_revision !== null) ? currentRevision : null,
        publishedRevision: revisions.length === 1 ? scalarTextV1(revisions[0]) : revisions.length > 1 ? `mixed:${publicationDigestV1(revisions.sort((left, right) => scalarTextV1(left).localeCompare(scalarTextV1(right))))}` : null,
        version };
      }) };
    });
  }
}
