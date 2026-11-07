import type { GradebookPostgresReadPortV1 } from '../../persistence/postgres/postgres-database-v1';
import {
  createRelationalAcademicProjectionServiceV1,
  type RelationalAcademicProjectionV1,
  type RelationalProjectionRequestV1,
  type RelationalSourceComparisonV1,
} from './relational-academic-projection-v1';
import {
  resolveSimplifiedAnnualOutcomeV1,
  type SimplifiedAnnualOutcomeV1,
  type SimplifiedEnrollmentStatusV1,
} from '../../../../src/gradebook-domain/calculations/simplified/resolve-simplified-annual-outcome-v1';
import { compareSourceSubjectPresentationV1 } from '../../../../shared/gradebook-contracts/source/subject-abbreviations-v1';

type Row = Record<string, unknown>;
type BindValue = string | number | null;

type RelationalFormalCouncilDecisionV1 = 1 | 2 | 3;
type RelationalFormalCouncilVisibleResultV1 =
  | 'APROVADO PELO CONSELHO'
  | 'REPROVADO PELO CONSELHO'
  | 'REPROVADO POR FALTA';

interface RelationalAnnualComponentProjectionV1 {
  readonly ofertaId: number;
  readonly disciplinaId: number;
  readonly disciplina: string;
  readonly professorId: number;
  readonly professor: string;
  readonly projection: RelationalAcademicProjectionV1;
}

interface RelationalComparisonSummaryV1 {
  readonly match: number;
  readonly mismatch: number;
  readonly unavailable: number;
}

interface RelationalStudentAnnualProjectionV1 {
  readonly ano: number;
  readonly alunoId: number;
  readonly alunoNome: string;
  readonly turma: {
    readonly id: number;
    readonly codigo: string;
    readonly nome: string;
    readonly numero: number;
  };
  readonly status: SimplifiedEnrollmentStatusV1;
  readonly minimumApprovalMilli: number;
  readonly maxCouncilComponents: number;
  readonly components: readonly RelationalAnnualComponentProjectionV1[];
  readonly calculatedAnnual: SimplifiedAnnualOutcomeV1;
  readonly formalCouncilDecision: {
    readonly code: RelationalFormalCouncilDecisionV1;
    readonly visibleResult: RelationalFormalCouncilVisibleResultV1;
  } | null;
  readonly homologation: {
    readonly am: RelationalComparisonSummaryV1;
    readonly u: RelationalComparisonSummaryV1;
  };
}

type RelationalStudentAnnualProjectionErrorCodeV1 =
  | 'student-current-binding-not-found'
  | 'invalid-relational-row'
  | 'duplicate-current-discipline-offers'
  | 'projection-year-mismatch';

class RelationalStudentAnnualProjectionErrorV1 extends Error {
  constructor(readonly code: RelationalStudentAnnualProjectionErrorCodeV1) {
    super(code);
    this.name = 'RelationalStudentAnnualProjectionErrorV1';
  }
}

export interface RelationalStudentAnnualProjectionDependenciesV1 {
  readonly projectOffer?: (input: {
    readonly ofertaId: number;
    readonly alunoId: number;
  }) => Promise<RelationalAcademicProjectionV1>;
}

function asInteger(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new RelationalStudentAnnualProjectionErrorV1('invalid-relational-row');
  }
  return number;
}

function positiveInteger(value: unknown): number {
  const number = asInteger(value);
  if (number <= 0) throw new RelationalStudentAnnualProjectionErrorV1('invalid-relational-row');
  return number;
}

function nonNegativeInteger(value: unknown): number {
  const number = asInteger(value);
  if (number < 0) throw new RelationalStudentAnnualProjectionErrorV1('invalid-relational-row');
  return number;
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RelationalStudentAnnualProjectionErrorV1('invalid-relational-row');
  }
  return value;
}

function enrollmentStatus(value: unknown): SimplifiedEnrollmentStatusV1 {
  if (value === null || value === undefined) return null;
  const status = asInteger(value);
  if (status < 1 || status > 7) {
    throw new RelationalStudentAnnualProjectionErrorV1('invalid-relational-row');
  }
  return status as Exclude<SimplifiedEnrollmentStatusV1, null>;
}

function isStatusTerminal(status: SimplifiedEnrollmentStatusV1): boolean {
  return status === 1 || status === 2 || status === 3 || status === 4 || status === 5;
}

function formalCouncilDecision(
  value: unknown,
): RelationalStudentAnnualProjectionV1['formalCouncilDecision'] {
  if (value === null || value === undefined) return null;
  const code = asInteger(value);
  switch (code) {
    case 1: return { code, visibleResult: 'APROVADO PELO CONSELHO' };
    case 2: return { code, visibleResult: 'REPROVADO PELO CONSELHO' };
    case 3: return { code, visibleResult: 'REPROVADO POR FALTA' };
    default: throw new RelationalStudentAnnualProjectionErrorV1('invalid-relational-row');
  }
}

async function first<T extends Row>(database: GradebookPostgresReadPortV1, sql: string, values: readonly BindValue[]): Promise<T | null> {
  return (await database.query<T>(sql, values))[0] ?? null;
}

async function all<T extends Row>(database: GradebookPostgresReadPortV1, sql: string, values: readonly BindValue[]): Promise<readonly T[]> {
  return database.query<T>(sql, values);
}

function comparisonSummary(values: readonly RelationalSourceComparisonV1[]): RelationalComparisonSummaryV1 {
  return {
    match: values.filter((value) => value === 'match').length,
    mismatch: values.filter((value) => value === 'mismatch').length,
    unavailable: values.filter((value) => value === 'unavailable').length,
  };
}

