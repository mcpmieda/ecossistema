import { recordResetWriteV1 } from '../../../student-portal/integration/year-reset/writer-v1';
import {
  isGradebookImportDiagnosticsAuditRequestV1,
  type GradebookImportDiagnosticsAuditRequestV1,
} from '../../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import { type GradebookPostgresWritePortV1, type GradebookPostgresTransactionV1  } from '../../persistence/postgres/postgres-database-v1';

import { postgresJsonTextV1 } from '../../persistence/postgres/postgres-values-v1';

type TransactionDatabase = GradebookPostgresWritePortV1 & {
  transaction<T>(operation: (database: GradebookPostgresTransactionV1) => Promise<T>): Promise<T>;
};

export class InvalidImportDiagnosticsSnapshotV1 extends Error {
  constructor() {
    super('invalid-import-diagnostics-snapshot');
    this.name = 'InvalidImportDiagnosticsSnapshotV1';
  }
}

/**
 * One complete observation replaces the current diagnostic set, including an empty set.
 * The caller owns authentication/origin checks. No academic facts/history are changed.
 * Locks and DELETE/INSERT share one PostgreSQL transaction/connection. A failed INSERT
 * cannot erase the previous evidence. Last successfully committed observation wins;
 * V1 contains no client observation sequence, so it cannot detect an older delayed upload.
 */
