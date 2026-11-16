import type {
  GradebookImportPersistenceRequestV9,
  GradebookImportPersistenceResponseV9,
  GradebookNotesImportRequestV9,
  GradebookRelationWarningV9,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { holdNameMismatchesV1, studentKeyV1 } from '../../onedrive-sync/server-audit-v1';

const keyV1 = (classCode: string, number: number) => `${classCode.trim().toUpperCase()}:${number}`;

/**
 * A student of the workbook that the system's Relação does not have in that class would make
 * the database refuse the whole file. Only that student is left out and reported; a class the
 * Relação does not have at all is left for the import to refuse (Relação first).
 */
export function dropUnboundStudentsV1(
  request: GradebookNotesImportRequestV9,
  bound: ReadonlySet<string>,
): {
  readonly request: GradebookNotesImportRequestV9;
  readonly warnings: GradebookRelationWarningV9[];
} {
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
    for (const numero of [...missing].sort((a, b) => a - b))
      warnings.push({ code: 'student-not-in-relation', classCode, number: numero });
    const present = <T extends readonly [number, ...unknown[]]>(row: T) => !missing.has(row[0]);
    return {
      ...offer,
      trimestres: offer.trimestres.map((term) => ({
        ...term,
        alunos: term.alunos.filter(present),
      })) as unknown as typeof offer.trimestres,
      recuperacao: offer.recuperacao === null ? null : offer.recuperacao.filter(present),
    };
  });
  return { request: warnings.length === 0 ? request : { ...request, ofertas }, warnings };
}

/**
 * Rule 14 (BN-DEC-046) in the manual import: with the workbook's names, a student whose name
 * is not the Relação's for that number is held, the same function as the OneDrive reading. Without
 * names (an older tab), nothing changes.
 */
export function holdManualNameMismatchesV1(
  request: GradebookNotesImportRequestV9,
  relationNames: ReadonlyMap<string, string>,
): {
  readonly request: GradebookNotesImportRequestV9;
  readonly warnings: GradebookRelationWarningV9[];
} {
  const { nomes, ...rest } = request;
  if (!nomes || nomes.length === 0) return { request: rest, warnings: [] };
  const sheetNames = new Map(
    nomes.map(([classCode, number, name]) => [studentKeyV1(classCode, number), name] as const),
  );
  const checked = holdNameMismatchesV1(rest, sheetNames, relationNames);
  const warnings = checked.items
    .filter((item) => item.code === 'student-name-mismatch' && item.classCode && item.studentNumber)
    .map((item): GradebookRelationWarningV9 => ({
      code: 'student-name-mismatch',
      classCode: item.classCode!.trim().toUpperCase(),
      number: item.studentNumber!,
    }));
  return { request: checked.request, warnings };
}

/** The bound students (`TURMA:número`) of a Relação read with names. */
export function boundStudentsFromNamesV1(
  relationNames: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  return new Set(
    [...relationNames.keys()].map((key) => {
      const at = key.lastIndexOf('|');
      return `${key.slice(0, at)}:${key.slice(at + 1)}`;
    }),
  );
}

/** Adds the left-out students to a written import's warnings. */
export function withUnboundWarningsV1(
  response: GradebookImportPersistenceResponseV9,
  warnings: readonly GradebookRelationWarningV9[],
): GradebookImportPersistenceResponseV9 {
  if (warnings.length === 0 || (response.state !== 'applied' && response.state !== 'no-changes'))
    return response;
  return { ...response, warnings: [...(response.warnings ?? []), ...warnings] };
}

export function isNotesRequestV1(
  request: GradebookImportPersistenceRequestV9,
): request is GradebookNotesImportRequestV9 {
  return request.operation === 'persist-notas';
}
