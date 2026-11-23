import {
  lockResetWriterV1,
  recordResetWriteV1,
} from '../../../student-portal/integration/year-reset/writer-v1';
import {
  RELATIONAL_COUNCIL_DECISIONS_V3,
  relationalCouncilRequestSchemaV3,
  relationalCouncilResponseMatchesV3,
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
type WriteRequest = Exclude<RelationalCouncilRequestV3, { operation: 'classes' | 'workspace' }>;
/** Opening, closing and reopening carry no justification (BN-DEC-049): their idempotency row,
 * whose column is not nullable, says so. */
const NO_JUSTIFICATION_V3 = 'sem justificativa';
// The codes 2 and 3 belonged to the decision and the count, whose commands are being redone.
const OPERATION_CODE = { open: 1, close: 4, reopen: 5 } as const;
const SESSION_STATE = { open: 1, closed: 2 } as const;
const ALL_STATUSES = [null, 1, 2, 3, 4, 5, 7] as const;

const fail = (
  state: RelationalCouncilFailureV3,
  currentVersion?: number | null,
): RelationalCouncilResponseV3 => ({
  contractVersion: 3,
  state,
  ...(currentVersion === undefined ? {} : { currentVersion }),
});
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('invalid-council-row');
  return value;
}
function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value);
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
function reviewReference(year: number, classId: number, version: number): string {
  return `council-review:${year}:${classId}:${version}`;
}
function cell(
  projection: PerformanceProjectionV2,
  period: 1 | 2 | 3 | 'annual',
  mode: 'regular' | 'recovery',
) {
  const value = performanceCellV2(projection, period, mode);
  return { valueMilli: value.valueMilli, maximumMilli: value.maximumMilli, state: value.state };
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
      s.estado,s.versao AS version,
      to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS read_at
    FROM gradebook.turma t JOIN gradebook.ano_letivo y ON y.ano=t.ano
    LEFT JOIN gradebook.conselho_sessao s ON s.ano=t.ano AND s.turma_id=t.id
    WHERE t.ano=$1 AND t.id=$2`,
    [year, classId],
  );
  if (!base) return 'not-found';
  const version = nullableInteger(base.version) ?? 0;
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
  };
  return {
    context: { year, minimumApprovalMilli: integer(base.minimo_aprovacao), maxCouncilComponents },
    classGroup: { id: integer(base.id), label: text(base.codigo), name: text(base.nome) },
    readAt: text(base.read_at),
    authority: 'calculated-eligibility-explicit-human-decision',
    session: {
      state: sessionStateOf(base.estado),
      version,
      reviewReference: reviewReference(year, classId, version),
    },
    summary,
    students,
  };
}

async function currentSession(
  db: GradebookPostgresTransactionV1,
  request: WriteRequest,
): Promise<Row | null> {
  return first(
    db,
    'SELECT estado,versao AS version FROM gradebook.conselho_sessao WHERE ano=$1 AND turma_id=$2 FOR UPDATE',
    [request.year, request.classId],
  );
}
async function idempotency(
  db: GradebookPostgresTransactionV1,
  request: WriteRequest,
): Promise<'new' | 'same' | 'conflict'> {
  const row = await first(
    db,
    `SELECT operacao,ano,turma_id,versao_anterior AS expected_version
      FROM gradebook.conselho_idempotencia WHERE chave=$1`,
    [request.idempotencyKey],
  );
  if (!row) return 'new';
  return integer(row.operacao) === OPERATION_CODE[request.operation] &&
    integer(row.ano) === request.year &&
    integer(row.turma_id) === request.classId &&
    integer(row.expected_version) === request.expectedVersion
    ? 'same'
    : 'conflict';
}
async function recordIdempotency(
  db: GradebookPostgresTransactionV1,
  request: WriteRequest,
  newVersion: number,
  actorId: string,
): Promise<void> {
  await db.executeNative(
    `INSERT INTO gradebook.conselho_idempotencia (chave,operacao,ano,turma_id,versao_anterior,versao_nova,justificativa,registrado_por) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      request.idempotencyKey,
      OPERATION_CODE[request.operation],
      request.year,
      request.classId,
      request.expectedVersion,
      newVersion,
      NO_JUSTIFICATION_V3,
      actorId,
    ],
  );
}
async function advanceSession(
  db: GradebookPostgresTransactionV1,
  request: WriteRequest,
  state: 1 | 2,
  actorId: string,
): Promise<number | null> {
  const row = await first(
    db,
    `UPDATE gradebook.conselho_sessao SET estado=$1,versao=versao+1,atualizado_por=$2,atualizado_em=transaction_timestamp()
    WHERE ano=$3 AND turma_id=$4 AND versao=$5 RETURNING versao AS version`,
    [state, actorId, request.year, request.classId, request.expectedVersion],
  );
  return row ? integer(row.version) : null;
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

type OpenRequestV3 = Extract<WriteRequest, { operation: 'open' }>;
type CloseRequestV3 = Extract<WriteRequest, { operation: 'close' }>;
type ReopenRequestV3 = Extract<WriteRequest, { operation: 'reopen' }>;
type CouncilWorkspaceReadV3 = Exclude<Awaited<ReturnType<typeof readWorkspace>>, string>;

/** Opening the meeting: the class exists, no meeting is open, and the version starts at 1. */
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
  const session = await currentSession(db, request);
  if (session) return fail('session-already-open', integer(session.version));
  if (request.expectedVersion !== 0) return fail('version-conflict', 0);
  await db.executeNative(
    `INSERT INTO gradebook.conselho_sessao (ano,turma_id,estado,versao,atualizado_por) VALUES ($1, $2, $3, $4, $5)`,
    [request.year, request.classId, SESSION_STATE.open, 1, actorId],
  );
  await recordIdempotency(db, request, 1, actorId);
  return ready(db, request);
}

