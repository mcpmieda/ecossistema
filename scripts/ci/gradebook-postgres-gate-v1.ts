import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import { compareCanonicalStringsV1 } from '../../shared/gradebook-contracts/string-order-v1.ts';

import {
  applyCurrentGradebookSchemaV1,
  applyReconciliationCandidateSchemaV1,
  assertCurrentGradebookSchemaV1,
  assertReconciliationCandidateSchemaV1,
  GRADEBOOK_CURRENT_CATALOG_V1,
  GRADEBOOK_CURRENT_SEQUENCE_NAMES_V1,
  GRADEBOOK_CURRENT_TABLES_V1,
  GRADEBOOK_RECONCILIATION_SCHEMA_PLAN_V1,
  GRADEBOOK_RECONCILIATION_TABLES_V1,
} from '../../server/gradebook/recovery/current-gradebook-schema-v1.ts';

const connectionString = process.env.GRADEBOOK_RECOVERY_DATABASE_URL ?? '';

function validatedTarget(): URL {
  let target: URL;
  try {
    target = new URL(connectionString);
  } catch {
    throw new Error('gradebook-ci-postgres-url-invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(target.protocol)) {
    throw new Error('gradebook-ci-postgres-protocol-invalid');
  }
  const host = target.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    throw new Error('gradebook-ci-postgres-not-loopback');
  }
  if (decodeURIComponent(target.pathname) !== '/gradebook_recovery_ci') {
    throw new Error('gradebook-ci-postgres-database-invalid');
  }
  if (target.search || target.hash) {
    throw new Error('gradebook-ci-postgres-url-components-invalid');
  }
  return target;
}

const sql = postgres(validatedTarget().toString(), {
  max: 1,
  prepare: true,
  ssl: false,
  onnotice: () => undefined,
});

async function firstRow(query: string): Promise<Record<string, unknown>> {
  const rows = await sql.unsafe(query);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error('gradebook-ci-postgres-result-missing');
  return row;
}

type GradebookAclV1 = {
  readonly select: boolean;
  readonly insert: boolean;
  readonly update: boolean;
  readonly delete: boolean;
};

const READ_DELETE_ONLY_TABLES_V1 = new Set<string>(['instrumento_historico', 'nota_historico']);

const APPEND_DELETE_ONLY_TABLES_V1 = new Set<string>([
  'boletim_snapshot',
  'conselho_decisao_comando',
  'conselho_fechamento',
  'conselho_fechamento_item',
  'conselho_idempotencia',
  'conselho_sessao_historico',
  'conselho_votacao_historico',
  'importacao_diagnostico_tratamento',
  'student_source_observation_v1',
  'student_reconciliation_decision_v1',
]);

function expectedCurrentTableAclV1(table: string): GradebookAclV1 {
  if (table === 'student_identity') {
    return { select: true, insert: false, update: false, delete: false };
  }
  if (READ_DELETE_ONLY_TABLES_V1.has(table)) {
    return { select: true, insert: false, update: false, delete: true };
  }
  if (APPEND_DELETE_ONLY_TABLES_V1.has(table)) {
    return { select: true, insert: true, update: false, delete: true };
  }
  return { select: true, insert: true, update: true, delete: true };
}

function booleanField(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw new Error(`gradebook-ci-acl-${key}-invalid`);
  return value;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`gradebook-ci-acl-${key}-invalid`);
  }
  return value;
}

async function assertGradebookSchemaAclV1(): Promise<void> {
  const schema = await firstRow(`
    SELECT
      has_schema_privilege('gradebook_app','gradebook','USAGE') AS schema_usage,
      has_schema_privilege('gradebook_app','gradebook','CREATE') AS schema_create,
      has_schema_privilege('anon','gradebook','USAGE') AS anon_usage,
      has_schema_privilege('authenticated','gradebook','USAGE') AS authenticated_usage
  `);
  const boundary = {
    usage: booleanField(schema, 'schema_usage'),
    create: booleanField(schema, 'schema_create'),
    anonUsage: booleanField(schema, 'anon_usage'),
    authenticatedUsage: booleanField(schema, 'authenticated_usage'),
  };
  if (
    boundary.usage !== true ||
    boundary.create !== false ||
    boundary.anonUsage !== false ||
    boundary.authenticatedUsage !== false
  ) {
    throw new Error('gradebook-ci-acl-schema-boundary-mismatch');
  }
}

