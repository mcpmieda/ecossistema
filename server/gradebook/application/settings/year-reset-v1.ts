import {
  completeYearResetV1,
  lockYearResetV1,
  newYearResetTokenV1,
  yearResetDigestV1,
  yearResetProofV1,
} from '../../../student-portal/integration/year-reset/proof-v1';
import {
  confirmationPhraseForYearResetV1,
  YEAR_RESET_CONTRACT_VERSION_V1,
  yearResetRequestSchemaV1,
  yearResetResponseSchemaV1,
  type YearResetCountsV1,
  type YearResetResponseV1,
} from '../../../../shared/gradebook-contracts/settings/year-reset-contract-v1';
import {
  type GradebookPostgresWritePortV1,
  type GradebookPostgresScalarV1, type GradebookPostgresTransactionV1 
} from '../../persistence/postgres/postgres-database-v1';

import { inOrderV1 } from '../../../../shared/in-order-v1';
import { frequencyYearCountsV2, resetFrequencyYearV2 } from '../../../attendance/service-v2';

type Row = Record<string, unknown>;
type TransactionalDatabase = GradebookPostgresWritePortV1 & {
  transaction<T>(operation: (database: GradebookPostgresTransactionV1) => Promise<T>): Promise<T>;
};

const RECONCILIATION_TABLES_V1 = [
  'student_report_pending_row_v1', 'student_report_profile_v1', 'student_source_link_v1',
  'student_reconciliation_decision_v1', 'student_source_observation_v1',
  'student_source_record_v1', 'student_report_class_v1', 'student_report_batch_v1',
] as const;

const RESET_TABLES_V1 = [
  'student_reconciliation_scope_v1',
  ...RECONCILIATION_TABLES_V1,
  'conselho_fechamento_item',
  'conselho_sessao_historico',
  'conselho_votacao_historico',
  'conselho_decisao_comando',
  'conselho_idempotencia',
  'conselho_votacao',
  'conselho_fechamento',
  'conselho_sessao',
  'boletim_snapshot',
  'importacao_diagnostico_tratamento',
  'nota_historico',
  'nota',
  'fechamento_historico',
  'fechamento',
  'instrumento_historico',
  'instrumento',
  'vinculo_historico',
  'vinculo',
  'conselho_anterior_historico',
  'conselho_decisao_historico',
  'conselho_decisao',
  'importacao_diagnostico',
  'importacao',
  'oferta',
  'aluno',
  'turma',
  'professor',
  'disciplina',
  'ano_letivo_historico',
  'ano_letivo',
] as const;

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid-year-reset-count');
  }
  return value;
}

async function first(
  database: GradebookPostgresTransactionV1,
  sql: string,
  values: readonly GradebookPostgresScalarV1[] = [],
): Promise<Row | null> {
  return (await database.query<Row>(sql, values))[0] ?? null;
}