export async function replaceGradebookImportDiagnosticsSnapshotV1(
  database: GradebookPostgresWritePortV1,
  request: GradebookImportDiagnosticsAuditRequestV1,
): Promise<number> {
  if (
    !isGradebookImportDiagnosticsAuditRequestV1(request) ||
    new Set(request.diagnostics.map((item) => item.key)).size !== request.diagnostics.length
  ) {
    throw new InvalidImportDiagnosticsSnapshotV1();
  }
  if (!('transaction' in database) || typeof database.transaction !== 'function') {
    throw new Error('import-diagnostics-transaction-unavailable');
  }
  // Capture all scalar input before the first await; later caller mutation is irrelevant.
  const { academicYear, fileName } = request;
  const sha256 = request.sha256.toLowerCase();
  // The persistent Audit is intentionally narrower than the import preflight.
  // Keep only findings that require human action: all blocking errors plus the
  // explicit above-maximum warning. Technical/expected warnings (for example
  // REC formulas without a saved cache or qualitative "*" maxima) stay out of
  // the durable current snapshot.
  const rows = request.diagnostics
    .filter((item) => item.severity === 'blocking-error' || item.code === 'above-maximum')
    .map((item) => ({
      ano: academicYear,
      arquivo: fileName,
      hash_hex: sha256,
      chave: item.key,
      nivel: item.severity,
      codigo: item.code,
      turma_codigo: item.classCode ?? null,
      disciplina: item.subject ?? null,
      periodo: item.period ?? null,
      aluno_numero: item.studentNumber ?? null,
      campo: item.fieldKind,
      rotulo: item.fieldLabel ?? null,
      valor_encontrado: item.foundValue ?? null,
      causa: item.cause ?? null,
      guia: item.sheetName ?? null,
      celula: item.cellAddress ?? null,
    }))
    .sort((a, b) => (a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0));
  const serialized = JSON.stringify(rows);
  // Keep source identity and content in distinct advisory-lock namespaces.
  const sourceKey = `gradebook-import-diagnostics-source:${JSON.stringify([academicYear, fileName])}`;
  const contentKey = `gradebook-import-diagnostics-content:${sha256}`;

  const scopeChanged = new Error('diagnostic-year-scope-changed');
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await (database as TransactionDatabase).transaction(async (transaction) => {
        await transaction.query('SELECT pg_advisory_xact_lock_shared(613,0)', []);
        const affectedYears = async () =>
          (
            await transaction.query<{ ano: number }>(
                `SELECT DISTINCT ano FROM gradebook.importacao_diagnostico
       WHERE ((ano IS NOT DISTINCT FROM $1 AND arquivo = $2) OR hash = decode($3, 'hex'))
         AND ano IS NOT NULL ORDER BY ano`,
              [academicYear, fileName, sha256],
            )
          ).map((row) => row.ano);
        const years = [
          ...new Set([
            ...(await affectedYears()),
            ...(academicYear === null ? [] : [academicYear]),
          ]),
        ].sort((a, b) => a - b);
        const materializedYears = new Set<number>();
        for (const year of years) {
          await transaction.query('SELECT pg_advisory_xact_lock(613,$1::integer)', [year]);
          const state = (await transaction.query<{ present: boolean | number }>(
            `SELECT TRUE AS present,
       student_portal.ensure_year_coordination_v1(y.ano) AS coordination
       FROM gradebook.ano_letivo y WHERE y.ano=$1::smallint`,
            [year],
          ))[0];
          const present = state?.present === true || state?.present === 1;
          if (present) {
            materializedYears.add(year);
          }
        }
        if (academicYear !== null && !materializedYears.has(academicYear)) return 0;
        // Source lock serializes versions; content lock also protects same bytes renamed.
        // A hash collision only adds serialization. Values never enter the SQL text/logs.
        for (const key of [sourceKey, contentKey]) {
          await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 629)) AS locked', [key]);
        }
        // Never acquire an additional annual lock after the content lock: restart instead.
        // Both aggregates observe the same rows once, after the source/content locks.
        // JSON uses the adapter's explicit *_json normalization, not a driver array cast.
        const current = (await transaction.executeNative<{
          previous_years_json: string;
          unchanged: number;
        }>(
            `SELECT COALESCE(jsonb_agg(DISTINCT d.ano ORDER BY d.ano)
         FILTER (WHERE d.ano IS NOT NULL), '[]'::jsonb) AS previous_years_json,
       COALESCE(jsonb_agg(
         (to_jsonb(d)-'id'-'hash'-'primeiro_em'-'ultimo_em'-'ocorrencias')
         || jsonb_build_object('hash_hex',encode(d.hash,'hex'))
         ORDER BY d.chave COLLATE "C"), '[]'::jsonb) = $1::jsonb AS unchanged
       FROM gradebook.importacao_diagnostico d
       WHERE (ano IS NOT DISTINCT FROM $2 AND arquivo = $3) OR hash = decode($4, 'hex')`,
          [postgresJsonTextV1(serialized), academicYear, fileName, sha256],
        )).rows[0];
        if (!current) throw new Error('import-diagnostics-snapshot-state-unavailable');
        const previousYears = JSON.parse(current.previous_years_json) as number[];
        // Equality must never skip revalidation: a new year requires a bounded retry
        // before any decision, never an additional annual lock after the content lock.
        if (previousYears.some((year) => !years.includes(year))) throw scopeChanged;
        if (current.unchanged === 1) return 0;
        const changedYears = [
          ...new Set([
            ...previousYears,
            ...(academicYear !== null && rows.length > 0 ? [academicYear] : []),
          ]),
        ]
          .filter((year) => materializedYears.has(year))
          .sort((a, b) => a - b);
        const recordChanges = async () => {
          for (const year of changedYears)
            await recordResetWriteV1(transaction, year, 'diagnostics');
        };
        // Human treatment is current-context metadata too: once the next complete
        // source observation no longer contains a diagnostic key, its treatment must
        // not survive as an orphan record.
        await transaction.executeNative(
            `DELETE FROM gradebook.importacao_diagnostico_tratamento a
       WHERE ((a.ano IS NOT DISTINCT FROM $1 AND a.arquivo = $2)
          OR a.hash = decode($3, 'hex'))
         AND NOT EXISTS (
           SELECT 1
           FROM jsonb_to_recordset($4::jsonb) AS x(ano smallint,arquivo text,chave text)
           WHERE x.ano IS NOT DISTINCT FROM a.ano
             AND x.arquivo = a.arquivo
             AND x.chave = a.chave
         )`,
          [academicYear, fileName, sha256, postgresJsonTextV1(serialized)],
        );

        const cleared = await transaction.executeNative(
            `DELETE FROM gradebook.importacao_diagnostico
       WHERE (ano IS NOT DISTINCT FROM $1 AND arquivo = $2)
          OR hash = decode($3, 'hex')`,
          [academicYear, fileName, sha256],
        );
        const clearedCount = cleared.changes;
        if (rows.length === 0) {
          await recordChanges();
          return clearedCount;
        }

        const inserted = await transaction.executeNative(
            `INSERT INTO gradebook.importacao_diagnostico
        (ano,arquivo,hash,chave,nivel,codigo,turma_codigo,disciplina,periodo,
         aluno_numero,campo,rotulo,valor_encontrado,causa,guia,celula)
       SELECT x.ano,x.arquivo,decode(x.hash_hex,'hex'),x.chave,x.nivel,x.codigo,
              x.turma_codigo,x.disciplina,x.periodo,x.aluno_numero,x.campo,x.rotulo,
              x.valor_encontrado,x.causa,x.guia,x.celula
       FROM jsonb_to_recordset($1::jsonb) AS x(
         ano smallint,arquivo text,hash_hex text,chave text,nivel text,codigo text,
         turma_codigo text,disciplina text,periodo text,aluno_numero smallint,
         campo text,rotulo text,valor_encontrado text,causa text,guia text,celula text
       )`,
          [postgresJsonTextV1(serialized)],
        );
        const writtenCount = inserted.changes;
        if (writtenCount !== rows.length) throw new Error('import-diagnostics-incomplete-snapshot');
        await recordChanges();
        return clearedCount + writtenCount;
      });
    } catch (cause) {
      if (cause === scopeChanged && attempt < 2) continue;
      throw cause;
    }
  }
}
