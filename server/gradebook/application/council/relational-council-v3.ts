import {
  lockResetWriterV1,
  recordResetWriteV1,
} from '../../../student-portal/integration/year-reset/writer-v1';
import {
  RELATIONAL_COUNCIL_DECISIONS_V3,
  relationalCouncilRequestSchemaV3,
  relationalCouncilResponseMatchesV3,
  relationalCouncilInformedV3,
  relationalCouncilTallyV3,
  relationalCouncilResponseSchemaV3,
  type RelationalCouncilDecisionV3,
  type RelationalCouncilFailureV3,
  type RelationalCouncilRequestV3,
  type RelationalCouncilResponseV3,
  type RelationalCouncilStudentV3,
  type RelationalCouncilWorkspaceV3,
} from '../../../../shared/gradebook-contracts/council/relational-council-v3';
import {
  performanceCellV2,
  type PerformanceProjectionV2,
} from '../results/relational-performance-facts-v2';
import { readRelationalPerformanceV2 } from '../read-models/performance/relational-performance-v2';
import {
  type GradebookPostgresWritePortV1,
  type GradebookPostgresScalarV1,
  type GradebookPostgresTransactionV1,
} from '../../persistence/postgres/postgres-database-v1';

type Row = Record<string, unknown>;
type Database = GradebookPostgresWritePortV1 & {
  transaction<T>(operation: (database: GradebookPostgresTransactionV1) => Promise<T>): Promise<T>;
};
type OpenRequestV3 = Extract<RelationalCouncilRequestV3, { operation: 'open' }>;
// The column also accepts 2, the closed meeting of the earlier version: closing no longer exists.
const SESSION_OPEN_V3 = 1;
const ALL_STATUSES = [null, 1, 2, 3, 4, 5, 7] as const;

const fail = (state: RelationalCouncilFailureV3): RelationalCouncilResponseV3 => ({
  contractVersion: 3,
  state,
});
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('invalid-council-row');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error('invalid-council-row');
  return value;
}
function serializationFailure(cause: unknown): boolean {
  return cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === '40001';
}
async function all(
  db: GradebookPostgresTransactionV1,
  sql: string,
  values: readonly GradebookPostgresScalarV1[] = [],
): Promise<readonly Row[]> {
  return db.query<Row>(sql, values);
}
async function first(
  db: GradebookPostgresTransactionV1,
  sql: string,
  values: readonly GradebookPostgresScalarV1[] = [],
): Promise<Row | null> {
  return (await db.query<Row>(sql, values))[0] ?? null;
}
function cell(
  projection: PerformanceProjectionV2,
  period: 1 | 2 | 3 | 'annual',
  mode: 'regular' | 'recovery',
) {
  const value = performanceCellV2(projection, period, mode);
  return {
    valueMilli: value.valueMilli,
    maximumMilli: value.maximumMilli,
    state: value.state,
    level: value.level,
  };
}

function eligibility(
  annual: {
    readonly state: string;
    readonly councilEligibility: string;
    readonly label: string | null;
  } | null,
  projections: readonly PerformanceProjectionV2[],
  indicatorEligible: boolean,
  maxCouncilComponents: number,
): RelationalCouncilStudentV3['eligibility'] {
  const failed = projections.filter(
    (item) =>
      item.recovery?.classification === 'not-approved' ||
      item.recovery?.classification === 'failed-repeat',
  ).length;
  if (!indicatorEligible)
    return {
      eligible: false,
      code: 'status',
      label: 'Situação de matrícula não participa do Conselho Final.',
      failedComponentCount: failed,
    };
  if (annual === null || projections.some((item) => item.recovery === null))
    return {
      eligible: false,
      code: 'definitions-unavailable',
      label: 'Definições acadêmicas ainda não estão completas.',
      failedComponentCount: failed,
    };
  if (annual.councilEligibility === 'eligible')
    return {
      eligible: true,
      code: 'eligible',
      label: 'Elegível ao Conselho Final.',
      failedComponentCount: failed,
    };
  if (annual.state === 'in-progress')
    return {
      eligible: false,
      code: 'in-progress',
      label: 'Cálculo anual ainda está em curso.',
      failedComponentCount: failed,
    };
  if (annual.state === 'recovery')
    return {
      eligible: false,
      code: 'recovery-pending',
      label: 'Recuperação ainda não concluída.',
      failedComponentCount: failed,
    };
  if (projections.some((item) => item.recovery?.classification === 'failed-no-show'))
    return {
      eligible: false,
      code: 'failed-no-show',
      label: 'Há recuperação marcada como não comparecimento.',
      failedComponentCount: failed,
    };
  if (projections.some((item) => item.recovery?.classification === 'failed-repeat'))
    return {
      eligible: false,
      code: 'failed-repeat',
      label: 'R/R determina reprovação automática, sem deliberação do Conselho.',
      failedComponentCount: failed,
    };
  if (failed > maxCouncilComponents)
    return {
      eligible: false,
      code: 'above-limit',
      label: `Reprovação em ${failed} componentes, acima do limite de ${maxCouncilComponents}.`,
      failedComponentCount: failed,
    };
  return {
    eligible: false,
    code: 'approved',
    label: annual.label ?? 'Resultado anual não exige deliberação do Conselho.',
    failedComponentCount: failed,
  };
}