async function assertGradebookTableAclV1(candidate = false): Promise<number> {
  const expectedTables = candidate
    ? [...GRADEBOOK_CURRENT_TABLES_V1, 'student_identity', ...GRADEBOOK_RECONCILIATION_TABLES_V1]
    : GRADEBOOK_CURRENT_TABLES_V1;
  const tableRows = Array.from(
    await sql.unsafe(`
    SELECT
      table_name,
      has_table_privilege('gradebook_app', format('%I.%I',table_schema,table_name), 'SELECT') AS can_select,
      has_table_privilege('gradebook_app', format('%I.%I',table_schema,table_name), 'INSERT') AS can_insert,
      has_table_privilege('gradebook_app', format('%I.%I',table_schema,table_name), 'UPDATE') AS can_update,
      has_table_privilege('gradebook_app', format('%I.%I',table_schema,table_name), 'DELETE') AS can_delete,
      (
        has_table_privilege('anon', format('%I.%I',table_schema,table_name), 'SELECT')
        OR has_table_privilege('anon', format('%I.%I',table_schema,table_name), 'INSERT')
        OR has_table_privilege('anon', format('%I.%I',table_schema,table_name), 'UPDATE')
        OR has_table_privilege('anon', format('%I.%I',table_schema,table_name), 'DELETE')
      ) AS anon_any,
      (
        has_table_privilege('authenticated', format('%I.%I',table_schema,table_name), 'SELECT')
        OR has_table_privilege('authenticated', format('%I.%I',table_schema,table_name), 'INSERT')
        OR has_table_privilege('authenticated', format('%I.%I',table_schema,table_name), 'UPDATE')
        OR has_table_privilege('authenticated', format('%I.%I',table_schema,table_name), 'DELETE')
      ) AS authenticated_any
    FROM information_schema.tables
    WHERE table_schema='gradebook' AND table_type='BASE TABLE'
    ORDER BY table_name
  `),
  ) as Record<string, unknown>[];
  if (tableRows.length !== expectedTables.length) {
    throw new Error('gradebook-ci-acl-table-count-mismatch');
  }

  const tableByName = new Map(tableRows.map((row) => [stringField(row, 'table_name'), row]));
  for (const table of expectedTables) {
    const row = tableByName.get(table);
    if (!row) throw new Error(`gradebook-ci-acl-table-missing:${table}`);
    const actual: GradebookAclV1 = {
      select: booleanField(row, 'can_select'),
      insert: booleanField(row, 'can_insert'),
      update: booleanField(row, 'can_update'),
      delete: booleanField(row, 'can_delete'),
    };
    const expected = expectedCurrentTableAclV1(table);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `gradebook-ci-acl-table-mismatch:${table}:expected=${JSON.stringify(expected)}:actual=${JSON.stringify(actual)}`,
      );
    }
    if (booleanField(row, 'anon_any') || booleanField(row, 'authenticated_any')) {
      throw new Error(`gradebook-ci-acl-client-table-grant:${table}`);
    }
  }
  return tableRows.length;
}

async function assertGradebookSequenceAclV1(): Promise<number> {
  const sequenceRows = Array.from(
    await sql.unsafe(`
    SELECT
      sequencename,
      has_sequence_privilege('gradebook_app', format('%I.%I',schemaname,sequencename), 'USAGE') AS can_usage,
      has_sequence_privilege('gradebook_app', format('%I.%I',schemaname,sequencename), 'SELECT') AS can_select,
      has_sequence_privilege('gradebook_app', format('%I.%I',schemaname,sequencename), 'UPDATE') AS can_update
    FROM pg_sequences
    WHERE schemaname='gradebook'
    ORDER BY sequencename
  `),
  ) as Record<string, unknown>[];
  if (sequenceRows.length !== GRADEBOOK_CURRENT_SEQUENCE_NAMES_V1.length) {
    throw new Error('gradebook-ci-acl-sequence-count-mismatch');
  }
  for (const row of sequenceRows) {
    const name = stringField(row, 'sequencename');
    const known = GRADEBOOK_CURRENT_SEQUENCE_NAMES_V1.includes(
      name as (typeof GRADEBOOK_CURRENT_SEQUENCE_NAMES_V1)[number],
    );
    if (
      !known ||
      booleanField(row, 'can_usage') !== true ||
      booleanField(row, 'can_select') !== true ||
      booleanField(row, 'can_update') !== false
    ) {
      throw new Error(`gradebook-ci-acl-sequence-mismatch:${name}`);
    }
  }
  return sequenceRows.length;
}

