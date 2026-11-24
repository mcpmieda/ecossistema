import {
  lockResetWriterV1,
  recordResetWriteV1,
} from '../../../student-portal/integration/year-reset/writer-v1';
import {
  RELATIONAL_COUNCIL_LIMITS_V3,
  relationalCouncilRequestSchemaV3,
  relationalCouncilResponseMatchesV3,
  relationalCouncilInformedV3,
  relationalCouncilTallyV3,
  relationalCouncilVotableV3,
  relationalCouncilResponseSchemaV3,
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
  return { valueMilli: value.valueMilli, state: value.state, level: value.level };
}

/** Why a student is, or is not, a student of the Conselho. The annual outcome comes from the one
 * calculation; this only names its case, R/R before N/C as the calculation itself does. */
type CouncilCaseV3 = {
  readonly eligible: boolean;
  readonly code:
    | RelationalCouncilStudentV3['eligibility']['code']
    | 'status'
    | 'definitions-unavailable'
    | 'in-progress'
    | 'above-limit'
    | 'approved';
  readonly failedComponentCount: number;
};
function eligibility(
  annual: { readonly state: string; readonly councilEligibility: string } | null,
  projections: readonly PerformanceProjectionV2[],
  indicatorEligible: boolean,
  maxCouncilComponents: number,
): CouncilCaseV3 {
  const failedComponentCount = projections.filter(
    (item) =>
      item.recovery?.classification === 'not-approved' ||
      item.recovery?.classification === 'failed-repeat',
  ).length;
  const classified = (item: PerformanceProjectionV2, classification: string) =>
    item.recovery?.classification === classification;
  let code: CouncilCaseV3['code'] = 'approved';
  if (!indicatorEligible) code = 'status';
  else if (annual === null || projections.some((item) => item.recovery === null))
    code = 'definitions-unavailable';
  else if (annual.councilEligibility === 'eligible') code = 'eligible';
  else if (annual.state === 'in-progress') code = 'in-progress';
  else if (annual.state === 'recovery') code = 'recovery-pending';
  else if (projections.some((item) => classified(item, 'failed-repeat'))) code = 'failed-repeat';
  else if (projections.some((item) => classified(item, 'failed-no-show'))) code = 'failed-no-show';
  else if (failedComponentCount > maxCouncilComponents) code = 'above-limit';
  return { eligible: code === 'eligible', code, failedComponentCount };
}

/** Whether the Conselho sees the student at all, with the case narrowed to the ones it sends. */
function beforeCouncilV3(
  studentCase: CouncilCaseV3,
): studentCase is CouncilCaseV3 & RelationalCouncilStudentV3['eligibility'] {
  const eligibility = { eligibility: studentCase };
  return relationalCouncilVotableV3(eligibility) || relationalCouncilInformedV3(eligibility);
}

async function readWorkspace(
  db: GradebookPostgresTransactionV1,
  year: number,
  classId: number,
): Promise<RelationalCouncilWorkspaceV3 | RelationalCouncilFailureV3> {
  const base = await first(
    db,
    `SELECT t.id,t.codigo,y.max_componentes_conselho,s.estado
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

  const maxCouncilComponents = integer(base.max_componentes_conselho);
  // Only who is before the Conselho is sent: the ones it deliberates on and the ones it takes
  // notice of. The marks of the rest of the class would be most of the answer, unread.
  const students: RelationalCouncilStudentV3[] = performance.rows.flatMap((row) => {
    const projections = projectionMap.get(row.student.id) ?? [];
    const studentCase = eligibility(
      row.calculatedAnnual,
      projections,
      row.student.indicatorEligible,
      maxCouncilComponents,
    );
    if (!beforeCouncilV3(studentCase)) return [];
    return {
      id: row.student.id,
      name: row.student.name,
      number: row.student.number,
      eligibility: studentCase,
      // The decision in force is the one the calculation itself honours (a decision recorded
      // before a grade changed the student's case no longer counts), so Desempenho and the
      // Conselho never disagree.
      decision: row.formalCouncilDecision ? { code: row.formalCouncilDecision.code } : null,
      components: performance.offers.map((offering, index) => {
        const projection = projections[index];
        if (!projection || projection.offerId !== offering.id)
          throw new Error('inconsistent-council-projection');
        return {
          offerId: offering.id,
          subject: offering.subject.label,
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
  // The counts follow who the Conselho deliberates on, which includes a recovery still to be
  // recorded.
  const votable = students.filter(relationalCouncilVotableV3);
  return {
    context: { year },
    classGroup: { id: integer(base.id), label: text(base.codigo) },
    session: { state: base.estado === null ? 'not-opened' : 'open' },
    summary: {
      total: performance.rows.length,
      decided: votable.filter((student) => student.decision).length,
      pending: votable.filter((student) => !student.decision).length,
      approved: votable.filter((student) => student.decision?.code === 1).length,
      rejected: votable.filter((student) => student.decision?.code === 2).length,
      absence: votable.filter((student) => student.decision?.code === 3).length,
      forInformation: students.filter(relationalCouncilInformedV3).length,
    },
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

/** Opening the meeting of a class. It opens once: asking again answers with the open meeting.
 * The class is read first, so a class that cannot be read is never left open behind a failure. */
async function openSessionV3(
  db: GradebookPostgresTransactionV1,
  request: OpenRequestV3,
  actorId: string,
): Promise<RelationalCouncilResponseV3> {
  const classRow = await first(
    db,
    'SELECT id FROM gradebook.turma WHERE ano=$1 AND id=$2 FOR UPDATE',
    [request.year, request.classId],
  );
  if (!classRow) return fail('not-found');
  const workspace = await readWorkspace(db, request.year, request.classId);
  if (typeof workspace === 'string') return fail(workspace);
  const opened = await db.executeNative(
    `INSERT INTO gradebook.conselho_sessao (ano,turma_id,estado,versao,atualizado_por) VALUES ($1, $2, $3, 1, $4)
    ON CONFLICT (ano,turma_id) DO NOTHING RETURNING turma_id`,
    [request.year, request.classId, SESSION_OPEN_V3, actorId],
  );
  // The year reset must know of the write; nothing the Portal publishes changed.
  if (opened.rows.length) await recordResetWriteV1(db, request.year, 'council');
  return {
    contractVersion: 3,
    state: 'ready',
    operation: 'open',
    workspace: { ...workspace, session: { state: 'open' } },
  };
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
          const limit = RELATIONAL_COUNCIL_LIMITS_V3.classes;
          const rows = await all(
            db,
            `SELECT id,codigo FROM gradebook.turma WHERE ano=$1 ORDER BY codigo COLLATE "C",id LIMIT $2`,
            [request.year, limit + 1],
          );
          // A year with more classes than one reading covers is refused whole, never cut short.
          if (rows.length > limit) return fail('scope-too-large');
          const classes = [];
          for (const row of rows) {
            // The tally is the class's own reading, so it can never disagree with its workspace.
            // A class whose reading failed, in whatever way, goes without one and is shown as
            // unreadable; it does not take the list with it. (A database error ends the
            // transaction, so the classes after it go without a tally too.)
            const workspace = await readWorkspace(db, request.year, integer(row.id)).catch(
              () => 'unavailable' as const,
            );
            classes.push({
              id: integer(row.id),
              label: text(row.codigo),
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
