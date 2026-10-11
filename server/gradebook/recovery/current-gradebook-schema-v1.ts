import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { compareCanonicalStringsV1 } from '../../../shared/gradebook-contracts/string-order-v1.ts';

export interface CurrentGradebookRecoveryQueryV1 {
  unsafe(
    query: string,
    parameters?: readonly unknown[],
  ): PromiseLike<readonly Record<string, unknown>[]>;
}

export const GRADEBOOK_CURRENT_CATALOG_V1 = {
  tables: 30,
  columns: 251,
  constraints: 223,
  indexes: 70,
  foreignKeys: 52,
  sequences: 13,
  functions: 4,
  triggers: 3,
} as const;

export const GRADEBOOK_CURRENT_TABLES_V1 = [
  'aluno',
  'ano_letivo',
  'ano_letivo_historico',
  'boletim_snapshot',
  'conselho_anterior_historico',
  'conselho_decisao',
  'conselho_decisao_comando',
  'conselho_decisao_historico',
  'conselho_fechamento',
  'conselho_fechamento_item',
  'conselho_idempotencia',
  'conselho_sessao',
  'conselho_sessao_historico',
  'conselho_votacao',
  'conselho_votacao_historico',
  'disciplina',
  'fechamento',
  'fechamento_historico',
  'importacao',
  'importacao_diagnostico',
  'importacao_diagnostico_tratamento',
  'instrumento',
  'instrumento_historico',
  'nota',
  'nota_historico',
  'oferta',
  'professor',
  'turma',
  'vinculo',
  'vinculo_historico',
] as const;

export const GRADEBOOK_CURRENT_SEQUENCE_NAMES_V1 = [
  'aluno_id_seq',
  'conselho_decisao_comando_id_seq',
  'conselho_fechamento_id_seq',
  'conselho_sessao_historico_id_seq',
  'conselho_votacao_historico_id_seq',
  'disciplina_id_seq',
  'importacao_diagnostico_id_seq',
  'importacao_diagnostico_tratamento_id_seq',
  'importacao_id_seq',
  'instrumento_id_seq',
  'oferta_id_seq',
  'professor_id_seq',
  'turma_id_seq',
] as const;

/** Applied academic baseline, also used by historical identity recovery fixtures. */
export const GRADEBOOK_CURRENT_SCHEMA_PLAN_V1 = [
  '0001_current_schema.sql',
  'application_role_grants.sql',
  '0003_council_session_v3.sql',
  '0004_council_v3_least_privilege.sql',
  '0005_relational_bulletin_snapshot_v2.sql',
  '0006_import_diagnostic_treatment_v1.sql',
  '0007_multiyear_rr_v1.sql',
  '0008_year_reset_acl_v1.sql',
  '0009_granular_observations_names_v1.sql',
  '0010_qualitative_corrections_2026_v1.sql',
  '0011_gradebook_rls_v1.sql',
  '0012_current_state_cleanup_v1.sql',
  '0013_default_privileges_hardening_v1.sql',
  '0014_function_execute_hardening_v1.sql',
  'current_cross_schema_indexes_v1.sql',
] as const;

/** Candidate package requires the full applied Portal lineage through 0024, including shared identity. */
export const GRADEBOOK_RECONCILIATION_SCHEMA_PLAN_V1 = [
  'gradebook-simplified/0015_student_reconciliation_v1.sql',
  'student-portal/0025_reconciliation_credentials_v1.sql',
  'gradebook-simplified/0016_reconciliation_year_reset_v1.sql',
] as const;

export const GRADEBOOK_RECONCILIATION_TABLES_V1 = [
  'student_reconciliation_scope_v1',
  'student_report_batch_v1',
  'student_report_class_v1',
  'student_report_pending_row_v1',
  'student_report_profile_v1',
  'student_reconciliation_decision_v1',
  'student_source_record_v1',
  'student_source_observation_v1',
  'student_source_link_v1',
] as const;

function integer(value: unknown, code: string): number {
  let normalized: unknown = value;
  if (typeof value === 'bigint' || typeof value === 'string') normalized = Number(value);
  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized)) throw new Error(code);
  return normalized;
}

async function firstRow(
  sql: CurrentGradebookRecoveryQueryV1,
  query: string,
): Promise<Record<string, unknown>> {
  const rows = Array.from(await sql.unsafe(query));
  const row = rows[0];
  if (!row) throw new Error('gradebook-current-catalog-row-missing');
  return row;
}

