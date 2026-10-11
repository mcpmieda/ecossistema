import {
  lockResetWriterV1,
  recordImportResetWriteV1,
} from '../../../student-portal/integration/year-reset/writer-v1';
import type {
  GradebookImportCellV9,
  GradebookImportOfferV9,
  GradebookImportTermV9,
  GradebookImportPersistenceRequestV9,
  GradebookImportPersistenceResponseV9,
  GradebookNotesImportRequestV9,
  GradebookRelationImportRequestV9,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import {
  resolveRelationalClosingUpdateV9,
  type RelationalClosingPatchV9,
  type RelationalClosingStateV9,
} from './import-relational-closing-v9';
import {
  isRelationalInstrumentActiveV9,
  resolveRelationalNoteMutationV9,
} from './import-relational-instrument-decisions-v9';
import {
  buildRelationPlanV9,
  normalizeRelationNameV9,
  RelationPlanErrorV9,
  relationBindingKeyV9,
  type ExistingRelationBindingV9,
  type RelationComponentV9,
  type RelationMovementWarningV9,
  type RelationPlanV9,
  type RelationSourceBindingV9,
} from './import-relational-relation-plan-v9';
import { buildRelationalImportInstrumentPlanV11 } from './import-relational-instrument-plan-v11';
import { materializeRelationalImportInstrumentPlanV11 } from '../../persistence/postgres/relational-import-instrument-batch-v11';
import {
  IMPORT_OFFER_READ_BLOCK_SIZE_V11,
  loadRelationalImportReadSetV11,
  resolveRelationalImportCatalogV11,
  type ImportInstrumentStateV11,
  type ImportOfferReadStateV11,
} from '../../persistence/postgres/relational-import-read-set-v11';
import type { GradebookPostgresScalarV1 } from '../../persistence/postgres/postgres-database-v1';
import type { GradebookPostgresWritePortV1 } from '../../persistence/postgres/postgres-database-v1';

interface TransactionDatabaseV9 extends GradebookPostgresWritePortV1 {
  transaction<T>(operation: (database: GradebookPostgresWritePortV1) => Promise<T>): Promise<T>;
}

type Row = Record<string, unknown>;

type ImportStateV9 = {
  importId: number | null;
  writes: number;
  academicWrites: number;
  sourceStudentIds: Set<number>;
  globalAcademicChange: boolean;
  warnings: readonly RelationMovementWarningV9[];
};

class RelationalImportErrorV9 extends Error {
  constructor(
    readonly state: 'blocked' | 'conflict' | 'review-required',
    readonly reason: string,
  ) {
    super(reason);
  }
}

function dbNameKey(value: string): string {
  return value.trim().toLocaleLowerCase('pt-BR');
}

function classKey(value: string): string {
  return value.trim().toUpperCase();
}

function asNumber(value: unknown, label: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`invalid-${label}`);
  return number;
}

async function first<T extends Row>(
  database: GradebookPostgresWritePortV1,
  query: string,
  values: readonly GradebookPostgresScalarV1[] = [],
): Promise<T | null> {
  return (await database.executeNative<T>(query, values)).rows[0] ?? null;
}

async function all<T extends Row>(
  database: GradebookPostgresWritePortV1,
  query: string,
  values: readonly GradebookPostgresScalarV1[] = [],
): Promise<readonly T[]> {
  return database.query<T>(query, values);
}

async function run(
  database: GradebookPostgresWritePortV1,
  query: string,
  values: readonly GradebookPostgresScalarV1[] = [],
): Promise<number> {
  return (await database.executeNative(query, values)).changes;
}

async function academicRun(
  database: GradebookPostgresWritePortV1,
  state: ImportStateV9,
  query: string,
  values: readonly GradebookPostgresScalarV1[],
): Promise<number> {
  const changes = await run(database, query, values);
  state.academicWrites += changes;
  return changes;
}

async function lockAcademicYear(database: GradebookPostgresWritePortV1, ano: number): Promise<void> {
  await lockResetWriterV1(database, ano);
}

function summary(writes: number, importWritten: boolean) {
  const committedWrites = {
    logicalSources: 0,
    sourceFileVersions: 0,
    importBatchVersions: importWritten ? 1 : 0,
    assessmentComponentVersions: 0,
    academicRecordVersions: Math.max(0, writes - (importWritten ? 1 : 0)),
    logicalSourceRecordAssociationVersions: 0,
    total: writes,
  } as const;
  return {
    assessmentDefinitions: { total: 0, resolved: 0, blocked: 0 },
    assessmentComponents: { unchanged: 0, new: 0, changed: 0, blocked: 0 },
    academicRecords: { unchanged: 0, new: 0, changed: 0, missingFromNewSource: 0, blocked: 0 },
    plannedWrites: committedWrites,
    committedWrites,
  } as const;
}

