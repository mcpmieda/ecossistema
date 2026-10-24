import type { GradebookPostgresValueV1, GradebookPostgresScalarV1 } from './postgres-values-v1';
export type { GradebookPostgresScalarV1 } from './postgres-values-v1';

type PostgresFactoryV1 = typeof import('postgres');
type PostgresRowV1 = Record<string, unknown>;

interface PostgresQueryResultV1 extends ReadonlyArray<PostgresRowV1> {
  readonly count?: number | null;
}

export interface GradebookPostgresQuerySqlV1 {
  unsafe(query: string, parameters?: readonly unknown[]): PromiseLike<PostgresQueryResultV1>;
  typed?(value: string, oid: number): unknown;
}

export interface GradebookPostgresSqlV1 extends GradebookPostgresQuerySqlV1 {
  begin<T>(operation: (sql: GradebookPostgresQuerySqlV1) => Promise<T>): Promise<T>;
  end?(options?: { readonly timeout?: number }): Promise<void>;
}

const NUMERIC_COLUMNS =
  /(?:^|_)(?:count|version|term|year|size_bytes|sequence|index|write_count)$/u;
const JSON_COLUMNS = /(?:^|_)(?:json|intent)$/u;
const POSTGRES_TEXT_OID_V1 = 25;

export interface GradebookPostgresDatabaseOptionsV1 {
  readonly maximumConnections?: number;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly maximumLifetimeSeconds?: number;
  readonly statementTimeoutMilliseconds?: number;
  readonly lockTimeoutMilliseconds?: number;
  readonly idleInTransactionTimeoutMilliseconds?: number;
}

/**
 * PostgreSQL receives the query as written: `$n` placeholders and explicit casts.
 * Reads and writes share connection limits, failure diagnostics and row normalization.
 */
export interface GradebookPostgresReadPortV1 {
  query<Row extends Record<string, unknown>>(
    text: string,
    parameters: readonly GradebookPostgresScalarV1[],
  ): Promise<readonly Row[]>;
}

export interface GradebookPostgresExecutionV1<Row = PostgresRowV1> {
  readonly rows: readonly Row[];
  readonly changes: number;
}

export interface GradebookPostgresWritePortV1 extends GradebookPostgresReadPortV1 {
  executeNative<Row extends PostgresRowV1 = PostgresRowV1>(
    text: string,
    parameters: readonly GradebookPostgresValueV1[],
  ): Promise<GradebookPostgresExecutionV1<Row>>;
}

/** Both native ports are bound to the transaction's own physical connection. */
export type GradebookPostgresTransactionV1 = GradebookPostgresWritePortV1;

export interface GradebookPostgresDatabaseV1 extends GradebookPostgresWritePortV1 {
  transaction<T>(operation: (database: GradebookPostgresTransactionV1) => Promise<T>): Promise<T>;
  lastFailure(): GradebookPostgresFailureDiagnosticV1 | null;
  close(): Promise<void>;
}

export interface GradebookPostgresFailureDiagnosticV1 {
  readonly operation: string;
  readonly relation: string | null;
  readonly errorType: string;
  readonly sqlState?: string;
  readonly category:
    | 'connection-parameter'
    | 'jsonb-cast'
    | 'permission'
    | 'relation-missing'
    | 'timeout'
    | 'unknown';
}

interface GradebookPostgresFailureStateV1 {
  value: GradebookPostgresFailureDiagnosticV1 | null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause ?? '');
}

function failureDiagnostic(query: string, cause: unknown): GradebookPostgresFailureDiagnosticV1 {
  const message = errorMessage(cause);
  const operation = /^\s*([A-Za-z]+)/u.exec(query)?.[1]?.toUpperCase() ?? 'UNKNOWN';
  const relation =
    /\b(?:FROM|INTO|TABLE|UPDATE)\s+(?:gradebook\.)?([A-Z_][A-Z0-9_]*)/iu.exec(query)?.[1] ??
    null;
  const code =
    cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  const sqlState = typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
  const category = /search_path|startup parameter/iu.test(message)
    ? 'connection-parameter'
    : /jsonb.*text|text.*jsonb|type jsonb/iu.test(message)
      ? 'jsonb-cast'
      : /permission denied|insufficient privilege/iu.test(message)
        ? 'permission'
        : /relation .* does not exist/iu.test(message)
          ? 'relation-missing'
          : /timeout|timed out|57014/iu.test(message)
            ? 'timeout'
            : 'unknown';
  return {
    operation,
    relation,
    errorType: cause instanceof Error ? cause.name : 'unknown',
    ...(sqlState ? { sqlState } : {}),
    category,
  };
}

function safeInteger(value: bigint): number | string {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value.toString();
}

