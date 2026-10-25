/**
 * Historical recovery contract for the private #662 artifact captured before the
 * later current-schema migrations. V2 is intentionally immutable and must not be
 * treated as the current Gradebook backup contract. Current schema reconstruction
 * lives in current-gradebook-schema-v1.ts.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compareCanonicalStringsV1 } from '../../../shared/gradebook-contracts/string-order-v1';

type BackupRowV2 = Readonly<Record<string, unknown>>;
type SqlRowV2 = Record<string, unknown>;

interface RecoveryQueryV2 {
  unsafe(query: string, parameters?: readonly unknown[]): PromiseLike<readonly SqlRowV2[]>;
}

export interface RecoveryDatabaseV2 extends RecoveryQueryV2 {
  begin<T>(operation: (sql: RecoveryQueryV2) => Promise<T>): Promise<T>;
}

interface BackupCatalogV2 {
  readonly index_count: 58;
  readonly table_count: 28;
  readonly column_count: 214;
  readonly constraint_count: 188;
  readonly foreign_key_count: 48;
}

interface BackupSequenceV2 {
  readonly schemaname: 'gradebook';
  readonly sequencename: RecoverySequenceNameV2;
  readonly last_value: number | null;
  readonly start_value: number;
  readonly increment_by: number;
}

export const LOGICAL_BACKUP_TABLE_ORDER_V2 = [
  'ano_letivo',
  'aluno',
  'disciplina',
  'professor',
  'turma',
  'importacao',
  'oferta',
  'vinculo',
  'instrumento',
  'nota',
  'fechamento',
  'ano_letivo_historico',
  'conselho_anterior_historico',
  'conselho_decisao',
  'conselho_decisao_historico',
  'fechamento_historico',
  'instrumento_historico',
  'nota_historico',
  'vinculo_historico',
  'importacao_diagnostico',
  'conselho_sessao',
  'conselho_sessao_historico',
  'conselho_votacao',
  'conselho_votacao_historico',
  'conselho_decisao_comando',
  'conselho_fechamento',
  'conselho_fechamento_item',
  'conselho_idempotencia',
] as const;

export type LogicalBackupTableV2 = (typeof LOGICAL_BACKUP_TABLE_ORDER_V2)[number];

export const LOGICAL_BACKUP_SEQUENCE_NAMES_V2 = [
  'aluno_id_seq',
  'conselho_decisao_comando_id_seq',
  'conselho_fechamento_id_seq',
  'conselho_sessao_historico_id_seq',
  'conselho_votacao_historico_id_seq',
  'disciplina_id_seq',
  'importacao_diagnostico_id_seq',
  'importacao_id_seq',
  'instrumento_id_seq',
  'oferta_id_seq',
  'professor_id_seq',
  'turma_id_seq',
] as const;

export type RecoverySequenceNameV2 = (typeof LOGICAL_BACKUP_SEQUENCE_NAMES_V2)[number];

/**
 * 0002 is the historical production migration whose resulting relation is already
 * present in the reconstructed 0001 baseline. Replaying it after 0001 is invalid.
 */
export const RECOVERY_SCHEMA_PLAN_V2 = [
  '0001_current_schema.sql',
  'application_role_grants.sql',
  '0003_council_session_v3.sql',
  '0004_council_v3_least_privilege.sql',
  '0005_relational_bulletin_snapshot_v2.sql',
] as const;

export interface LogicalBackupV2 {
  readonly format: 'gradebook-logical-backup-v2';
  readonly source: string;
  readonly captured_at: string;
  readonly source_head: string;
  readonly catalog: BackupCatalogV2;
  readonly tables: Readonly<Record<LogicalBackupTableV2, readonly BackupRowV2[]>>;
  readonly sequences: readonly BackupSequenceV2[];
}

export interface RecoveryTargetV2 {
  readonly connectionString: string;
  readonly databaseName: string;
  readonly host: '127.0.0.1' | 'localhost' | '::1';
}