async function assertGradebookFunctionAclV1(candidate = false): Promise<number> {
  const privateTriggers = new Set([
    'gradebook.guard_student_uid_input_v1()',
    'gradebook.assign_student_uid_v1()',
    'gradebook.reconciliation_observation_immutable_v1()',
  ]);
  const functionRows = Array.from(
    await sql.unsafe(`
    SELECT
      p.oid::regprocedure::text AS function_identity,
      has_function_privilege('gradebook_app',p.oid,'EXECUTE') AS can_execute
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='gradebook'
    ORDER BY p.oid::regprocedure::text
  `),
  ) as Record<string, unknown>[];
  if (
    functionRows.length !==
    GRADEBOOK_CURRENT_CATALOG_V1.functions + (candidate ? privateTriggers.size : 0)
  ) {
    throw new Error('gradebook-ci-acl-function-count-mismatch');
  }
  for (const row of functionRows) {
    const expected = !(candidate && privateTriggers.has(stringField(row, 'function_identity')));
    if (booleanField(row, 'can_execute') !== expected) {
      throw new Error(
        `gradebook-ci-acl-function-execute-missing:${stringField(row, 'function_identity')}`,
      );
    }
  }
  return functionRows.length;
}

async function assertPortalCoordinationAclV1(candidate = false): Promise<number> {
  const portalFunctionRows = Array.from(
    await sql.unsafe(`
    SELECT p.oid::regprocedure::text AS function_identity
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='student_portal'
      AND has_function_privilege('gradebook_app',p.oid,'EXECUTE')
    ORDER BY p.oid::regprocedure::text
  `),
  ) as Record<string, unknown>[];
  const portalCoordinationFunctions = portalFunctionRows.map((row) =>
    stringField(row, 'function_identity'),
  );
  const expectedPortalCoordinationFunctions = [
    'student_portal.complete_year_reset_v1(smallint,text,text)',
    'student_portal.consume_year_reset_v1(smallint,text,text)',
    'student_portal.ensure_year_coordination_v1(smallint)',
    'student_portal.inspect_year_reset_guard_v1(smallint)',
    'student_portal.prepare_year_reset_v1(smallint,text,text)',
    'student_portal.record_gradebook_change_v1(uuid,smallint,text,boolean,integer[],timestamp with time zone)',
    ...(candidate
      ? [
          'student_portal.synchronize_gradebook_profiles_v1()',
          'student_portal.apply_reconciliation_credentials_v1(uuid,uuid)',
          'student_portal.clear_reconciliation_credentials_v1(smallint)',
          'student_portal.reconciliation_credential_counts_v1(smallint)',
          'student_portal.reconciliation_accounts_v1(smallint)',
          'student_portal.reconciliation_revision_v1(smallint)',
          'student_portal.reset_reconciliation_state_v1(smallint)',
        ]
      : []),
  ].sort(compareCanonicalStringsV1);
  if (
    JSON.stringify(portalCoordinationFunctions) !==
    JSON.stringify(expectedPortalCoordinationFunctions)
  ) {
    throw new Error(
      `gradebook-ci-acl-portal-functions-mismatch:actual=${JSON.stringify(portalCoordinationFunctions)}`,
    );
  }

  const portalTables = await firstRow(`
    SELECT count(*)::integer AS count
    FROM information_schema.tables
    WHERE table_schema='student_portal'
      AND (
        has_table_privilege('gradebook_app', format('%I.%I',table_schema,table_name), 'SELECT')
        OR has_table_privilege('gradebook_app', format('%I.%I',table_schema,table_name), 'INSERT')
        OR has_table_privilege('gradebook_app', format('%I.%I',table_schema,table_name), 'UPDATE')
        OR has_table_privilege('gradebook_app', format('%I.%I',table_schema,table_name), 'DELETE')
      )
  `);
  if (Number(portalTables.count) !== 0) {
    throw new Error('gradebook-ci-acl-portal-table-grant');
  }
  return portalCoordinationFunctions.length;
}

