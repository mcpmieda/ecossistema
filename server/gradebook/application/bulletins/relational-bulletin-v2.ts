import {
  assessmentLabelV1,
  assessmentNamesSchemaV1,
  type AssessmentNamesV1,
} from '../../../../shared/gradebook-contracts/settings/assessment-names-v1';
import {
  RELATIONAL_BULLETIN_CONTRACT_VERSION_V2,
  RELATIONAL_BULLETIN_LIMITS_V2,
  RELATIONAL_BULLETIN_MODEL_VERSION_V2,
  relationalBulletinModelSchemaV2,
  type RelationalBulletinFailureV2,
  type RelationalBulletinModelV2,
  type RelationalBulletinRequestV2,
  type RelationalBulletinResponseV2,
  type RelationalBulletinSelectionV2,
  type RelationalBulletinSnapshotV2,
} from '../../../../shared/gradebook-contracts/bulletins/relational-bulletin-v2';
import {
  sourceSubjectAbbreviationV1,
  compareSourceSubjectPresentationV1,
} from '../../../../shared/gradebook-contracts/source/subject-abbreviations-v1';
import {
  resolveSimplifiedAnnualOutcomeV1,
  type SimplifiedEnrollmentStatusV1,
} from '../../../../src/gradebook-domain/calculations/simplified/resolve-simplified-annual-outcome-v1';
import type { SimplifiedAcademicTermV1 } from '../../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';
import { ACTIVE_INSTRUMENT_PREDICATE_V1 } from '../../persistence/postgres/active-instrument-predicate-v1';
import type { RelationalBulletinSnapshotRepositoryV2 } from '../../persistence/postgres/relational-bulletin-snapshot-v2';
import type { GradebookPostgresReadPortV1, GradebookPostgresTransactionV1 } from '../../persistence/postgres/postgres-database-v1';
import { createGradebookPostgresParametersV1 } from '../../persistence/postgres/postgres-parameters-v1';
import type {
  GradebookPostgresWritePortV1,
  GradebookPostgresScalarV1,
} from '../../persistence/postgres/postgres-database-v1';
import {
  createRelationalAcademicProjectionServiceV1,
  RELATIONAL_PROJECTION_BATCH_LIMIT_V1,
  type RelationalAcademicProjectionV1,
} from '../results/relational-academic-projection-v1';

type Row = Record<string, unknown>;
type TransactionDatabaseV2 = GradebookPostgresTransactionV1 & {
  transaction<T>(operation: (database: GradebookPostgresTransactionV1) => Promise<T>): Promise<T>;
};

const STATUS_LABELS: Record<number, string> = {
  1: 'ESPECIAL',
  2: 'ASSISTIDO',
  3: 'DESISTENTE',
  4: 'TRANSFERIDO',
  5: 'FALECIDO',
  6: 'FOI PARA',
  7: 'ESTAVA NO',
};
const COUNCIL_LABELS: Record<number, string> = {
  1: 'APROVADO PELO CONSELHO',
  2: 'REPROVADO PELO CONSELHO',
  3: 'REPROVADO POR FALTA',
};

export interface RelationalBulletinServiceDependenciesV2 {
  readonly database: GradebookPostgresWritePortV1;
  readonly snapshots: RelationalBulletinSnapshotRepositoryV2;
  readonly now?: () => string;
  readonly createSnapshotId?: () => string;
}

export interface RelationalBulletinServerContextV2 {
  readonly issuerOid: string;
}

class RelationalBulletinErrorV2 extends Error {
  constructor(readonly code: RelationalBulletinFailureV2) {
    super(code);
    this.name = 'RelationalBulletinErrorV2';
  }
}

function integer(value: unknown, positive = false): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || (positive && parsed <= 0)) {
    throw new RelationalBulletinErrorV2('unavailable');
  }
  return parsed;
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value);
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RelationalBulletinErrorV2('unavailable');
  }
  return value;
}

function enrollmentStatus(value: unknown): SimplifiedEnrollmentStatusV1 {
  if (value === null || value === undefined) return null;
  const parsed = integer(value);
  if (parsed < 1 || parsed > 7) throw new RelationalBulletinErrorV2('unavailable');
  return parsed as Exclude<SimplifiedEnrollmentStatusV1, null>;
}