export interface RecoveryReportV2 {
  readonly format: 'gradebook-recovery-report-v2';
  readonly backupSha256: string;
  readonly sourceHead: string;
  readonly capturedAt: string;
  readonly restoredTables: 28;
  readonly restoredRows: number;
  readonly restoredSequences: 12;
  readonly currentCatalog: {
    readonly tables: 29;
    readonly columns: 227;
    readonly constraints: 203;
    readonly indexes: 62;
    readonly foreignKeys: 51;
    readonly sequences: 12;
    readonly functions: 4;
    readonly triggers: 3;
  };
  readonly academicYears: readonly [2026];
  readonly bulletinSnapshots: 0;
  readonly invalidForeignKeys: 0;
  readonly publicTablePrivileges: 0;
}

export class LogicalBackupRecoveryErrorV2 extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'LogicalBackupRecoveryErrorV2';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new LogicalBackupRecoveryErrorV2(code);
}

function sqlStateSuffix(cause: unknown): string {
  if (!record(cause)) return '';
  const code = cause.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code) ? `-${code.toLowerCase()}` : '';
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCanonicalStringsV1);
  const sortedExpected = [...expected].sort(compareCanonicalStringsV1);
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function hasExactNames(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...actual].sort(compareCanonicalStringsV1);
  const right = [...expected].sort(compareCanonicalStringsV1);
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function parseCsvCellV2(csv: string): string {
  const normalized = csv.replace(/^\uFEFF/u, '');
  const firstBreak = normalized.indexOf('\n');
  if (firstBreak < 0 || normalized.slice(0, firstBreak).replace(/\r$/u, '') !== 'gradebook_backup') {
    fail('recovery-backup-header-invalid');
  }
  const cell = normalized.slice(firstBreak + 1).trim();
  if (cell.length < 2 || !cell.startsWith('"') || !cell.endsWith('"')) {
    fail('recovery-backup-cell-invalid');
  }
  return cell.slice(1, -1).replaceAll('""', '"');
}

function parseCatalogV2(value: unknown): BackupCatalogV2 {
  if (!record(value) || !exactKeys(value, ['index_count', 'table_count', 'column_count', 'constraint_count', 'foreign_key_count']) ||
      value.index_count !== 58 || value.table_count !== 28 || value.column_count !== 214 ||
      value.constraint_count !== 188 || value.foreign_key_count !== 48) {
    fail('recovery-backup-catalog-invalid');
  }
  return value as unknown as BackupCatalogV2;
}

function parseTablesV2(value: unknown): LogicalBackupV2['tables'] {
  if (!record(value) || !hasExactNames(Object.keys(value), LOGICAL_BACKUP_TABLE_ORDER_V2)) {
    fail('recovery-backup-tables-invalid');
  }
  for (const table of LOGICAL_BACKUP_TABLE_ORDER_V2) {
    const rows = value[table];
    if (!Array.isArray(rows) || rows.some((row) => !record(row))) {
      fail('recovery-backup-rows-invalid');
    }
  }
  return value as unknown as LogicalBackupV2['tables'];
}

function parseSequenceV2(value: unknown): BackupSequenceV2 {
  if (!record(value) || value.schemaname !== 'gradebook' ||
      !LOGICAL_BACKUP_SEQUENCE_NAMES_V2.includes(value.sequencename as RecoverySequenceNameV2) ||
      !(value.last_value === null || safeInteger(value.last_value)) ||
      !safeInteger(value.start_value) || !safeInteger(value.increment_by) || value.increment_by <= 0) {
    fail('recovery-backup-sequence-invalid');
  }
  return value as unknown as BackupSequenceV2;
}

export function parseLogicalBackupCsvV2(csv: string): LogicalBackupV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(parseCsvCellV2(csv));
  } catch (cause) {
    if (cause instanceof LogicalBackupRecoveryErrorV2) throw cause;
    fail('recovery-backup-json-invalid');
  }
  if (!record(parsed) || parsed.format !== 'gradebook-logical-backup-v2' ||
      typeof parsed.source !== 'string' || !parsed.source.trim() ||
      typeof parsed.captured_at !== 'string' || Number.isNaN(Date.parse(parsed.captured_at)) ||
      typeof parsed.source_head !== 'string' || !/^[0-9a-f]{40}$/iu.test(parsed.source_head) ||
      !Array.isArray(parsed.sequences)) {
    fail('recovery-backup-envelope-invalid');
  }
  const sequences = parsed.sequences.map(parseSequenceV2);
  if (!hasExactNames(sequences.map((sequence) => sequence.sequencename), LOGICAL_BACKUP_SEQUENCE_NAMES_V2)) {
    fail('recovery-backup-sequences-invalid');
  }
  return {
    format: 'gradebook-logical-backup-v2',
    source: parsed.source,
    captured_at: parsed.captured_at,
    source_head: parsed.source_head.toLowerCase(),
    catalog: parseCatalogV2(parsed.catalog),
    tables: parseTablesV2(parsed.tables),
    sequences,
  };
}

