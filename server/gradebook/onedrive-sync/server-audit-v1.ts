import type {
  GradebookImportDiagnosticAuditItemV1,
  GradebookImportDiagnosticsAuditRequestV1,
} from '../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import type {
  GradebookImportCellV9,
  GradebookNotesImportRequestV9,
  GradebookRelationMovementEndpointV9,
  GradebookRelationMovementReviewV9,
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
    // A student the system's Relação does not have for this class: the database would refuse
    // the whole file, so only that student is left out (and shown in the Auditoria).
    const missing = new Set<number>();
    if (relationNames.size > 0) {
      const numbers = new Set([...offer.trimestres.flatMap((term) => term.alunos.map(([numero]) => numero)),
        ...(offer.recuperacao ?? []).map(([numero]) => numero)]);
      for (const numero of numbers) {
        if (relationNames.has(studentKeyV1(offer.turmaCodigo, numero))) continue;
        missing.add(numero);
        items.push({
          key: `student-not-in-relation|${offer.turmaCodigo}|${offer.disciplina}|${numero}`.slice(0, 320),
          severity: 'blocking-error',
          code: 'student-not-in-relation',
          message: 'Aluno da planilha não está na Relação do sistema.',
          recommendedAction: 'Envie a Relação atualizada ao sistema ou confira o número na planilha. As notas deste aluno não foram lançadas.',
          classCode: offer.turmaCodigo,
          subject: offer.disciplina,
          studentNumber: numero,
          fieldKind: 'student',
          ...(sheetNames.get(studentKeyV1(offer.turmaCodigo, numero)) ? { foundValue: sheetNames.get(studentKeyV1(offer.turmaCodigo, numero))!.slice(0, 240) } : {}),
        });
      }
    }
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
    if (held.size === 0 && missing.size === 0) return offer;
    const holdRow = <T extends readonly [number, ...unknown[]]>(row: T, hold: (row: T) => T) => (held.has(row[0]) ? hold(row) : row);
    const present = <T extends readonly [number, ...unknown[]]>(row: T) => !missing.has(row[0]);
    return {
      ...offer,
      trimestres: offer.trimestres.map((term) => ({
        ...term,
        alunos: term.alunos.filter(present).map((row) => holdRow(row, ([numero, values]) =>
          [numero, values.map((): GradebookImportCellV9 => HELD), HELD] as unknown as typeof row)),
      })) as unknown as typeof offer.trimestres,
      recuperacao: offer.recuperacao?.filter(present).map((row) => holdRow(row, ([numero]) =>
        [numero, HELD, HELD, HELD, HELD] as unknown as typeof row)) ?? null,
    };
  });
  return { request: { ...request, ofertas }, items };
}

const endpointV1 = (item: GradebookRelationMovementEndpointV9) => `${item.classCode} nº ${item.number} ${item.name}`.trim();

/**
 * A Relação the database asks to review (a class move it cannot pair by itself, or a position
 * with evidence of another student): nothing of it was written. One finding per doubtful move,
 * so only that doubt needs a look; the confirmation is the manual import's movement review.
 */
export function relationReviewItemsV1(fileName: string, reason: string,
  review: GradebookRelationMovementReviewV9 | undefined): GradebookImportDiagnosticAuditItemV1[] {
  const action = 'Confirme os pares na importação manual da Relação (ela mostra a conferência). Nada desta Relação foi lançado.';
  const groups = review?.groups ?? [];
  if (groups.length === 0) {
    return [{
      key: `class-move-review|${fileName}`.slice(0, 320), severity: 'blocking-error', code: 'class-move-review',
      message: 'A Relação tem aluno com dúvida de identidade ou de troca de turma.', recommendedAction: action,
      fieldKind: 'file', foundValue: reason.slice(0, 240),
    }];
  }
  return groups.flatMap((group) => group.origins.map((origin) => ({
    key: `class-move-review|${origin.classCode}|${origin.number}|${group.destinations[0]?.classCode ?? ''}`.slice(0, 320),
    severity: 'blocking-error' as const, code: 'class-move-review' as const,
    message: 'Troca de turma que o sistema não conseguiu ligar sozinho.', recommendedAction: action,
    classCode: origin.classCode.slice(0, 24), studentNumber: origin.number, fieldKind: 'student' as const,
    // Where this student may have gone: the system does not guess which one.
    foundValue: `${endpointV1(origin)} → ${group.destinations.map(endpointV1).join(' ou ')}`.slice(0, 240),
  })));
}
