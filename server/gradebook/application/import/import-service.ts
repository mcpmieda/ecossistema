import { normalizeTemplateDescriptionsV1 } from '../../../../shared/gradebook-contracts/source/qualitative-slot-evidence-v1';
import { lockResetWriterV1 } from '../../../student-portal/integration/year-reset/writer-v1';
import type {
  GradebookImportOfferV9,
  GradebookImportPersistenceRequestV9,
  GradebookImportPersistenceResponseV9,
  GradebookImportTermV9,
  GradebookNotesImportRequestV9,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import {
  requireTransactionDatabaseV1,
  type GradebookPostgresReadPortV1,
  type GradebookPostgresWritePortV1,
} from '../../persistence/postgres/postgres-database-v1';
import { createBufferedRelationalImportDatabaseV11 } from '../../persistence/postgres/relational-import-write-buffer-v11';
import type { ImportPerformanceObserverV1 } from '../../persistence/postgres/import-performance-observer-v1';
import { createRelationalImportWriter } from './relational-import-writer';

type Row = Record<string, unknown>;

type NonCommittedImportResponse = Exclude<
  GradebookImportPersistenceResponseV9,
  { readonly state: 'applied' | 'no-changes' }
>;

function isNonCommittedImportResponse(
  response: GradebookImportPersistenceResponseV9,
): response is NonCommittedImportResponse {
  return response.state !== 'applied' && response.state !== 'no-changes';
}

class ImportRollback extends Error {
  constructor(readonly response: NonCommittedImportResponse) {
    super('gradebook-import-transaction-not-committed');
  }
}

function classKey(value: string): string {
  return value.trim().toUpperCase();
}

function historicalBindingKey(turmaCodigo: string, numero: number): string {
  return `${classKey(turmaCodigo)}:${numero}`;
}

function filterTerm(
  term: GradebookImportTermV9,
  turmaCodigo: string,
  historicalBindings: ReadonlySet<string>,
): GradebookImportTermV9 {
  return {
    ...term,
    alunos: term.alunos.filter(
      ([numero]) => !historicalBindings.has(historicalBindingKey(turmaCodigo, numero)),
    ),
  };
}

function filterOffer(
  offer: GradebookImportOfferV9,
  historicalBindings: ReadonlySet<string>,
): GradebookImportOfferV9 {
  const [term1, term2, term3] = offer.trimestres;
  return {
    ...offer,
    trimestres: [
      filterTerm(term1, offer.turmaCodigo, historicalBindings),
      filterTerm(term2, offer.turmaCodigo, historicalBindings),
      filterTerm(term3, offer.turmaCodigo, historicalBindings),
    ],
    recuperacao:
      offer.recuperacao === null
        ? null
        : offer.recuperacao.filter(
            ([numero]) => !historicalBindings.has(historicalBindingKey(offer.turmaCodigo, numero)),
          ),
  };
}

/**
 * Movement rule, applied independently inside each selected year:
 * facts from a FOI_PARA binding belong to the previous class and are discarded
 * before persistence. There is deliberately no fallback to the previous class.
 */
export function filterHistoricalClassFacts(
  request: GradebookNotesImportRequestV9,
  historicalBindings: ReadonlySet<string>,
): GradebookNotesImportRequestV9 {
  if (historicalBindings.size === 0) return request;
  return {
    ...request,
    ofertas: request.ofertas.map((offer) => filterOffer(offer, historicalBindings)),
  };
}

async function loadHistoricalBindings(
  database: GradebookPostgresReadPortV1,
  ano: number,
): Promise<ReadonlySet<string>> {
  const rows = await database.query<Row>(
    `SELECT t.codigo AS turma_codigo, v.numero
     FROM gradebook.vinculo v
     JOIN gradebook.turma t ON t.id = v.turma_id
     WHERE v.ano = $1 AND v.situacao = 6`,
    [ano],
  );
  const result = new Set<string>();
  for (const row of rows) {
    const numero = typeof row.numero === 'number' ? row.numero : Number(row.numero);
    if (!Number.isSafeInteger(numero) || numero <= 0 || typeof row.turma_codigo !== 'string') {
      throw new Error('gradebook-historical-binding-invalid');
    }
    result.add(historicalBindingKey(row.turma_codigo, numero));
  }
  return result;
}

/**
 * Academic policy over the database it receives (the service passes the buffered one):
 * the Relação goes straight to the writer; notes run in one transaction that holds the
 * year lock, drops FOI_PARA facts and rolls back when the writer does not commit.
 */
export async function applyImportPolicy(
  database: GradebookPostgresWritePortV1,
  request: GradebookImportPersistenceRequestV9,
  actorId?: string,
): Promise<GradebookImportPersistenceResponseV9> {
  if (request.operation === 'persist-relacao') {
    return createRelationalImportWriter(database, actorId).execute(request);
  }

  try {
    return await requireTransactionDatabaseV1(database).transaction(async (transaction) => {
      // Hold the same year lock used by the writer while selecting the current/historical
      // bindings, so a concurrent Relação import cannot change the movement state
      // between filtering and persistence. The writer reuses this transaction and lock.
      await lockResetWriterV1(transaction, request.ano);
      const historicalBindings = await loadHistoricalBindings(transaction, request.ano);
      const filtered = filterHistoricalClassFacts(request, historicalBindings);
      const result = await createRelationalImportWriter(transaction).execute(filtered);
      // The native facade reuses nested transactions without a savepoint.
      // A refusal caught by the writer must still reach the outer rollback boundary.
      if (isNonCommittedImportResponse(result)) {
        throw new ImportRollback(result);
      }
      return result;
    });
  } catch (cause) {
    if (cause instanceof ImportRollback) return cause.response;
    throw cause;
  }
}

/**
 * Gradebook import service: normalizes template descriptions, groups the writer's
 * single-row nota/fechamento writes into bounded recordset statements inside the same
 * transaction, and applies the academic policy. The version lives only in the network
 * contract (`transportVersion: 9`).
 */
export function createGradebookImportService(
  database: GradebookPostgresWritePortV1,
  observer?: ImportPerformanceObserverV1,
  actorId?: string,
) {
  const buffered = createBufferedRelationalImportDatabaseV11(database, observer);
  return {
    execute(
      request: GradebookImportPersistenceRequestV9,
    ): Promise<GradebookImportPersistenceResponseV9> {
      return applyImportPolicy(buffered, normalizeTemplateDescriptionsV1(request), actorId);
    },
  };
}