async function loadCounts(
  database: GradebookPostgresTransactionV1,
  year: number,
): Promise<YearResetCountsV1> {
  const row = await first(
    database,
    `WITH y AS (SELECT $1::smallint AS ano)
     SELECT
       (SELECT count(*)::integer FROM gradebook.ano_letivo a,y WHERE a.ano=y.ano) AS academic_year,
       (${RECONCILIATION_TABLES_V1.map((table) => `(SELECT count(*) FROM gradebook.${table} r,y WHERE r.academic_year=y.ano)`).join('+')}
         +student_portal.reconciliation_credential_counts_v1($1::smallint))::integer AS reconciliation,
       (SELECT count(*)::integer FROM gradebook.aluno a,y WHERE a.ano=y.ano) AS students,
       (SELECT count(*)::integer FROM gradebook.turma t,y WHERE t.ano=y.ano) AS classes,
       (SELECT count(*)::integer FROM gradebook.professor p,y WHERE p.ano=y.ano) AS teachers,
       (SELECT count(*)::integer FROM gradebook.disciplina d,y WHERE d.ano=y.ano) AS subjects,
       (SELECT count(*)::integer FROM gradebook.vinculo v,y WHERE v.ano=y.ano) AS bindings,
       (SELECT count(*)::integer FROM gradebook.oferta o,y WHERE o.ano=y.ano) AS offers,
       (SELECT count(*)::integer FROM gradebook.instrumento i JOIN gradebook.oferta o ON o.id=i.oferta_id,y WHERE o.ano=y.ano) AS assessments,
       (SELECT count(*)::integer FROM gradebook.nota n JOIN gradebook.instrumento i ON i.id=n.instrumento_id JOIN gradebook.oferta o ON o.id=i.oferta_id,y WHERE o.ano=y.ano) AS grades,
       (SELECT count(*)::integer FROM gradebook.fechamento f JOIN gradebook.oferta o ON o.id=f.oferta_id,y WHERE o.ano=y.ano) AS closures,
       (SELECT count(*)::integer FROM gradebook.importacao i,y WHERE i.ano=y.ano) AS imports,
       (SELECT count(*)::integer FROM gradebook.importacao_diagnostico d,y WHERE d.ano=y.ano) AS diagnostics,
       (SELECT count(*)::integer FROM gradebook.importacao_diagnostico_tratamento t,y WHERE t.ano=y.ano) AS audit_trail,
       ((SELECT count(*) FROM gradebook.conselho_decisao c JOIN gradebook.aluno a ON a.id=c.aluno_id,y WHERE a.ano=y.ano)
        +(SELECT count(*) FROM gradebook.conselho_sessao c,y WHERE c.ano=y.ano)
        +(SELECT count(*) FROM gradebook.conselho_sessao_historico c,y WHERE c.ano=y.ano)
        +(SELECT count(*) FROM gradebook.conselho_idempotencia c,y WHERE c.ano=y.ano)
        +(SELECT count(*) FROM gradebook.conselho_votacao c,y WHERE c.ano=y.ano)
        +(SELECT count(*) FROM gradebook.conselho_votacao_historico c,y WHERE c.ano=y.ano)
        +(SELECT count(*) FROM gradebook.conselho_decisao_comando c,y WHERE c.ano=y.ano)
        +(SELECT count(*) FROM gradebook.conselho_fechamento c,y WHERE c.ano=y.ano)
        +(SELECT count(*) FROM gradebook.conselho_fechamento_item i JOIN gradebook.conselho_fechamento c ON c.id=i.fechamento_id,y WHERE c.ano=y.ano))::integer AS council,
       (SELECT count(*)::integer FROM gradebook.boletim_snapshot b,y WHERE b.ano=y.ano) AS bulletins,
       ((SELECT count(*) FROM gradebook.ano_letivo_historico h,y WHERE h.ano=y.ano)
        +(SELECT count(*) FROM gradebook.conselho_anterior_historico h JOIN gradebook.aluno a ON a.id=h.aluno_id,y WHERE a.ano=y.ano)
        +(SELECT count(*) FROM gradebook.conselho_decisao_historico h JOIN gradebook.aluno a ON a.id=h.aluno_id,y WHERE a.ano=y.ano)
        +(SELECT count(*) FROM gradebook.fechamento_historico h JOIN gradebook.oferta o ON o.id=h.oferta_id,y WHERE o.ano=y.ano)
        +(SELECT count(*) FROM gradebook.instrumento_historico h JOIN gradebook.instrumento i ON i.id=h.instrumento_id JOIN gradebook.oferta o ON o.id=i.oferta_id,y WHERE o.ano=y.ano)
        +(SELECT count(*) FROM gradebook.nota_historico h JOIN gradebook.instrumento i ON i.id=h.instrumento_id JOIN gradebook.oferta o ON o.id=i.oferta_id,y WHERE o.ano=y.ano)
        +(SELECT count(*) FROM gradebook.vinculo_historico h JOIN gradebook.turma t ON t.id=h.turma_id,y WHERE t.ano=y.ano))::integer AS histories`,
    [year],
  );
  if (!row) throw new Error('year-reset-counts-missing');
  const attendance = await hasFrequency(database, year)
    ? Object.values(await frequencyYearCountsV2(database, year)).reduce((sum, value) => sum + integer(value), 0)
    : 0;
  const counts = {
    academicYear: integer(row.academic_year),
    students: integer(row.students),
    classes: integer(row.classes),
    teachers: integer(row.teachers),
    subjects: integer(row.subjects),
    bindings: integer(row.bindings),
    offers: integer(row.offers),
    assessments: integer(row.assessments),
    grades: integer(row.grades),
    closures: integer(row.closures),
    imports: integer(row.imports),
    diagnostics: integer(row.diagnostics),
    auditTrail: integer(row.audit_trail),
    council: integer(row.council),
    bulletins: integer(row.bulletins),
    histories: integer(row.histories),
    reconciliation: integer(row.reconciliation),
    attendance,
  };
  return {
    ...counts,
    totalRows: Object.values(counts).reduce((total, value) => total + value, 0),
  };
}

