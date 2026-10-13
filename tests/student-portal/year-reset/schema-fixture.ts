import { readFileSync } from 'node:fs';

// Complete private schema on a disposable test database, never a production fallback.
export async function installResetSchemaFixtureV1(database: {
  exec(sql: string): Promise<unknown>;
}): Promise<void> {
  await database.exec(
    'ALTER TABLE gradebook.fechamento ADD COLUMN IF NOT EXISTS rec_rr_mask SMALLINT NOT NULL DEFAULT 0',
  );
  await database.exec(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gradebook_app') THEN
      CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$;`);
  for (const name of [
    '0001_identity_credentials_acl_v1.sql',
    '0002_policy_publication_revision_v1.sql',
    '0003_audit_receipts_closure_integration_v1.sql',
    '0004_gradebook_integration_usage_v1.sql',
    '0005_year_reset_protocol_v1.sql',
    '0006_gradebook_revision_year_range_v1.sql',
    '0007_lifecycle_integration_v1.sql',
    '0014_year_reset_full_cleanup_v1.sql',
    '0020_term_closing_policy_v1.sql',
    '0023_audit_detail_v1.sql',
  ])
    await database.exec(readFileSync(`migrations/student-portal/${name}`, 'utf8'));
  await installShiftReadViewFixtureV1(database);
  await installLegacyBirthReadFixtureV1(database);
}

/** Historical schemas have only the legacy source; current runtime still uses the single reader. */
export async function installLegacyBirthReadFixtureV1(database: { exec(sql: string): Promise<unknown> }): Promise<void> {
  await database.exec(`CREATE VIEW student_portal.account_birth_v1 AS
    SELECT a.id AS account_id,d.birth_year,d.confirmation,COALESCE(d.version,0)::bigint AS version,
      CASE WHEN d.birth_year IS NULL THEN 'missing' ELSE 'legacy' END AS source
    FROM student_portal.account a LEFT JOIN student_portal.account_access_data d ON d.account_id=a.id;
    GRANT SELECT ON student_portal.account_birth_v1 TO student_portal_app;`);
}

/** This historical fixture predates atomic publication (0008). Current policy reads need the
 * narrow class view, but installing the replacement pin function here would collide with the
 * original CREATE FUNCTION in fixtures that subsequently install 0008. Reuse the actual view
 * DDL; shift-policy tests apply the complete 0022 migration after 0008/0013/0021. */
export async function installShiftReadViewFixtureV1(database: {
  exec(sql: string): Promise<unknown>;
}): Promise<void> {
  const migration = readFileSync('migrations/student-portal/0022_shift_policy_v1.sql', 'utf8');
  const view = migration.match(/CREATE OR REPLACE VIEW student_portal\.academic_class_v1[\s\S]+?GRANT SELECT ON student_portal\.academic_class_v1 TO student_portal_app;/u)?.[0];
  if (!view) throw new Error('Missing shift-policy view migration');
  await database.exec(view);
}

/** Current Relação writers require the shared UID and reconciliation evidence tables. */
export async function installReconciliationSchemaFixtureV1(
  database: { exec(sql: string): Promise<unknown> },
  sharedIdentityAlreadyInstalled = false,
): Promise<void> {
  await database.exec(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  END $$;`);
  if (!sharedIdentityAlreadyInstalled) {
    await database.exec(readFileSync('migrations/student-portal/0018_shared_student_identity_v1.sql', 'utf8'));
  }
  await database.exec(readFileSync('migrations/gradebook-simplified/0015_student_reconciliation_v1.sql', 'utf8'));
}
