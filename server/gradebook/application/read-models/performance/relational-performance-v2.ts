import {
  assessmentLabelV1,
  assessmentNamesSchemaV1,
} from '../../../../../shared/gradebook-contracts/settings/assessment-names-v1';
import { ACTIVE_INSTRUMENT_PREDICATE_V1 } from '../../../persistence/postgres/active-instrument-predicate-v1';
import { createGradebookPostgresParametersV1 as parameters } from '../../../persistence/postgres/postgres-parameters-v1';
import {
  compareSourceSubjectPresentationV1,
  sourceSubjectAbbreviationV1,
} from '../../../../../shared/gradebook-contracts/source/subject-abbreviations-v1';
import { termRecoveryVisibilityV1 } from '../../../../../src/gradebook-domain/calculations/simplified/term-recovery-visibility-v1';
import {
  performanceRequestSchemaV2,
  performanceResponseSchemaV2,
  performanceResponseMatchesV2,
  PERFORMANCE_LIMITS_V2,
  type PerformanceRequestV2,
  type PerformanceResponseV2,
  type PerformanceRowV2,
  type PerformanceOfferV2,
  type PerformanceFailureV2,
} from '../../../../../shared/gradebook-contracts/performance/relational-performance-v2';
import { resolveSimplifiedAnnualOutcomeV1 } from '../../../../../src/gradebook-domain/calculations/simplified/resolve-simplified-annual-outcome-v1';
import type {
  SimplifiedInstrumentSlotV1,
  SimplifiedAcademicTermV1,
  SimplifiedRecoveryValueV1,
} from '../../../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';
import {
  type GradebookPostgresWritePortV1,
  type GradebookPostgresScalarV1,
  type GradebookPostgresReadPortV1,
  type GradebookPostgresTransactionV1
} from '../../../persistence/postgres/postgres-database-v1';

import {
  projectPerformanceFactsV2,
  performanceCellV2,
  performanceRecoveryCellIsRelevantV2,
  EMPTY_PERFORMANCE_CLOSING_V2,
  type PerformanceFactV2,
  type PerformanceClosingV2,
  type PerformanceProjectionV2,
} from '../../results/relational-performance-facts-v2';

type Row = Record<string, unknown>;
type TransactionDatabase = GradebookPostgresWritePortV1 & {
  transaction<T>(operation: (db: GradebookPostgresTransactionV1) => Promise<T>): Promise<T>;
};
const fail = (state: PerformanceFailureV2): PerformanceResponseV2 => ({
  transportVersion: 2,
  state,
});
const integer = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('invalid-performance-row');
  return value;
};
const nullable = (value: unknown): number | null =>
  value === null || value === undefined ? null : integer(value);
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid-performance-row');
  return value;
};
const all = (
  db: GradebookPostgresReadPortV1,
  sql: string,
  values: readonly GradebookPostgresScalarV1[] = [],
): Promise<readonly Row[]> => db.query<Row>(sql, values);
const STATUS_LABELS = {
  1: 'Especial',
  2: 'Assistido',
  3: 'Desistente',
  4: 'Transferido',
  5: 'Falecido',
  7: 'Estava no',
} as const;
const DECISION_LABELS = {
  1: 'APROVADO PELO CONSELHO',
  2: 'REPROVADO PELO CONSELHO',
  3: 'REPROVADO POR FALTA',
} as const;
const TERMS = [1, 2, 3] as const;