async function ensureImport(
  database: GradebookPostgresWritePortV1,
  state: ImportStateV9,
  request: GradebookImportPersistenceRequestV9,
  tipo: 1 | 2,
): Promise<number> {
  if (state.importId !== null) return state.importId;
  const row = await first<{ id: unknown }>(
    database,
    `INSERT INTO gradebook.importacao (ano, tipo, arquivo, hash)
     VALUES ($1, $2, $3, decode($4, 'hex'))
     RETURNING id`,
    [request.ano, tipo, request.manifest.fileName, request.manifest.sha256],
  );
  if (!row) throw new Error('importacao-insert-without-id');
  state.importId = asNumber(row.id, 'import-id');
  state.writes++;
  return state.importId;
}

async function changedRun(
  database: GradebookPostgresWritePortV1,
  state: ImportStateV9,
  request: GradebookImportPersistenceRequestV9,
  tipo: 1 | 2,
  query: string,
  values: readonly GradebookPostgresScalarV1[],
  affectsAcademic = true,
): Promise<number> {
  // request/tipo stay in this compatibility helper signature; current-state writes
  // no longer create import ledger rows unless a retained history explicitly needs one.
  void request;
  void tipo;
  const changes = await run(database, query, values);
  state.writes += changes;
  if (affectsAcademic) state.academicWrites += changes;
  return changes;
}

async function changedFirst<T extends Row>(
  database: GradebookPostgresWritePortV1,
  state: ImportStateV9,
  request: GradebookImportPersistenceRequestV9,
  tipo: 1 | 2,
  query: string,
  values: readonly GradebookPostgresScalarV1[],
  affectsAcademic = true,
): Promise<T> {
  void request;
  void tipo;
  const row = await first<T>(database, query, values);
  if (!row) throw new Error('write-without-returning-row');
  state.writes++;
  if (affectsAcademic) state.academicWrites++;
  return row;
}

interface ExistingClassV9 {
  readonly id: number;
  readonly codigo: string;
  readonly nome: string;
  readonly etapa: number;
  readonly turno: string;
}

async function resolveRelationClasses(
  database: GradebookPostgresWritePortV1,
  state: ImportStateV9,
  request: GradebookRelationImportRequestV9,
): Promise<ReadonlyMap<string, ExistingClassV9>> {
  const result = new Map<string, ExistingClassV9>();
  for (const source of request.turmas) {
    const current = await first<Row>(
      database,
      `SELECT id, codigo, nome, etapa, turno
       FROM gradebook.turma
       WHERE ano = $1 AND upper(btrim(codigo)) = upper(btrim($2))`,
      [request.ano, source.codigo],
    );
    if (!current) {
      const created = await changedFirst<Row>(
        database,
        state,
        request,
        1,
        `INSERT INTO gradebook.turma (ano, codigo, nome, etapa, turno) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, codigo, nome, etapa, turno`,
        [
          request.ano,
          source.codigo.trim().toUpperCase(),
          source.nome.trim(),
          source.etapa,
          source.turno.trim(),
        ],
      );
      result.set(classKey(source.codigo), {
        id: asNumber(created.id, 'turma-id'),
        codigo: String(created.codigo),
        nome: String(created.nome),
        etapa: asNumber(created.etapa, 'etapa'),
        turno: String(created.turno),
      });
      continue;
    }
    const id = asNumber(current.id, 'turma-id');
    const expectedCode = source.codigo.trim().toUpperCase();
    const expectedName = source.nome.trim();
    const expectedTurn = source.turno.trim();
    const currentStage = asNumber(current.etapa, 'etapa');
    if (
      String(current.codigo) !== expectedCode ||
      String(current.nome) !== expectedName ||
      currentStage !== source.etapa ||
      String(current.turno) !== expectedTurn
    ) {
      await changedRun(
        database,
        state,
        request,
        1,
        `UPDATE gradebook.turma
         SET codigo = $1, nome = $2, etapa = $3, turno = $4
         WHERE id = $5`,
        [expectedCode, expectedName, source.etapa, expectedTurn, id],
      );
    }
    result.set(classKey(source.codigo), {
      id,
      codigo: expectedCode,
      nome: expectedName,
      etapa: source.etapa,
      turno: expectedTurn,
    });
  }
  return result;
}

