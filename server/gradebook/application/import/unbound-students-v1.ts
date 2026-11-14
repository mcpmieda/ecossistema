import type {
  GradebookImportPersistenceRequestV9,
  GradebookImportPersistenceResponseV9,
  GradebookNotesImportRequestV9,
  GradebookRelationWarningV9,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { GradebookPostgresReadPortV1 } from '../../persistence/postgres/postgres-database-v1';

const keyV1 = (classCode: string, number: number) => `${classCode.trim().toUpperCase()}:${number}`;

/**
 * A student of the workbook that the system's Relação does not have in that class would make
 * the database refuse the whole file. Only that student is left out and reported; a class the
 * Relação does not have at all is left for the import to refuse (Relação first).
 */
export function dropUnboundStudentsV1(
  request: GradebookNotesImportRequestV9,
  bound: ReadonlySet<string>,
): { readonly request: GradebookNotesImportRequestV9; readonly warnings: GradebookRelationWarningV9[] } {
  const classes = new Set([...bound].map((key) => key.slice(0, key.lastIndexOf(':'))));
  const warnings: GradebookRelationWarningV9[] = [];
  const ofertas = request.ofertas.map((offer) => {
    const classCode = offer.turmaCodigo.trim().toUpperCase();
    if (!classes.has(classCode)) return offer;
    const numbers = new Set([
      ...offer.trimestres.flatMap((term) => term.alunos.map(([numero]) => numero)),
      ...(offer.recuperacao ?? []).map(([numero]) => numero),
    ]);
    const missing = new Set([...numbers].filter((numero) => !bound.has(keyV1(classCode, numero))));
    if (missing.size === 0) return offer;
    for (const numero of [...missing].sort((a, b) => a - b)) warnings.push({ code: 'student-not-in-relation', classCode, number: numero });
    const present = <T extends readonly [number, ...unknown[]]>(row: T) => !missing.has(row[0]);
    return {
      ...offer,
      trimestres: offer.trimestres.map((term) => ({ ...term, alunos: term.alunos.filter(present) })) as unknown as typeof offer.trimestres,
      recuperacao: offer.recuperacao === null ? null : offer.recuperacao.filter(present),
    };
  });
  return { request: warnings.length === 0 ? request : { ...request, ofertas }, warnings };
}

/** Every `TURMA:número` the system's Relação has for the year (any situation). */
export async function loadBoundStudentsV1(database: GradebookPostgresReadPortV1, year: number): Promise<ReadonlySet<string>> {
  const rows = await database.query<{ turma_codigo: unknown; numero: unknown }>(
    `SELECT t.codigo AS turma_codigo, v.numero
     FROM gradebook.vinculo v
     JOIN gradebook.turma t ON t.id = v.turma_id
     WHERE v.ano = $1`,
    [year],
  );
  const result = new Set<string>();
  for (const row of rows) {
    const numero = Number(row.numero);
    if (Number.isSafeInteger(numero) && numero > 0 && typeof row.turma_codigo === 'string') result.add(keyV1(row.turma_codigo, numero));
  }
  return result;
}

/** Adds the left-out students to a written import's warnings. */
export function withUnboundWarningsV1(
  response: GradebookImportPersistenceResponseV9,
  warnings: readonly GradebookRelationWarningV9[],
): GradebookImportPersistenceResponseV9 {
  if (warnings.length === 0 || (response.state !== 'applied' && response.state !== 'no-changes')) return response;
  return { ...response, warnings: [...(response.warnings ?? []), ...warnings] };
}

export function isNotesRequestV1(request: GradebookImportPersistenceRequestV9): request is GradebookNotesImportRequestV9 {
  return request.operation === 'persist-notas';
}