function statusLabel(status: SimplifiedEnrollmentStatusV1): string {
  return status === null ? 'REGULAR' : (STATUS_LABELS[status] ?? 'REGULAR');
}

async function rows(
  database: GradebookPostgresReadPortV1,
  sql: string,
  values: readonly GradebookPostgresScalarV1[] = [],
): Promise<readonly Row[]> {
  return database.query<Row>(sql.trim(), values);
}

function offerOrder(left: OfferV2, right: OfferV2): number {
  return (
    compareSourceSubjectPresentationV1(left.subjectLabel, right.subjectLabel) || left.id - right.id
  );
}

interface ClassV2 {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly minimumApprovalMilli: number;
  readonly maxCouncilComponents: number;
}

interface StudentV2 {
  readonly id: number;
  readonly number: number;
  readonly name: string;
  readonly status: SimplifiedEnrollmentStatusV1;
  readonly councilDecision: string | null;
}

interface OfferV2 {
  readonly id: number;
  readonly subjectId: number;
  readonly subjectLabel: string;
  readonly teacherId: number;
  readonly teacherLabel: string;
}

interface InstrumentV2 {
  readonly id: number;
  readonly offerId: number;
  readonly studentId: number;
  readonly term: SimplifiedAcademicTermV1;
  readonly slot: number;
  readonly label: string;
  readonly maximumMilli: number | null;
  readonly valueMilli: number | null;
  notDone?: true;
}

function classFromRow(row: Row): ClassV2 {
  return {
    id: integer(row.id, true),
    code: text(row.codigo),
    name: text(row.nome),
    minimumApprovalMilli: integer(row.minimo_aprovacao, true),
    maxCouncilComponents: integer(row.max_componentes_conselho),
  };
}

function studentFromRow(row: Row): StudentV2 {
  const decision = nullableInteger(row.conselho_decisao);
  return {
    id: integer(row.id, true),
    number: integer(row.numero, true),
    name: text(row.nome),
    status: enrollmentStatus(row.situacao),
    councilDecision: decision === null ? null : (COUNCIL_LABELS[decision] ?? null),
  };
}

function offerFromRow(row: Row): OfferV2 {
  return {
    id: integer(row.id, true),
    subjectId: integer(row.disciplina_id, true),
    subjectLabel: text(row.disciplina_nome),
    teacherId: integer(row.professor_id, true),
    teacherLabel: text(row.professor_nome),
  };
}

function instrumentFromRow(row: Row, names: AssessmentNamesV1): InstrumentV2 {
  const term = integer(row.trimestre) as SimplifiedAcademicTermV1;
  if (![1, 2, 3].includes(term)) throw new RelationalBulletinErrorV2('unavailable');
  const slot = integer(row.slot, true);
  return {
    id: integer(row.id, true),
    offerId: integer(row.oferta_id, true),
    studentId: integer(row.aluno_id, true),
    term,
    slot,
    label: assessmentLabelV1(
      slot,
      term,
      names,
      typeof row.descricao === 'string' ? row.descricao : null,
    ),
    maximumMilli: nullableInteger(row.maximo),
    valueMilli: nullableInteger(row.valor),
    ...(row.valor === null && (row.observed === true || row.observed === 1)
      ? { notDone: true as const }
      : {}),
  };
}

function chunks<T>(values: readonly T[], limit: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += limit) {
    result.push(values.slice(offset, offset + limit));
  }
  return result;
}

function projectionKey(studentId: number, offerId: number): string {
  return `${studentId}:${offerId}`;
}

function instrumentsKey(studentId: number, offerId: number, term: number): string {
  return `${studentId}:${offerId}:${term}`;
}

function fnvDataVersion(model: RelationalBulletinModelV2): string {
  const serialized = JSON.stringify({ ...model, readAt: '' });
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `relational-bulletin-v2:${(hash >>> 0).toString(16).padStart(8, '0')}:${serialized.length}`;
}