function parseExistingRelationBindingsV9(
  rows: readonly Row[],
): readonly ExistingRelationBindingV9[] {
  return rows.map((row) => ({
    turmaId: asNumber(row.turma_id, 'turma-id'),
    numero: asNumber(row.numero, 'numero'),
    alunoId: asNumber(row.aluno_id, 'aluno-id'),
    situacao: row.situacao === null ? null : asNumber(row.situacao, 'situacao'),
    turmaRelacionadaId:
      row.turma_relacionada_id === null
        ? null
        : asNumber(row.turma_relacionada_id, 'turma-relacionada-id'),
    nome: String(row.nome),
    studentUid: String(row.student_uid),
  }));
}

function relationPlanOrThrowV9(
  request: GradebookRelationImportRequestV9,
  classes: ReadonlyMap<string, ExistingClassV9>,
  existing: readonly ExistingRelationBindingV9[],
) {
  try {
    return buildRelationPlanV9(request, classes, existing);
  } catch (cause) {
    if (cause instanceof RelationPlanErrorV9) {
      throw new RelationalImportErrorV9(cause.state, cause.reason);
    }
    throw cause;
  }
}

function isDatabaseTrueV9(value: unknown): boolean {
  return value === true || value === 1;
}

/** Compares the complete previous state before any student name or binding is changed. */
async function assertRelationIdentityEvidenceV9(
  database: GradebookPostgresWritePortV1,
  request: GradebookRelationImportRequestV9,
  plan: RelationPlanV9,
): Promise<void> {
  const existing = [...plan.existingByBinding.values()];
  const names = new Map<string, Set<number>>();
  const identities = new Map<number, string>();
  for (const binding of existing) {
    if (!binding.studentUid || binding.studentUid === 'undefined') throw new Error('relation-student-identity-missing');
    identities.set(binding.alunoId, binding.studentUid);
    const key = normalizeRelationNameV9(binding.nome);
    const values = names.get(key) ?? new Set<number>();
    values.add(binding.alunoId);
    names.set(key, values);
  }
  const observations = await all<Row>(database, `SELECT o.source_id::text,o.name_key,o.birth_date::text,o.inep_key,
      l.student_uid::text,c.gradebook_class_id,(o.id=s.current_observation_id) AS current_observation,
      (p.observation_id=o.id AND NOT p.review_required AND NOT l.review_required) AS selected_profile
    FROM gradebook.student_source_observation_v1 o
    JOIN gradebook.student_source_record_v1 s ON s.id=o.source_id AND s.academic_year=o.academic_year
    JOIN gradebook.student_report_class_v1 c ON c.id=o.report_class_id AND c.academic_year=o.academic_year
    LEFT JOIN gradebook.student_source_link_v1 l ON l.source_id=o.source_id AND l.academic_year=o.academic_year
    LEFT JOIN gradebook.student_report_profile_v1 p ON p.student_uid=l.student_uid AND p.academic_year=l.academic_year
    WHERE o.academic_year=$1`, [request.ano]);
  const decisions = await all<Row>(database, `SELECT DISTINCT ON(source_id,student_uid)
      source_id::text,student_uid::text,action
    FROM gradebook.student_reconciliation_decision_v1
    WHERE academic_year=$1 AND source_id IS NOT NULL AND student_uid IS NOT NULL
      AND action IN ('reject','separate','release','associate','confirm')
    ORDER BY source_id,student_uid,sequence DESC,recorded_at DESC,id DESC`, [request.ano]);
  const rejected = new Set(decisions.filter((row) => row.action === 'reject' || row.action === 'separate')
    .map((row) => `${String(row.source_id)}:${String(row.student_uid)}`));
  const observationsByName = new Map<string, Row[]>();
  const profilesByUid = new Map<string, Row>();
  const identitiesByInepBirth = new Map<string, Set<string>>();
  for (const row of observations) {
    const key = String(row.name_key);
    const matching = observationsByName.get(key) ?? [];
    matching.push(row);
    observationsByName.set(key, matching);
    if (isDatabaseTrueV9(row.selected_profile) && typeof row.student_uid === 'string') profilesByUid.set(row.student_uid, row);
    if (isDatabaseTrueV9(row.current_observation) && typeof row.inep_key === 'string' && typeof row.student_uid === 'string') {
      const personalKey = `${row.inep_key}:${String(row.birth_date)}`;
      const uids = identitiesByInepBirth.get(personalKey) ?? new Set<string>();
      uids.add(row.student_uid);
      identitiesByInepBirth.set(personalKey, uids);
    }
  }
  for (const component of plan.components) {
    const alunoId = component.seedAlunoId;
    if (alunoId === null) continue;
    const uid = identities.get(alunoId);
    if (!uid) throw new Error('relation-student-identity-missing');
    const profile = profilesByUid.get(uid);
    for (const item of component.items) {
      const key = normalizeRelationNameV9(item.nome);
      const current = plan.existingByBinding.get(relationBindingKeyV9(item.turmaId, item.numero));
      const nameChanged = current !== undefined && normalizeRelationNameV9(current.nome) !== key;
      const movement = component.items.length > 1 || item.relatedTurmaId !== null;
      if (!nameChanged && !movement) continue;
      const academicConflict = nameChanged && [...(names.get(key) ?? [])].some((id) => id !== alunoId);
      const candidates = observationsByName.get(key) ?? [];
      const reportConflict = candidates.some((row) =>
        (row.student_uid !== null && row.student_uid !== uid) ||
        rejected.has(`${String(row.source_id)}:${uid}`) ||
        (isDatabaseTrueV9(row.current_observation) && profile && row.gradebook_class_id === item.turmaId && row.birth_date !== profile.birth_date) ||
        (isDatabaseTrueV9(row.current_observation) && row.inep_key !== null && [...(identitiesByInepBirth.get(`${String(row.inep_key)}:${String(row.birth_date)}`) ?? [])]
          .some((otherUid) => otherUid !== uid)),
      );
      if (academicConflict || reportConflict) {
        throw new RelationalImportErrorV9('review-required', 'A posição ou movimentação tem evidências de outra identidade. Confira os alunos.');
      }
    }
  }
}