function normalizeValue(column: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return safeInteger(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (JSON_COLUMNS.test(column) && value !== null && typeof value !== 'string') {
    return JSON.stringify(value);
  }
  if (NUMERIC_COLUMNS.test(column) && typeof value === 'string' && /^-?\d+$/u.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value;
  }
  return value;
}

function normalizeRow(row: PostgresRowV1): PostgresRowV1 {
  const normalized = Object.fromEntries(
    Object.entries(row).map(([column, value]) => [column, normalizeValue(column, value)]),
  );
  const parseObject = (column: string): Record<string, unknown> | null => {
    const value = normalized[column];
    if (typeof value !== 'string') return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const payload = parseObject('payload_json');
  const filePayload = parseObject('file_payload_json');
  const setWhenPresent = (column: string, value: unknown) => {
    if (column in normalized && (typeof value === 'string' || value === null)) {
      normalized[column] = value;
    }
  };

  if (payload) {
    setWhenPresent('received_at', payload.receivedAt);
    setWhenPresent('updated_at', payload.updatedAt);
    setWhenPresent('emitted_at', payload.emittedAt);
    setWhenPresent('decided_at', payload.decidedAt);
    const manifest = payload.manifest;
    if (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)) {
      const sourceManifest = manifest as Record<string, unknown>;
      setWhenPresent('last_modified_at', sourceManifest.lastModifiedAt);
      setWhenPresent('read_at', sourceManifest.readAt);
    }
  }
  const sourceFile = filePayload?.sourceFile;
  if (sourceFile !== null && typeof sourceFile === 'object' && !Array.isArray(sourceFile)) {
    setWhenPresent('last_modified_at', (sourceFile as Record<string, unknown>).lastModifiedAt);
  }
  return normalized;
}

class GradebookPostgresFacadeV1 implements GradebookPostgresWritePortV1 {
  constructor(
    private readonly sql: GradebookPostgresQuerySqlV1,
    private readonly root: GradebookPostgresSqlV1,
    private readonly transactional: boolean,
    private readonly failureState: GradebookPostgresFailureStateV1,
  ) {}

  async executeNative<Row extends PostgresRowV1 = PostgresRowV1>(
    text: string,
    values: readonly GradebookPostgresValueV1[],
  ): Promise<GradebookPostgresExecutionV1<Row>> {
    const parameters = values.map((value) =>
      value !== null && typeof value === 'object'
        ? (this.sql.typed ? this.sql.typed(value.jsonText, POSTGRES_TEXT_OID_V1) : value.jsonText)
        : value,
    );
    let result: PostgresQueryResultV1;
    try {
      result = await this.sql.unsafe(text, parameters);
    } catch (cause) {
      this.failureState.value = failureDiagnostic(text, cause);
      throw cause;
    }
    return {
      rows: Array.from(result, normalizeRow) as readonly Row[],
      changes: typeof result.count === 'number' ? result.count : result.length,
    };
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    parameters: readonly GradebookPostgresScalarV1[],
  ): Promise<readonly Row[]> {
    return (await this.executeNative<Row>(text, parameters)).rows;
  }

  transaction<T>(operation: (database: GradebookPostgresTransactionV1) => Promise<T>): Promise<T> {
    if (this.transactional) return operation(this);
    return this.root.begin(async (transactionSql) =>
      operation(new GradebookPostgresFacadeV1(transactionSql, this.root, true, this.failureState)),
    );
  }
}

function postgresModuleDefault(module: unknown): PostgresFactoryV1 {
  if (typeof module === 'function') return module as PostgresFactoryV1;
  if (
    module !== null &&
    typeof module === 'object' &&
    'default' in module &&
    typeof module.default === 'function'
  ) {
    return module.default as PostgresFactoryV1;
  }
  throw new Error('gradebook-postgres-driver-load-failed');
}

export async function createGradebookPostgresDatabaseV1(
  connectionString: string,
  options: GradebookPostgresDatabaseOptionsV1 = {},
): Promise<GradebookPostgresDatabaseV1> {
  if (connectionString.trim().length === 0) {
    throw new Error('gradebook-postgres-connection-string-missing');
  }
  const postgres = postgresModuleDefault(await import('postgres'));
  const sql: GradebookPostgresSqlV1 = postgres(connectionString, {
    max: options.maximumConnections ?? 5,
    fetch_types: false,
    prepare: true,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 2,
    max_lifetime: options.maximumLifetimeSeconds ?? 60,
    connection: {
      application_name: 'ecossistema-escola-gradebook',
      statement_timeout: options.statementTimeoutMilliseconds ?? 30_000,
      lock_timeout: options.lockTimeoutMilliseconds ?? 5000,
      idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMilliseconds ?? 30_000,
    },
  });
  return createGradebookPostgresDatabaseFromSqlV1(sql);
}

export function createGradebookPostgresDatabaseFromSqlV1(
  sql: GradebookPostgresSqlV1,
): GradebookPostgresDatabaseV1 {
  const failureState: GradebookPostgresFailureStateV1 = { value: null };
  const facade = new GradebookPostgresFacadeV1(sql, sql, false, failureState);
  return {
    query: facade.query.bind(facade),
    executeNative: facade.executeNative.bind(facade),
    transaction: facade.transaction.bind(facade),
    lastFailure: () => failureState.value,
    async close() {
      try {
        await sql.end?.({ timeout: 1 });
      } catch (cause) {
        if (!/connection.*closed|not.*open/iu.test(errorMessage(cause))) throw cause;
      }
    },
  };
}
