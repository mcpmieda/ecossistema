import {
  isOperationalWorkspaceRequestV2,
  isOperationalWorkspaceResponseV2,
  WORKSPACE_MAX_OFFSET_V2,
  WORKSPACE_MAX_YEARS_V2,
  type OperationalWorkspaceRequestV2,
  type OperationalWorkspaceResponseV2,
  type WorkspaceBindingV2,
  type WorkspaceCenterV2,
  type WorkspaceCountsV2,
  type WorkspaceKindV2,
  type WorkspaceLinkV2,
  type WorkspaceOfferV2,
  type WorkspaceStatusV2,
  type WorkspaceYearV2,
} from '../../../../shared/gradebook-contracts/operational-workspace/operational-workspace-transport-v2';
import { compareSourceSubjectPresentationV1 } from '../../../../shared/gradebook-contracts/source/subject-abbreviations-v1';
import { type GradebookPostgresWritePortV1, type GradebookPostgresScalarV1, type GradebookPostgresReadPortV1, type GradebookPostgresTransactionV1  } from '../../persistence/postgres/postgres-database-v1';


type Row = Record<string, unknown>;
type Database = GradebookPostgresWritePortV1 & {
  transaction<T>(operation: (database: GradebookPostgresTransactionV1) => Promise<T>): Promise<T>;
};
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('invalid-workspace-row');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid-workspace-row');
  return value;
}
function ref(kind: WorkspaceKindV2, id: unknown, label: unknown): WorkspaceLinkV2 {
  return { kind, id: integer(id), label: text(label) };
}
function context(row: Row): WorkspaceYearV2 {
  return { year: integer(row.ano), minimumApprovalMilli: integer(row.minimo_aprovacao), maxCouncilComponents: integer(row.max_componentes_conselho) };
}
async function all(db: GradebookPostgresReadPortV1, sql: string, values: readonly GradebookPostgresScalarV1[] = []): Promise<readonly Row[]> {
  return db.query<Row>(sql.trim(), values);
}
async function first(db: GradebookPostgresReadPortV1, sql: string, values: readonly GradebookPostgresScalarV1[] = []): Promise<Row | null> {
  return (await db.query<Row>(sql.trim(), values))[0] ?? null;
}
function nextOffset(length: number, offset: number, limit: number): number | null {
  if (length <= limit) return null;
  if (offset + limit > WORKSPACE_MAX_OFFSET_V2) throw new Error('workspace-pagination-limit');
  return offset + limit;
}
function toBinding(row: Row): WorkspaceBindingV2 {
  const status = row.situacao === null ? null : integer(row.situacao) as WorkspaceStatusV2;
  return {
    student: ref('student', row.aluno_id, row.aluno_nome),
    classGroup: ref('class-group', row.turma_id, row.turma_codigo),
    number: integer(row.numero), status,
    position: status === 6 ? 'historical' : 'current',
    relatedClass: row.turma_relacionada_id === null ? null : ref('class-group', row.turma_relacionada_id, row.turma_relacionada_codigo),
  };
}
function toOffer(row: Row): WorkspaceOfferV2 {
  return {
    id: integer(row.id),
    classGroup: ref('class-group', row.turma_id, row.turma_codigo),
    teacher: ref('teacher', row.professor_id, row.professor_nome),
    subject: ref('subject', row.disciplina_id, row.disciplina_nome),
  };
}
function orderOffers(left: WorkspaceOfferV2, right: WorkspaceOfferV2): number {
  return left.classGroup.label.localeCompare(right.classGroup.label, 'pt-BR') ||
    compareSourceSubjectPresentationV1(left.subject.label, right.subject.label) ||
    left.teacher.label.localeCompare(right.teacher.label, 'pt-BR') ||
    left.id - right.id;
}