const EMPTY_COMPARISON_SUMMARY_V1: RelationalComparisonSummaryV1 = {
  match: 0, mismatch: 0, unavailable: 0,
};

export function createRelationalStudentAnnualProjectionServiceV1(
  database: GradebookPostgresReadPortV1,
  dependencies: RelationalStudentAnnualProjectionDependenciesV1 = {},
) {
  const academic = createRelationalAcademicProjectionServiceV1(database);
  async function projectOffers(requests: readonly RelationalProjectionRequestV1[]) {
    if (dependencies.projectOffer === undefined) return academic.projectMany(requests);
    // Preserve the existing injected single-offer seam. The default SQL path is batched.
    const results: RelationalAcademicProjectionV1[] = [];
    for (const request of requests) results.push(await dependencies.projectOffer(request));
    return results;
  }

  return {
    async project(input: { readonly ano: number; readonly alunoId: number }): Promise<RelationalStudentAnnualProjectionV1> {
      if (!Number.isSafeInteger(input.ano) || input.ano < 2000 || input.ano > 2200 ||
          !Number.isSafeInteger(input.alunoId) || input.alunoId <= 0) {
        throw new RelationalStudentAnnualProjectionErrorV1('invalid-relational-row');
      }
      const base = await first<Row>(database,
        `SELECT a.ano, a.nome AS aluno_nome,
                v.turma_id, v.numero, v.situacao,
                t.codigo AS turma_codigo, t.nome AS turma_nome,
                y.minimo_aprovacao, y.max_componentes_conselho,
                cd.decisao AS conselho_decisao
         FROM gradebook.aluno a
         JOIN gradebook.vinculo v ON v.aluno_id = a.id AND v.ano = a.ano
          AND COALESCE(v.situacao, 0) <> 6
         JOIN gradebook.turma t ON t.id = v.turma_id AND t.ano = v.ano
         JOIN gradebook.ano_letivo y ON y.ano = a.ano
         LEFT JOIN gradebook.conselho_decisao cd ON cd.aluno_id = a.id
         WHERE a.id = $1 AND a.ano = $2`, [input.alunoId, input.ano]);
      if (!base) throw new RelationalStudentAnnualProjectionErrorV1('student-current-binding-not-found');
      const ano = asInteger(base.ano);
      const turmaId = positiveInteger(base.turma_id);
      const status = enrollmentStatus(base.situacao);
      const minimumApprovalMilli = positiveInteger(base.minimo_aprovacao);
      const maxCouncilComponents = nonNegativeInteger(base.max_componentes_conselho);
      const common = {
        ano, alunoId: input.alunoId, alunoNome: requiredText(base.aluno_nome),
        turma: {
          id: turmaId, codigo: requiredText(base.turma_codigo),
          nome: requiredText(base.turma_nome), numero: positiveInteger(base.numero),
        },
        status, minimumApprovalMilli, maxCouncilComponents,
        formalCouncilDecision: formalCouncilDecision(base.conselho_decisao),
      } as const;
      // A terminal status is independent from grade projection. Preserve its precedence.
      if (isStatusTerminal(status)) {
        return {
          ...common, components: [],
          calculatedAnnual: resolveSimplifiedAnnualOutcomeV1({
            status, components: [], maxCouncilComponents,
          }),
          homologation: { am: EMPTY_COMPARISON_SUMMARY_V1, u: EMPTY_COMPARISON_SUMMARY_V1 },
        };
      }
      const offerRows = await all<Row>(database,
        `SELECT o.id AS oferta_id, d.id AS disciplina_id, d.nome AS disciplina_nome,
                p.id AS professor_id, p.nome AS professor_nome
         FROM gradebook.oferta o
         JOIN gradebook.disciplina d ON d.id = o.disciplina_id AND d.ano = o.ano
         JOIN gradebook.professor p ON p.id = o.professor_id AND p.ano = o.ano
         WHERE o.ano = $1 AND o.turma_id = $2`, [ano, turmaId]);
      const disciplineIds = new Set<number>();
      // Validate the entire offer set before projecting any component.
      const offers = offerRows.map((row) => {
        const disciplinaId = positiveInteger(row.disciplina_id);
        if (disciplineIds.has(disciplinaId)) {
          throw new RelationalStudentAnnualProjectionErrorV1('duplicate-current-discipline-offers');
        }
        disciplineIds.add(disciplinaId);
        return {
          ofertaId: positiveInteger(row.oferta_id), disciplinaId,
          disciplina: requiredText(row.disciplina_nome),
          professorId: positiveInteger(row.professor_id), professor: requiredText(row.professor_nome),
        };
      }).sort((left, right) =>
        compareSourceSubjectPresentationV1(left.disciplina, right.disciplina) || left.ofertaId - right.ofertaId);
      const projections = await projectOffers(offers.map((offer) => ({
        ofertaId: offer.ofertaId, alunoId: input.alunoId,
      })));
      const components: RelationalAnnualComponentProjectionV1[] = offers.map((offer, index) => {
        const projection = projections[index]!;
        if (projection.ano !== ano) {
          throw new RelationalStudentAnnualProjectionErrorV1('projection-year-mismatch');
        }
        return { ...offer, projection };
      });
      return {
        ...common, components,
        calculatedAnnual: resolveSimplifiedAnnualOutcomeV1({
          status, components: components.map((component) => component.projection.recovery),
          maxCouncilComponents,
        }),
        homologation: {
          am: comparisonSummary(components.flatMap((component) => component.projection.terms.map((term) => term.sourceComparison))),
          u: comparisonSummary(components.map((component) => component.projection.sourceUComparison)),
        },
      };
    },
  };
}