async function resolveRelationComponentStudentV9(
  database: GradebookPostgresWritePortV1,
  state: ImportStateV9,
  request: GradebookRelationImportRequestV9,
  component: RelationComponentV9,
): Promise<number> {
  let alunoId = component.seedAlunoId;
  if (alunoId === null) {
    const created = await changedFirst<Row>(
      database,
      state,
      request,
      1,
      'INSERT INTO gradebook.aluno (ano, nome) VALUES ($1, $2) RETURNING id',
      [request.ano, component.preferred.nome],
    );
    return asNumber(created.id, 'aluno-id');
  }

  const current = await first<Row>(
    database,
    'SELECT nome FROM gradebook.aluno WHERE id = $1 AND ano = $2',
    [alunoId, request.ano],
  );
  if (!current) {
    throw new RelationalImportErrorV9(
      'conflict',
      `Aluno existente fora do ano ${request.ano}.`,
    );
  }
  if (String(current.nome) !== component.preferred.nome) {
    await changedRun(
      database,
      state,
      request,
      1,
      'UPDATE gradebook.aluno SET nome = $1 WHERE id = $2',
      [component.preferred.nome, alunoId],
    );
  }
  return alunoId;
}

async function persistRelationBindingV9(
  database: GradebookPostgresWritePortV1,
  state: ImportStateV9,
  request: GradebookRelationImportRequestV9,
  item: RelationSourceBindingV9,
  alunoId: number,
  current: ExistingRelationBindingV9 | undefined,
): Promise<void> {
  if (!current) {
    await changedRun(
      database,
      state,
      request,
      1,
      `INSERT INTO gradebook.vinculo (ano, turma_id, numero, aluno_id, situacao, turma_relacionada_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [request.ano, item.turmaId, item.numero, alunoId, item.situacao, item.relatedTurmaId],
    );
    return;
  }
  if (current.alunoId !== alunoId) {
    throw new RelationalImportErrorV9(
      'conflict',
      `Vínculo ${item.turmaCode}/${item.numero} pertence a outro aluno.`,
    );
  }
  if (current.situacao === item.situacao && current.turmaRelacionadaId === item.relatedTurmaId) {
    return;
  }

  const importId = await ensureImport(database, state, request, 1);
  await run(
    database,
    `INSERT INTO gradebook.vinculo_historico (importacao_id, turma_id, numero, situacao_anterior, situacao_nova, turma_rel_anterior, turma_rel_nova) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      importId,
      item.turmaId,
      item.numero,
      current.situacao,
      item.situacao,
      current.turmaRelacionadaId,
      item.relatedTurmaId,
    ],
  );
  state.writes++;
  state.writes += await academicRun(
    database,
    state,
    `UPDATE gradebook.vinculo SET situacao = $1, turma_relacionada_id = $2
     WHERE turma_id = $3 AND numero = $4`,
    [item.situacao, item.relatedTurmaId, item.turmaId, item.numero],
  );
}

