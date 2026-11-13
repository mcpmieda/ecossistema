import type {
  GradebookImportDiagnosticAuditItemV1,
  GradebookImportDiagnosticsAuditRequestV1,
} from '../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import type {
  GradebookImportCellV9,
  GradebookNotesImportRequestV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

/**
 * The two BN-DEC-046 rules that need context outside the workbook: the academic year of the
 * folder (rule 3) and the system's Relação (rule 14). Both only hold and report; nothing is fixed.
 */
const HELD: readonly ['u'] = ['u'];

/** Rule 3: CONFIGURAÇÃO!C2 is not the year of the folder. Reported under the expected year. */
export function wrongYearAuditV1(audit: GradebookImportDiagnosticsAuditRequestV1, expectedYear: number,
  foundYear: number | null): GradebookImportDiagnosticsAuditRequestV1 {
  const item: GradebookImportDiagnosticAuditItemV1 = {
    key: `wrong-year|${audit.fileName}`.slice(0, 320),
    severity: 'blocking-error',
    code: 'wrong-year',
    message: 'Ano da planilha diferente do ano da pasta.',
    recommendedAction: `Corrija o ano em CONFIGURAÇÃO!C2 para ${expectedYear}. Nada desta planilha foi lançado.`,
    fieldKind: 'file',
    ...(foundYear === null ? {} : { foundValue: String(foundYear) }),
    sheetName: 'CONFIGURAÇÃO',
    cellAddress: 'C2',
  };
  return { ...audit, academicYear: expectedYear, diagnostics: [...audit.diagnostics, item] };
}

const PARTICLES = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E']);

function nameTokens(name: string): string[] {
  return name.normalize('NFD').replace(/[̀-ͯ]/gu, '').toUpperCase().replace(/[^A-Z. ]/gu, ' ')
    .split(/\s+/u).filter((token) => token && !PARTICLES.has(token));
}

function sameToken(a: string, b: string): boolean {
  const initial = (token: string) => token.length === 1 || (token.length === 2 && token.endsWith('.'));
  if (initial(a) || initial(b)) return a[0] === b[0];
  return a.replace(/\.$/u, '') === b.replace(/\.$/u, '');
}

/** Same person by first and last name; an abbreviated surname ("S.") matches by its initial. */
export function sameStudentNameV1(sheetName: string, relationName: string): boolean {
  const a = nameTokens(sheetName);
  const b = nameTokens(relationName);
  if (a.length === 0 || b.length === 0) return true;
  if (!sameToken(a[0]!, b[0]!)) return false;
  if (a.length === 1 || b.length === 1) return true;
  return sameToken(a.at(-1)!, b.at(-1)!);
}

export const studentKeyV1 = (classCode: string, number: number) => `${classCode.trim().toUpperCase()}|${number}`;

/**
 * Rule 14: a student whose name in the sheet is not the Relação's name for that number is held
 * in that class/subject (every term and the final recovery), so no grade reaches someone else.
 */
export function holdNameMismatchesV1(request: GradebookNotesImportRequestV9,
  sheetNames: ReadonlyMap<string, string>, relationNames: ReadonlyMap<string, string>):
  { readonly request: GradebookNotesImportRequestV9; readonly items: GradebookImportDiagnosticAuditItemV1[] } {
  const items: GradebookImportDiagnosticAuditItemV1[] = [];
  const ofertas = request.ofertas.map((offer) => {
    const held = new Set<number>();
    for (const [numero] of offer.trimestres[0].alunos) {
      const key = studentKeyV1(offer.turmaCodigo, numero);
      const sheetName = sheetNames.get(key);
      const relationName = relationNames.get(key);
      if (!sheetName || !relationName || sameStudentNameV1(sheetName, relationName)) continue;
      held.add(numero);
      items.push({
        key: `student-name-mismatch|${offer.turmaCodigo}|${offer.disciplina}|${numero}`.slice(0, 320),
        severity: 'blocking-error',
        code: 'student-name-mismatch',
        message: 'Nome do aluno diferente da Relação para este número.',
        recommendedAction: 'Confira o número e o nome do aluno na planilha. As notas dele nesta disciplina não foram lançadas.',
        classCode: offer.turmaCodigo,
        subject: offer.disciplina,
        studentNumber: numero,
        fieldKind: 'student',
        foundValue: sheetName.slice(0, 240),
      });
    }
    if (held.size === 0) return offer;
    const holdRow = <T extends readonly [number, ...unknown[]]>(row: T, hold: (row: T) => T) => (held.has(row[0]) ? hold(row) : row);
    return {
      ...offer,
      trimestres: offer.trimestres.map((term) => ({
        ...term,
        alunos: term.alunos.map((row) => holdRow(row, ([numero, values]) =>
          [numero, values.map((): GradebookImportCellV9 => HELD), HELD] as unknown as typeof row)),
      })) as unknown as typeof offer.trimestres,
      recuperacao: offer.recuperacao?.map((row) => holdRow(row, ([numero]) =>
        [numero, HELD, HELD, HELD, HELD] as unknown as typeof row)) ?? null,
    };
  });
  return { request: { ...request, ofertas }, items };
}
