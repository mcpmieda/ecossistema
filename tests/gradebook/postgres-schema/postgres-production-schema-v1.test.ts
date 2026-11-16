// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = join(
  process.cwd(),
  'migrations',
  'postgres',
  '0002_gradebook_production_v1.sql',
);
const sql = readFileSync(migrationPath, 'utf8').replace(/\r\n/gu, '\n');

const expectedTables = [
  'gradebook_schema_migrations',
  'academic_years',
  'academic_year_configuration_versions',
  'academic_year_versions',
  'academic_entity_streams',
  'academic_entity_versions',
  'logical_sources',
  'source_file_streams',
  'source_file_versions',
  'source_file_logical_source_candidates',
  'import_batch_streams',
  'import_batch_versions',
  'import_batch_files',
  'import_diagnostics',
  'academic_record_streams',
  'academic_record_versions',
  'audit_record_streams',
  'audit_record_versions',
  'audit_occurrence_transitions',
  'logical_source_record_streams',
  'logical_source_record_versions',
  'bulletin_snapshot_streams',
  'bulletin_snapshot_versions',
  'council_decision_streams',
  'council_decision_versions',
  'council_session_streams',
  'council_session_versions',
  'gradebook_import_stage_sessions',
  'gradebook_import_stage_chunks',
] as const;

const expectedLogicalMigrations = [
  'gradebook_context_entities_imports_v1',
  'gradebook_records_audit_v1',
  'logical_source_record_catalog_v1',
  'bulletin_council_durability_v1',
  'council_session_durability_v2',
  'import_staging_v1',
] as const;

describe('PostgreSQL gradebook production schema v1', () => {
  it('creates a dedicated gradebook schema and ports every canonical D1 table through 0006', () => {
    expect(sql).toMatch(/CREATE SCHEMA IF NOT EXISTS gradebook;/u);

    for (const table of expectedTables) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS gradebook.${table}`);
    }

    expect(sql.match(/CREATE TABLE IF NOT EXISTS gradebook\./gu)).toHaveLength(
      expectedTables.length,
    );
  });

  it('uses PostgreSQL-native JSON and time types without SQLite-only syntax', () => {
    expect(sql).toMatch(/\bJSONB\b/u);
    expect(sql).toMatch(/\bTIMESTAMPTZ\b/u);
    expect(sql).toMatch(/\bDATE\b/u);

    expect(sql).not.toMatch(/\bPRAGMA\b/u);
    expect(sql).not.toMatch(/\bSTRICT\b/u);
    expect(sql).not.toMatch(/\bGLOB\b/u);
    expect(sql).not.toMatch(/json_valid\s*\(/u);
    expect(sql).not.toMatch(/INSERT\s+OR\s+IGNORE/iu);
    expect(sql).not.toMatch(/strftime\s*\(/iu);
  });

  it('preserves version sequencing, source association integrity and staging cleanup', () => {
    expect(sql).toContain('(version = 1 AND previous_version IS NULL)');
    expect(sql).toContain('(version > 1 AND previous_version = version - 1)');

    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_source_file_versions_confirmed_source',
    );
    expect(sql).toContain(
      'REFERENCES gradebook.source_file_versions (\n    academic_year_id,\n    manifest_id,\n    version,\n    confirmed_logical_source_id\n  )',
    );

    expect(sql).toMatch(
      /REFERENCES gradebook\.gradebook_import_stage_sessions \(session_id\)\s+ON DELETE CASCADE/u,
    );
  });

  it('registers the six logical schema migrations and denies PUBLIC access', () => {
    for (const migration of expectedLogicalMigrations) {
      expect(sql).toContain(`'${migration}'`);
    }

    expect(sql).toContain('REVOKE ALL ON SCHEMA gradebook FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA gradebook FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gradebook FROM PUBLIC;');
    expect(sql).toContain(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA gradebook REVOKE ALL ON TABLES FROM PUBLIC;',
    );
  });

  it('keeps academic authority as data, separate from the storage provider', () => {
    expect(sql).toContain(
      "authority_mode TEXT NOT NULL CHECK (authority_mode IN ('imported-source', 'native-engine'))",
    );
    expect(sql).not.toMatch(/PROD_DB|GRADEBOOK_D1|Hyperdrive|Supabase/u);
  });
});
