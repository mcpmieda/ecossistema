import type { GradebookPostgresWritePortV1 } from './postgres-database-v1';
import { postgresJsonTextV1 } from './postgres-values-v1';
import { jsonRecordChunksV1, serializeJsonRecordV1 } from './json-record-chunks-v1';
import {
  assertImportChangesV11,
  importReadIntegerV11,
  type ImportOfferReadStateV11,
} from './relational-import-read-set-v11';
import type { ImportInstrumentPlanV11 } from '../../application/import/import-relational-instrument-plan-v11';

type Row = Record<string, unknown>;

type InstrumentEntryV11 = ImportInstrumentPlanV11['entries'][number];
const instrumentKeyV11 = (ofertaId: number, term: number, slot: number) => `${ofertaId}:${term}:${slot}`;

/** Removes the retired instruments and their notes, in the database and in the read state. */
async function retireInstrumentsV11(
  database: GradebookPostgresWritePortV1,
  ano: number,
  plan: ImportInstrumentPlanV11,
  state: ImportOfferReadStateV11,
): Promise<number> {
  let writes = 0;
  const retiredIds = new Set<number>();
  for (const row of plan.retirements) {
    if (retiredIds.has(row.id))
      throw new Error('gradebook-import-instrument-plan-duplicate-retirement');
    retiredIds.add(row.id);
  }
  const noteCounts = new Map<number, number>();
  for (const key of state.notes.keys()) {
    const id = Number(key.split(':')[0]);
    if (retiredIds.has(id)) noteCounts.set(id, (noteCounts.get(id) ?? 0) + 1);
  }
  for (const chunk of jsonRecordChunksV1(
    plan.retirements.map((row) => serializeJsonRecordV1({ id: row.id, oferta_id: row.ofertaId })),
  )) {
    const records = JSON.parse(chunk.jsonText) as Array<{ id: number; oferta_id: number }>;
    const expectedNotes = records.reduce((sum, row) => sum + (noteCounts.get(row.id) ?? 0), 0);
    const notes = await database.executeNative(
      `DELETE FROM gradebook.nota n USING gradebook.instrumento i, gradebook.oferta o,
       jsonb_to_recordset($2::text::jsonb) AS s(id bigint, oferta_id bigint)
       WHERE n.instrumento_id = i.id AND i.id = s.id AND i.oferta_id = s.oferta_id
       AND o.id = i.oferta_id AND o.ano = $1 /* import-instruments:retire-notes */`,
      [ano, postgresJsonTextV1(chunk.jsonText)],
    );
    assertImportChangesV11(notes.changes, expectedNotes);
    const instruments = await database.executeNative(
      `DELETE FROM gradebook.instrumento i USING gradebook.oferta o,
       jsonb_to_recordset($2::text::jsonb) AS s(id bigint, oferta_id bigint)
       WHERE i.id = s.id AND i.oferta_id = s.oferta_id AND o.id = i.oferta_id AND o.ano = $1
       /* import-instruments:retire */`,
      [ano, postgresJsonTextV1(chunk.jsonText)],
    );
    assertImportChangesV11(instruments.changes, chunk.rows);
    writes += notes.changes + instruments.changes;
  }
  for (const row of plan.retirements) {
    state.instruments.delete(row.key);
    state.observedInstruments.delete(row.id);
  }
  for (const key of state.notes.keys())
    if (retiredIds.has(Number(key.split(':')[0]))) state.notes.delete(key);
  return writes;
}

const INSTRUMENT_SQL_V11 = {
  create: `INSERT INTO gradebook.instrumento (oferta_id, trimestre, slot, maximo, descricao)
           SELECT s.oferta_id, s.trimestre, s.slot, s.maximo, s.descricao
           FROM jsonb_to_recordset($2::text::jsonb) AS s(oferta_id bigint, trimestre smallint, slot smallint, maximo integer, descricao text)
           JOIN gradebook.oferta o ON o.id = s.oferta_id AND o.ano = $1
           RETURNING id, oferta_id, trimestre, slot /* import-instruments:create */`,
  update: `UPDATE gradebook.instrumento i SET maximo = s.maximo, descricao = s.descricao
           FROM jsonb_to_recordset($2::text::jsonb) AS s(id bigint, oferta_id bigint, trimestre smallint, slot smallint, maximo integer, descricao text), gradebook.oferta o
           WHERE i.id = s.id AND i.oferta_id = s.oferta_id AND i.trimestre = s.trimestre AND i.slot = s.slot
           AND o.id = i.oferta_id AND o.ano = $1
           RETURNING i.id, i.oferta_id, i.trimestre, i.slot /* import-instruments:update */`,
} as const;