function student(row: Row): PerformanceRowV2['student'] {
  const status = nullable(row.situacao) as PerformanceRowV2['student']['status'];
  const relatedClass =
    typeof row.turma_relacionada_codigo === 'string' && row.turma_relacionada_codigo.trim()
      ? row.turma_relacionada_codigo.trim()
      : null;
  return {
    id: integer(row.id),
    name: text(row.nome),
    number: integer(row.numero),
    status,
    statusLabel:
      status === null
        ? 'Em curso'
        : status === 7 && relatedClass !== null
          ? `ESTAVA NO ${relatedClass}`
          : STATUS_LABELS[status],
    indicatorEligible: status === null || status === 7,
  };
}
function offer(row: Row): PerformanceOfferV2 {
  return {
    id: integer(row.id),
    subject: {
      id: integer(row.disciplina_id),
      label: text(row.disciplina_nome),
      abbreviation: sourceSubjectAbbreviationV1(text(row.disciplina_nome)),
    },
    teacher: { id: integer(row.professor_id), label: text(row.professor_nome) },
  };
}
function orderOffers(left: PerformanceOfferV2, right: PerformanceOfferV2): number {
  return (
    compareSourceSubjectPresentationV1(left.subject.label, right.subject.label) ||
    left.id - right.id
  );
}
function closing(row: Row): PerformanceClosingV2 {
  const nc = integer(row.rec_nc_mask ?? 0);
  const rr = integer(row.rec_rr_mask ?? 0);
  const rec = TERMS.map((term): SimplifiedRecoveryValueV1 => {
    const bit = 1 << (term - 1);
    if ((rr & bit) !== 0) return 'RR';
    if ((nc & bit) !== 0) return 'NC';
    return nullable(row[`rec${term}`]);
  }) as unknown as PerformanceClosingV2['rec'];
  return {
    am: [nullable(row.am1_fonte), nullable(row.am2_fonte), nullable(row.am3_fonte)],
    rec,
    u: nullable(row.u_fonte),
  };
}
function makeRow(
  source: Row,
  projections: readonly PerformanceProjectionV2[],
  request: Exclude<PerformanceRequestV2, { operation: 'classes' }>,
  maxCouncilComponents: number,
): PerformanceRowV2 {
  const info = student(source);
  const completeDefinitions = projections.every((value) => value.recovery !== null);
  // Terminal states are resolved by the central engine even when grade definitions are missing.
  // Missing component definitions are never omitted to manufacture a passing annual result.
  const annual =
    !info.indicatorEligible || completeDefinitions
      ? resolveSimplifiedAnnualOutcomeV1({
          status: info.status,
          components: projections.flatMap((value) => (value.recovery ? [value.recovery] : [])),
          maxCouncilComponents,
        })
      : null;
  const decision = nullable(source.decisao) as 1 | 2 | 3 | null;
  const repeatFailure = projections.some(
    (projection) => projection.recovery?.classification === 'failed-repeat',
  );
  return {
    student: info,
    calculatedAnnual: annual
      ? {
          state: annual.state,
          label: annual.visibleResult,
          councilEligibility: annual.councilEligibility,
        }
      : null,
    formalCouncilDecision:
      decision === null || repeatFailure
        ? null
        : { code: decision, label: DECISION_LABELS[decision] },
    cells: projections.map((value) => performanceCellV2(value, request.period, request.mode)),
  };
}

