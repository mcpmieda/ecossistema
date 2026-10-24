import { lockResetWriterV1, recordResetWriteV1 } from '../../../student-portal/integration/year-reset/writer-v1';
import {
  RELATIONAL_COUNCIL_DECISIONS_V3,
  RELATIONAL_COUNCIL_LIMITS_V3,
  relationalCouncilRequestSchemaV3,
  relationalCouncilResponseMatchesV3,
  relationalCouncilResponseSchemaV3,
  type RelationalCouncilDecisionV3,
  type RelationalCouncilFailureV3,
  type RelationalCouncilRequestV3,
  type RelationalCouncilResponseV3,
  type RelationalCouncilStudentV3,
  type RelationalCouncilWorkspaceV3,
} from '../../../../shared/gradebook-contracts/council/relational-council-v3';
import { performanceCellV2, type PerformanceProjectionV2 } from '../results/relational-performance-facts-v2';
import { readRelationalPerformanceV2 } from '../read-models/performance/relational-performance-v2';
import { type GradebookPostgresWritePortV1, type GradebookPostgresScalarV1, type GradebookPostgresTransactionV1  } from '../../persistence/postgres/postgres-database-v1';


type Row = Record<string, unknown>;
type Database = GradebookPostgresWritePortV1 & {
  transaction<T>(operation: (database: GradebookPostgresTransactionV1) => Promise<T>): Promise<T>;
};
type WriteRequest = Exclude<RelationalCouncilRequestV3, { operation: 'classes' | 'workspace' }>;

const OPERATION_CODE = { open: 1, decision: 2, vote: 3, close: 4, reopen: 5 } as const;
const SESSION_STATE = { open: 1, closed: 2 } as const;
const SESSION_EVENT = { open: 1, close: 2, reopen: 3 } as const;
const ALL_STATUSES = [null, 1, 2, 3, 4, 5, 7] as const;

const fail = (state: RelationalCouncilFailureV3, currentVersion?: number | null): RelationalCouncilResponseV3 => ({
  contractVersion: 3,
  state,
  ...(currentVersion === undefined ? {} : { currentVersion }),
});
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('invalid-council-row');
  return value;
}
function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value);
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('invalid-council-row');
  return value;
}
function serializationFailure(cause: unknown): boolean {
  return cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === '40001';
}
async function all(db: GradebookPostgresTransactionV1, sql: string, values: readonly GradebookPostgresScalarV1[] = []): Promise<readonly Row[]> {
  return db.query<Row>(sql, values);
}
async function first(db: GradebookPostgresTransactionV1, sql: string, values: readonly GradebookPostgresScalarV1[] = []): Promise<Row | null> {
  return (await db.query<Row>(sql, values))[0] ?? null;
}
function reviewReference(year: number, classId: number, version: number): string {
  return `council-review:${year}:${classId}:${version}`;
}
function voteComparison(favoraveis: number, contrarios: number): 'favoraveis' | 'contrarios' | 'empate' {
  return favoraveis === contrarios ? 'empate' : favoraveis > contrarios ? 'favoraveis' : 'contrarios';
}
function cell(projection: PerformanceProjectionV2, period: 1 | 2 | 3 | 'annual', mode: 'regular' | 'recovery') {
  const value = performanceCellV2(projection, period, mode);
  return { valueMilli: value.valueMilli, maximumMilli: value.maximumMilli, state: value.state };
}