async function readWorkspace(
  db: GradebookPostgresTransactionV1,
  year: number,
  classId: number,
): Promise<RelationalCouncilWorkspaceV3 | RelationalCouncilFailureV3> {
  const base = await first(
    db,
    `SELECT t.id,t.codigo,t.nome,y.minimo_aprovacao,y.max_componentes_conselho,
      s.estado,
      to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS read_at
    FROM gradebook.turma t JOIN gradebook.ano_letivo y ON y.ano=t.ano
    LEFT JOIN gradebook.conselho_sessao s ON s.ano=t.ano AND s.turma_id=t.id
    WHERE t.ano=$1 AND t.id=$2`,
    [year, classId],
  );
  if (!base) return 'not-found';
  const projectionMap = new Map<number, readonly PerformanceProjectionV2[]>();
  const performance = await readRelationalPerformanceV2(
    db,
    {
      transportVersion: 2,
      operation: 'matrix',
      year,
      classId,
      period: 'annual',
      mode: 'regular',
      statuses: [...ALL_STATUSES],
    },
    {
      collect: (value) => {
        for (const [studentId, projections] of value) projectionMap.set(studentId, projections);
      },
    },
  );
  if (performance.state !== 'ready')
    return performance.state === 'scope-too-large' ? 'scope-too-large' : 'unavailable';
  if (performance.operation !== 'matrix') return 'unavailable';

  const decisionRows = await all(
    db,
    `SELECT cd.aluno_id,cd.decisao,cd.justificativa,cd.registrado_em AS updated_at
      FROM gradebook.conselho_decisao cd JOIN gradebook.vinculo v ON v.aluno_id=cd.aluno_id
      WHERE v.ano=$1 AND v.turma_id=$2 AND v.situacao IS DISTINCT FROM 6`,
    [year, classId],
  );
  const decisions = new Map(decisionRows.map((row) => [integer(row.aluno_id), row]));
  const maxCouncilComponents = integer(base.max_componentes_conselho);
  const students: RelationalCouncilStudentV3[] = performance.rows.map((row) => {
    const projections = projectionMap.get(row.student.id) ?? [];
    const currentDecision = decisions.get(row.student.id);
    return {
      id: row.student.id,
      name: row.student.name,
      number: row.student.number,
      statusLabel: row.student.statusLabel,
      eligibility: eligibility(
        row.calculatedAnnual,
        projections,
        row.student.indicatorEligible,
        maxCouncilComponents,
      ),
      calculatedResult: row.calculatedAnnual?.label ?? null,
      decision: currentDecision
        ? {
            code: integer(currentDecision.decisao) as RelationalCouncilDecisionV3,
            label:
              RELATIONAL_COUNCIL_DECISIONS_V3[
                integer(currentDecision.decisao) as RelationalCouncilDecisionV3
              ],
            justification: text(currentDecision.justificativa),
            updatedAt: text(currentDecision.updated_at),
          }
        : null,
      components: performance.offers.map((offering, index) => {
        const projection = projections[index];
        if (!projection || projection.offerId !== offering.id)
          throw new Error('inconsistent-council-projection');
        return {
          offerId: offering.id,
          subject: {
            id: offering.subject.id,
            label: offering.subject.label,
            abbreviation: offering.subject.abbreviation ?? null,
          },
          terms: [
            cell(projection, 1, 'regular'),
            cell(projection, 2, 'regular'),
            cell(projection, 3, 'regular'),
          ],
          termRecoveries: [
            cell(projection, 1, 'recovery'),
            cell(projection, 2, 'recovery'),
            cell(projection, 3, 'recovery'),
          ],
          annual: cell(projection, 'annual', 'regular'),
          recovery: cell(projection, 'annual', 'recovery'),
          result: projection.recovery?.classification ?? 'unavailable',
        };
      }),
    };
  });
  const eligible = students.filter((student) => student.eligibility.eligible);
  const summary = {
    total: students.length,
    eligible: eligible.length,
    decided: eligible.filter((student) => student.decision).length,
    pending: eligible.filter((student) => !student.decision).length,
    approved: eligible.filter((student) => student.decision?.code === 1).length,
    rejected: eligible.filter((student) => student.decision?.code === 2).length,
    absence: eligible.filter((student) => student.decision?.code === 3).length,
    notEligible: students.length - eligible.length,
    forInformation: students.filter(relationalCouncilInformedV3).length,
  };
  return {
    context: { year, minimumApprovalMilli: integer(base.minimo_aprovacao), maxCouncilComponents },
    classGroup: { id: integer(base.id), label: text(base.codigo), name: text(base.nome) },
    readAt: text(base.read_at),
    authority: 'calculated-eligibility-explicit-human-decision',
    session: { state: sessionStateOf(base.estado) },
    summary,
    students,
  };
}