// All fragments are fixed, reviewed identifiers. No request text becomes SQL syntax.
const ENTITY_SQL: Record<WorkspaceKindV2, string> = {
  student: 'SELECT id, nome AS label FROM gradebook.aluno WHERE ano = $1 AND id = $2',
  'class-group': 'SELECT id, codigo AS label, codigo, etapa, turno FROM gradebook.turma WHERE ano = $1 AND id = $2',
  teacher: 'SELECT id, nome AS label FROM gradebook.professor WHERE ano = $1 AND id = $2',
  subject: 'SELECT id, nome AS label FROM gradebook.disciplina WHERE ano = $1 AND id = $2',
};
const OFFER_FILTER: Record<WorkspaceKindV2, string> = {
  student: `EXISTS (SELECT 1 FROM gradebook.vinculo v
    WHERE v.ano = o.ano AND v.turma_id = o.turma_id AND v.aluno_id = $2 AND v.situacao IS DISTINCT FROM 6)`,
  'class-group': 'o.turma_id = $2',
  teacher: 'o.professor_id = $2',
  subject: 'o.disciplina_id = $2',
};

async function loadCenter(db: GradebookPostgresReadPortV1, request: Extract<OperationalWorkspaceRequestV2, {operation:'center'}>): Promise<WorkspaceCenterV2 | null> {
  const entity = await first(db, ENTITY_SQL[request.kind], [request.year, request.id]);
  if (!entity) return null;
  let bindings: readonly Row[] = [];
  if (request.kind === 'student' || request.kind === 'class-group') {
    const scope = request.kind === 'student' ? 'v.aluno_id = $2' : 'v.turma_id = $2';
    bindings = await all(db, `SELECT v.aluno_id,a.nome AS aluno_nome,v.turma_id,t.codigo AS turma_codigo,
        v.numero,v.situacao,v.turma_relacionada_id,rt.codigo AS turma_relacionada_codigo
      FROM gradebook.vinculo v
      JOIN gradebook.aluno a ON a.id = v.aluno_id AND a.ano = v.ano
      JOIN gradebook.turma t ON t.id = v.turma_id AND t.ano = v.ano
      LEFT JOIN gradebook.turma rt ON rt.id = v.turma_relacionada_id AND rt.ano = v.ano
      WHERE v.ano = $1 AND ${scope}
      ORDER BY (v.situacao IS NOT DISTINCT FROM 6),t.codigo COLLATE "C",v.numero,v.aluno_id
      LIMIT $3 OFFSET $4`, [request.year, request.id, request.limit + 1, request.offset]);
  }
  const offers = (await all(db, `SELECT o.id,o.turma_id,t.codigo AS turma_codigo,
      o.professor_id,p.nome AS professor_nome,o.disciplina_id,d.nome AS disciplina_nome
    FROM gradebook.oferta o
    JOIN gradebook.turma t ON t.id = o.turma_id AND t.ano = o.ano
    JOIN gradebook.professor p ON p.id = o.professor_id AND p.ano = o.ano
    JOIN gradebook.disciplina d ON d.id = o.disciplina_id AND d.ano = o.ano
    WHERE o.ano = $1 AND ${OFFER_FILTER[request.kind]}
    ORDER BY t.codigo COLLATE "C",d.nome COLLATE "C",p.nome COLLATE "C",o.id
    LIMIT $3 OFFSET $4`, [request.year, request.id, request.limit + 1, request.offset])).map(toOffer).sort(orderOffers);
  return {
    entity: ref(request.kind, entity.id, entity.label),
    classInfo: request.kind === 'class-group' ? {code:text(entity.codigo),stage:integer(entity.etapa),shift:text(entity.turno)} : null,
    bindings: bindings.slice(0, request.limit).map(toBinding),
    offers: offers.slice(0, request.limit),
    nextOffset: nextOffset(Math.max(bindings.length, offers.length), request.offset, request.limit),
  };
}