export async function provisionCurrentGradebookRolesV1(
  sql: CurrentGradebookRecoveryQueryV1,
): Promise<void> {
  await sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gradebook_app') THEN
      CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      CREATE ROLE anon NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
  END $$`);
}

export async function applyCurrentGradebookSchemaV1(
  sql: CurrentGradebookRecoveryQueryV1,
  repositoryRoot: string,
): Promise<void> {
  const existing = await firstRow(
    sql,
    "SELECT count(*)::integer AS count FROM information_schema.schemata WHERE schema_name='gradebook'",
  );
  if (integer(existing.count, 'gradebook-current-target-count-invalid') !== 0) {
    throw new Error('gradebook-current-target-not-empty');
  }

  await provisionCurrentGradebookRolesV1(sql);
  for (const file of GRADEBOOK_CURRENT_SCHEMA_PLAN_V1) {
    const source = await readFile(
      join(repositoryRoot, 'migrations/gradebook-simplified', file),
      'utf8',
    );
    await sql.unsafe(source);
  }
}

/** Isolated recovery/CI only; production migration authorization is a separate operation. */
export async function applyReconciliationCandidateSchemaV1(
  sql: CurrentGradebookRecoveryQueryV1,
  repositoryRoot: string,
): Promise<void> {
  const prerequisites = await firstRow(
    sql,
    `SELECT
    to_regclass('gradebook.student_identity') IS NOT NULL AS identity_ready,
    to_regclass('student_portal.seal_count_cache_v1') IS NOT NULL AS portal_ready,
    to_regclass('gradebook.student_reconciliation_scope_v1') IS NULL AS candidate_empty`,
  );
  if (
    prerequisites.identity_ready !== true ||
    prerequisites.portal_ready !== true ||
    prerequisites.candidate_empty !== true
  ) {
    throw new Error('gradebook-reconciliation-candidate-prerequisites-invalid');
  }
  for (const file of GRADEBOOK_RECONCILIATION_SCHEMA_PLAN_V1) {
    await sql.unsafe(await readFile(join(repositoryRoot, 'migrations', file), 'utf8'));
  }
}

export async function readCurrentGradebookCatalogV1(
  sql: CurrentGradebookRecoveryQueryV1,
): Promise<typeof GRADEBOOK_CURRENT_CATALOG_V1> {
  const row = await firstRow(
    sql,
    `SELECT
      (SELECT count(*)::integer FROM information_schema.tables
        WHERE table_schema='gradebook' AND table_type='BASE TABLE') AS tables,
      (SELECT count(*)::integer FROM information_schema.columns
        WHERE table_schema='gradebook') AS columns,
      (SELECT count(*)::integer FROM pg_constraint c
        JOIN pg_namespace n ON n.oid=c.connamespace
        WHERE n.nspname='gradebook' AND c.contype<>'n') AS constraints,
      (SELECT count(*)::integer FROM pg_indexes WHERE schemaname='gradebook') AS indexes,
      (SELECT count(*)::integer FROM pg_constraint c
        JOIN pg_namespace n ON n.oid=c.connamespace
        WHERE n.nspname='gradebook' AND c.contype='f') AS foreign_keys,
      (SELECT count(*)::integer FROM pg_sequences WHERE schemaname='gradebook') AS sequences,
      (SELECT count(*)::integer FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='gradebook') AS functions,
      (SELECT count(*)::integer FROM pg_trigger t
        JOIN pg_class r ON r.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=r.relnamespace
        WHERE n.nspname='gradebook' AND NOT t.tgisinternal) AS triggers`,
  );

  const actual = {
    tables: integer(row.tables, 'gradebook-current-catalog-tables-invalid'),
    columns: integer(row.columns, 'gradebook-current-catalog-columns-invalid'),
    constraints: integer(row.constraints, 'gradebook-current-catalog-constraints-invalid'),
    indexes: integer(row.indexes, 'gradebook-current-catalog-indexes-invalid'),
    foreignKeys: integer(row.foreign_keys, 'gradebook-current-catalog-foreign-keys-invalid'),
    sequences: integer(row.sequences, 'gradebook-current-catalog-sequences-invalid'),
    functions: integer(row.functions, 'gradebook-current-catalog-functions-invalid'),
    triggers: integer(row.triggers, 'gradebook-current-catalog-triggers-invalid'),
  };

  for (const [key, expected] of Object.entries(GRADEBOOK_CURRENT_CATALOG_V1)) {
    if (actual[key as keyof typeof actual] !== expected) {
      throw new Error(
        `gradebook-current-catalog-${key}-mismatch: expected=${String(expected)}, actual=${String(actual[key as keyof typeof actual])}`,
      );
    }
  }

  return actual as typeof GRADEBOOK_CURRENT_CATALOG_V1;
}

async function exactNames(
  sql: CurrentGradebookRecoveryQueryV1,
  query: string,
  column: string,
): Promise<readonly string[]> {
  const rows = Array.from(await sql.unsafe(query));
  return rows.map((row) => String(row[column])).sort(compareCanonicalStringsV1);
}

export async function assertCurrentGradebookSchemaV1(
  sql: CurrentGradebookRecoveryQueryV1,
): Promise<void> {
  await readCurrentGradebookCatalogV1(sql);

  const tables = await exactNames(
    sql,
    "SELECT tablename FROM pg_tables WHERE schemaname='gradebook'",
    'tablename',
  );
  if (
    JSON.stringify(tables) !==
    JSON.stringify([...GRADEBOOK_CURRENT_TABLES_V1].sort(compareCanonicalStringsV1))
  ) {
    throw new Error('gradebook-current-table-set-mismatch');
  }

  const sequences = await exactNames(
    sql,
    "SELECT sequencename FROM pg_sequences WHERE schemaname='gradebook'",
    'sequencename',
  );
  if (
    JSON.stringify(sequences) !==
    JSON.stringify([...GRADEBOOK_CURRENT_SEQUENCE_NAMES_V1].sort(compareCanonicalStringsV1))
  ) {
    throw new Error('gradebook-current-sequence-set-mismatch');
  }

  const rls = await firstRow(
    sql,
    `SELECT
      (SELECT count(*)::integer
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='gradebook' AND c.relkind='r' AND c.relrowsecurity) AS enabled,
      (SELECT count(*)::integer
       FROM pg_policies
       WHERE schemaname='gradebook' AND policyname='gradebook_app_backend_v1') AS policies`,
  );
  if (
    integer(rls.enabled, 'gradebook-current-rls-enabled-invalid') !== 30 ||
    integer(rls.policies, 'gradebook-current-rls-policies-invalid') !== 30
  ) {
    throw new Error('gradebook-current-rls-mismatch');
  }

  const role = await firstRow(
    sql,
    "SELECT rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname='gradebook_app'",
  );
  if (role.rolsuper === true || role.rolbypassrls === true || role.rolinherit === true) {
    throw new Error('gradebook-current-role-unsafe');
  }

  const clientAcl = await firstRow(
    sql,
    `SELECT
      has_schema_privilege('anon','gradebook','USAGE') AS anon_schema,
      has_schema_privilege('authenticated','gradebook','USAGE') AS authenticated_schema,
      (SELECT count(*)::integer
       FROM information_schema.table_privileges
       WHERE table_schema='gradebook' AND grantee='PUBLIC') AS public_tables`,
  );
  if (
    clientAcl.anon_schema === true ||
    clientAcl.authenticated_schema === true ||
    integer(clientAcl.public_tables, 'gradebook-current-public-table-privileges-invalid') !== 0
  ) {
    throw new Error('gradebook-current-client-acl-mismatch');
  }
}

export async function assertReconciliationCandidateSchemaV1(
  sql: CurrentGradebookRecoveryQueryV1,
): Promise<void> {
  const expected = [
    ...GRADEBOOK_CURRENT_TABLES_V1,
    'student_identity',
    ...GRADEBOOK_RECONCILIATION_TABLES_V1,
  ].sort(compareCanonicalStringsV1);
  const tables = await exactNames(
    sql,
    "SELECT tablename FROM pg_tables WHERE schemaname='gradebook'",
    'tablename',
  );
  if (JSON.stringify(tables) !== JSON.stringify(expected))
    throw new Error('gradebook-candidate-table-set-mismatch');
  const counts = await firstRow(
    sql,
    `SELECT
    (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='gradebook' AND c.relkind='r' AND c.relrowsecurity) AS rls,
    (SELECT count(*)::integer FROM pg_policies WHERE schemaname='gradebook' AND policyname='reconciliation_backend_v1') AS policies,
    (SELECT count(*)::integer FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='gradebook'
      AND t.relname=ANY(ARRAY['student_reconciliation_scope_v1','student_report_batch_v1','student_report_class_v1',
        'student_report_pending_row_v1','student_report_profile_v1','student_reconciliation_decision_v1',
        'student_source_record_v1','student_source_observation_v1','student_source_link_v1'])
      AND c.contype='f' AND c.convalidated AND c.confdeltype='a') AS foreign_keys,
    (SELECT count(*)::integer FROM information_schema.columns WHERE table_schema='gradebook'
      AND table_name IN ('student_report_pending_row_v1','student_source_observation_v1')
      AND column_name='birth_date' AND data_type='date' AND is_nullable='NO') AS civil_births`,
  );
  if (
    integer(counts.rls, 'candidate-rls-invalid') !== expected.length ||
    integer(counts.policies, 'candidate-policy-count-invalid') !==
      GRADEBOOK_RECONCILIATION_TABLES_V1.length ||
    integer(counts.foreign_keys, 'candidate-fk-count-invalid') !== 24 ||
    integer(counts.civil_births, 'candidate-civil-birth-count-invalid') !== 2
  ) {
    throw new Error('gradebook-candidate-catalog-mismatch:' + JSON.stringify(counts));
  }
}