export function assertDisposableRecoveryTargetV2(connectionString: string): RecoveryTargetV2 {
  let target: URL;
  try {
    target = new URL(connectionString);
  } catch {
    fail('recovery-target-url-invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(target.protocol)) fail('recovery-target-protocol-invalid');
  const host = target.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') {
    fail('recovery-target-not-loopback');
  }
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//u, ''));
  if (!/^gradebook_recovery_[a-z0-9_]+$/u.test(databaseName)) fail('recovery-target-name-invalid');
  return {
    connectionString,
    databaseName,
    host: host === '[::1]' ? '::1' : host as RecoveryTargetV2['host'],
  };
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) fail('recovery-identifier-invalid');
  return `"${value}"`;
}

async function rows(sql: RecoveryQueryV2, query: string, parameters: readonly unknown[] = []): Promise<readonly SqlRowV2[]> {
  return Array.from(await sql.unsafe(query, parameters));
}

function integerColumn(row: SqlRowV2, name: string): number {
  const value = row[name];
  let normalized;
  if (typeof value === 'bigint') {
    normalized = Number(value);
  } else if (typeof value === 'string') {
    normalized = Number(value);
  } else {
    normalized = value;
  }
  if (!safeInteger(normalized)) fail('recovery-validation-row-invalid');
  return normalized;
}

async function assertEmptyDatabaseV2(sql: RecoveryQueryV2): Promise<void> {
  const result = await rows(sql, `SELECT count(*)::integer AS count FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog','information_schema')`);
  if (result.length !== 1 || integerColumn(result[0]!, 'count') !== 0) fail('recovery-target-not-empty');
}

async function provisionLocalApplicationRoleV2(sql: RecoveryQueryV2): Promise<void> {
  await sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gradebook_app') THEN
      CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
  END $$`);
}

export async function applyRecoverySchemaV2(sql: RecoveryQueryV2, repositoryRoot: string): Promise<void> {
  await assertEmptyDatabaseV2(sql);
  await provisionLocalApplicationRoleV2(sql);
  for (const file of RECOVERY_SCHEMA_PLAN_V2) {
    const migration = await readFile(`${repositoryRoot}/migrations/gradebook-simplified/${file}`, 'utf8');
    try {
      await sql.unsafe(migration);
    } catch (cause) {
      fail(`recovery-schema-${file.replace(/\.sql$/u, '').replaceAll('_', '-')}-failed${sqlStateSuffix(cause)}`);
    }
  }
}

async function tableColumnsV2(sql: RecoveryQueryV2, table: LogicalBackupTableV2): Promise<readonly string[]> {
  const result = await rows(sql, `SELECT column_name FROM information_schema.columns
    WHERE table_schema='gradebook' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  const columns = result.map((row) => row.column_name);
  if (columns.some((column) => typeof column !== 'string') || columns.length === 0) fail('recovery-table-columns-invalid');
  return columns as string[];
}

function validateRowColumnsV2(tableRows: readonly BackupRowV2[], columns: readonly string[]): void {
  for (const row of tableRows) {
    if (!hasExactNames(Object.keys(row), columns)) fail('recovery-row-columns-invalid');
  }
}

async function insertRowsV2(sql: RecoveryQueryV2, table: LogicalBackupTableV2, tableRows: readonly BackupRowV2[]): Promise<void> {
  const columns = await tableColumnsV2(sql, table);
  validateRowColumnsV2(tableRows, columns);
  const identifier = `gradebook.${quotedIdentifier(table)}`;
  for (let offset = 0; offset < tableRows.length; offset += 1000) {
    const chunk = tableRows.slice(offset, offset + 1000);
    await sql.unsafe(`INSERT INTO ${identifier} SELECT * FROM json_populate_recordset(NULL::${identifier}, $1::json)`, [chunk]);
  }
}