/** One returned instrument: planned, returned once, a new id for a create, the same id for an update. */
function acceptInstrumentRowV11(
  row: Row,
  planned: ReadonlyMap<string, InstrumentEntryV11>,
  expected: Set<string>,
  knownInstrumentIds: Set<number>,
  state: ImportOfferReadStateV11,
) {
  const returnedKey = instrumentKeyV11(
    importReadIntegerV11(row.oferta_id, 'offer-id'),
    importReadIntegerV11(row.trimestre, 'term'),
    importReadIntegerV11(row.slot, 'slot'),
  );
  const entry = planned.get(returnedKey);
  if (!entry || !expected.delete(returnedKey))
    throw new Error('gradebook-import-instrument-unexpected-return');
  const id = importReadIntegerV11(row.id, 'instrument-id');
  if (entry.action === 'create') {
    if (knownInstrumentIds.has(id))
      throw new Error('gradebook-import-instrument-duplicate-id');
    knownInstrumentIds.add(id);
  }
  if (entry.action !== 'create' && id !== entry.existingId)
    throw new Error('gradebook-import-instrument-unexpected-id');
  state.instruments.set(entry.key, {
    id,
    maximo: entry.metadata.maximo,
    descricao: entry.metadata.descricao,
  });
}

/** The instruments of one action (create or update), written in batches and checked on return. */
async function writeInstrumentsV11(
  database: GradebookPostgresWritePortV1,
  ano: number,
  action: 'create' | 'update',
  entries: readonly InstrumentEntryV11[],
  target: { state: ImportOfferReadStateV11; knownInstrumentIds: Set<number> },
): Promise<number> {
  let writes = 0;
  const planned = new Map(
    entries.map((entry) => [
      instrumentKeyV11(entry.ofertaId, entry.term.trimestre, entry.term.instrumentos[entry.column]![0]),
      entry,
    ]),
  );
  if (planned.size !== entries.length)
    throw new Error('gradebook-import-instrument-plan-duplicate-key');
  const records = entries.map((entry) =>
    serializeJsonRecordV1({
      oferta_id: entry.ofertaId,
      trimestre: entry.term.trimestre,
      slot: entry.term.instrumentos[entry.column]![0],
      maximo: entry.metadata.maximo,
      descricao: entry.metadata.descricao,
      ...(entry.action !== 'create' ? { id: entry.existingId } : {}),
    }),
  );
  for (const chunk of jsonRecordChunksV1(records)) {
    const execution = await database.executeNative<Row>(INSTRUMENT_SQL_V11[action], [
      ano,
      postgresJsonTextV1(chunk.jsonText),
    ]);
    assertImportChangesV11(execution.changes, chunk.rows);
    if (execution.rows.length !== chunk.rows)
      throw new Error('gradebook-import-instrument-return-cardinality-mismatch');
    const expected = new Set<string>(
      (
        JSON.parse(chunk.jsonText) as Array<{
          oferta_id: number;
          trimestre: number;
          slot: number;
        }>
      ).map((row) => instrumentKeyV11(row.oferta_id, row.trimestre, row.slot)),
    );
    for (const row of execution.rows)
      acceptInstrumentRowV11(row, planned, expected, target.knownInstrumentIds, target.state);
    if (expected.size > 0) throw new Error('gradebook-import-instrument-missing-return');
    writes += execution.changes;
  }
  return writes;
}

/** Materializes metadata before any note delta. All calls use the current transaction port. */
export async function materializeRelationalImportInstrumentPlanV11(
  database: GradebookPostgresWritePortV1,
  ano: number,
  plan: ImportInstrumentPlanV11,
  state: ImportOfferReadStateV11,
): Promise<number> {
  let writes = await retireInstrumentsV11(database, ano, plan, state);
  const knownInstrumentIds = new Set(
    [...state.instruments.values()].map((instrument) => instrument.id),
  );
  const creates = plan.entries.filter((entry) => entry.action === 'create');
  const updates = plan.entries.filter((entry) => entry.action === 'update');
  writes += await writeInstrumentsV11(database, ano, 'create', creates, { state, knownInstrumentIds });
  writes += await writeInstrumentsV11(database, ano, 'update', updates, { state, knownInstrumentIds });
  return writes;
}