function eligibility(
  annual: { readonly state: string; readonly councilEligibility: string; readonly label: string | null } | null,
  projections: readonly PerformanceProjectionV2[],
  indicatorEligible: boolean,
  maxCouncilComponents: number,
): RelationalCouncilStudentV3['eligibility'] {
  const failed = projections.filter((item) => item.recovery?.classification === 'not-approved' || item.recovery?.classification === 'failed-repeat').length;
  if (!indicatorEligible) return { eligible: false, code: 'status', label: 'Situação de matrícula não participa do Conselho Final.', failedComponentCount: failed };
  if (annual === null || projections.some((item) => item.recovery === null)) return { eligible: false, code: 'definitions-unavailable', label: 'Definições acadêmicas ainda não estão completas.', failedComponentCount: failed };
  if (annual.councilEligibility === 'eligible') return { eligible: true, code: 'eligible', label: 'Elegível ao Conselho Final.', failedComponentCount: failed };
  if (annual.state === 'in-progress') return { eligible: false, code: 'in-progress', label: 'Cálculo anual ainda está em curso.', failedComponentCount: failed };
  if (annual.state === 'recovery') return { eligible: false, code: 'recovery-pending', label: 'Recuperação ainda não concluída.', failedComponentCount: failed };
  if (projections.some((item) => item.recovery?.classification === 'failed-no-show')) return { eligible: false, code: 'failed-no-show', label: 'Há recuperação marcada como não comparecimento.', failedComponentCount: failed };
  if (projections.some((item) => item.recovery?.classification === 'failed-repeat')) return { eligible: false, code: 'failed-repeat', label: 'R/R determina reprovação automática, sem deliberação do Conselho.', failedComponentCount: failed };
  if (failed > maxCouncilComponents) return { eligible: false, code: 'above-limit', label: `Reprovação em ${failed} componentes, acima do limite de ${maxCouncilComponents}.`, failedComponentCount: failed };
  return { eligible: false, code: 'approved', label: annual.label ?? 'Resultado anual não exige deliberação do Conselho.', failedComponentCount: failed };
}