export async function readRelationalPerformanceV2(
  db: GradebookPostgresReadPortV1,
  request: PerformanceRequestV2,
  options: {
    readonly descriptionOfferId?: number;
    /** Internal V6 opt-in; preserve source labels in this same bounded snapshot query. */
    readonly includeInstrumentDescriptions?: boolean;
    readonly collect?: (values: ReadonlyMap<number, readonly PerformanceProjectionV2[]>) => void;
  } = {},
): Promise<PerformanceResponseV2> {
  const yearQuery = parameters();
  const [year] = await all(
    db,
    `SELECT ano, minimo_aprovacao, max_componentes_conselho,
    COALESCE(to_jsonb(y)->'nomes_avaliacoes','{}'::jsonb) AS assessment_names,
    to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS read_at
    FROM gradebook.ano_letivo y WHERE ano = ${yearQuery.param(request.year)}`,
    yearQuery.values,
  );
  if (!year) return fail('not-found');
  const assessmentNames = assessmentNamesSchemaV1.parse(year.assessment_names ?? {});
  const common = {
    transportVersion: 2,
    state: 'ready',
    authority: 'calculated-preview',
    context: {
      year: integer(year.ano),
      minimumApprovalMilli: integer(year.minimo_aprovacao),
      maxCouncilComponents: integer(year.max_componentes_conselho),
    },
    readAt: text(year.read_at),
  } as const;
  if (request.operation === 'classes') {
    const classesQuery = parameters();
    const classesYear = classesQuery.param(request.year);
    const classesLimit = classesQuery.param(request.limit + 1);
    const classesOffset = classesQuery.param(request.offset);
    const rows = await all(
      db,
      `SELECT id, codigo FROM gradebook.turma WHERE ano = ${classesYear} ORDER BY codigo COLLATE "C", id LIMIT ${classesLimit} OFFSET ${classesOffset}`,
      classesQuery.values,
    );
    const nextOffset = rows.length > request.limit ? request.offset + request.limit : null;
    if (nextOffset !== null && nextOffset > 100_000) return fail('scope-too-large');
    return {
      ...common,
      operation: 'classes',
      statusOptions: [
        { value: null, label: 'Em curso' },
        ...([1, 2, 3, 4, 5, 7] as const).map((value) => ({
          value,
          label: STATUS_LABELS[value],
        })),
      ],
      classes: rows
        .slice(0, request.limit)
        .map((value) => ({ id: integer(value.id), label: text(value.codigo) })),
      nextOffset,
    };
  }
  const classQuery = parameters();
  const classYearParam = classQuery.param(request.year);
  const classIdParam = classQuery.param(request.classId);
  const [classRow] = await all(
    db,
    `SELECT id, codigo, nome FROM gradebook.turma WHERE ano = ${classYearParam} AND id = ${classIdParam}`,
    classQuery.values,
  );
  if (!classRow) return fail('not-found');
  const selected = {
    classGroup: {
      id: integer(classRow.id),
      label: text(classRow.codigo),
      name: text(classRow.nome),
    },
    period: request.period,
    mode: request.mode,
  };
  const specificStudent = request.operation !== 'matrix';
  const specificOffer = request.operation === 'cell-detail';
  const studentsQuery = parameters();
  const studentsYear = studentsQuery.param(request.year);
  const studentsClass = studentsQuery.param(request.classId);
  const studentsFilter = specificStudent ? `AND a.id=${studentsQuery.param(request.studentId)}` : '';
  const studentsLimit = studentsQuery.param(PERFORMANCE_LIMITS_V2.students + 1);
  const students = await all(
    db,
    `SELECT a.id,COALESCE(presentation.name,a.nome) AS nome,v.numero,v.situacao,tr.codigo AS turma_relacionada_codigo,cd.decisao
    FROM gradebook.vinculo v
    JOIN gradebook.aluno a ON a.id=v.aluno_id AND a.ano=v.ano
    LEFT JOIN gradebook.student_presentation_v1 presentation ON presentation.student_id=a.id AND presentation.academic_year=a.ano
    LEFT JOIN gradebook.turma tr ON tr.id=v.turma_relacionada_id AND tr.ano=v.ano
    LEFT JOIN gradebook.conselho_decisao cd ON cd.aluno_id=a.id
    WHERE v.ano=${studentsYear} AND v.turma_id=${studentsClass} AND v.situacao IS DISTINCT FROM 6 ${studentsFilter}
    ORDER BY v.numero,a.id LIMIT ${studentsLimit}`,
    studentsQuery.values,
  );
  if (specificStudent && students.length === 0) return fail('not-found');
  if (students.length > PERFORMANCE_LIMITS_V2.students) return fail('scope-too-large');
  const offersQuery = parameters();
  const offersYear = offersQuery.param(request.year);
  const offersClass = offersQuery.param(request.classId);
  const offersFilter = specificOffer ? `AND o.id=${offersQuery.param(request.offerId)}` : '';
  const offersLimit = offersQuery.param(PERFORMANCE_LIMITS_V2.offers + 1);
  const offers = (
    await all(
      db,
      `SELECT o.id,o.disciplina_id,d.nome AS disciplina_nome,o.professor_id,p.nome AS professor_nome
    FROM gradebook.oferta o
    JOIN gradebook.disciplina d ON d.id=o.disciplina_id AND d.ano=o.ano
    JOIN gradebook.professor p ON p.id=o.professor_id AND p.ano=o.ano
    WHERE o.ano=${offersYear} AND o.turma_id=${offersClass} ${offersFilter}
    ORDER BY d.nome COLLATE "C",o.id LIMIT ${offersLimit}`,
      offersQuery.values,
    )
  )
    .map(offer)
    .sort(orderOffers);
  if (specificOffer && offers.length === 0) return fail('not-found');
  if (
    offers.length > PERFORMANCE_LIMITS_V2.offers ||
    students.length * offers.length > PERFORMANCE_LIMITS_V2.pairs
  )
    return fail('scope-too-large');
  if (new Set(offers.map((value) => value.subject.id)).size !== offers.length)
    return fail('ambiguous-offers');

  const grouped = new Map<string, { facts: PerformanceFactV2[]; closing: PerformanceClosingV2 }>();
  if (students.length && offers.length) {
    // The V6 label budget is 500 characters. Do not truncate a compound description into a
    // participation alias: oversized labels keep their original source and use a generic label.
    const factsQuery = parameters();
    const description = specificOffer
      ? 'i.descricao'
      : options.descriptionOfferId !== undefined
        ? `CASE WHEN o.id=${factsQuery.param(options.descriptionOfferId)} THEN i.descricao ELSE NULL::text END`
        : options.includeInstrumentDescriptions === true
          ? 'CASE WHEN char_length(i.descricao) <= 500 THEN i.descricao ELSE NULL::text END'
          : 'NULL::text';
    // One query for the entire bounded scope. A detail restricts SQL, not just its response.
    const factsYear = factsQuery.param(request.year);
    const factsClass = factsQuery.param(request.classId);
    const factsStudent = specificStudent ? `AND v.aluno_id=${factsQuery.param(request.studentId)}` : '';
    const factsOffer = specificOffer ? `AND o.id=${factsQuery.param(request.offerId)}` : '';
    const facts = await all(
      db,
      `SELECT v.aluno_id,o.id AS oferta_id,i.trimestre,i.slot,i.maximo,n.valor,n.instrumento_id IS NOT NULL AS observed,
      ${description} AS descricao,
      f.am1_fonte,f.am2_fonte,f.am3_fonte,f.rec1,f.rec2,f.rec3,f.rec_nc_mask,
      COALESCE((to_jsonb(f)->>'rec_rr_mask')::smallint,0) AS rec_rr_mask,f.u_fonte
      FROM gradebook.vinculo v JOIN gradebook.oferta o ON o.ano=v.ano AND o.turma_id=v.turma_id
      LEFT JOIN gradebook.instrumento i ON i.oferta_id=o.id AND ${ACTIVE_INSTRUMENT_PREDICATE_V1}
      LEFT JOIN gradebook.nota n ON n.instrumento_id=i.id AND n.aluno_id=v.aluno_id
      LEFT JOIN gradebook.fechamento f ON f.oferta_id=o.id AND f.aluno_id=v.aluno_id
      WHERE v.ano=${factsYear} AND v.turma_id=${factsClass} AND v.situacao IS DISTINCT FROM 6
        ${factsStudent} ${factsOffer}
      ORDER BY v.aluno_id,o.id,i.trimestre,i.slot`,
      factsQuery.values,
    );
    for (const row of facts) {
      const key = `${integer(row.aluno_id)}:${integer(row.oferta_id)}`;
      const group = grouped.get(key) ?? { facts: [], closing: closing(row) };
      if (row.slot !== null) {
        const slot = integer(row.slot) as SimplifiedInstrumentSlotV1;
        group.facts.push({
          term: integer(row.trimestre) as SimplifiedAcademicTermV1,
          slot,
          maximumMilli: nullable(row.maximo),
          valueMilli: nullable(row.valor),
          observed: row.observed === true || row.observed === 1,
          label: assessmentLabelV1(
            slot,
            integer(row.trimestre),
            assessmentNames,
            typeof row.descricao === 'string' ? row.descricao : null,
          ),
        });
      }
      grouped.set(key, group);
    }
  }
  const project = (value: Row) =>
    offers.map((offering) => {
      const group = grouped.get(`${integer(value.id)}:${offering.id}`);
      return projectPerformanceFactsV2(
        offering.id,
        group?.facts ?? [],
        group?.closing ?? EMPTY_PERFORMANCE_CLOSING_V2,
        common.context.minimumApprovalMilli,
      );
    });
  if (request.operation === 'cell-detail') {
    const projection = project(students[0]!)[0]!;
    return {
      ...common,
      ...selected,
      operation: 'cell-detail',
      student: student(students[0]!),
      offer: offers[0]!,
      terms: TERMS.map((term) => {
        const outcome = projection.terms[term - 1] ?? null;
        const visibility = termRecoveryVisibilityV1(
          outcome,
          projection.recovery?.recoveryTerms[term].applicable ?? null,
        );
        const hasGrades =
          projection.facts.some(
            (fact) => fact.term === term && (fact.valueMilli !== null || fact.observed === true),
          ) ||
          projection.closing.am[term - 1] !== null ||
          projection.closing.rec[term - 1] !== null;
        return {
          term,
          hasGrades,
          ...visibility,
          regular: performanceCellV2(projection, term, 'regular', request.includeRawSum === true),
          recovery: performanceCellV2(projection, term, 'recovery'),
          quantitativeOriginalMilli: outcome?.quantitativeOriginalMilli ?? null,
          quantitativeConsideredMilli: outcome?.quantitativeConsideredMilli ?? null,
          qualitativeMilli: outcome?.qualitativeOperationalMilli ?? null,
          parallelMilli: outcome?.parallelMilli ?? null,
          parallelApplicable: outcome?.parallelApplicable ?? null,
          instruments: projection.facts
            .filter((value) => value.term === term)
            .map(({ slot, label, maximumMilli, valueMilli, observed }) => ({
              slot,
              label,
              maximumMilli: slot === 3 ? (outcome?.quantitativeMaximumMilli ?? null) : maximumMilli,
              valueMilli,
              ...(observed === true && valueMilli === null ? { notDone: true as const } : {}),
            })),
        };
      }) as Extract<PerformanceResponseV2, { operation: 'cell-detail' }>['terms'],
    };
  }
  if (request.operation === 'student-detail') {
    const projections = project(students[0]!);
    return {
      ...common,
      ...selected,
      operation: 'student-detail',
      offers,
      row: makeRow(students[0]!, projections, request, common.context.maxCouncilComponents),
      trajectory: projections.map((value) => ({
        offerId: value.offerId,
        terms: [
          performanceCellV2(value, 1, 'regular'),
          performanceCellV2(value, 2, 'regular'),
          performanceCellV2(value, 3, 'regular'),
        ],
      })),
    };
  }
  const projections = new Map(students.map((value) => [integer(value.id), project(value)]));
  options.collect?.(projections);
  const allRows = students.map((value) =>
    makeRow(
      value,
      projections.get(integer(value.id))!,
      request,
      common.context.maxCouncilComponents,
    ),
  );
  const statusRows = allRows.filter((value) => request.statuses.includes(value.student.status));
  const rows =
    request.mode === 'regular'
      ? statusRows
      : statusRows.filter(
          (value) =>
            value.student.indicatorEligible &&
            value.cells.some(performanceRecoveryCellIsRelevantV2),
        );
  const eligible = rows.filter((value) => value.student.indicatorEligible);
  const consideredCells = eligible
    .flatMap((value) => value.cells)
    .filter((value) => request.mode === 'regular' || performanceRecoveryCellIsRelevantV2(value));
  return {
    ...common,
    ...selected,
    operation: 'matrix',
    offers,
    rows,
    comparison: { available: false, reason: 'comparability-not-contracted' },
    statistics: {
      classRows: allRows.length,
      visibleRows: rows.length,
      eligibleRows: eligible.length,
      recoveryUnknownRows: statusRows.filter(
        (value) =>
          value.student.indicatorEligible &&
          value.cells.some((cell) => cell.recoveryApplicable === null),
      ).length,
      consideredCells: consideredCells.length,
      completeCells: consideredCells.filter((value) => value.state === 'complete').length,
      noShowCells: consideredCells.filter((value) => value.state === 'no-show').length,
      incompleteCells: consideredCells.filter(
        (value) =>
          value.state !== 'complete' &&
          value.state !== 'no-show' &&
          value.state !== 'repeat-failure',
      ).length,
      attentionRows: eligible.filter((value) => value.cells.some((cell) => cell.level === 'below'))
        .length,
    },
  };
}

/** Authorization belongs to the HTTP boundary; every read shares one PostgreSQL snapshot. */
export function createRelationalPerformanceV2(database: GradebookPostgresWritePortV1) {
  return {
    async execute(input: unknown): Promise<PerformanceResponseV2> {
      const parsed = performanceRequestSchemaV2.safeParse(input);
      if (!parsed.success) return fail('invalid-request');
      if (!('transaction' in database) || typeof database.transaction !== 'function')
        return fail('unavailable');
      return (database as TransactionDatabase).transaction(async (db) => {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', []);
        const response = performanceResponseSchemaV2.parse(
          await readRelationalPerformanceV2(db, parsed.data),
        );
        if (!performanceResponseMatchesV2(parsed.data, response))
          throw new Error('inconsistent-performance-response');
        return response;
      });
    },
  };
}