async function hasFrequency(database: GradebookPostgresTransactionV1, year: number): Promise<boolean> {
  if (year !== 2026) return false;
  const row = await first(database, "SELECT to_regclass('attendance.school_state_v2') IS NOT NULL AS installed");
  return row?.installed === true || row?.installed === 1;
}

function changed(result: { readonly changes: number }): number {
  const value = result.changes;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid-year-reset-write-count');
  }
  return value;
}

async function removeYear(database: GradebookPostgresTransactionV1, year: number): Promise<number> {
  let deleted = 0;
  if (await hasFrequency(database, year)) {
    const counts = await resetFrequencyYearV2(database, year);
    deleted += Object.values(counts).reduce((sum, value) => sum + integer(value), 0);
  }
  const run = async (sql: string) => {
    deleted += changed(await database.executeNative(sql, [year]));
  };

  const portal = await first(database,
    'SELECT student_portal.clear_reconciliation_credentials_v1($1::smallint) AS deleted', [year]);
  if (!portal) throw new Error('year-reset-reconciliation-count-missing');
  deleted += integer(portal.deleted);
  await database.executeNative('UPDATE gradebook.student_reconciliation_scope_v1 SET current_batch_id=NULL WHERE academic_year=$1', [year]);
  await database.executeNative('UPDATE gradebook.student_source_record_v1 SET current_observation_id=NULL WHERE academic_year=$1', [year]);
  await inOrderV1(RECONCILIATION_TABLES_V1, (table) => run(`DELETE FROM gradebook.${table} WHERE academic_year=$1`));
  await database.executeNative(`UPDATE gradebook.student_reconciliation_scope_v1
    SET generation=gen_random_uuid(),revision=0,academic_revision=NULL,name_source='report' WHERE academic_year=$1`, [year]);

  await database.executeNative(
    'UPDATE gradebook.conselho_sessao SET fechamento_atual_id=NULL WHERE ano=$1',
    [year],
  );
  await run(`DELETE FROM gradebook.conselho_fechamento_item i USING gradebook.conselho_fechamento c
    WHERE c.id=i.fechamento_id AND c.ano=$1`);
  for (const table of [
    'conselho_sessao_historico',
    'conselho_votacao_historico',
    'conselho_decisao_comando',
    'conselho_idempotencia',
    'conselho_votacao',
    'conselho_fechamento',
    'conselho_sessao',
    'boletim_snapshot',
    'importacao_diagnostico_tratamento',
  ] as const) {
    await run(`DELETE FROM gradebook.${table} WHERE ano=$1`);
  }
  await run(`DELETE FROM gradebook.nota_historico h USING gradebook.instrumento i,gradebook.oferta o
    WHERE i.id=h.instrumento_id AND o.id=i.oferta_id AND o.ano=$1`);
  await run(`DELETE FROM gradebook.nota n USING gradebook.instrumento i,gradebook.oferta o
    WHERE i.id=n.instrumento_id AND o.id=i.oferta_id AND o.ano=$1`);
  await run(`DELETE FROM gradebook.fechamento_historico h USING gradebook.oferta o
    WHERE o.id=h.oferta_id AND o.ano=$1`);
  await run(`DELETE FROM gradebook.fechamento f USING gradebook.oferta o
    WHERE o.id=f.oferta_id AND o.ano=$1`);
  await run(`DELETE FROM gradebook.instrumento_historico h USING gradebook.instrumento i,gradebook.oferta o
    WHERE i.id=h.instrumento_id AND o.id=i.oferta_id AND o.ano=$1`);
  await run(`DELETE FROM gradebook.instrumento i USING gradebook.oferta o
    WHERE o.id=i.oferta_id AND o.ano=$1`);
  await run(`DELETE FROM gradebook.vinculo_historico h USING gradebook.turma t
    WHERE t.id=h.turma_id AND t.ano=$1`);
  await run('DELETE FROM gradebook.vinculo WHERE ano=$1');
  for (const table of [
    'conselho_anterior_historico',
    'conselho_decisao_historico',
    'conselho_decisao',
  ] as const) {
    await run(`DELETE FROM gradebook.${table} c USING gradebook.aluno a
      WHERE a.id=c.aluno_id AND a.ano=$1`);
  }
  await run('DELETE FROM gradebook.importacao_diagnostico WHERE ano=$1');
  await run('DELETE FROM gradebook.importacao WHERE ano=$1');
  await run('DELETE FROM gradebook.oferta WHERE ano=$1');
  for (const table of [
    'aluno',
    'turma',
    'professor',
    'disciplina',
    'ano_letivo_historico',
    'ano_letivo',
  ] as const) {
    await run(`DELETE FROM gradebook.${table} WHERE ano=$1`);
  }
  return deleted;
}