function seriesKey(selection: RelationalBulletinSelectionV2): string {
  return `relational-bulletin-series-v2:${JSON.stringify({
    contractVersion: RELATIONAL_BULLETIN_CONTRACT_VERSION_V2,
    year: selection.year,
    classId: selection.classId,
    studentId: selection.studentId,
    period: selection.period,
    detail: selection.detail,
  })}`;
}

async function readMaterializations(
  database: GradebookPostgresReadPortV1,
  selections: readonly RelationalBulletinSelectionV2[],
  readAt: string,
): Promise<readonly RelationalBulletinModelV2[]> {
  const first = selections[0];
  if (!first) return [];
  if (
    selections.some(
      (selection) =>
        selection.year !== first.year ||
        selection.classId !== first.classId ||
        JSON.stringify(selection.period) !== JSON.stringify(first.period) ||
        selection.detail !== first.detail,
    )
  ) {
    throw new RelationalBulletinErrorV2('invalid-request');
  }
  const classRows = await rows(
    database,
    `SELECT t.id, t.codigo, t.nome, y.minimo_aprovacao, y.max_componentes_conselho,
            COALESCE(to_jsonb(y)->'nomes_avaliacoes','{}'::jsonb) AS assessment_names
       FROM gradebook.turma t
       JOIN gradebook.ano_letivo y ON y.ano = t.ano
      WHERE t.ano = $1 AND t.id = $2`,
    [first.year, first.classId],
  );
  if (classRows.length === 0) throw new RelationalBulletinErrorV2('not-found');
  const classGroup = classFromRow(classRows[0]!);
  const assessmentNames = assessmentNamesSchemaV1.parse(classRows[0]!.assessment_names ?? {});

  const studentIds = [...new Set(selections.map((selection) => selection.studentId))];
  if (studentIds.length !== selections.length)
    throw new RelationalBulletinErrorV2('invalid-request');
  const studentParameters = createGradebookPostgresParametersV1();
  const studentRows = await rows(
    database,
    `SELECT a.id, sp.name AS nome, v.numero, v.situacao, cd.decisao AS conselho_decisao
       FROM gradebook.vinculo v
       JOIN gradebook.aluno a ON a.id = v.aluno_id AND a.ano = v.ano
       JOIN gradebook.student_presentation_v1 sp ON sp.student_id = a.id AND sp.academic_year = a.ano
       LEFT JOIN gradebook.conselho_decisao cd ON cd.aluno_id = a.id
      WHERE v.ano = ${studentParameters.param(first.year)} AND v.turma_id = ${studentParameters.param(first.classId)} AND v.situacao IS DISTINCT FROM 6
        AND a.id IN (${studentIds.map((id) => studentParameters.param(id)).join(', ')})
      ORDER BY v.numero`,
    studentParameters.values,
  );
  if (studentRows.length !== studentIds.length) throw new RelationalBulletinErrorV2('not-found');
  const students = studentRows.map(studentFromRow);
  const studentsById = new Map(students.map((student) => [student.id, student]));

  const offerRows = await rows(
    database,
    `SELECT o.id, o.disciplina_id, d.nome AS disciplina_nome,
            o.professor_id, p.nome AS professor_nome
       FROM gradebook.oferta o
       JOIN gradebook.disciplina d ON d.id = o.disciplina_id AND d.ano = o.ano
       JOIN gradebook.professor p ON p.id = o.professor_id AND p.ano = o.ano
      WHERE o.ano = $1 AND o.turma_id = $2`,
    [first.year, first.classId],
  );
  if (offerRows.length > RELATIONAL_BULLETIN_LIMITS_V2.offers) {
    throw new RelationalBulletinErrorV2('scope-too-large');
  }
  const offers = offerRows.map(offerFromRow).sort(offerOrder);
  if (new Set(offers.map((offer) => offer.subjectId)).size !== offers.length) {
    throw new RelationalBulletinErrorV2('ambiguous-offers');
  }

  const requests = students.flatMap((student) =>
    offers.map((offer) => ({
      ofertaId: offer.id,
      alunoId: student.id,
    })),
  );
  const projectionMap = new Map<string, RelationalAcademicProjectionV1>();
  for (const batch of chunks(requests, RELATIONAL_PROJECTION_BATCH_LIMIT_V1)) {
    const values = await createRelationalAcademicProjectionServiceV1(database).projectMany(batch);
    for (const value of values)
      projectionMap.set(projectionKey(value.alunoId, value.ofertaId), value);
  }

  const instrumentsMap = new Map<string, InstrumentV2[]>();
  if (first.detail === 'detailed' && offers.length > 0) {
    const detailParameters = createGradebookPostgresParametersV1();
    const detailRows = await rows(
      database,
      `SELECT i.id, i.oferta_id, v.aluno_id, i.trimestre, i.slot,
              i.maximo, i.descricao, n.valor, n.instrumento_id IS NOT NULL AS observed
         FROM gradebook.vinculo v
         JOIN gradebook.oferta o ON o.turma_id = v.turma_id AND o.ano = v.ano
         JOIN gradebook.instrumento i ON i.oferta_id = o.id AND ${ACTIVE_INSTRUMENT_PREDICATE_V1}
         LEFT JOIN gradebook.nota n ON n.instrumento_id = i.id AND n.aluno_id = v.aluno_id
        WHERE v.ano = ${detailParameters.param(first.year)} AND v.turma_id = ${detailParameters.param(first.classId)} AND v.situacao IS DISTINCT FROM 6
          AND v.aluno_id IN (${studentIds.map((id) => detailParameters.param(id)).join(', ')})
        ORDER BY v.aluno_id, i.oferta_id, i.trimestre, i.slot`,
      detailParameters.values,
    );
    for (const row of detailRows) {
      const value = instrumentFromRow(row, assessmentNames);
      const key = instrumentsKey(value.studentId, value.offerId, value.term);
      const bucket = instrumentsMap.get(key) ?? [];
      bucket.push(value);
      instrumentsMap.set(key, bucket);
    }
  }

  return selections.map((selection) => {
    const student = studentsById.get(selection.studentId);
    if (!student) throw new RelationalBulletinErrorV2('not-found');
    const projections = offers.map((offer) => {
      const projection = projectionMap.get(projectionKey(student.id, offer.id));
      if (!projection) throw new RelationalBulletinErrorV2('unavailable');
      return { offer, projection };
    });
    const annualOutcome = resolveSimplifiedAnnualOutcomeV1({
      status: student.status,
      components: projections.map(({ projection }) => projection.recovery),
      maxCouncilComponents: classGroup.maxCouncilComponents,
    });
    const hasRepeatFailure = projections.some(
      ({ projection }) => projection.recovery.classification === 'failed-repeat',
    );
    const formalCouncilDecision =
      (student.status === null || student.status === 7) && !hasRepeatFailure
        ? student.councilDecision
        : null;
    const visibleResult =
      student.status === 2 ? null : (formalCouncilDecision ?? annualOutcome.visibleResult);
    const reasons = new Set<string>();

    const currentPeriod = first.period;
    const terminalRepeatFailure =
      currentPeriod.kind === 'annual' &&
      annualOutcome.visibleResult === 'REPROVADO' &&
      hasRepeatFailure;
    const subjects = projections.map(({ offer, projection }) => {
      const selectedTerms =
        currentPeriod.kind === 'term'
          ? projection.terms.filter((item) => item.term === currentPeriod.term)
          : projection.terms;
      const terms = selectedTerms.map(
        ({ term: currentTerm, outcome, sourceAmMilli, sourceComparison }) => {
          if (!outcome.coverage.complete && !terminalRepeatFailure)
            reasons.add(`incomplete-calculation:${offer.id}:t${currentTerm}`);
          if (sourceAmMilli === null)
            reasons.add(`missing-official-am:${offer.id}:t${currentTerm}`);
          return {
            term: currentTerm,
            maximumMilli: outcome.termMaximumMilli,
            sourceAmMilli,
            calculatedAmMilli: outcome.coverage.complete ? outcome.roundedMilli : null,
            comparison: sourceComparison,
            quantitative: {
              originalMilli: outcome.quantitativeOriginalMilli,
              parallelMilli: outcome.parallelMilli,
              parallelApplicable: outcome.parallelApplicable,
              consideredMilli: outcome.quantitativeConsideredMilli,
            },
            qualitativeMilli: outcome.qualitativeOperationalMilli,
            coverage: outcome.coverage,
            warningCodes: outcome.warnings.map((warning) => warning.code),
            instruments:
              first.detail === 'detailed'
                ? (instrumentsMap.get(instrumentsKey(student.id, offer.id, currentTerm)) ?? [])
                  .filter((instrument) => instrument.slot !== 3 || outcome.parallelApplicable === true)
                  .map((instrument) => ({
                    id: instrument.id,
                    term: instrument.term,
                    slot: instrument.slot,
                    label: instrument.label,
                    maximumMilli: instrument.maximumMilli,
                    valueMilli: instrument.valueMilli,
                    ...(instrument.notDone ? { notDone: true as const } : {}),
                  }))
                : [],
          };
        },
      );
      const recovery = projection.recovery;
      if (currentPeriod.kind === 'annual') {
        if (recovery.classification === 'in-progress' && !terminalRepeatFailure)
          reasons.add(`annual-in-progress:${offer.id}`);
        if (recovery.classification === 'recovery-pending' && !terminalRepeatFailure)
          reasons.add(`final-recovery-pending:${offer.id}`);
        if (
          !terminalRepeatFailure &&
          recovery.recoveryRequired === true &&
          recovery.classification !== 'failed-no-show' &&
          recovery.classification !== 'failed-repeat' &&
          projection.sourceUMilli === null
        ) {
          reasons.add(`missing-official-u:${offer.id}`);
        }
      }
      return {
        offerId: offer.id,
        subject: {
          id: offer.subjectId,
          label: offer.subjectLabel,
          abbreviation: sourceSubjectAbbreviationV1(offer.subjectLabel),
        },
        teacher: { id: offer.teacherId, label: offer.teacherLabel },
        terms,
        annual:
          currentPeriod.kind === 'annual'
            ? {
                originalTotalMilli: recovery.originalTotalMilli,
                sourceUMilli: projection.sourceUMilli,
                calculatedPostRecoveryMilli: recovery.postRecoveryTotalMilli,
                comparison: projection.sourceUComparison,
                recoveryRequired: recovery.recoveryRequired,
                recoveryTerms: ([1, 2, 3] as const).map((termValue) => ({
                  term: termValue,
                  applicable: recovery.recoveryTerms[termValue].applicable,
                  source: recovery.recoveryTerms[termValue].source,
                  replacementMilli: recovery.recoveryTerms[termValue].replacementMilli,
                })),
                classification: recovery.classification,
                warningCodes: recovery.warnings.map((warning) => warning.code),
              }
            : null,
      };
    });
    if (subjects.length === 0) reasons.add('no-current-offers');
    if (currentPeriod.kind === 'annual') {
      if (annualOutcome.state === 'in-progress') reasons.add('annual-result-in-progress');
      if (annualOutcome.state === 'recovery') reasons.add('annual-recovery-pending');
      if (annualOutcome.state === 'council-eligible' && formalCouncilDecision === null) {
        reasons.add('council-decision-pending');
      }
    }
    const model = {
      contractVersion: RELATIONAL_BULLETIN_CONTRACT_VERSION_V2,
      modelVersion: RELATIONAL_BULLETIN_MODEL_VERSION_V2,
      year: first.year,
      period: currentPeriod,
      detail: first.detail,
      authority: {
        officialValues: 'imported-source' as const,
        calculatedValues: 'descriptive-comparison' as const,
        formalDecision: 'human-recorded-only' as const,
      },
      readAt,
      classGroup: { id: classGroup.id, code: classGroup.code, name: classGroup.name },
      student: {
        id: student.id,
        number: student.number,
        name: student.name,
        statusCode: student.status,
        statusLabel: statusLabel(student.status),
      },
      subjects,
      overall: {
        calculatedResult: annualOutcome.visibleResult,
        formalCouncilDecision,
        visibleResult,
      },
      emissionReadiness: { ready: reasons.size === 0, reasons: [...reasons] },
    };
    const parsed = relationalBulletinModelSchemaV2.safeParse(model);
    if (!parsed.success) throw new RelationalBulletinErrorV2('unavailable');
    return parsed.data;
  });
}