async function persistRelation(
  database: GradebookPostgresWritePortV1,
  request: GradebookRelationImportRequestV9,
  state: ImportStateV9,
): Promise<void> {
  const year = await first<Row>(database, 'SELECT ano FROM gradebook.ano_letivo WHERE ano = $1', [
    request.ano,
  ]);
  if (!year) {
    await changedRun(
      database,
      state,
      request,
      1,
      `INSERT INTO gradebook.ano_letivo (ano, minimo_aprovacao, max_componentes_conselho) VALUES ($1, 60000, 2)`,
      [request.ano],
    );
  }

  const classes = await resolveRelationClasses(database, state, request);
  const existingRows = await all<Row>(
    database,
    `SELECT v.turma_id, v.numero, v.aluno_id, v.situacao, v.turma_relacionada_id, a.nome, a.student_uid::text
     FROM gradebook.vinculo v
     JOIN gradebook.aluno a ON a.id = v.aluno_id
     WHERE v.ano = $1`,
    [request.ano],
  );
  const plan = relationPlanOrThrowV9(
    request,
    classes,
    parseExistingRelationBindingsV9(existingRows),
  );
  await assertRelationIdentityEvidenceV9(database, request, plan);
  state.warnings = plan.warnings;

  const alunoForSource = new Map<number, number>();
  for (const component of plan.components) {
    const alunoId = await resolveRelationComponentStudentV9(database, state, request, component);
    for (const item of component.items) alunoForSource.set(item.index, alunoId);
  }

  for (const item of plan.orderedSource) {
    const alunoId = alunoForSource.get(item.index);
    if (alunoId === undefined) throw new Error('component-aluno-missing');
    const current = plan.existingByBinding.get(
      relationBindingKeyV9(item.turmaId, item.numero),
    );
    await persistRelationBindingV9(database, state, request, item, alunoId, current);
  }
}

async function resolveProfessor(
  database: GradebookPostgresWritePortV1,
  state: ImportStateV9,
  request: GradebookNotesImportRequestV9,
): Promise<number> {
  const current = await first<Row>(
    database,
    `SELECT id, nome FROM gradebook.professor WHERE ano = $1 AND lower(btrim(nome)) = lower(btrim($2))`,
    [request.ano, request.professor],
  );
  if (!current) {
    const created = await changedFirst<Row>(
      database,
      state,
      request,
      2,
      `INSERT INTO gradebook.professor (ano, nome) VALUES ($1, $2) RETURNING id`,
      [request.ano, request.professor.trim()],
      false,
    );
    return asNumber(created.id, 'professor-id');
  }
  const id = asNumber(current.id, 'professor-id');
  if (String(current.nome) !== request.professor.trim()) {
    await changedRun(
      database,
      state,
      request,
      2,
      `UPDATE gradebook.professor SET nome = $1 WHERE id = $2`,
      [request.professor.trim(), id],
      false,
    );
  }
  return id;
}

async function resolveDiscipline(
  database: GradebookPostgresWritePortV1,
  state: ImportStateV9,
  request: GradebookNotesImportRequestV9,
  name: string,
): Promise<number> {
  const current = await first<Row>(
    database,
    `SELECT id, nome FROM gradebook.disciplina WHERE ano = $1 AND lower(btrim(nome)) = lower(btrim($2))`,
    [request.ano, name],
  );
  if (!current) {
    const created = await changedFirst<Row>(
      database,
      state,
      request,
      2,
      `INSERT INTO gradebook.disciplina (ano, nome) VALUES ($1, $2) RETURNING id`,
      [request.ano, name.trim()],
    );
    return asNumber(created.id, 'disciplina-id');
  }
  const id = asNumber(current.id, 'disciplina-id');
  if (String(current.nome) !== name.trim()) {
    // A shared subject label may affect classes outside this file's offers.
    state.globalAcademicChange = true;
    await changedRun(
      database,
      state,
      request,
      2,
      `UPDATE gradebook.disciplina SET nome = $1 WHERE id = $2`,
      [name.trim(), id],
    );
  }
  return id;
}

type InstrumentStateV9 = ImportInstrumentStateV11;

interface OfferInstrumentReconciliationV9 {
  readonly database: GradebookPostgresWritePortV1;
  readonly state: ImportStateV9;
  readonly request: GradebookNotesImportRequestV9;
  readonly offer: GradebookImportOfferV9;
  readonly ofertaId: number;
  readonly turmaId: number;
  readonly bindings: ReadonlyMap<string, number>;
  readonly existingInstruments: Map<string, InstrumentStateV9>;
  readonly observedInstruments: Set<number>;
  readonly notes: Map<string, number | null>;
}