async function ready(
  db: GradebookPostgresTransactionV1,
  request: Exclude<RelationalCouncilRequestV3, { operation: 'classes' }>,
): Promise<RelationalCouncilResponseV3> {
  const workspace = await readWorkspace(db, request.year, request.classId);
  return typeof workspace === 'string'
    ? fail(workspace)
    : { contractVersion: 3, state: 'ready', operation: request.operation, workspace };
}

/** Opening the meeting of a class. It opens once: asking again answers with the open meeting. */
async function openSessionV3(
  db: GradebookPostgresTransactionV1,
  request: OpenRequestV3,
  actorId: string,
) {
  const classRow = await first(
    db,
    'SELECT id FROM gradebook.turma WHERE ano=$1 AND id=$2 FOR UPDATE',
    [request.year, request.classId],
  );
  if (!classRow) return fail('not-found');
  const opened = await db.executeNative(
    `INSERT INTO gradebook.conselho_sessao (ano,turma_id,estado,versao,atualizado_por) VALUES ($1, $2, $3, 1, $4)
    ON CONFLICT (ano,turma_id) DO NOTHING RETURNING turma_id`,
    [request.year, request.classId, SESSION_OPEN_V3, actorId],
  );
  // The year reset must know of the write; nothing the Portal publishes changed.
  if (opened.rows.length) await recordResetWriteV1(db, request.year, 'council');
  return ready(db, request);
}

/** The meeting's state from its row: none yet, or open. */
function sessionStateOf(estado: unknown) {
  return estado === null ? 'not-opened' : 'open';
}

export function createRelationalCouncilV3(database: GradebookPostgresWritePortV1, actorId: string) {
  return {
    async execute(input: unknown): Promise<RelationalCouncilResponseV3> {
      const parsed = relationalCouncilRequestSchemaV3.safeParse(input);
      if (!parsed.success) return fail('invalid-request');
      if (!('transaction' in database) || typeof database.transaction !== 'function')
        return fail('unavailable');
      const request = parsed.data;
      const executeTransaction = () =>
        (database as Database).transaction(async (db) => {
          if (request.operation === 'open') {
            await db.executeNative('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', []);
            await lockResetWriterV1(db, request.year);
            return openSessionV3(db, request, actorId);
          }
          await db.executeNative('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', []);
          if (request.operation === 'workspace') return ready(db, request);
          const rows = await all(
            db,
            `SELECT t.id,t.codigo,t.nome,s.estado
          FROM gradebook.turma t LEFT JOIN gradebook.conselho_sessao s ON s.ano=t.ano AND s.turma_id=t.id
          WHERE t.ano=$1 ORDER BY t.codigo COLLATE "C",t.id LIMIT $2 OFFSET $3`,
            [request.year, request.limit + 1, request.offset],
          );
          const classes = [];
          for (const row of rows.slice(0, request.limit)) {
            // The tally is the class's own reading, so it can never disagree with its workspace.
            // A class whose reading failed goes without one.
            const workspace = await readWorkspace(db, request.year, integer(row.id));
            classes.push({
              id: integer(row.id),
              label: text(row.codigo),
              name: text(row.nome),
              sessionState: sessionStateOf(row.estado),
              ...(typeof workspace === 'string'
                ? {}
                : { tally: relationalCouncilTallyV3(workspace.summary) }),
            });
          }
          return {
            contractVersion: 3,
            state: 'ready',
            operation: 'classes',
            year: request.year,
            classes,
            nextOffset: rows.length > request.limit ? request.offset + request.limit : null,
          };
        });
      let response: unknown;
      try {
        response = await executeTransaction();
      } catch (cause) {
        if (!serializationFailure(cause)) throw cause;
        response = await executeTransaction();
      }
      const checked = relationalCouncilResponseSchemaV3.parse(response);
      if (!relationalCouncilResponseMatchesV3(request, checked))
        throw new Error('inconsistent-council-response');
      return checked;
    },
  };
}