async function readGradebookDefaultAclV1(): Promise<{
  readonly broadDefaultTablePrivileges: boolean;
  readonly broadDefaultSequencePrivileges: boolean;
  readonly broadDefaultFunctionPrivileges: boolean;
  readonly publicDefaultFunctionExecute: boolean;
}> {
  const defaults = await firstRow(`
    SELECT
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_default_acl d
        CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
        JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
        JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
        WHERE n.nspname='gradebook'
          AND r.rolname='gradebook_app'
          AND d.defaclobjtype='r'
          AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
      ) AS broad_table_defaults,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_default_acl d
        CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
        JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
        JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
        WHERE n.nspname='gradebook'
          AND r.rolname='gradebook_app'
          AND d.defaclobjtype='S'
          AND a.privilege_type IN ('USAGE','SELECT','UPDATE')
      ) AS broad_sequence_defaults,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_default_acl d
        CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
        JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
        JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
        WHERE n.nspname='gradebook'
          AND r.rolname='gradebook_app'
          AND d.defaclobjtype='f'
          AND a.privilege_type='EXECUTE'
      ) AS broad_function_defaults,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_default_acl d
        CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
        JOIN pg_catalog.pg_roles owner_role ON owner_role.oid=d.defaclrole
        WHERE d.defaclnamespace=0
          AND owner_role.rolname=current_user
          AND a.grantee=0
          AND d.defaclobjtype='f'
          AND a.privilege_type='EXECUTE'
      ) AS public_function_execute
  `);
  return {
    broadDefaultTablePrivileges: booleanField(defaults, 'broad_table_defaults'),
    broadDefaultSequencePrivileges: booleanField(defaults, 'broad_sequence_defaults'),
    broadDefaultFunctionPrivileges: booleanField(defaults, 'broad_function_defaults'),
    publicDefaultFunctionExecute: booleanField(defaults, 'public_function_execute'),
  };
}

function assertGradebookDefaultAclHardenedV1(defaults: {
  readonly broadDefaultTablePrivileges: boolean;
  readonly broadDefaultSequencePrivileges: boolean;
  readonly broadDefaultFunctionPrivileges: boolean;
  readonly publicDefaultFunctionExecute: boolean;
}): void {
  if (
    defaults.broadDefaultTablePrivileges ||
    defaults.broadDefaultSequencePrivileges ||
    defaults.broadDefaultFunctionPrivileges ||
    defaults.publicDefaultFunctionExecute
  ) {
    throw new Error(`gradebook-ci-acl-defaults-not-hardened:${JSON.stringify(defaults)}`);
  }
}

