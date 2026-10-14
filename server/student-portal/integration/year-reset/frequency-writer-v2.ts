import type { GradebookPostgresWritePortV1 } from '../../../gradebook/persistence/postgres/postgres-database-v1';

/** Caller holds the existing annual reset writer lock, on this physical transaction. */
export async function recordFrequencyResetWriteV2(transaction: GradebookPostgresWritePortV1, year: number): Promise<void> {
  if (year !== 2026) throw new Error('frequency-year-invalid');
  const [row] = await transaction.query<{ reset_version: unknown }>(
    'SELECT attendance.record_reset_write_v2($1::smallint) AS reset_version', [year],
  );
  if (!row || typeof row.reset_version !== 'string') throw new Error('frequency-reset-version-unavailable');
}