async function reconcileInstrumentNotesV9(
  scope: OfferInstrumentReconciliationV9,
  term: GradebookImportTermV9,
  column: number,
  instrument: InstrumentStateV9,
  hasValue: boolean,
): Promise<void> {
  const {
    database,
    state,
    request,
    offer,
    turmaId,
    bindings,
    observedInstruments,
    notes,
  } = scope;
  const slot = term.instrumentos[column]![0];
  const activeInstrument = isRelationalInstrumentActiveV9({
    slot,
    metadata: instrument,
    hasValue,
    observed: observedInstruments.has(instrument.id),
  });
  const retainBlank = request.granularObservationVersion === 1 && activeInstrument;

  for (const [numero, values] of term.alunos) {
    const alunoId = bindings.get(`${turmaId}:${numero}`);
    if (alunoId === undefined) {
      throw new RelationalImportErrorV9(
        'blocked',
        `Aluno número ${numero} não existe na turma ${offer.turmaCodigo}. Importe a Relação primeiro.`,
      );
    }
    const noteKey = `${instrument.id}:${alunoId}`;
    const mutation = resolveRelationalNoteMutationV9({
      target: values[column]!,
      previous: notes.get(noteKey) ?? null,
      observed: notes.has(noteKey),
      retainBlank,
    });

    if (mutation.kind === 'preserve') continue;
    if (mutation.kind === 'delete') {
      state.writes += await academicRun(
        database,
        state,
        'DELETE FROM gradebook.nota WHERE instrumento_id = $1 AND aluno_id = $2',
        [instrument.id, alunoId],
      );
      notes.delete(noteKey);
      continue;
    }
    if (mutation.kind === 'insert') {
      state.writes += await academicRun(
        database,
        state,
        'INSERT INTO gradebook.nota (instrumento_id, aluno_id, valor) VALUES ($1, $2, $3)',
        [instrument.id, alunoId, mutation.value],
      );
      notes.set(noteKey, mutation.value);
      continue;
    }
    state.writes += await academicRun(
      database,
      state,
      'UPDATE gradebook.nota SET valor = $1 WHERE instrumento_id = $2 AND aluno_id = $3',
      [mutation.value, instrument.id, alunoId],
    );
    notes.set(noteKey, mutation.value);
  }
}