async function restoreSequencesV2(sql: RecoveryQueryV2, sequences: readonly BackupSequenceV2[]): Promise<void> {
  for (const sequence of sequences) {
    const value = sequence.last_value ?? sequence.start_value;
    await sql.unsafe('SELECT setval($1::regclass,$2,$3)', [
      `gradebook.${sequence.sequencename}`,
      value,
      sequence.last_value !== null,
    ]);
  }
}

async function restoreCouncilSessionClosurePointersV2(sql: RecoveryQueryV2, tableRows: readonly BackupRowV2[]): Promise<void> {
  const pointers = tableRows.filter((row) => row.fechamento_atual_id !== null).map((row) => ({
    ano: row.ano,
    turma_id: row.turma_id,
    fechamento_atual_id: row.fechamento_atual_id,
  }));
  if (pointers.length === 0) return;
  await sql.unsafe(`UPDATE gradebook.conselho_sessao s SET fechamento_atual_id=p.fechamento_atual_id
    FROM json_to_recordset($1::json) AS p(ano smallint,turma_id integer,fechamento_atual_id bigint)
    WHERE s.ano=p.ano AND s.turma_id=p.turma_id`, [pointers]);
}

export async function restoreLogicalBackupV2(sql: RecoveryDatabaseV2, backup: LogicalBackupV2): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction.unsafe('SET CONSTRAINTS ALL DEFERRED');
    for (const table of LOGICAL_BACKUP_TABLE_ORDER_V2) {
      try {
        let tableRows = backup.tables[table];
        if (table === 'conselho_sessao') {
          tableRows = tableRows.map((row) => ({...row, fechamento_atual_id: null}));
        }
        if (table === 'aluno') {
          await transaction.unsafe('ALTER TABLE gradebook.aluno DISABLE TRIGGER aluno_preparar_conselho_anterior_trg');
          await insertRowsV2(transaction, table, tableRows);
          await transaction.unsafe('ALTER TABLE gradebook.aluno ENABLE TRIGGER aluno_preparar_conselho_anterior_trg');
        } else {
          await insertRowsV2(transaction, table, tableRows);
        }
      } catch (cause) {
        if (cause instanceof LogicalBackupRecoveryErrorV2) throw cause;
        fail(`recovery-restore-${table.replaceAll('_', '-')}-failed${sqlStateSuffix(cause)}`);
      }
    }
    try {
      await restoreCouncilSessionClosurePointersV2(transaction, backup.tables.conselho_sessao);
      await restoreSequencesV2(transaction, backup.sequences);
    } catch (cause) {
      if (cause instanceof LogicalBackupRecoveryErrorV2) throw cause;
      fail(`recovery-restore-finalization-failed${sqlStateSuffix(cause)}`);
    }
  });
}

async function validateCountsV2(sql: RecoveryQueryV2, backup: LogicalBackupV2): Promise<number> {
  let total = 0;
  for (const table of LOGICAL_BACKUP_TABLE_ORDER_V2) {
    const result = await rows(sql, `SELECT count(*)::integer AS count FROM gradebook.${quotedIdentifier(table)}`);
    const actual = integerColumn(result[0]!, 'count');
    const expected = backup.tables[table].length;
    if (actual !== expected) fail('recovery-row-count-mismatch');
    total += actual;
  }
  return total;
}

async function validateSequencesV2(sql: RecoveryQueryV2, backup: LogicalBackupV2): Promise<void> {
  for (const expected of backup.sequences) {
    const result = await rows(sql, `SELECT last_value::bigint AS last_value,is_called
      FROM gradebook.${quotedIdentifier(expected.sequencename)}`);
    const actual = result[0];
    if (!actual) fail('recovery-sequence-missing');
    const lastValue = integerColumn(actual, 'last_value');
    if (lastValue !== (expected.last_value ?? expected.start_value) || actual.is_called !== (expected.last_value !== null)) {
      fail('recovery-sequence-mismatch');
    }
  }
}