/** Reopening a closed meeting: it accepts decisions and counts again. */
async function reopenSessionV3(
  db: GradebookPostgresTransactionV1,
  request: ReopenRequestV3,
  actorId: string,
  session: { state: number; currentVersion: number },
) {
  const { state, currentVersion } = session;
  if (state !== SESSION_STATE.closed) return fail('session-already-open', currentVersion);
  const newVersion = await advanceSession(db, request, SESSION_STATE.open, actorId);
  if (newVersion === null) return fail('version-conflict', currentVersion);
  await recordIdempotency(db, request, newVersion, actorId);
  return ready(db, request);
}

/** Closing: the state the operator reviewed and no pending student. Decisions and counts stay as
 * they are; the closed meeting only stops accepting them. */
async function closeSessionV3(
  db: GradebookPostgresTransactionV1,
  request: CloseRequestV3,
  actorId: string,
  workspace: CouncilWorkspaceReadV3,
  currentVersion: number,
) {
  if (workspace.session.reviewReference !== request.reviewReference)
    return fail('review-conflict', currentVersion);
  if (workspace.summary.pending > 0) return fail('closure-blocked', currentVersion);
  const newVersion = await advanceSession(db, request, SESSION_STATE.closed, actorId);
  if (newVersion === null) return fail('version-conflict', currentVersion);
  await recordIdempotency(db, request, newVersion, actorId);
  return ready(db, request);
}

async function mutate(
  db: GradebookPostgresTransactionV1,
  request: WriteRequest,
  actorId: string,
): Promise<RelationalCouncilResponseV3> {
  const duplicate = await idempotency(db, request);
  if (duplicate === 'conflict') return fail('idempotency-conflict');
  if (duplicate === 'same') return ready(db, request);
  if (request.operation === 'open') return openSessionV3(db, request, actorId);

  const session = await currentSession(db, request);
  if (!session) return fail('session-not-open', 0);
  const currentVersion = integer(session.version);
  if (currentVersion !== request.expectedVersion) return fail('version-conflict', currentVersion);
  const state = integer(session.estado);
  if (request.operation === 'reopen')
    return reopenSessionV3(db, request, actorId, { state, currentVersion });
  if (state !== SESSION_STATE.open) return fail('session-closed', currentVersion);

  const workspace = await readWorkspace(db, request.year, request.classId);
  if (typeof workspace === 'string') return fail(workspace);
  return closeSessionV3(db, request, actorId, workspace, currentVersion);
}

/** The meeting's state from its row: none yet, open, or closed. */
function sessionStateOf(estado: unknown) {
  if (estado === null) return 'not-opened';
  return integer(estado) === SESSION_STATE.open ? 'open' : 'closed';
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
          if (request.operation === 'classes' || request.operation === 'workspace') {
            await db.executeNative(
              'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
              [],
            );
          } else {
            await db.executeNative('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', []);
            await lockResetWriterV1(db, request.year);
          }
          if (request.operation === 'classes') {
            const rows = await all(
              db,
              `SELECT t.id,t.codigo,t.nome,s.estado,s.versao AS version
          FROM gradebook.turma t LEFT JOIN gradebook.conselho_sessao s ON s.ano=t.ano AND s.turma_id=t.id
          WHERE t.ano=$1 ORDER BY t.codigo COLLATE "C",t.id LIMIT $2 OFFSET $3`,
              [request.year, request.limit + 1, request.offset],
            );
            const classes = [];
            for (const row of rows.slice(0, request.limit)) {
              // The tally is the class's own reading, so it can never disagree with its workspace.
              const workspace = request.tally
                ? await readWorkspace(db, request.year, integer(row.id))
                : null;
              classes.push({
                id: integer(row.id),
                label: text(row.codigo),
                name: text(row.nome),
                sessionState: sessionStateOf(row.estado),
                sessionVersion: nullableInteger(row.version) ?? 0,
                ...(workspace !== null && typeof workspace !== 'string'
                  ? { tally: relationalCouncilTallyV3(workspace.summary) }
                  : {}),
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
          }
          if (request.operation === 'workspace') return ready(db, request);
          const duplicate = await idempotency(db, request);
          const result = await mutate(db, request, actorId);
          // The persisted command proves a write even if rebuilding the response is unavailable.
          if (duplicate === 'new' && (await idempotency(db, request)) === 'same') {
            // Closing and reopening change what the Portal may publish; opening does not.
            await recordResetWriteV1(db, request.year, 'council', {
              changed: request.operation !== 'open',
              studentIds: [],
            });
          }
          return result;
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