async function processOffer(
  database: GradebookPostgresWritePortV1,
  state: ImportStateV9,
  request: GradebookNotesImportRequestV9,
  offer: GradebookImportOfferV9,
  turmaId: number,
  ofertaId: number,
  bindings: ReadonlyMap<string, number>,
  readState: ImportOfferReadStateV11,
): Promise<void> {
  const { instruments: existingInstruments, notes, observedInstruments, closing } = readState;
  // A repeated SQL identity can occur under collation differences. Refresh only at the
  // offer boundary; instrument activity within this offer uses its original observations.
  observedInstruments.clear();
  for (const key of notes.keys()) observedInstruments.add(Number(key.split(':')[0]));
  const plan = buildRelationalImportInstrumentPlanV11({
    ofertaId,
    offer,
    granularObservationVersion: request.granularObservationVersion,
    instruments: existingInstruments,
  });
  const instrumentWrites = await materializeRelationalImportInstrumentPlanV11(
    database,
    request.ano,
    plan,
    readState,
  );
  state.writes += instrumentWrites;
  state.academicWrites += instrumentWrites;
  const scope: OfferInstrumentReconciliationV9 = {
    database,
    state,
    request,
    offer,
    ofertaId,
    turmaId,
    bindings,
    existingInstruments,
    observedInstruments,
    notes,
  };
  for (const entry of plan.entries) {
    const instrument = existingInstruments.get(entry.key);
    if (!instrument) throw new Error('gradebook-import-planned-instrument-unresolved');
    await reconcileInstrumentNotesV9(scope, entry.term, entry.column, instrument, entry.hasValue);
  }

  const patches = new Map<number, RelationalClosingPatchV9>();
  for (const term of offer.trimestres) {
    for (const [numero, , am] of term.alunos) {
      const alunoId = bindings.get(`${turmaId}:${numero}`);
      if (alunoId === undefined)
        throw new RelationalImportErrorV9(
          'blocked',
          `Aluno número ${numero} não existe na turma ${offer.turmaCodigo}.`,
        );
      const patch = patches.get(alunoId) ?? {};
      const ams: [GradebookImportCellV9?, GradebookImportCellV9?, GradebookImportCellV9?] =
        patch.am ? [...patch.am] : [];
      ams[term.trimestre - 1] = am;
      patches.set(alunoId, { ...patch, am: ams });
    }
  }
  for (const [numero, rec1, rec2, rec3, u] of offer.recuperacao ?? []) {
    const alunoId = bindings.get(`${turmaId}:${numero}`);
    if (alunoId === undefined)
      throw new RelationalImportErrorV9(
        'blocked',
        `Aluno REC número ${numero} não existe na turma ${offer.turmaCodigo}.`,
      );
    const patch = patches.get(alunoId) ?? {};
    patches.set(alunoId, { ...patch, rec: [rec1, rec2, rec3], u });
  }

  for (const [alunoId, patch] of patches) {
    const current: RelationalClosingStateV9 = closing.get(alunoId) ?? {
      exists: false,
      am: [null, null, null],
      rec: [null, null, null],
      ncMask: 0,
      rrMask: 0,
      u: null,
    };
    const { next, changes, empty } = resolveRelationalClosingUpdateV9(current, patch);
    if (changes.length === 0) continue;
    const importId = await ensureImport(database, state, request, 2);
    for (const change of changes) {
      state.writes += await run(
        database,
        `INSERT INTO gradebook.fechamento_historico (importacao_id, oferta_id, aluno_id, campo, valor_anterior, valor_novo, estado_anterior, estado_novo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          importId,
          ofertaId,
          alunoId,
          change.campo,
          change.oldValue,
          change.newValue,
          change.oldState,
          change.newState,
        ],
      );
    }
    if (empty && current.exists) {
      state.writes += await academicRun(
        database,
        state,
        `DELETE FROM gradebook.fechamento WHERE oferta_id = $1 AND aluno_id = $2`,
        [ofertaId, alunoId],
      );
      closing.delete(alunoId);
      continue;
    }
    if (empty) continue;
    if (!current.exists) {
      state.writes += await academicRun(
        database,
        state,
        `INSERT INTO gradebook.fechamento (oferta_id, aluno_id, am1_fonte, am2_fonte, am3_fonte, rec1, rec2, rec3, rec_nc_mask, rec_rr_mask, u_fonte) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          ofertaId,
          alunoId,
          next.am[0],
          next.am[1],
          next.am[2],
          next.rec[0],
          next.rec[1],
          next.rec[2],
          next.ncMask,
          next.rrMask,
          next.u,
        ],
      );
    } else {
      state.writes += await academicRun(
        database,
        state,
        `UPDATE gradebook.fechamento
         SET am1_fonte = $1, am2_fonte = $2, am3_fonte = $3, rec1 = $4, rec2 = $5, rec3 = $6, rec_nc_mask = $7, rec_rr_mask = $8, u_fonte = $9
         WHERE oferta_id = $10 AND aluno_id = $11`,
        [
          next.am[0],
          next.am[1],
          next.am[2],
          next.rec[0],
          next.rec[1],
          next.rec[2],
          next.ncMask,
          next.rrMask,
          next.u,
          ofertaId,
          alunoId,
        ],
      );
    }
    closing.set(alunoId, { ...next, exists: true });
  }
}

