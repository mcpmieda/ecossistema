import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';

/** Exercise helper only. Never import into a deployed Worker or expose a recovery/reset API. */
export async function quarantineSyntheticRestoreV1(
  sql: StudentPortalPostgresSqlV1,
  servingGate: 'closed',
) {
  if (servingGate !== 'closed') throw new Error('synthetic-recovery-gate-required');
  return sql.begin(async (tx) => {
    const identity = await tx.unsafe('SELECT current_database() AS database');
    if (identity[0]?.database !== 'portal705_test')
      throw new Error('synthetic-recovery-database-required');
    await tx.unsafe('SELECT pg_advisory_xact_lock(613,0)');
    await tx.unsafe('SELECT pg_advisory_xact_lock(613,2026)');
    await tx.unsafe(
      'UPDATE student_portal.lifecycle_control SET population_enabled=false WHERE academic_year=2026',
    );
    await tx.unsafe(`UPDATE student_portal.account SET blocked=true,auth_state='reset-required',security_version=security_version+1,
      pin_version=pin_version+1,version=version+1,updated_at=statement_timestamp() WHERE academic_year=2026`);
    await tx.unsafe(
      `UPDATE student_portal.qr_credential SET state='revoked',revoked_at=statement_timestamp() WHERE state='active'`,
    );
    await tx.unsafe(
      'UPDATE student_portal.session SET revoked_at=statement_timestamp() WHERE revoked_at IS NULL',
    );
    await tx.unsafe(
      'UPDATE student_portal.auth_challenge SET consumed_at=statement_timestamp() WHERE consumed_at IS NULL',
    );
    await tx.unsafe(`UPDATE student_portal.password_credential p SET pin_verifier=NULL,password_verifier=NULL,pin_version=a.pin_version,
      updated_at=statement_timestamp() FROM student_portal.account a WHERE a.id=p.account_id`);
    // A restored value cannot silently be treated as current confirmation. Clear only this synthetic fixture.
    await tx.unsafe(`UPDATE student_portal.account_access_data SET birth_year=NULL,confirmation=NULL,version=version+1,
      updated_at=statement_timestamp() WHERE birth_year IS NOT NULL`);
    await tx.unsafe(
      "UPDATE student_portal.publication_job SET state='failed',attempts=0,lease_until=NULL,updated_at=statement_timestamp() WHERE state IN ('queued','running')",
    );
    await tx.unsafe(
      "UPDATE student_portal.publication SET state='no-data',available_revision=NULL,published_revision=NULL,version=version+1,updated_at=statement_timestamp()",
    );
    await tx.unsafe('DELETE FROM student_portal.operation_receipt');
    await tx.unsafe(
      'UPDATE student_portal.link_close_preview SET consumed_at=statement_timestamp() WHERE consumed_at IS NULL',
    );
    await tx.unsafe(
      'UPDATE student_portal.year_reset_preview_proof SET consumed_at=statement_timestamp() WHERE consumed_at IS NULL',
    );
    // Preserve academic facts, all key versions, audit, revision authority and link-closure tombstones.
  });
}