async function readWorkspace(
  db: GradebookPostgresTransactionV1,
  year: number,
  classId: number,
): Promise<RelationalCouncilWorkspaceV3 | RelationalCouncilFailureV3> {
  const base = await first(db, `SELECT t.id,t.codigo,t.nome,y.minimo_aprovacao,y.max_componentes_conselho,
      s.estado,s.versao AS version,c.fechado_em,
      (SELECT count(*)::integer FROM gradebook.conselho_fechamento x WHERE x.ano=t.ano AND x.turma_id=t.id) AS snapshot_count,
      to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS read_at
    FROM gradebook.turma t JOIN gradebook.ano_letivo y ON y.ano=t.ano
    LEFT JOIN gradebook.conselho_sessao s ON s.ano=t.ano AND s.turma_id=t.id
    LEFT JOIN gradebook.conselho_fechamento c ON c.id=s.fechamento_atual_id
    WHERE t.ano=$1 AND t.id=$2`, [year, classId]);
  if (!base) return 'not-found';
  const version = nullableInteger(base.version) ?? 0;
  const projectionMap = new Map<number, readonly PerformanceProjectionV2[]>();
  const performance = await readRelationalPerformanceV2(db, {
    transportVersion: 2, operation: 'matrix', year, classId, period: 'annual', mode: 'regular', statuses: [...ALL_STATUSES],
  }, { collect: (value) => { for (const [studentId, projections] of value) projectionMap.set(studentId, projections); } });
  if (performance.state !== 'ready') return performance.state === 'scope-too-large' ? 'scope-too-large' : 'unavailable';
  if (performance.operation !== 'matrix') return 'unavailable';

  const [decisionRows, voteRows, timelineRows, closureRows] = await Promise.all([
    all(db, `SELECT cd.aluno_id,cd.decisao,cd.justificativa,cd.registrado_em AS updated_at,
        COALESCE((SELECT max(x.versao) FROM gradebook.conselho_decisao_comando x
          WHERE x.ano=$1 AND x.turma_id=$2 AND x.aluno_id=cd.aluno_id),0)::integer AS version
      FROM gradebook.conselho_decisao cd JOIN gradebook.vinculo v ON v.aluno_id=cd.aluno_id
      WHERE v.ano=$3 AND v.turma_id=$4 AND v.situacao IS DISTINCT FROM 6`, [year, classId, year, classId]),
    all(db, `SELECT aluno_id,favoraveis,contrarios,versao AS version,justificativa,registrado_em AS updated_at
      FROM gradebook.conselho_votacao WHERE ano=$1 AND turma_id=$2`, [year, classId]),
    all(db, `SELECT * FROM (
        SELECT 's:'||h.id AS timeline_id,CASE h.evento WHEN 1 THEN 'opened' WHEN 2 THEN 'closed' ELSE 'reopened' END AS action,
          h.versao AS version,NULL::integer AS aluno_id,NULL::text AS aluno_nome,h.justificativa,h.alterado_em AS occurred_at
        FROM gradebook.conselho_sessao_historico h WHERE h.ano=$1 AND h.turma_id=$2
        UNION ALL
        SELECT 'd:'||d.id,'decision-recorded',d.versao,d.aluno_id,COALESCE(presentation.name,a.nome),d.justificativa_nova,d.alterado_em
        FROM gradebook.conselho_decisao_comando d JOIN gradebook.aluno a ON a.id=d.aluno_id
        LEFT JOIN gradebook.student_presentation_v1 presentation ON presentation.student_id=a.id AND presentation.academic_year=a.ano
        WHERE d.ano=$3 AND d.turma_id=$4
        UNION ALL
        SELECT 'v:'||v.id,'vote-recorded',v.versao,v.aluno_id,COALESCE(presentation.name,a.nome),v.justificativa,v.alterado_em
        FROM gradebook.conselho_votacao_historico v JOIN gradebook.aluno a ON a.id=v.aluno_id
        LEFT JOIN gradebook.student_presentation_v1 presentation ON presentation.student_id=a.id AND presentation.academic_year=a.ano
        WHERE v.ano=$5 AND v.turma_id=$6
      ) x ORDER BY occurred_at DESC,version DESC LIMIT $7`, [year, classId, year, classId, year, classId, RELATIONAL_COUNCIL_LIMITS_V3.timeline]),
    all(db, `SELECT id::integer AS id,sequencia,versao AS version,fechado_em,
        total,elegiveis,aprovados,reprovados,faltas,nao_elegiveis
      FROM gradebook.conselho_fechamento WHERE ano=$1 AND turma_id=$2
      ORDER BY sequencia DESC LIMIT $3`, [year, classId, RELATIONAL_COUNCIL_LIMITS_V3.closures]),
  ]);
  const decisions = new Map(decisionRows.map((row) => [integer(row.aluno_id), row]));
  const votes = new Map(voteRows.map((row) => [integer(row.aluno_id), row]));
  const maxCouncilComponents = integer(base.max_componentes_conselho);
  const students: RelationalCouncilStudentV3[] = performance.rows.map((row) => {
    const projections = projectionMap.get(row.student.id) ?? [];
    const currentDecision = decisions.get(row.student.id);
    const currentVote = votes.get(row.student.id);
    return {
      id: row.student.id, name: row.student.name, number: row.student.number, statusLabel: row.student.statusLabel,
      eligibility: eligibility(row.calculatedAnnual, projections, row.student.indicatorEligible, maxCouncilComponents),
      calculatedResult: row.calculatedAnnual?.label ?? null,
      decision: currentDecision ? {
        code: integer(currentDecision.decisao) as RelationalCouncilDecisionV3,
        label: RELATIONAL_COUNCIL_DECISIONS_V3[integer(currentDecision.decisao) as RelationalCouncilDecisionV3],
        justification: text(currentDecision.justificativa), version: integer(currentDecision.version), updatedAt: text(currentDecision.updated_at),
      } : null,
      vote: currentVote ? {
        favoraveis: integer(currentVote.favoraveis), contrarios: integer(currentVote.contrarios),
        presentes: integer(currentVote.favoraveis) + integer(currentVote.contrarios),
        comparison: voteComparison(integer(currentVote.favoraveis), integer(currentVote.contrarios)),
        justification: text(currentVote.justificativa), version: integer(currentVote.version), updatedAt: text(currentVote.updated_at),
      } : null,
      components: performance.offers.map((offering, index) => {
        const projection = projections[index];
        if (!projection || projection.offerId !== offering.id) throw new Error('inconsistent-council-projection');
        return { offerId: offering.id, subject: { id: offering.subject.id, label: offering.subject.label, abbreviation: offering.subject.abbreviation ?? null },
          terms: [cell(projection, 1, 'regular'), cell(projection, 2, 'regular'), cell(projection, 3, 'regular')],
          recovery: cell(projection, 'annual', 'recovery'), result: projection.recovery?.classification ?? 'unavailable' };
      }),
    };
  });
  const eligible = students.filter((student) => student.eligibility.eligible);
  const summary = {
    total: students.length, eligible: eligible.length, decided: eligible.filter((student) => student.decision).length,
    pending: eligible.filter((student) => !student.decision).length,
    approved: eligible.filter((student) => student.decision?.code === 1).length,
    rejected: eligible.filter((student) => student.decision?.code === 2).length,
    absence: eligible.filter((student) => student.decision?.code === 3).length,
    notEligible: students.length - eligible.length,
  };
  return {
    context: { year, minimumApprovalMilli: integer(base.minimo_aprovacao), maxCouncilComponents },
    classGroup: { id: integer(base.id), label: text(base.codigo), name: text(base.nome) }, readAt: text(base.read_at),
    authority: 'calculated-eligibility-explicit-human-decision',
    session: { state: base.estado === null ? 'not-opened' : integer(base.estado) === SESSION_STATE.open ? 'open' : 'closed',
      version, reviewReference: reviewReference(year, classId, version), closedAt: base.fechado_em === null ? null : text(base.fechado_em), snapshotCount: integer(base.snapshot_count) },
    summary, students,
    timeline: timelineRows.map((row) => ({ id: text(row.timeline_id), action: text(row.action) as RelationalCouncilWorkspaceV3['timeline'][number]['action'],
      version: integer(row.version), studentId: nullableInteger(row.aluno_id), studentLabel: row.aluno_nome === null ? null : text(row.aluno_nome),
      justification: text(row.justificativa), occurredAt: text(row.occurred_at) })),
    closures: closureRows.map((row) => ({ id: integer(row.id), sequence: integer(row.sequencia), version: integer(row.version), closedAt: text(row.fechado_em),
      summary: { total: integer(row.total), eligible: integer(row.elegiveis), approved: integer(row.aprovados), rejected: integer(row.reprovados),
        absence: integer(row.faltas), notEligible: integer(row.nao_elegiveis) } })),
  };
}