async function persistNotes(
  database: GradebookPostgresWritePortV1,
  request: GradebookNotesImportRequestV9,
  state: ImportStateV9,
): Promise<void> {
  const year = await first<Row>(database, `SELECT ano FROM gradebook.ano_letivo WHERE ano = $1`, [
    request.ano,
  ]);
  if (!year) {
    throw new RelationalImportErrorV9('blocked', `Relação ${request.ano} ainda não foi importada.`);
  }
  const classRows = await all<Row>(
    database,
    `SELECT id, codigo FROM gradebook.turma WHERE ano = $1`,
    [request.ano],
  );
  const classes = new Map<string, number>();
  for (const row of classRows)
    classes.set(classKey(String(row.codigo)), asNumber(row.id, 'turma-id'));
  const bindingRows = await all<Row>(
    database,
    `SELECT turma_id, numero, aluno_id FROM gradebook.vinculo WHERE ano = $1`,
    [request.ano],
  );
  const bindings = new Map<string, number>();
  const classStudents = new Map<number, Set<number>>();
  for (const row of bindingRows) {
    const turmaId = asNumber(row.turma_id, 'turma-id');
    const numero = asNumber(row.numero, 'numero');
    const alunoId = asNumber(row.aluno_id, 'aluno-id');
    bindings.set(`${turmaId}:${numero}`, alunoId);
    const students = classStudents.get(turmaId) ?? new Set<number>();
    students.add(alunoId);
    classStudents.set(turmaId, students);
  }
  const professorId = await resolveProfessor(database, state, request);
  const seen = new Set<string>();
  const prepared: Array<{ sourceIndex: number; offer: GradebookImportOfferV9; turmaId: number }> =
    [];
  for (const [sourceIndex, offer] of request.ofertas.entries()) {
    const turmaId = classes.get(classKey(offer.turmaCodigo));
    if (turmaId === undefined) {
      throw new RelationalImportErrorV9(
        'blocked',
        `Turma ${offer.turmaCodigo} não existe na Relação ${request.ano}.`,
      );
    }
    const key = `${turmaId}:${dbNameKey(offer.disciplina)}`;
    if (seen.has(key))
      throw new RelationalImportErrorV9(
        'blocked',
        `Oferta duplicada: ${offer.turmaCodigo} / ${offer.disciplina}.`,
      );
    seen.add(key);
    prepared.push({ sourceIndex, offer, turmaId });
  }
  const catalog = await resolveRelationalImportCatalogV11(
    database,
    request.ano,
    professorId,
    prepared.map(({ sourceIndex, offer, turmaId }) => ({
      sourceIndex,
      turmaId,
      name: offer.disciplina,
    })),
    async (name) => {
      const before = state.academicWrites;
      const id = await resolveDiscipline(database, state, request, name);
      return { id, changed: state.academicWrites > before };
    },
  );
  state.writes += catalog.writes;
  state.academicWrites += catalog.writes;
  state.globalAcademicChange ||= catalog.globalAcademicChange;
  for (let offset = 0; offset < prepared.length; offset += IMPORT_OFFER_READ_BLOCK_SIZE_V11) {
    const block = prepared.slice(offset, offset + IMPORT_OFFER_READ_BLOCK_SIZE_V11);
    const offerIds = [
      ...new Set(block.map(({ sourceIndex }) => catalog.offers.get(sourceIndex)!.ofertaId)),
    ];
    const readSet = await loadRelationalImportReadSetV11(database, request.ano, offerIds);
    for (const { sourceIndex, offer, turmaId } of block) {
      const resolved = catalog.offers.get(sourceIndex)!;
      const before = state.academicWrites;
      await processOffer(
        database,
        state,
        request,
        offer,
        turmaId,
        resolved.ofertaId,
        bindings,
        readSet.get(resolved.ofertaId)!,
      );
      // Metadata changes can affect every student in the source class, including
      // observations outside the supplied student slice. Keep the Portal scope conservative.
      if (resolved.catalogChanged || state.academicWrites > before) {
        for (const studentId of classStudents.get(turmaId) ?? [])
          state.sourceStudentIds.add(studentId);
      }
    }
  }
}

function transactionDatabase(database: GradebookPostgresWritePortV1): TransactionDatabaseV9 {
  if (
    !('transaction' in database) ||
    typeof (database as { transaction?: unknown }).transaction !== 'function'
  ) {
    throw new Error('gradebook-relational-import-requires-postgres');
  }
  return database as TransactionDatabaseV9;
}

export function createGradebookRelationalImportServiceV9(database: GradebookPostgresWritePortV1) {
  return {
    async execute(
      request: GradebookImportPersistenceRequestV9,
    ): Promise<GradebookImportPersistenceResponseV9> {
      try {
        const result = await transactionDatabase(database).transaction(async (transaction) => {
          await lockAcademicYear(transaction, request.ano);
          const state: ImportStateV9 = {
            importId: null,
            writes: 0,
            academicWrites: 0,
            sourceStudentIds: new Set(),
            globalAcademicChange: false,
            warnings: [],
          };
          if (request.operation === 'persist-relacao')
            await persistRelation(transaction, request, state);
          else await persistNotes(transaction, request, state);
          if (state.writes > 0)
            await recordImportResetWriteV1(
              transaction,
              request.ano,
              request.operation === 'persist-relacao' ? 'relation' : 'marks',
              {
                changed: state.academicWrites > 0,
                studentIds: state.globalAcademicChange ? [] : [...state.sourceStudentIds],
              },
            );
          return state;
        });
        return {
          transportVersion: 9,
          state: result.writes === 0 ? 'no-changes' : 'applied',
          summary: summary(result.writes, result.importId !== null),
          ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        };
      } catch (cause) {
        if (cause instanceof RelationalImportErrorV9) {
          return { transportVersion: 9, state: cause.state, reason: cause.reason };
        }
        const code =
          cause !== null && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
        if (code === '23505' || code === '23503' || code === '23514') {
          return {
            transportVersion: 9,
            state: 'conflict',
            reason:
              'O estado acadêmico mudou ou violou uma regra de integridade durante a importação.',
          };
        }
        throw cause;
      }
    },
  };
}