async function execute(db: GradebookPostgresReadPortV1, request: OperationalWorkspaceRequestV2): Promise<OperationalWorkspaceResponseV2> {
  if (request.operation === 'bootstrap') {
    const rows = await all(db, `SELECT ano,minimo_aprovacao,max_componentes_conselho
      FROM gradebook.ano_letivo ORDER BY ano DESC LIMIT $1`, [WORKSPACE_MAX_YEARS_V2 + 1]);
    if (rows.length > WORKSPACE_MAX_YEARS_V2) throw new Error('workspace-year-catalog-limit');
    return {contractVersion:2,state:'ready',operation:'bootstrap',years:rows.map(context)};
  }
  const year = await first(db, 'SELECT ano,minimo_aprovacao,max_componentes_conselho FROM gradebook.ano_letivo WHERE ano = $1', [request.year]);
  if (!year) return {contractVersion:2,state:'not-found'};
  const common = {contractVersion:2,state:'ready',context:context(year)} as const;
  if (request.operation === 'context') {
    const row = await first(db, `WITH y AS (SELECT $1::smallint AS ano)
      SELECT (SELECT count(*)::integer FROM gradebook.aluno a,y WHERE a.ano=y.ano) AS students,
        (SELECT count(*)::integer FROM gradebook.turma t,y WHERE t.ano=y.ano) AS classes,
        (SELECT count(*)::integer FROM gradebook.professor p,y WHERE p.ano=y.ano) AS teachers,
        (SELECT count(*)::integer FROM gradebook.disciplina d,y WHERE d.ano=y.ano) AS subjects,
        (SELECT count(*)::integer FROM gradebook.oferta o,y WHERE o.ano=y.ano) AS offers,
        (SELECT count(*)::integer FROM gradebook.vinculo v,y WHERE v.ano=y.ano AND v.situacao IS DISTINCT FROM 6) AS current_bindings,
        (SELECT count(*)::integer FROM gradebook.vinculo v,y WHERE v.ano=y.ano AND v.situacao=6) AS historical_bindings`, [request.year]);
    if (!row) throw new Error('workspace-context-missing');
    const counts: WorkspaceCountsV2 = {
      students:integer(row.students),classes:integer(row.classes),teachers:integer(row.teachers),
      subjects:integer(row.subjects),offers:integer(row.offers),
      currentBindings:integer(row.current_bindings),historicalBindings:integer(row.historical_bindings),
    };
    return {...common,operation:'context',counts};
  }
  if (request.operation === 'center') {
    const center = await loadCenter(db, request);
    return center ? {...common,operation:'center',center} : {contractVersion:2,state:'not-found'};
  }
  const rows = await all(db, `WITH y AS (SELECT $1::smallint AS ano), candidates AS (
      SELECT 1 AS rank,'student'::text AS kind,a.id,a.nome AS label,
        CASE WHEN t.id IS NULL THEN NULL ELSE t.codigo || ' · Nº ' || v.numero END AS description
      FROM gradebook.aluno a JOIN y ON a.ano=y.ano
      LEFT JOIN gradebook.vinculo v ON v.aluno_id=a.id AND v.ano=a.ano AND v.situacao IS DISTINCT FROM 6
      LEFT JOIN gradebook.turma t ON t.id=v.turma_id AND t.ano=v.ano
      UNION ALL SELECT 2,'class-group',t.id,t.codigo,t.nome FROM gradebook.turma t JOIN y ON t.ano=y.ano
      UNION ALL SELECT 3,'teacher',p.id,p.nome,NULL FROM gradebook.professor p JOIN y ON p.ano=y.ano
      UNION ALL SELECT 4,'subject',d.id,d.nome,NULL FROM gradebook.disciplina d JOIN y ON d.ano=y.ano
    ) SELECT kind,id,label,description FROM candidates
    WHERE ($2 = 'all' OR kind = $3) AND position(lower($4) in lower(label)) > 0
    ORDER BY rank,lower(label) COLLATE "C",id LIMIT $5 OFFSET $6`,
  [request.year,request.kind,request.kind,request.query.trim(),request.limit+1,request.offset]);
  return {
    ...common,operation:'search',
    items: rows.slice(0,request.limit).map((row) => ({
      entity:ref(text(row.kind) as WorkspaceKindV2,row.id,row.label),
      description:row.description === null ? null : text(row.description),
    })),
    nextOffset:nextOffset(rows.length,request.offset,request.limit),
  };
}

/** Backend-only application service. The HTTP boundary owns authentication and authorization. */
export function createRelationalWorkspaceV2(database: GradebookPostgresWritePortV1) {
  return {
    async execute(input: unknown): Promise<OperationalWorkspaceResponseV2> {
      if (!isOperationalWorkspaceRequestV2(input)) return {contractVersion:2,state:'invalid-request'};
      if (!('transaction' in database) || typeof database.transaction !== 'function') throw new Error('workspace-transaction-unavailable');
      const request = {...input}; // Only scalar values; caller mutation cannot change the scope while waiting.
      return (database as Database).transaction(async (db) => {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', []);
        const response = await execute(db, request);
        if (!isOperationalWorkspaceResponseV2(response)) throw new Error('invalid-workspace-response');
        return response;
      });
    },
  };
}
