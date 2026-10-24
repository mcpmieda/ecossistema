import type { GradebookPostgresWritePortV1 } from './postgres-database-v1';
import { postgresJsonTextV1 } from './postgres-values-v1';
import { jsonRecordChunksV1, serializeJsonRecordV1 } from './json-record-chunks-v1';
import type { RelationalClosingStateV9 } from '../../application/import/import-relational-closing-v9';
import { trimCharsV1 } from '../../../../shared/trim-chars-v1';

export const IMPORT_OFFER_READ_BLOCK_SIZE_V11 = 32;
type Row = Record<string, unknown>;
export interface ImportInstrumentStateV11 {
  readonly id: number;
  maximo: number | null;
  descricao: string | null;
}
export interface ImportOfferReadStateV11 {
  readonly instruments: Map<string, ImportInstrumentStateV11>;
  readonly notes: Map<string, number | null>;
  readonly observedInstruments: Set<number>;
  readonly closing: Map<number, RelationalClosingStateV9>;
}

export function importReadIntegerV11(value: unknown, label: string): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+$/u.test(value)))
    throw new Error(`gradebook-import-invalid-${label}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (label.endsWith('-id') && number < 1))
    throw new Error(`gradebook-import-invalid-${label}`);
  return number;
}
function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : importReadIntegerV11(value, label);
}
function nullableText(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new Error('gradebook-import-invalid-description');
}
export function assertImportChangesV11(changes: number, expected: number): void {
  if (!Number.isSafeInteger(changes) || changes < 0 || changes !== expected)
    throw new Error('gradebook-import-batch-cardinality-mismatch');
}

export async function loadRelationalImportReadSetV11(
  database: GradebookPostgresWritePortV1,
  ano: number,
  offerIds: readonly number[],
): Promise<Map<number, ImportOfferReadStateV11>> {
  const result = new Map<number, ImportOfferReadStateV11>();
  for (const id of offerIds) {
    importReadIntegerV11(id, 'offer-id');
    if (result.has(id)) throw new Error('gradebook-import-duplicate-offer-id');
    result.set(id, {
      instruments: new Map(),
      notes: new Map(),
      observedInstruments: new Set(),
      closing: new Map(),
    });
  }
  if (offerIds.length === 0) return result;
  const values = [ano, postgresJsonTextV1(JSON.stringify(offerIds))];
  const offersSql = `SELECT value::bigint AS id FROM jsonb_array_elements_text($2::text::jsonb)`;
  const instruments = (
    await database.executeNative<Row>(
      `SELECT i.id, i.oferta_id, i.trimestre, i.slot, i.maximo, i.descricao
     FROM gradebook.instrumento i JOIN gradebook.oferta o ON o.id = i.oferta_id
     WHERE o.ano = $1 AND o.id IN (${offersSql}) /* import-read-set:instruments */`,
      values,
    )
  ).rows;
  const scope = (row: Row) => {
    const state = result.get(importReadIntegerV11(row.oferta_id, 'offer-id'));
    if (!state) throw new Error('gradebook-import-read-set-unexpected-offer');
    return state;
  };
  const seenInstrumentIds = new Set<number>();
  for (const row of instruments) {
    const state = scope(row);
    const key = `${importReadIntegerV11(row.trimestre, 'term')}:${importReadIntegerV11(row.slot, 'slot')}`;
    if (state.instruments.has(key))
      throw new Error('gradebook-import-read-set-duplicate-instrument');
    const instrumentId = importReadIntegerV11(row.id, 'instrument-id');
    if (seenInstrumentIds.has(instrumentId))
      throw new Error('gradebook-import-read-set-duplicate-instrument-id');
    seenInstrumentIds.add(instrumentId);
    state.instruments.set(key, {
      id: instrumentId,
      maximo: nullableInteger(row.maximo, 'maximum'),
      descricao: nullableText(row.descricao),
    });
  }
  const notes = (
    await database.executeNative<Row>(
      `SELECT i.oferta_id, n.instrumento_id, n.aluno_id, n.valor
     FROM gradebook.nota n JOIN gradebook.instrumento i ON i.id = n.instrumento_id
     JOIN gradebook.oferta o ON o.id = i.oferta_id
     WHERE o.ano = $1 AND o.id IN (${offersSql}) /* import-read-set:notes */`,
      values,
    )
  ).rows;
  const instrumentIds = new Map(
    [...result].map(([id, state]) => [
      id,
      new Set([...state.instruments.values()].map((instrument) => instrument.id)),
    ]),
  );
  for (const row of notes) {
    const state = scope(row);
    const id = importReadIntegerV11(row.instrumento_id, 'instrument-id');
    const key = `${id}:${importReadIntegerV11(row.aluno_id, 'student-id')}`;
    if (state.notes.has(key)) throw new Error('gradebook-import-read-set-duplicate-note');
    if (!instrumentIds.get(importReadIntegerV11(row.oferta_id, 'offer-id'))!.has(id))
      throw new Error('gradebook-import-read-set-unexpected-instrument');
    state.notes.set(key, nullableInteger(row.valor, 'note'));
    state.observedInstruments.add(id);
  }
  const closings = (
    await database.executeNative<Row>(
      `SELECT f.oferta_id, f.aluno_id, f.am1_fonte, f.am2_fonte, f.am3_fonte,
       f.rec1, f.rec2, f.rec3, f.rec_nc_mask, f.rec_rr_mask, f.u_fonte
     FROM gradebook.fechamento f JOIN gradebook.oferta o ON o.id = f.oferta_id
     WHERE o.ano = $1 AND o.id IN (${offersSql}) /* import-read-set:closings */`,
      values,
    )
  ).rows;
  for (const row of closings) {
    const state = scope(row);
    const id = importReadIntegerV11(row.aluno_id, 'student-id');
    if (state.closing.has(id)) throw new Error('gradebook-import-read-set-duplicate-closing');
    state.closing.set(id, {
      exists: true,
      am: [
        nullableInteger(row.am1_fonte, 'am1'),
        nullableInteger(row.am2_fonte, 'am2'),
        nullableInteger(row.am3_fonte, 'am3'),
      ],
      rec: [
        nullableInteger(row.rec1, 'rec1'),
        nullableInteger(row.rec2, 'rec2'),
        nullableInteger(row.rec3, 'rec3'),
      ],
      ncMask: importReadIntegerV11(row.rec_nc_mask, 'nc-mask'),
      rrMask: importReadIntegerV11(row.rec_rr_mask, 'rr-mask'),
      u: nullableInteger(row.u_fonte, 'u'),
    });
  }
  return result;
}

export interface ImportCatalogSourceV11 {
  readonly sourceIndex: number;
  readonly turmaId: number;
  readonly name: string;
}
export interface ImportResolvedCatalogV11 {
  readonly ofertaId: number;
  readonly disciplinaId: number;
  readonly catalogChanged: boolean;
}

/** SQL owns normalized subject identity. Ambiguous display labels retain V9's sequential resolver. */
export async function resolveRelationalImportCatalogV11(
  database: GradebookPostgresWritePortV1,
  ano: number,
  professorId: number,
  sources: readonly ImportCatalogSourceV11[],
  resolveAmbiguous: (name: string) => Promise<{ id: number; changed: boolean }>,
): Promise<{
  offers: Map<number, ImportResolvedCatalogV11>;
  writes: number;
  globalAcademicChange: boolean;
}> {
  const sourceByIndex = new Map(sources.map((source) => [source.sourceIndex, source]));
  if (sourceByIndex.size !== sources.length)
    throw new Error('gradebook-import-duplicate-source-index');
  let writes = 0;
  let globalAcademicChange = false;
  const disciplineIds = new Map<number, { id: number; changed: boolean }>();
  // V9 reads the raw label with SQL btrim (U+0020 only), then persists JS trim.
  // Other boundary whitespace therefore requires its original source-order
  // resolver for every subject; mixing preloaded creates would change conflicts.
  const needsSequentialWhitespace = sources.some(
    (source) => source.name.trim() !== trimCharsV1(source.name, ' '),
  );
  if (needsSequentialWhitespace) {
    for (const source of [...sources].sort((a, b) => a.sourceIndex - b.sourceIndex)) {
      const resolved = await resolveAmbiguous(source.name);
      disciplineIds.set(source.sourceIndex, {
        id: importReadIntegerV11(resolved.id, 'discipline-id'),
        changed: resolved.changed,
      });
    }
  } else {
    const groups = new Map<
      string,
      {
        source: ImportCatalogSourceV11;
        id: number | null;
        currentName: string | null;
        sources: ImportCatalogSourceV11[];
      }
    >();
    const seen = new Set<number>();
    const disciplineKeysById = new Map<number, string>();
    for (const chunk of jsonRecordChunksV1(
      sources.map((source) =>
        serializeJsonRecordV1({ source_index: source.sourceIndex, nome: source.name }),
      ),
    )) {
      const rows = (
        await database.executeNative<Row>(
          `SELECT s.source_index, lower(btrim(s.nome)) AS normalized, d.id, d.nome
       FROM gradebook.disciplina d RIGHT JOIN jsonb_to_recordset($2::text::jsonb) AS s(source_index integer, nome text)
         ON d.ano = $1 AND lower(btrim(d.nome)) = lower(btrim(s.nome)) /* import-catalog:disciplines-read */`,
          [ano, postgresJsonTextV1(chunk.jsonText)],
        )
      ).rows;
      if (rows.length !== chunk.rows)
        throw new Error('gradebook-import-catalog-cardinality-mismatch');
      for (const row of rows) {
        const index = importReadIntegerV11(row.source_index, 'source-index');
        const source = sourceByIndex.get(index);
        if (!source || seen.has(index) || typeof row.normalized !== 'string')
          throw new Error('gradebook-import-catalog-unexpected-source');
        seen.add(index);
        const id = row.id === null ? null : importReadIntegerV11(row.id, 'discipline-id');
        const currentName = nullableText(row.nome);
        if (id !== null) {
          const priorKey = disciplineKeysById.get(id);
          if (priorKey !== undefined && priorKey !== row.normalized)
            throw new Error('gradebook-import-catalog-duplicate-discipline-id');
          disciplineKeysById.set(id, row.normalized);
        }
        const group = groups.get(row.normalized);
        if (group) {
          if (group.id !== id || group.currentName !== currentName)
            throw new Error('gradebook-import-catalog-ambiguous-result');
          group.sources.push(source);
        } else groups.set(row.normalized, { source, id, currentName, sources: [source] });
      }
    }
    if (seen.size !== sources.length) throw new Error('gradebook-import-catalog-missing-source');
    const creates: Array<{ nome: string; normalized: string }> = [];
    const updates: Array<{ id: number; nome: string }> = [];
    for (const [normalized, group] of groups) {
      if (new Set(group.sources.map((source) => source.name.trim())).size > 1) {
        for (const source of group.sources.sort((a, b) => a.sourceIndex - b.sourceIndex))
          disciplineIds.set(source.sourceIndex, await resolveAmbiguous(source.name));
        continue;
      }
      const changed = group.id === null || group.currentName !== group.source.name.trim();
      if (group.id === null) creates.push({ nome: group.source.name.trim(), normalized });
      else {
        if (changed) {
          updates.push({ id: group.id, nome: group.source.name.trim() });
          globalAcademicChange = true;
        }
        for (const source of group.sources)
          disciplineIds.set(source.sourceIndex, { id: group.id, changed });
      }
    }
    for (const chunk of jsonRecordChunksV1(creates.map(serializeJsonRecordV1))) {
      const execution = await database.executeNative<Row>(
        `INSERT INTO gradebook.disciplina (ano, nome)
       SELECT $1, s.nome FROM jsonb_to_recordset($2::text::jsonb) AS s(nome text, normalized text)
       RETURNING id, lower(btrim(nome)) AS normalized /* import-catalog:disciplines-create */`,
        [ano, postgresJsonTextV1(chunk.jsonText)],
      );
      assertImportChangesV11(execution.changes, chunk.rows);
      if (execution.rows.length !== chunk.rows)
        throw new Error('gradebook-import-catalog-cardinality-mismatch');
      const expected = new Set<string>(
        (JSON.parse(chunk.jsonText) as typeof creates).map((row) => row.normalized),
      );
      for (const row of execution.rows) {
        if (typeof row.normalized !== 'string' || !expected.delete(row.normalized))
          throw new Error('gradebook-import-catalog-unexpected-discipline');
        const group = groups.get(row.normalized)!;
        const id = importReadIntegerV11(row.id, 'discipline-id');
        if (disciplineKeysById.has(id))
          throw new Error('gradebook-import-catalog-duplicate-discipline-id');
        disciplineKeysById.set(id, row.normalized);
        for (const source of group.sources)
          disciplineIds.set(source.sourceIndex, { id, changed: true });
      }
      if (expected.size > 0) throw new Error('gradebook-import-catalog-missing-discipline');
      writes += execution.changes;
    }
    for (const chunk of jsonRecordChunksV1(updates.map(serializeJsonRecordV1))) {
      const execution = await database.executeNative(
        `UPDATE gradebook.disciplina d SET nome = s.nome
       FROM jsonb_to_recordset($2::text::jsonb) AS s(id bigint, nome text)
       WHERE d.id = s.id AND d.ano = $1 /* import-catalog:disciplines-update */`,
        [ano, postgresJsonTextV1(chunk.jsonText)],
      );
      assertImportChangesV11(execution.changes, chunk.rows);
      writes += execution.changes;
    }
  }
  const offerKey = (turmaId: number, disciplinaId: number) =>
    `${turmaId}:${professorId}:${disciplinaId}`;
  const expectedOffers = new Map<string, ImportCatalogSourceV11[]>();
  for (const source of sources) {
    const discipline = disciplineIds.get(source.sourceIndex);
    if (!discipline) throw new Error('gradebook-import-catalog-missing-discipline');
    const key = offerKey(source.turmaId, discipline.id);
    const group = expectedOffers.get(key) ?? [];
    group.push(source);
    expectedOffers.set(key, group);
  }
  const offerRecords = [...expectedOffers.values()].map(([source]) => ({
    turma_id: source!.turmaId,
    professor_id: professorId,
    disciplina_id: disciplineIds.get(source!.sourceIndex)!.id,
  }));
  const offers = new Map<number, ImportResolvedCatalogV11>();
  const missing: typeof offerRecords = [];
  const offerSeen = new Set<string>();
  const offerKeysById = new Map<number, string>();
  const accept = (row: Row, created: boolean) => {
    const turmaId = importReadIntegerV11(row.turma_id, 'class-id');
    const teacherId = importReadIntegerV11(row.professor_id, 'professor-id');
    const disciplinaId = importReadIntegerV11(row.disciplina_id, 'discipline-id');
    const key = offerKey(turmaId, disciplinaId);
    const group = expectedOffers.get(key);
    if (!group || teacherId !== professorId || offerSeen.has(key))
      throw new Error('gradebook-import-catalog-unexpected-offer');
    offerSeen.add(key);
    if (row.id === null && !created) {
      missing.push({ turma_id: turmaId, professor_id: professorId, disciplina_id: disciplinaId });
      return;
    }
    const ofertaId = importReadIntegerV11(row.id, 'offer-id');
    if (offerKeysById.has(ofertaId)) throw new Error('gradebook-import-catalog-duplicate-offer-id');
    offerKeysById.set(ofertaId, key);
    for (const source of group)
      offers.set(source.sourceIndex, {
        ofertaId,
        disciplinaId,
        catalogChanged: created || disciplineIds.get(source.sourceIndex)!.changed,
      });
  };
  for (const chunk of jsonRecordChunksV1(offerRecords.map(serializeJsonRecordV1))) {
    const execution = await database.executeNative<Row>(
      `SELECT s.turma_id, s.professor_id, s.disciplina_id, o.id
       FROM gradebook.oferta o RIGHT JOIN jsonb_to_recordset($2::text::jsonb) AS s(turma_id bigint, professor_id bigint, disciplina_id bigint)
         ON o.ano = $1 AND o.turma_id = s.turma_id AND o.professor_id = s.professor_id AND o.disciplina_id = s.disciplina_id
       /* import-catalog:offers-read */`,
      [ano, postgresJsonTextV1(chunk.jsonText)],
    );
    if (execution.rows.length !== chunk.rows)
      throw new Error('gradebook-import-catalog-cardinality-mismatch');
    for (const row of execution.rows) accept(row, false);
  }
  if (offerSeen.size !== expectedOffers.size)
    throw new Error('gradebook-import-catalog-missing-offer');
  for (const record of missing) offerSeen.delete(offerKey(record.turma_id, record.disciplina_id));
  for (const chunk of jsonRecordChunksV1(missing.map(serializeJsonRecordV1))) {
    const execution = await database.executeNative<Row>(
      `INSERT INTO gradebook.oferta (ano, turma_id, professor_id, disciplina_id)
       SELECT $1, s.turma_id, s.professor_id, s.disciplina_id
       FROM jsonb_to_recordset($2::text::jsonb) AS s(turma_id bigint, professor_id bigint, disciplina_id bigint)
       RETURNING id, turma_id, professor_id, disciplina_id /* import-catalog:offers-create */`,
      [ano, postgresJsonTextV1(chunk.jsonText)],
    );
    assertImportChangesV11(execution.changes, chunk.rows);
    if (execution.rows.length !== chunk.rows)
      throw new Error('gradebook-import-catalog-cardinality-mismatch');
    for (const row of execution.rows) accept(row, true);
    writes += execution.changes;
  }
  if (offers.size !== sources.length) throw new Error('gradebook-import-catalog-missing-offer');
  return { offers, writes, globalAcademicChange };
}