async function currentSession(db: GradebookPostgresTransactionV1, request: WriteRequest): Promise<Row | null> {
  return first(db, 'SELECT estado,versao AS version FROM gradebook.conselho_sessao WHERE ano=$1 AND turma_id=$2 FOR UPDATE', [request.year, request.classId]);
}
async function idempotency(db: GradebookPostgresTransactionV1, request: WriteRequest): Promise<'new' | 'same' | 'conflict'> {
  const row = await first(db, `SELECT operacao,ano,turma_id,aluno_id,versao_anterior AS expected_version,
      decisao,favoraveis,contrarios,justificativa FROM gradebook.conselho_idempotencia WHERE chave=$1`, [request.idempotencyKey]);
  if (!row) return 'new';
  const studentId = 'studentId' in request ? request.studentId : null;
  const decision = request.operation === 'decision' ? request.decision : null;
  const favoraveis = request.operation === 'vote' ? request.favoraveis : null;
  const contrarios = request.operation === 'vote' ? request.contrarios : null;
  return integer(row.operacao) === OPERATION_CODE[request.operation] && integer(row.ano) === request.year &&
    integer(row.turma_id) === request.classId && nullableInteger(row.aluno_id) === studentId &&
    integer(row.expected_version) === request.expectedVersion && nullableInteger(row.decisao) === decision &&
    nullableInteger(row.favoraveis) === favoraveis && nullableInteger(row.contrarios) === contrarios &&
    text(row.justificativa) === request.justification ? 'same' : 'conflict';
}
async function recordIdempotency(db: GradebookPostgresTransactionV1, request: WriteRequest, newVersion: number, actorId: string): Promise<void> {
  await db.executeNative(`INSERT INTO gradebook.conselho_idempotencia (chave,operacao,ano,turma_id,aluno_id,versao_anterior,versao_nova,decisao,favoraveis,contrarios,justificativa,registrado_por) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [request.idempotencyKey, OPERATION_CODE[request.operation], request.year, request.classId, 'studentId' in request ? request.studentId : null, request.expectedVersion, newVersion, request.operation === 'decision' ? request.decision : null, request.operation === 'vote' ? request.favoraveis : null, request.operation === 'vote' ? request.contrarios : null, request.justification, actorId]);
}
async function advanceSession(db: GradebookPostgresTransactionV1, request: WriteRequest, state: 1 | 2, actorId: string, clearClosure = false): Promise<number | null> {
  const row = await first(db, `UPDATE gradebook.conselho_sessao SET estado=$1,versao=versao+1,
      fechamento_atual_id=${clearClosure ? 'NULL' : 'fechamento_atual_id'},atualizado_por=$2,atualizado_em=transaction_timestamp()
    WHERE ano=$3 AND turma_id=$4 AND versao=$5 RETURNING versao AS version`, [state, actorId, request.year, request.classId, request.expectedVersion]);
  return row ? integer(row.version) : null;
}
async function ready(db: GradebookPostgresTransactionV1, request: Exclude<RelationalCouncilRequestV3, { operation: 'classes' }>): Promise<RelationalCouncilResponseV3> {
  const workspace = await readWorkspace(db, request.year, request.classId);
  return typeof workspace === 'string' ? fail(workspace) : { contractVersion: 3, state: 'ready', operation: request.operation, workspace };
}

async function mutate(db: GradebookPostgresTransactionV1, request: WriteRequest, actorId: string): Promise<RelationalCouncilResponseV3> {
  const duplicate = await idempotency(db, request);
  if (duplicate === 'conflict') return fail('idempotency-conflict');
  if (duplicate === 'same') return ready(db, request);

  if (request.operation === 'open') {
    const classRow = await first(db, 'SELECT id FROM gradebook.turma WHERE ano=$1 AND id=$2 FOR UPDATE', [request.year, request.classId]);
    if (!classRow) return fail('not-found');
    const session = await currentSession(db, request);
    if (session) return fail('session-already-open', integer(session.version));
    if (request.expectedVersion !== 0) return fail('version-conflict', 0);
    await db.executeNative(`INSERT INTO gradebook.conselho_sessao (ano,turma_id,estado,versao,atualizado_por) VALUES ($1, $2, $3, $4, $5)`, [request.year, request.classId, SESSION_STATE.open, 1, actorId]);
    await recordIdempotency(db, request, 1, actorId);
    await db.executeNative(`INSERT INTO gradebook.conselho_sessao_historico (ano,turma_id,versao,evento,estado_anterior,estado_novo,justificativa,alterado_por,chave_idempotencia) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [request.year, request.classId, 1, SESSION_EVENT.open, null, SESSION_STATE.open, request.justification, actorId, request.idempotencyKey]);
    return ready(db, request);
  }

  const session = await currentSession(db, request);
  if (!session) return fail('session-not-open', 0);
  const currentVersion = integer(session.version);
  if (currentVersion !== request.expectedVersion) return fail('version-conflict', currentVersion);
  const state = integer(session.estado);
  if (request.operation === 'reopen') {
    if (state !== SESSION_STATE.closed) return fail('session-already-open', currentVersion);
    const newVersion = await advanceSession(db, request, SESSION_STATE.open, actorId, true);
    if (newVersion === null) return fail('version-conflict', currentVersion);
    await recordIdempotency(db, request, newVersion, actorId);
    await db.executeNative(`INSERT INTO gradebook.conselho_sessao_historico (ano,turma_id,versao,evento,estado_anterior,estado_novo,justificativa,alterado_por,chave_idempotencia) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [request.year, request.classId, newVersion, SESSION_EVENT.reopen, SESSION_STATE.closed, SESSION_STATE.open, request.justification, actorId, request.idempotencyKey]);
    return ready(db, request);
  }
  if (state !== SESSION_STATE.open) return fail('session-closed', currentVersion);

  const workspace = await readWorkspace(db, request.year, request.classId);
  if (typeof workspace === 'string') return fail(workspace);

  if (request.operation === 'decision' || request.operation === 'vote') {
    const student = workspace.students.find((item) => item.id === request.studentId);
    if (!student) return fail('not-found', currentVersion);
    if (!student.eligibility.eligible) return fail('student-not-eligible', currentVersion);
    if (request.operation === 'decision' && student.decision?.code === request.decision && student.decision.justification === request.justification) return ready(db, request);
    if (request.operation === 'vote' && student.vote?.favoraveis === request.favoraveis && student.vote.contrarios === request.contrarios && student.vote.justification === request.justification) return ready(db, request);
    const newVersion = await advanceSession(db, request, SESSION_STATE.open, actorId);
    if (newVersion === null) return fail('version-conflict', currentVersion);
    await recordIdempotency(db, request, newVersion, actorId);
    if (request.operation === 'decision') {
      const previous = await first(db, 'SELECT decisao,justificativa FROM gradebook.conselho_decisao WHERE aluno_id=$1', [request.studentId]);
      if (previous) {
        await db.executeNative(`INSERT INTO gradebook.conselho_decisao_historico (aluno_id,decisao_anterior,decisao_nova,justificativa_anterior,justificativa_nova,alterado_por) VALUES ($1, $2, $3, $4, $5, $6)`, [request.studentId, integer(previous.decisao), request.decision, text(previous.justificativa), request.justification, actorId]);
      }
      await db.executeNative(`INSERT INTO gradebook.conselho_decisao (aluno_id,decisao,justificativa,registrado_por,registrado_em) VALUES ($1, $2, $3, $4, transaction_timestamp()) ON CONFLICT (aluno_id) DO UPDATE SET decisao=EXCLUDED.decisao,
        justificativa=EXCLUDED.justificativa,registrado_por=EXCLUDED.registrado_por,registrado_em=EXCLUDED.registrado_em`, [request.studentId, request.decision, request.justification, actorId]);
      await db.executeNative(`INSERT INTO gradebook.conselho_decisao_comando (ano,turma_id,aluno_id,versao,decisao_anterior,justificativa_anterior,decisao_nova,justificativa_nova,alterado_por,chave_idempotencia) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [request.year, request.classId, request.studentId, newVersion, previous ? integer(previous.decisao) : null, previous ? text(previous.justificativa) : null, request.decision, request.justification, actorId, request.idempotencyKey]);
    } else {
      const previous = await first(db, `SELECT favoraveis,contrarios FROM gradebook.conselho_votacao
        WHERE ano=$1 AND turma_id=$2 AND aluno_id=$3`, [request.year, request.classId, request.studentId]);
      await db.executeNative(`INSERT INTO gradebook.conselho_votacao (ano,turma_id,aluno_id,favoraveis,contrarios,versao,justificativa,registrado_por,registrado_em) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, transaction_timestamp()) ON CONFLICT (ano,turma_id,aluno_id) DO UPDATE SET
        favoraveis=EXCLUDED.favoraveis,contrarios=EXCLUDED.contrarios,versao=EXCLUDED.versao,
        justificativa=EXCLUDED.justificativa,registrado_por=EXCLUDED.registrado_por,registrado_em=EXCLUDED.registrado_em`, [request.year, request.classId, request.studentId, request.favoraveis, request.contrarios, newVersion, request.justification, actorId]);
      await db.executeNative(`INSERT INTO gradebook.conselho_votacao_historico (ano,turma_id,aluno_id,versao,favoraveis_anterior,contrarios_anterior,favoraveis_novo,contrarios_novo,
          justificativa,alterado_por,chave_idempotencia) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [request.year, request.classId, request.studentId, newVersion, previous ? integer(previous.favoraveis) : null, previous ? integer(previous.contrarios) : null, request.favoraveis, request.contrarios, request.justification, actorId, request.idempotencyKey]);
    }
    return ready(db, request);
  }

  if (workspace.session.reviewReference !== request.reviewReference) return fail('review-conflict', currentVersion);
  if (workspace.summary.pending > 0) return fail('closure-blocked', currentVersion);
  const newVersion = await advanceSession(db, request, SESSION_STATE.closed, actorId);
  if (newVersion === null) return fail('version-conflict', currentVersion);
  await recordIdempotency(db, request, newVersion, actorId);
  const sequence = (workspace.closures[0]?.sequence ?? 0) + 1;
  const closure = await first(db, `INSERT INTO gradebook.conselho_fechamento (ano,turma_id,sequencia,versao,total,elegiveis,aprovados,reprovados,faltas,nao_elegiveis,justificativa,fechado_por,chave_idempotencia) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id::integer AS id`, [request.year, request.classId, sequence, newVersion,
    workspace.summary.total, workspace.summary.eligible, workspace.summary.approved, workspace.summary.rejected,
    workspace.summary.absence, workspace.summary.notEligible, request.justification, actorId, request.idempotencyKey]);
  if (!closure) throw new Error('council-closure-missing');
  const closureId = integer(closure.id);
  for (const student of workspace.students) {
    await db.executeNative(`INSERT INTO gradebook.conselho_fechamento_item (fechamento_id,aluno_id,elegivel,motivo_elegibilidade,decisao,favoraveis,contrarios) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [closureId, student.id, student.eligibility.eligible ? 1 : 0, student.eligibility.label, student.decision?.code ?? null, student.vote?.favoraveis ?? null, student.vote?.contrarios ?? null]);
  }
  await db.executeNative(`INSERT INTO gradebook.conselho_sessao_historico (ano,turma_id,versao,evento,estado_anterior,estado_novo,justificativa,alterado_por,chave_idempotencia) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [request.year, request.classId, newVersion, SESSION_EVENT.close, SESSION_STATE.open, SESSION_STATE.closed, request.justification, actorId, request.idempotencyKey]);
  await db.executeNative('UPDATE gradebook.conselho_sessao SET fechamento_atual_id=$1 WHERE ano=$2 AND turma_id=$3', [closureId, request.year, request.classId]);
  return ready(db, request);
}

export function createRelationalCouncilV3(database: GradebookPostgresWritePortV1, actorId: string) {
  return { async execute(input: unknown): Promise<RelationalCouncilResponseV3> {
    const parsed = relationalCouncilRequestSchemaV3.safeParse(input);
    if (!parsed.success) return fail('invalid-request');
    if (!('transaction' in database) || typeof database.transaction !== 'function') return fail('unavailable');
    const request = parsed.data;
    const executeTransaction = () => (database as Database).transaction(async (db) => {
      if (request.operation === 'classes' || request.operation === 'workspace') {
        await db.executeNative('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', []);
      } else {
        await db.executeNative('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', []);
        await lockResetWriterV1(db, request.year);
      }
      if (request.operation === 'classes') {
        const rows = await all(db, `SELECT t.id,t.codigo,t.nome,s.estado,s.versao AS version
          FROM gradebook.turma t LEFT JOIN gradebook.conselho_sessao s ON s.ano=t.ano AND s.turma_id=t.id
          WHERE t.ano=$1 ORDER BY t.codigo COLLATE "C",t.id LIMIT $2 OFFSET $3`, [request.year, request.limit + 1, request.offset]);
        return { contractVersion: 3, state: 'ready', operation: 'classes', year: request.year,
          classes: rows.slice(0, request.limit).map((row) => ({ id: integer(row.id), label: text(row.codigo), name: text(row.nome),
            sessionState: row.estado === null ? 'not-opened' as const : integer(row.estado) === SESSION_STATE.open ? 'open' as const : 'closed' as const,
            sessionVersion: nullableInteger(row.version) ?? 0 })), nextOffset: rows.length > request.limit ? request.offset + request.limit : null };
      }
      if (request.operation === 'workspace') return ready(db, request);
      const duplicate = await idempotency(db, request);
      const previousDecision = request.operation === 'decision'
        ? await first(db, 'SELECT decisao FROM gradebook.conselho_decisao WHERE aluno_id=$1', [request.studentId])
        : null;
      const result = await mutate(db, request, actorId);
      // The persisted command proves a write even if rebuilding the response is unavailable.
      if (duplicate === 'new' && await idempotency(db, request) === 'same') {
        const academicChange = request.operation === 'close' || request.operation === 'reopen'
          || (request.operation === 'decision' && (previousDecision === null || integer(previousDecision.decisao) !== request.decision));
        await recordResetWriteV1(db, request.year, 'council', {
          changed: academicChange,
          studentIds: request.operation === 'decision' ? [request.studentId] : [],
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
    if (!relationalCouncilResponseMatchesV3(request, checked)) throw new Error('inconsistent-council-response');
    return checked;
  } };
}
