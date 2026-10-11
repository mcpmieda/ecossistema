// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  GRADEBOOK_CURRENT_CATALOG_V1,
  GRADEBOOK_CURRENT_SCHEMA_PLAN_V1,
  GRADEBOOK_CURRENT_SEQUENCE_NAMES_V1,
  GRADEBOOK_CURRENT_TABLES_V1,
  GRADEBOOK_RECONCILIATION_SCHEMA_PLAN_V1,
  GRADEBOOK_RECONCILIATION_TABLES_V1,
} from '../../../server/gradebook/recovery/current-gradebook-schema-v1';
import { compareCanonicalStringsV1 } from '../../../shared/gradebook-contracts/string-order-v1';

const root = process.cwd();

describe('current Gradebook recovery catalog V1', () => {
  it('pins the current physical catalog measured by the native PostgreSQL gate', () => {
    expect(GRADEBOOK_CURRENT_CATALOG_V1).toEqual({
      tables: 30,
      columns: 251,
      constraints: 223,
      indexes: 70,
      foreignKeys: 52,
      sequences: 13,
      functions: 4,
      triggers: 3,
    });
    expect(GRADEBOOK_CURRENT_TABLES_V1).toHaveLength(30);
    expect(new Set(GRADEBOOK_CURRENT_TABLES_V1).size).toBe(30);
    expect(GRADEBOOK_CURRENT_SEQUENCE_NAMES_V1).toHaveLength(13);
    expect(new Set(GRADEBOOK_CURRENT_SEQUENCE_NAMES_V1).size).toBe(13);
  });

  it('replays the current migration lineage without replaying historical 0002', () => {
    expect(GRADEBOOK_CURRENT_SCHEMA_PLAN_V1).toContain('0001_current_schema.sql');
    expect(GRADEBOOK_CURRENT_SCHEMA_PLAN_V1).not.toContain('0002_import_diagnostics_audit_v1.sql');
    expect(GRADEBOOK_CURRENT_SCHEMA_PLAN_V1.at(-1)).toBe('current_cross_schema_indexes_v1.sql');

    for (const file of GRADEBOOK_CURRENT_SCHEMA_PLAN_V1) {
      expect(existsSync(join(root, 'migrations/gradebook-simplified', file)), file).toBe(true);
    }
  });

  it('accounts for every migration file on disk, so the gate cannot silently skip one', () => {
    // The gate replays the applied baseline and the complete dependent candidate package. A new migration
    // left out of the plan would never be applied in CI, and the table-set assertion would
    // still pass because it compares the declared catalog with what the plan created.
    const intentionallyNotReplayed = new Map([
      ['0002_import_diagnostics_audit_v1.sql', 'already folded into the 0001 baseline'],
      ['inspect_current_schema.sql', 'read-only catalog inspection, not a migration'],
    ]);
    const directory = join(root, 'migrations/gradebook-simplified');
    const planned = new Set<string>([
      ...GRADEBOOK_CURRENT_SCHEMA_PLAN_V1,
      ...GRADEBOOK_RECONCILIATION_SCHEMA_PLAN_V1.filter((file) =>
        file.startsWith('gradebook-simplified/'),
      ).map((file) => file.slice('gradebook-simplified/'.length)),
    ]);
    const unaccounted = readdirSync(directory)
      .filter((file) => file.endsWith('.sql'))
      .filter((file) => !planned.has(file) && !intentionallyNotReplayed.has(file))
      .sort(compareCanonicalStringsV1);

    expect(
      unaccounted,
      'add each new migration to the applied or dependent candidate schema plan',
    ).toEqual([]);
    for (const file of intentionallyNotReplayed.keys()) {
      expect(existsSync(join(directory, file)), `stale exclusion ${file}`).toBe(true);
      expect(planned.has(file), `${file} is excluded and planned at once`).toBe(false);
    }
  });

  it('proves the complete candidate package after the Portal baseline instead of omitting dependent migrations', () => {
    expect(GRADEBOOK_RECONCILIATION_SCHEMA_PLAN_V1).toEqual([
      'gradebook-simplified/0015_student_reconciliation_v1.sql',
      'student-portal/0025_reconciliation_credentials_v1.sql',
      'gradebook-simplified/0016_reconciliation_year_reset_v1.sql',
    ]);
    expect(GRADEBOOK_RECONCILIATION_TABLES_V1).toHaveLength(9);
    expect(new Set(GRADEBOOK_RECONCILIATION_TABLES_V1).size).toBe(9);
    for (const file of GRADEBOOK_RECONCILIATION_SCHEMA_PLAN_V1) {
      expect(existsSync(join(root, 'migrations', file)), file).toBe(true);
    }
    const gate = readFileSync(join(root, 'scripts/ci/gradebook-postgres-gate-v1.ts'), 'utf8');
    expect(gate).toContain('await applyReconciliationCandidateSchemaV1(sql, process.cwd())');
    expect(gate).toContain('await assertReconciliationCandidateSchemaV1(sql)');
  });

  it('replays numbered migrations in ascending order', () => {
    const numbered = GRADEBOOK_CURRENT_SCHEMA_PLAN_V1.filter((file) => /^\d{4}_/u.test(file));
    expect(numbered).toEqual([...numbered].sort(compareCanonicalStringsV1));
  });

  it('keeps cross-schema indexes tied to the Portal migration that owns them', () => {
    const supplement = readFileSync(
      join(root, 'migrations/gradebook-simplified/current_cross_schema_indexes_v1.sql'),
      'utf8',
    );
    const portal = readFileSync(
      join(root, 'migrations/student-portal/0010_incremental_publication_v3.sql'),
      'utf8',
    );
    for (const index of [
      'gradebook_nota_history_student_v3',
      'gradebook_nota_history_instrument_v3',
      'gradebook_closing_history_student_v3',
      'gradebook_closing_history_offer_v3',
    ]) {
      expect(supplement).toContain(index);
      expect(portal).toContain(index);
    }
    expect(supplement).toContain('NOT a production migration');
  });

  it('keeps recovery V2 explicitly historical instead of relabeling old data as current', () => {
    const v2 = readFileSync(
      join(root, 'server/gradebook/recovery/logical-backup-recovery-v2.ts'),
      'utf8',
    );
    expect(v2).toContain('Historical recovery contract');
    expect(v2).toContain('must not be');
    expect(v2).toContain('current-gradebook-schema-v1.ts');
  });
});
