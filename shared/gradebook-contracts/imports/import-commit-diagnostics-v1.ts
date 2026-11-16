import { isPlainRecordV1 as record } from '../../plain-record-v1';

/** Optional technical header; independent from the academic V9 response body. */
export const IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1 = 'X-Gradebook-Commit-Diagnostics';
export const IMPORT_COMMIT_DIAGNOSTICS_MAXIMUM_BYTES_V1 = 2_048;
export const IMPORT_COMMIT_DIAGNOSTICS_CATEGORIES_V1 = [
  'professor',
  'disciplina',
  'oferta',
  'instrumento',
  'nota',
  'fechamento',
  'history-import',
  'other',
] as const;
export type ImportCommitCategoryV1 = (typeof IMPORT_COMMIT_DIAGNOSTICS_CATEGORIES_V1)[number];
export type ImportCommitActionV1 = 'insert' | 'update' | 'delete';
export type ImportCommitAffectedRowsV1 = Readonly<
  Record<ImportCommitCategoryV1, Readonly<Record<ImportCommitActionV1, number>>>
>;
export interface ImportCommitDiagnosticsV1 {
  readonly version: 1;
  readonly scope: 'direct-import-statements';
  readonly coverage: 'complete' | 'partial';
  readonly transaction: 'committed' | 'rejected' | 'unknown' | 'not-started';
  /** Affected rows measured before the transaction's final outcome; not value differences. */
  readonly attempted: ImportCommitAffectedRowsV1;
  readonly confirmed: ImportCommitAffectedRowsV1 | null;
  readonly unmeasuredStatements: number;
  readonly excludedEffects: 'sql-functions-triggers-portal';
}

export function emptyImportCommitAffectedRowsV1(): Record<
  ImportCommitCategoryV1,
  Record<ImportCommitActionV1, number>
> {
  return Object.fromEntries(
    IMPORT_COMMIT_DIAGNOSTICS_CATEGORIES_V1.map((category) => [
      category,
      { insert: 0, update: 0, delete: 0 },
    ]),
  ) as Record<ImportCommitCategoryV1, Record<ImportCommitActionV1, number>>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function affectedRows(value: unknown): value is ImportCommitAffectedRowsV1 {
  if (!record(value) || !exactKeys(value, IMPORT_COMMIT_DIAGNOSTICS_CATEGORIES_V1)) return false;
  return IMPORT_COMMIT_DIAGNOSTICS_CATEGORIES_V1.every((category) => {
    const actions = value[category];
    return (
      record(actions) &&
      exactKeys(actions, ['insert', 'update', 'delete']) &&
      count(actions.insert) &&
      count(actions.update) &&
      count(actions.delete)
    );
  });
}
export function isImportCommitDiagnosticsV1(value: unknown): value is ImportCommitDiagnosticsV1 {
  if (
    !record(value) ||
    !exactKeys(value, [
      'version',
      'scope',
      'coverage',
      'transaction',
      'attempted',
      'confirmed',
      'unmeasuredStatements',
      'excludedEffects',
    ]) ||
    value.version !== 1 ||
    value.scope !== 'direct-import-statements' ||
    typeof value.coverage !== 'string' ||
    !['complete', 'partial'].includes(value.coverage) ||
    typeof value.transaction !== 'string' ||
    !['committed', 'rejected', 'unknown', 'not-started'].includes(value.transaction) ||
    value.excludedEffects !== 'sql-functions-triggers-portal' ||
    !count(value.unmeasuredStatements) ||
    (value.coverage === 'complete' && value.unmeasuredStatements !== 0) ||
    !affectedRows(value.attempted)
  )
    return false;
  if (value.confirmed === null) return true;
  return (
    value.transaction === 'committed' &&
    affectedRows(value.confirmed) &&
    IMPORT_COMMIT_DIAGNOSTICS_CATEGORIES_V1.every((category) => {
      const confirmed = (value.confirmed as ImportCommitAffectedRowsV1)[category];
      const attempted = (value.attempted as ImportCommitAffectedRowsV1)[category];
      return (['insert', 'update', 'delete'] as const).every(
        (action) => confirmed[action] <= attempted[action],
      );
    })
  );
}

/** Strict bounded ASCII input: unknown fields/categories never enter the G report. */
export function parseImportCommitDiagnosticsHeaderV1(
  raw: string | null,
): ImportCommitDiagnosticsV1 | null {
  if (
    raw === null ||
    raw.length === 0 ||
    raw.length > IMPORT_COMMIT_DIAGNOSTICS_MAXIMUM_BYTES_V1 ||
    /[^\x20-\x7e]/u.test(raw)
  )
    return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isImportCommitDiagnosticsV1(value) ? value : null;
  } catch {
    return null;
  }
}

/** Serialization failure or future growth drops only this optional header. */
export function serializeImportCommitDiagnosticsHeaderV1(value: unknown): string | null {
  try {
    if (!isImportCommitDiagnosticsV1(value)) return null;
    const raw = JSON.stringify(value);
    return parseImportCommitDiagnosticsHeaderV1(raw) === null ? null : raw;
  } catch {
    return null;
  }
}
