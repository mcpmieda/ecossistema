import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  confirmationPhraseForYearResetV1,
  yearResetRequestSchemaV1,
} from '../../../shared/gradebook-contracts/settings/year-reset-contract-v1';

let pg: PGlite;
const migrationPath = 'migrations/gradebook-simplified/0008_year_reset_acl_v1.sql';

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec(
    'CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;',
  );
  await pg.exec(
    readFileSync('migrations/gradebook-simplified/application_role_grants.sql', 'utf8'),
  );
  for (const file of [
    '0003_council_session_v3.sql',
    '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql',
    '0009_granular_observations_names_v1.sql',
    '0008_year_reset_acl_v1.sql',
  ]) {
    await pg.exec(readFileSync(`migrations/gradebook-simplified/${file}`, 'utf8'));
  }
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe('year reset V1 contract and ACL', () => {
  it('requires an exact, explicit and revision-bound command', () => {
    const preview = { contractVersion: 1, operation: 'preview', year: 2025 } as const;
    const execute = {
      contractVersion: 1,
      operation: 'execute',
      year: 2025,
      previewRevision: 'a'.repeat(64),
      confirmationPhrase: confirmationPhraseForYearResetV1(2025),
      understandsIrreversible: true,
    } as const;
    expect(yearResetRequestSchemaV1.safeParse(preview).success).toBe(true);
    expect(yearResetRequestSchemaV1.safeParse(execute).success).toBe(true);
    expect(
      yearResetRequestSchemaV1.safeParse({ ...execute, understandsIrreversible: false }).success,
    ).toBe(false);
    expect(yearResetRequestSchemaV1.safeParse({ ...execute, extra: true }).success).toBe(false);
    expect(yearResetRequestSchemaV1.safeParse({ ...preview, year: 1999 }).success).toBe(false);
  });

  it('adds only the bounded DELETE privilege required by the authenticated executor', async () => {
    const rows = (
      await pg.query(`SELECT r.rolname,
        has_schema_privilege(r.rolname,'gradebook','USAGE') AS schema_usage,
        has_table_privilege(r.rolname,'gradebook.boletim_snapshot','SELECT') AS bulletin_select,
        has_table_privilege(r.rolname,'gradebook.boletim_snapshot','DELETE') AS bulletin_delete,
        has_table_privilege(r.rolname,'gradebook.conselho_fechamento','DELETE') AS council_delete,
        has_table_privilege(r.rolname,'gradebook.importacao_diagnostico_tratamento','DELETE') AS audit_delete
      FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','gradebook_app')
      ORDER BY r.rolname`)
    ).rows;
    expect(rows).toEqual([
      {
        rolname: 'anon',
        schema_usage: false,
        bulletin_select: false,
        bulletin_delete: false,
        council_delete: false,
        audit_delete: false,
      },
      {
        rolname: 'authenticated',
        schema_usage: false,
        bulletin_select: false,
        bulletin_delete: false,
        council_delete: false,
        audit_delete: false,
      },
      {
        rolname: 'gradebook_app',
        schema_usage: true,
        bulletin_select: true,
        bulletin_delete: true,
        council_delete: true,
        audit_delete: true,
      },
    ]);
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|UPDATE|INSERT)\b/iu);
    expect(migration).not.toMatch(/\bGRANT\s+(?:ALL|TRUNCATE)\b/iu);
  });
});