export function createYearResetServiceV1(database: GradebookPostgresWritePortV1, actorOid: string) {
  return {
    async execute(input: unknown): Promise<YearResetResponseV1> {
      const parsed = yearResetRequestSchemaV1.safeParse(input);
      if (!parsed.success) {
        return { contractVersion: YEAR_RESET_CONTRACT_VERSION_V1, state: 'invalid-request' };
      }
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(actorOid)) {
        return { contractVersion: YEAR_RESET_CONTRACT_VERSION_V1, state: 'not-authorized' };
      }
      if (!('transaction' in database) || typeof database.transaction !== 'function') {
        return { contractVersion: YEAR_RESET_CONTRACT_VERSION_V1, state: 'unavailable' };
      }
      const request = parsed.data;
      const actorDigest = await yearResetDigestV1(actorOid.toLowerCase());
      const token =
        request.operation === 'preview' ? newYearResetTokenV1() : request.previewRevision;
      const tokenDigest = await yearResetDigestV1(token);
      if (
        request.operation === 'execute' &&
        request.confirmationPhrase !== confirmationPhraseForYearResetV1(request.year)
      ) {
        return { contractVersion: YEAR_RESET_CONTRACT_VERSION_V1, state: 'preview-changed' };
      }
      // Restart the entire physical transaction once; never continue an old snapshot.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const response = await (database as TransactionalDatabase).transaction(
            async (transaction) => {
              await transaction.executeNative(
                request.operation === 'preview'
                  ? 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
                  : 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
                [],
              );
              await lockYearResetV1(transaction, request.year, request.operation);
              if (request.operation === 'execute') {
                await transaction.executeNative(
                  `LOCK TABLE ${RESET_TABLES_V1.map((table) => `gradebook.${table}`).join(',')} IN SHARE ROW EXCLUSIVE MODE`,
                  [],
                );
              }
              const state = await yearResetProofV1(
                transaction,
                request.operation === 'preview' ? 'prepare' : 'consume',
                request.year,
                actorDigest,
                tokenDigest,
              );
              if (state !== 'clear')
                return { contractVersion: YEAR_RESET_CONTRACT_VERSION_V1, state };
              const counts = await loadCounts(transaction, request.year);
              if (counts.academicYear !== 1 && !(counts.academicYear === 0 && counts.reconciliation + counts.attendance > 0))
                throw new Error('year-reset-year-missing-after-proof');
              if (request.operation === 'preview') {
                return {
                  contractVersion: YEAR_RESET_CONTRACT_VERSION_V1,
                  state: 'ready',
                  operation: 'preview',
                  year: request.year,
                  counts,
                  previewRevision: token,
                  confirmationPhrase: confirmationPhraseForYearResetV1(request.year),
                } as const;
              }
              const deletedRows = await removeYear(transaction, request.year);
              if (deletedRows !== counts.totalRows) throw new Error('year-reset-incomplete-delete');
              const remaining = await loadCounts(transaction, request.year);
              if (remaining.totalRows !== 0) throw new Error('year-reset-postcondition-failed');
              await completeYearResetV1(transaction, request.year, actorDigest, tokenDigest);
              return {
                contractVersion: YEAR_RESET_CONTRACT_VERSION_V1,
                state: 'ready',
                operation: 'execute',
                year: request.year,
                deletedRows,
              } as const;
            },
          );
          return yearResetResponseSchemaV1.parse(response);
        } catch (cause) {
          const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
          if (code === '40001' && attempt === 0) continue;
          throw cause;
        }
      }
    },
  };
}