async function assertFutureGradebookObjectAclV1(): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE gradebook.__bn_acl_probe_table_v1 (id integer);
    CREATE SEQUENCE gradebook.__bn_acl_probe_sequence_v1;
    CREATE FUNCTION gradebook.__bn_acl_probe_function_v1()
      RETURNS integer
      LANGUAGE sql
      SET search_path TO 'pg_catalog'
      AS 'SELECT 1';
  `);
  try {
    const probe = await firstRow(`
      SELECT
        (
          has_table_privilege('gradebook_app','gradebook.__bn_acl_probe_table_v1','SELECT')
          OR has_table_privilege('gradebook_app','gradebook.__bn_acl_probe_table_v1','INSERT')
          OR has_table_privilege('gradebook_app','gradebook.__bn_acl_probe_table_v1','UPDATE')
          OR has_table_privilege('gradebook_app','gradebook.__bn_acl_probe_table_v1','DELETE')
        ) AS app_table_any,
        (
          has_sequence_privilege('gradebook_app','gradebook.__bn_acl_probe_sequence_v1','USAGE')
          OR has_sequence_privilege('gradebook_app','gradebook.__bn_acl_probe_sequence_v1','SELECT')
          OR has_sequence_privilege('gradebook_app','gradebook.__bn_acl_probe_sequence_v1','UPDATE')
        ) AS app_sequence_any,
        has_function_privilege(
          'gradebook_app',
          'gradebook.__bn_acl_probe_function_v1()',
          'EXECUTE'
        ) AS app_function_execute,
        has_function_privilege(
          'anon',
          'gradebook.__bn_acl_probe_function_v1()',
          'EXECUTE'
        ) AS anon_function_execute,
        has_function_privilege(
          'authenticated',
          'gradebook.__bn_acl_probe_function_v1()',
          'EXECUTE'
        ) AS authenticated_function_execute
    `);
    const inherited = {
      appTable: booleanField(probe, 'app_table_any'),
      appSequence: booleanField(probe, 'app_sequence_any'),
      appFunction: booleanField(probe, 'app_function_execute'),
      anonFunction: booleanField(probe, 'anon_function_execute'),
      authenticatedFunction: booleanField(probe, 'authenticated_function_execute'),
    };
    if (Object.values(inherited).some(Boolean)) {
      throw new Error(
        `gradebook-ci-acl-future-object-inherited-privilege:${JSON.stringify(inherited)}`,
      );
    }
  } finally {
    await sql.unsafe(`
      DROP FUNCTION gradebook.__bn_acl_probe_function_v1();
      DROP TABLE gradebook.__bn_acl_probe_table_v1;
      DROP SEQUENCE gradebook.__bn_acl_probe_sequence_v1;
    `);
  }
}

async function assertCurrentGradebookAclV1(candidate = false): Promise<{
  readonly tables: number;
  readonly sequences: number;
  readonly functions: number;
  readonly portalCoordinationFunctions: number;
  readonly broadDefaultTablePrivileges: boolean;
  readonly broadDefaultSequencePrivileges: boolean;
  readonly broadDefaultFunctionPrivileges: boolean;
  readonly publicDefaultFunctionExecute: boolean;
}> {
  await assertGradebookSchemaAclV1();
  const [tables, sequences, functions, portalCoordinationFunctions, defaults] = await Promise.all([
    assertGradebookTableAclV1(candidate),
    assertGradebookSequenceAclV1(),
    assertGradebookFunctionAclV1(candidate),
    assertPortalCoordinationAclV1(candidate),
    readGradebookDefaultAclV1(),
  ]);
  assertGradebookDefaultAclHardenedV1(defaults);
  return {
    tables,
    sequences,
    functions,
    portalCoordinationFunctions,
    ...defaults,
  };
}

async function seedSyntheticCurrentState(): Promise<void> {
  await sql.unsafe(
    'INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho) VALUES (2026,60000,2);' +
      "INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES (10,2026,'CI6A','6º ANO CI',6,'M');" +
      "INSERT INTO gradebook.professor (id,ano,nome) VALUES (1,2026,'DOCENTE SINTÉTICO CI');" +
      "INSERT INTO gradebook.disciplina (id,ano,nome) VALUES (1,2026,'PORTUGUÊS'),(2,2026,'MATEMÁTICA');" +
      'INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id) VALUES (10,2026,10,1,1),(20,2026,10,1,2);' +
      "INSERT INTO gradebook.aluno (id,ano,nome) VALUES (1,2026,'ALUNO SINTÉTICO CI A'),(2,2026,'ALUNO SINTÉTICO CI B');" +
      'INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id,situacao) VALUES (2026,10,1,1,NULL),(2026,10,2,2,NULL);' +
      'INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao) ' +
      'SELECT oferta_id*1000+trimestre*100+slot,oferta_id,trimestre,slot,' +
      'CASE WHEN slot=11 THEN CASE WHEN trimestre=3 THEN 22000 ELSE 16500 END ELSE CASE WHEN trimestre=3 THEN 9000 ELSE 6750 END END,' +
      "CASE slot WHEN 1 THEN 'AV1' WHEN 2 THEN 'AV2' ELSE 'ATIVIDADE' END " +
      'FROM (VALUES (10),(20)) oferta(oferta_id) CROSS JOIN generate_series(1,3) trimestre CROSS JOIN (VALUES (1),(2),(11)) instrumento(slot);' +
      'INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor) ' +
      'SELECT id,aluno_id,CASE WHEN aluno_id=1 THEN maximo ELSE maximo/2 END FROM gradebook.instrumento CROSS JOIN (VALUES (1),(2)) aluno(aluno_id);' +
      'INSERT INTO gradebook.fechamento (oferta_id,aluno_id,am1_fonte,am2_fonte,am3_fonte,rec_nc_mask,rec_rr_mask,u_fonte) VALUES ' +
      '(10,1,30000,30000,40000,0,0,100000),(20,1,30000,30000,40000,0,0,100000),' +
      '(10,2,15000,15000,20000,0,0,50000),(20,2,15000,15000,20000,0,0,50000);',
  );
}

async function installPortalCoordination(): Promise<void> {
  const migrations = [
    '0001_identity_credentials_acl_v1.sql',
    '0002_policy_publication_revision_v1.sql',
    '0003_audit_receipts_closure_integration_v1.sql',
    '0004_gradebook_integration_usage_v1.sql',
    '0005_year_reset_protocol_v1.sql',
    '0006_gradebook_revision_year_range_v1.sql',
  ] as const;

  for (const file of migrations) {
    const source = await readFile('migrations/student-portal/' + file, 'utf8');
    await sql.unsafe(source);
  }

  const revision = await firstRow(
    'SELECT academic_year::integer AS academic_year, academic_counter::integer AS academic_counter, reset_counter::integer AS reset_counter FROM student_portal.academic_revision WHERE academic_year=2026',
  );
  if (
    Number(revision.academic_year) !== 2026 ||
    Number(revision.academic_counter) !== 1 ||
    Number(revision.reset_counter) !== 1
  ) {
    throw new Error('gradebook-ci-postgres-portal-coordination-mismatch');
  }
}

async function completePortalBaseline(): Promise<void> {
  const remaining = (await readdir('migrations/student-portal'))
    .filter(
      (file) =>
        /^\d{4}_.+\.sql$/u.test(file) &&
        Number(file.slice(0, 4)) > 6 &&
        Number(file.slice(0, 4)) <= 24,
    )
    .sort(compareCanonicalStringsV1);
  if (remaining.length !== 18) throw new Error('gradebook-ci-portal-lineage-incomplete');
  for (const file of remaining) {
    if (file.startsWith('0019_')) {
      // Synthetic isolated replay satisfies the historical, already-approved publication cutover.
      await sql.unsafe('UPDATE student_portal.publication_control_v2 SET enabled=true');
    }
    await sql.unsafe(await readFile('migrations/student-portal/' + file, 'utf8'));
  }
}

async function assertReconciliationBridgeV1(): Promise<void> {
  const boundary = await firstRow(`SELECT
    (SELECT count(*)::integer FROM pg_roles WHERE rolname='student_reconciliation_bridge_v1'
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin AND NOT rolinherit
      AND NOT rolcreatedb AND NOT rolcreaterole) AS safe_owner,
    (SELECT count(*)::integer FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
      WHERE r.rolname='student_reconciliation_bridge_v1' AND c.relkind IN ('r','p')) AS owned_tables,
    (SELECT count(*)::integer FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE r.rolname='student_reconciliation_bridge_v1'
      AND n.nspname='student_portal' AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']
      AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
      AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')) AS narrow_functions,
    (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='student_portal' AND c.relname IN ('reconciliation_birth_v1','reconciliation_credential_stage_v1','reconciliation_credential_attempt_v1')
      AND c.relrowsecurity
      AND NOT has_table_privilege('student_portal_app',c.oid,'SELECT,INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege('gradebook_app',c.oid,'SELECT,INSERT,UPDATE,DELETE')) AS private_tables`);
  if (
    Number(boundary.safe_owner) !== 1 ||
    Number(boundary.owned_tables) !== 0 ||
    Number(boundary.narrow_functions) !== 12 ||
    Number(boundary.private_tables) !== 3
  ) {
    throw new Error('gradebook-ci-reconciliation-bridge-mismatch:' + JSON.stringify(boundary));
  }
}

async function assertReconciliationForeignKeysV1(): Promise<void> {
  await sql.unsafe('BEGIN');
  try {
    await sql.unsafe(`SET LOCAL ROLE gradebook_app;
      INSERT INTO gradebook.student_reconciliation_scope_v1(academic_year,generation)
        VALUES(2026,'00000000-0000-4000-8000-000000000001');
      INSERT INTO gradebook.student_report_batch_v1(id,academic_year,generation,actor_id,source_evidence,
        normalization_version,digest,request_digest,idempotency_key,base_revision,base_academic_revision,state,expires_at,class_links)
        VALUES('00000000-0000-4000-8000-000000000002',2026,'00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000003','unknown',1,repeat('a',64),repeat('b',64),
          '00000000-0000-4000-8000-000000000004',0,'synthetic','preparing',now()+interval '24 hours','[]');
      INSERT INTO gradebook.student_report_class_v1(id,academic_year,label,class_key,shift,shift_key,stage_label,stage,gradebook_class_id)
        VALUES('00000000-0000-4000-8000-000000000005',2026,'SYNTHETIC CLASS','SYNTHETIC CLASS','M','M','6',6,10);
      INSERT INTO gradebook.student_source_record_v1(id,academic_year,last_batch_id)
        VALUES('00000000-0000-4000-8000-000000000006',2026,'00000000-0000-4000-8000-000000000002');
      INSERT INTO gradebook.student_source_observation_v1(id,academic_year,source_id,version,batch_id,report_class_id,
        name,name_key,birth_date,enrollment_hash,shift,shift_key,status,status_key)
        VALUES('00000000-0000-4000-8000-000000000007',2026,'00000000-0000-4000-8000-000000000006',1,
          '00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000005',
          'SYNTHETIC PERSON','SYNTHETIC PERSON','2012-02-03','synthetic','M','M','ATIVO','ATIVO');
      INSERT INTO gradebook.student_reconciliation_decision_v1(id,academic_year,generation,sequence,actor_id,action,source_id,student_uid,reason)
        SELECT '00000000-0000-4000-8000-000000000008',2026,'00000000-0000-4000-8000-000000000001',1,
          '00000000-0000-4000-8000-000000000003','associate','00000000-0000-4000-8000-000000000006',student_uid,'synthetic' FROM gradebook.aluno WHERE id=1;
      INSERT INTO gradebook.student_source_link_v1(academic_year,source_id,student_uid,version,decision_id)
        SELECT 2026,'00000000-0000-4000-8000-000000000006',student_uid,1,'00000000-0000-4000-8000-000000000008' FROM gradebook.aluno WHERE id=1;
      DO $$ BEGIN
        BEGIN
          INSERT INTO gradebook.student_report_profile_v1(academic_year,student_uid,source_id,observation_id,version)
            SELECT 2026,student_uid,'00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000007',1 FROM gradebook.aluno WHERE id=2;
          SET CONSTRAINTS ALL IMMEDIATE;
          RAISE EXCEPTION 'gradebook-ci-profile-cross-uid-accepted';
        EXCEPTION WHEN foreign_key_violation THEN NULL; END;
        BEGIN
          INSERT INTO gradebook.student_source_link_v1(academic_year,source_id,student_uid,version,decision_id)
            SELECT 2026,'00000000-0000-4000-8000-000000000006',student_uid,1,'00000000-0000-4000-8000-000000000008' FROM gradebook.aluno WHERE id=2;
          RAISE EXCEPTION 'gradebook-ci-source-second-uid-accepted';
        EXCEPTION WHEN unique_violation THEN NULL; END;
        BEGIN
          INSERT INTO gradebook.student_source_observation_v1(id,academic_year,source_id,version,batch_id,report_class_id,
            name,name_key,birth_date,enrollment_hash,shift,shift_key,status,status_key)
            SELECT '00000000-0000-4000-8000-000000000009',2027,source_id,2,batch_id,report_class_id,
              name,name_key,birth_date,enrollment_hash,shift,shift_key,status,status_key FROM gradebook.student_source_observation_v1;
          RAISE EXCEPTION 'gradebook-ci-observation-cross-year-accepted';
        EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      END $$;`);
  } finally {
    await sql.unsafe('ROLLBACK');
  }
}

async function run(): Promise<void> {
  try {
    await applyCurrentGradebookSchemaV1(sql, process.cwd());
    await assertCurrentGradebookSchemaV1(sql);
    await seedSyntheticCurrentState();
    await installPortalCoordination();
    const acl = await assertCurrentGradebookAclV1();
    await assertFutureGradebookObjectAclV1();
    await completePortalBaseline();
    await applyReconciliationCandidateSchemaV1(sql, process.cwd());
    await assertReconciliationCandidateSchemaV1(sql);
    const candidateAcl = await assertCurrentGradebookAclV1(true);
    await assertReconciliationBridgeV1();
    await assertReconciliationForeignKeysV1();
    await assertFutureGradebookObjectAclV1();
    process.stdout.write(
      JSON.stringify({
        state: 'ready',
        database: 'gradebook_recovery_ci',
        postgres: '17.6',
        tables: GRADEBOOK_CURRENT_CATALOG_V1.tables,
        rlsTables: GRADEBOOK_CURRENT_CATALOG_V1.tables,
        syntheticOnly: true,
        portalCoordinationMigrations: 6,
        acl,
        candidateMigrations: GRADEBOOK_RECONCILIATION_SCHEMA_PLAN_V1,
        candidateTables:
          GRADEBOOK_CURRENT_TABLES_V1.length + 1 + GRADEBOOK_RECONCILIATION_TABLES_V1.length,
        candidatePortalBaselineMigrations: 24,
        candidateAcl,
        candidateForeignKeysVerified: true,
        futureDefaultAclHardened: true,
      }) + '\n',
    );
  } finally {
    await sql.end({ timeout: 2 });
  }
}

await run();