async function currentCatalogV2(sql: RecoveryQueryV2): Promise<RecoveryReportV2['currentCatalog']> {
  const result = await rows(sql, `SELECT
    (SELECT count(*)::integer FROM information_schema.tables WHERE table_schema='gradebook' AND table_type='BASE TABLE') AS tables,
    (SELECT count(*)::integer FROM information_schema.columns WHERE table_schema='gradebook') AS columns,
    (SELECT count(*)::integer FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='gradebook' AND c.contype<>'n') AS constraints,
    (SELECT count(*)::integer FROM pg_indexes WHERE schemaname='gradebook') AS indexes,
    (SELECT count(*)::integer FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='gradebook' AND c.contype='f') AS foreign_keys,
    (SELECT count(*)::integer FROM pg_sequences WHERE schemaname='gradebook') AS sequences,
    (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='gradebook') AS functions,
    (SELECT count(*)::integer FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='gradebook' AND NOT t.tgisinternal) AS triggers`);
  const row = result[0];
  if (!row) fail('recovery-catalog-missing');
  const catalog = {
    tables: integerColumn(row, 'tables'), columns: integerColumn(row, 'columns'),
    constraints: integerColumn(row, 'constraints'), indexes: integerColumn(row, 'indexes'),
    foreignKeys: integerColumn(row, 'foreign_keys'), sequences: integerColumn(row, 'sequences'),
    functions: integerColumn(row, 'functions'), triggers: integerColumn(row, 'triggers'),
  };
  if (catalog.tables !== 29 || catalog.columns !== 227 || catalog.constraints !== 203 ||
      catalog.indexes !== 62 || catalog.foreignKeys !== 51 || catalog.sequences !== 12 ||
      catalog.functions !== 4 || catalog.triggers !== 3) fail('recovery-current-catalog-mismatch');
  return catalog as RecoveryReportV2['currentCatalog'];
}

export async function validateLogicalRecoveryV2(
  sql: RecoveryQueryV2,
  backup: LogicalBackupV2,
  backupBytes: Uint8Array,
): Promise<RecoveryReportV2> {
  const restoredRows = await validateCountsV2(sql, backup);
  await validateSequencesV2(sql, backup);
  const catalog = await currentCatalogV2(sql);
  const validation = await rows(sql, `SELECT
    ARRAY(SELECT ano::integer FROM gradebook.ano_letivo ORDER BY ano) AS years,
    (SELECT count(*)::integer FROM gradebook.boletim_snapshot) AS bulletin_snapshots,
    (SELECT count(*)::integer FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname='gradebook' AND c.contype='f' AND NOT c.convalidated) AS invalid_foreign_keys,
    (SELECT count(*)::integer FROM information_schema.table_privileges
      WHERE table_schema='gradebook' AND grantee='PUBLIC') AS public_table_privileges`);
  const row = validation[0];
  const years = row?.years;
  if (!Array.isArray(years) || years.length !== 1 || Number(years[0]) !== 2026 ||
      integerColumn(row!, 'bulletin_snapshots') !== 0 || integerColumn(row!, 'invalid_foreign_keys') !== 0 ||
      integerColumn(row!, 'public_table_privileges') !== 0) fail('recovery-postflight-invalid');
  return {
    format: 'gradebook-recovery-report-v2',
    backupSha256: createHash('sha256').update(backupBytes).digest('hex'),
    sourceHead: backup.source_head,
    capturedAt: backup.captured_at,
    restoredTables: 28,
    restoredRows,
    restoredSequences: 12,
    currentCatalog: catalog,
    academicYears: [2026],
    bulletinSnapshots: 0,
    invalidForeignKeys: 0,
    publicTablePrivileges: 0,
  };
}

export function repositoryRootForRecoveryV2(): string {
  return fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/u, '');
}

export async function readLogicalBackupV2(path: string): Promise<{readonly backup: LogicalBackupV2; readonly bytes: Uint8Array}> {
  const bytes = await readFile(path);
  return {backup: parseLogicalBackupCsvV2(bytes.toString()), bytes};
}

export function sanitizedRecoveryFailureV2(cause: unknown): string {
  return cause instanceof LogicalBackupRecoveryErrorV2 ? cause.code : 'unexpected-recovery-failure';
}