function failure(
  operation: RelationalBulletinRequestV2['operation'],
  state: RelationalBulletinFailureV2,
  reasons?: readonly string[],
): RelationalBulletinResponseV2 {
  return {
    contractVersion: RELATIONAL_BULLETIN_CONTRACT_VERSION_V2,
    operation,
    state,
    ...(reasons === undefined ? {} : { reasons: [...reasons] }),
  } as RelationalBulletinResponseV2;
}

export function createRelationalBulletinServiceV2(
  dependencies: RelationalBulletinServiceDependenciesV2,
) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const createSnapshotId = dependencies.createSnapshotId ?? (() => crypto.randomUUID());
  const database = dependencies.database as TransactionDatabaseV2;
  if (typeof database.transaction !== 'function') {
    throw new Error('relational-bulletin-postgres-required');
  }

  async function materialize(
    selections: readonly RelationalBulletinSelectionV2[],
  ): Promise<readonly RelationalBulletinModelV2[]> {
    return database.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', []);
      return readMaterializations(tx, selections, now());
    });
  }

  async function emitModel(
    selection: RelationalBulletinSelectionV2,
    model: RelationalBulletinModelV2,
    context: RelationalBulletinServerContextV2,
  ): Promise<RelationalBulletinSnapshotV2 | null> {
    if (!model.emissionReadiness.ready) return null;
    const key = seriesKey(selection);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await dependencies.snapshots.getLatest(key);
      const version = (latest?.snapshotVersion ?? 0) + 1;
      const snapshot: RelationalBulletinSnapshotV2 = {
        snapshotId: latest?.snapshotId ?? createSnapshotId(),
        snapshotVersion: version,
        dataVersion: fnvDataVersion(model),
        emittedAt: now(),
        presentation: selection.presentation,
        model,
      };
      if (
        latest !== null &&
        latest.dataVersion === snapshot.dataVersion &&
        JSON.stringify(latest.presentation) === JSON.stringify(snapshot.presentation)
      )
        return latest;
      const appended = await dependencies.snapshots.append({
        seriesKey: key,
        expectedPreviousVersion: version - 1,
        issuerOid: context.issuerOid,
        snapshot,
      });
      if (appended.state === 'appended') return appended.snapshot;
    }
    throw new RelationalBulletinErrorV2('version-conflict');
  }

  return {
    async execute(
      request: RelationalBulletinRequestV2,
      context: RelationalBulletinServerContextV2,
    ): Promise<RelationalBulletinResponseV2> {
      try {
        if (request.operation === 'catalog') {
          const values = await rows(
            database,
            `SELECT t.id, t.codigo, t.nome, COUNT(v.aluno_id) AS student_count
               FROM gradebook.turma t
               LEFT JOIN gradebook.vinculo v ON v.turma_id = t.id AND v.ano = t.ano
                AND v.situacao IS DISTINCT FROM 6
              WHERE t.ano = $1
              GROUP BY t.id, t.codigo, t.nome
              ORDER BY t.nome COLLATE "C", t.id
              LIMIT $2`,
            [request.year, RELATIONAL_BULLETIN_LIMITS_V2.classes + 1],
          );
          if (values.length > RELATIONAL_BULLETIN_LIMITS_V2.classes)
            return failure(request.operation, 'scope-too-large');
          return {
            contractVersion: RELATIONAL_BULLETIN_CONTRACT_VERSION_V2,
            operation: request.operation,
            state: 'ready',
            year: request.year,
            classes: values.map((row) => ({
              id: integer(row.id, true),
              code: text(row.codigo),
              name: text(row.nome),
              label: text(row.nome),
              studentCount: integer(row.student_count),
            })),
          };
        }

        if (request.operation === 'students') {
          const classRows = await rows(
            database,
            'SELECT id, codigo, nome FROM gradebook.turma WHERE ano = $1 AND id = $2',
            [request.year, request.classId],
          );
          if (classRows.length === 0) return failure(request.operation, 'not-found');
          const values = await rows(
            database,
            `SELECT a.id, sp.name AS nome, v.numero, v.situacao
               FROM gradebook.vinculo v
               JOIN gradebook.aluno a ON a.id = v.aluno_id AND a.ano = v.ano
               JOIN gradebook.student_presentation_v1 sp ON sp.student_id = a.id AND sp.academic_year = a.ano
              WHERE v.ano = $1 AND v.turma_id = $2 AND v.situacao IS DISTINCT FROM 6
              ORDER BY v.numero
              LIMIT $3`,
            [request.year, request.classId, RELATIONAL_BULLETIN_LIMITS_V2.students + 1],
          );
          if (values.length > RELATIONAL_BULLETIN_LIMITS_V2.students)
            return failure(request.operation, 'scope-too-large');
          const classRow = classRows[0]!;
          return {
            contractVersion: RELATIONAL_BULLETIN_CONTRACT_VERSION_V2,
            operation: request.operation,
            state: 'ready',
            classGroup: {
              id: integer(classRow.id, true),
              code: text(classRow.codigo),
              name: text(classRow.nome),
              label: text(classRow.nome),
            },
            students: values.map((row) => {
              const status = enrollmentStatus(row.situacao);
              return {
                id: integer(row.id, true),
                number: integer(row.numero, true),
                name: text(row.nome),
                statusCode: status,
                statusLabel: statusLabel(status),
              };
            }),
          };
        }

        if (request.operation === 'preview') {
          const [model] = await materialize([request.selection]);
          if (!model) return failure(request.operation, 'not-found');
          return {
            contractVersion: RELATIONAL_BULLETIN_CONTRACT_VERSION_V2,
            operation: request.operation,
            state: 'ready',
            model,
          };
        }

        if (request.operation === 'emit') {
          const [model] = await materialize([request.selection]);
          if (!model) return failure(request.operation, 'not-found');
          if (!model.emissionReadiness.ready)
            return failure(request.operation, 'insufficient-data', model.emissionReadiness.reasons);
          const snapshot = await emitModel(request.selection, model, context);
          if (!snapshot)
            return failure(request.operation, 'insufficient-data', model.emissionReadiness.reasons);
          return {
            contractVersion: RELATIONAL_BULLETIN_CONTRACT_VERSION_V2,
            operation: request.operation,
            state: 'ready',
            snapshot,
          };
        }

        if (request.operation === 'emit-batch') {
          const selections = request.selection.studentIds
            .map((studentId) => ({
              ...request.selection,
              studentId,
              studentIds: undefined,
            }))
            .map(({ studentIds: _studentIds, ...selection }) => selection);
          const models = await materialize(selections);
          const ready: { studentId: number; snapshot: RelationalBulletinSnapshotV2 }[] = [];
          const blocked: { studentId: number; reasons: string[] }[] = [];
          for (let index = 0; index < models.length; index += 1) {
            const model = models[index]!;
            const selection = selections[index]!;
            if (!model.emissionReadiness.ready) {
              blocked.push({
                studentId: model.student.id,
                reasons: model.emissionReadiness.reasons,
              });
              continue;
            }
            const snapshot = await emitModel(selection, model, context);
            if (snapshot) ready.push({ studentId: model.student.id, snapshot });
          }
          return {
            contractVersion: RELATIONAL_BULLETIN_CONTRACT_VERSION_V2,
            operation: request.operation,
            state: 'ready',
            ready,
            blocked,
          };
        }

        if (request.operation === 'history') {
          const items = await dependencies.snapshots.history(request);
          return {
            contractVersion: RELATIONAL_BULLETIN_CONTRACT_VERSION_V2,
            operation: request.operation,
            state: 'ready',
            items: [...items],
          };
        }

        const snapshot = await dependencies.snapshots.get(
          request.snapshotId,
          request.snapshotVersion,
        );
        if (snapshot === null) return failure(request.operation, 'not-found');
        return {
          contractVersion: RELATIONAL_BULLETIN_CONTRACT_VERSION_V2,
          operation: request.operation,
          state: 'ready',
          source: 'historical-snapshot',
          snapshot,
        };
      } catch (cause) {
        if (cause instanceof RelationalBulletinErrorV2)
          return failure(request.operation, cause.code);
        return failure(request.operation, 'unavailable');
      }
    },
  };
}

export type RelationalBulletinServiceV2 = ReturnType<typeof createRelationalBulletinServiceV2>;
