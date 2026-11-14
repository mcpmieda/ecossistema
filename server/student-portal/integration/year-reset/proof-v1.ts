import type { GradebookPostgresReadPortV1 } from '../../../gradebook/persistence/postgres/postgres-database-v1';

type ProofState = 'clear' | 'portal-linked-accounts' | 'not-found' | 'preview-changed';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function yearResetDigestV1(value: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  );
}

export function newYearResetTokenV1(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

// Receives the caller's physical transaction. It never opens another connection.
export async function lockYearResetV1(
  transaction: GradebookPostgresReadPortV1,
  year: number,
  operation: 'preview' | 'execute',
): Promise<void> {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new Error('year-reset-invalid-year');
  }
  await transaction.query(
    operation === 'execute'
      ? 'SELECT pg_advisory_xact_lock(613,0)'
      : 'SELECT pg_advisory_xact_lock_shared(613,0)',
    [],
  );
  await transaction.query('SELECT pg_advisory_xact_lock(613,$1::integer)', [year]);
}

/** Only against a reset in progress (any year), for readers that do not write the year. */
export async function lockYearResetSharedV1(transaction: GradebookPostgresReadPortV1): Promise<void> {
  await transaction.query('SELECT pg_advisory_xact_lock_shared(613,0)', []);
}

export async function yearResetProofV1(
  transaction: GradebookPostgresReadPortV1,
  operation: 'prepare' | 'consume',
  year: number,
  actorDigest: string,
  tokenDigest: string,
): Promise<ProofState> {
  const query =
    operation === 'prepare'
      ? 'SELECT student_portal.prepare_year_reset_v1($1::smallint,$2::text,$3::text) AS state'
      : 'SELECT student_portal.consume_year_reset_v1($1::smallint,$2::text,$3::text) AS state';
  const row = (
    await transaction.query<{ state: unknown }>(query, [year, actorDigest, tokenDigest])
  )[0];
  const allowed =
    operation === 'prepare'
      ? ['clear', 'portal-linked-accounts', 'not-found']
      : ['clear', 'portal-linked-accounts', 'preview-changed'];
  if (!row || typeof row.state !== 'string' || !allowed.includes(row.state)) {
    throw new Error('year-reset-proof-unavailable');
  }
  return row.state as ProofState;
}

export async function completeYearResetV1(
  transaction: GradebookPostgresReadPortV1,
  year: number,
  actorDigest: string,
  tokenDigest: string,
): Promise<void> {
  await transaction.query(
    'SELECT student_portal.complete_year_reset_v1($1::smallint,$2::text,$3::text)',
    [year, actorDigest, tokenDigest],
  );
}
