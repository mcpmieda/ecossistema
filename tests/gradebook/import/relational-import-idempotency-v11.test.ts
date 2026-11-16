// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectGradebookImportPersistenceRequestV9,
  type GradebookImportCellV9,
  type GradebookImportInstrumentV9,
  type GradebookImportOfferV9,
  type GradebookImportPersistenceRequestV9,
  type GradebookImportTermV9,
  type GradebookNotesImportRequestV9,
  type GradebookRelationImportRequestV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import {
  IMPORT_JSON_STATEMENT_LIMITS_V1,
  IMPORT_PENDING_LIMITS_V1,
} from '../../../server/gradebook/persistence/postgres/json-record-chunks-v1';
import { createRelationalImportIdempotencyFixtureV11 } from '../fixtures/relational-import-idempotency-v11';
import {
  emptyImportCommitAffectedRowsV1,
  type ImportCommitCategoryV1,
} from '../../../shared/gradebook-contracts/imports/import-commit-diagnostics-v1';

type Fixture = Awaited<ReturnType<typeof createRelationalImportIdempotencyFixtureV11>>;
type Execution = Awaited<ReturnType<Fixture['execute']>>;
let fixture: Fixture;
const manifest = {
  fileName: 'SYNTHETIC IDEMPOTENCY.xlsb',
  sha256: 'a'.repeat(64),
  parserVersion: 'synthetic-idempotency-v11',
};
const classCode = (index: number) => `SYN-${index + 1}`;
function relation(classes = 2, students = 3): GradebookRelationImportRequestV9 {
  return {
    transportVersion: 9,
    operation: 'persist-relacao',
    ano: 2026,
    manifest,
    turmas: Array.from({ length: classes }, (_, index) => ({
      codigo: classCode(index),
      nome: `SYNTHETIC CLASS ${index + 1}`,
      etapa: 6,
      turno: 'MATUTINO',
      alunos: Array.from(
        { length: students },
        (_, student) => [student + 1, `SYNTHETIC STUDENT ${index + 1}-${student + 1}`, 0] as const,
      ),
    })),
  };
}
function offer(
  index = 0,
  students = 3,
  instruments: readonly GradebookImportInstrumentV9[] = [
    [1, 10_000, 'SYNTHETIC AV1'],
    [2, 10_000, 'SYNTHETIC AV2'],
    [3, null],
    [11, 5_000, 'SYNTHETIC ACTIVITY'],
  ],
): GradebookImportOfferV9 {
  const term = (trimestre: 1 | 2 | 3): GradebookImportTermV9 => ({
    trimestre,
    definitionSnapshotVersion: 1,
    instrumentos: instruments,
    alunos: Array.from(
      { length: students },
      (_, student) => [student + 1, instruments.map(() => 1_000), 5_000] as const,
    ),
  });
  return {
    turmaCodigo: classCode(index),
    disciplina: 'SYNTHETIC SUBJECT',
    trimestres: [term(1), term(2), term(3)],
    recuperacao: null,
  };
}
function notes(
  ofertas: readonly GradebookImportOfferV9[] = [offer(), offer(1)],
): GradebookNotesImportRequestV9 {
  return {
    transportVersion: 9,
    operation: 'persist-notas',
    ano: 2026,
    manifest,
    granularObservationVersion: 1,
    professor: 'SYNTHETIC TEACHER',
    ofertas,
  };
}
function mapTerms(
  source: GradebookImportOfferV9,
  change: (term: GradebookImportTermV9) => GradebookImportTermV9,
): GradebookImportOfferV9 {
  return {
    ...source,
    trimestres: source.trimestres.map(change) as unknown as GradebookImportOfferV9['trimestres'],
  };
}
function assertNoWrites(execution: Execution) {
  expect(execution.response).toMatchObject({
    state: 'no-changes',
    summary: { committedWrites: { total: 0 } },
  });
  expect(execution.counts).toMatchObject({
    dml: {},
    revisionCalls: 0,
    lifecycleCalls: 0,
    commits: 1,
    rollbacks: 0,
  });
  expect(execution.metrics).toMatchObject({
    sqlWriteCalls: 0,
    bufferedLogicalMutations: 0,
    groupedStatements: 0,
    instrumentsCreated: 0,
    instrumentsUpdated: 0,
    instrumentsRetired: 0,
    transactionOutcome: 'committed',
  });
  expect(execution.diagnostics).toMatchObject({
    coverage: 'complete',
    transaction: 'committed',
    unmeasuredStatements: 0,
    attempted: emptyImportCommitAffectedRowsV1(),
    confirmed: emptyImportCommitAffectedRowsV1(),
  });
}
function assertPhysicalAffectedRows(execution: Execution) {
  const expected = emptyImportCommitAffectedRowsV1();
  for (const [name, measurement] of Object.entries(execution.counts.dml)) {
    const [table, action] = name.split(':');
    const category: ImportCommitCategoryV1 = [
      'professor',
      'disciplina',
      'oferta',
      'instrumento',
      'nota',
      'fechamento',
    ].includes(table!)
      ? (table as ImportCommitCategoryV1)
      : ['vinculo_historico', 'fechamento_historico', 'importacao'].includes(table!)
        ? 'history-import'
        : 'other';
    expected[category][action as 'insert' | 'update' | 'delete'] += measurement.affectedRows;
  }
  expect(execution.diagnostics).toMatchObject({
    coverage: 'complete',
    transaction: 'committed',
    unmeasuredStatements: 0,
    attempted: expected,
    confirmed: expected,
    excludedEffects: 'sql-functions-triggers-portal',
  });
}
async function stableThree(
  request: GradebookImportPersistenceRequestV9,
  state: 'applied' | 'no-changes' = 'applied',
) {
  expect(inspectGradebookImportPersistenceRequestV9(request)).toBe('ready');
  const sourceBefore = structuredClone(request);
  const firstRequest = structuredClone(request);
  const first = await fixture.execute(firstRequest);
  assertPhysicalAffectedRows(first);
  expect(firstRequest).toEqual(sourceBefore);
  expect(first.response.state).toBe(state);
  if (state === 'no-changes') assertNoWrites(first);
  const stable = await fixture.snapshot();
  const revision = await fixture.revision();
  for (let run = 2; run <= 3; run++) {
    const repeatedRequest = structuredClone(request);
    assertNoWrites(await fixture.execute(repeatedRequest));
    expect(repeatedRequest).toEqual(sourceBefore);
    expect(await fixture.snapshot()).toEqual(stable);
    expect(await fixture.revision()).toEqual(revision);
  }
  expect(request).toEqual(sourceBefore);
  return first;
}
async function seed(classes = 2, students = 3) {
  expect((await fixture.execute(relation(classes, students))).response.state).toBe('applied');
}
async function currentNotes() {
  return (
    await fixture.pg.query<{
      codigo: string;
      numero: number;
      trimestre: number;
      slot: number;
      valor: number | null;
    }>(`SELECT t.codigo,v.numero,i.trimestre,i.slot,n.valor
    FROM gradebook.nota n JOIN gradebook.instrumento i ON i.id=n.instrumento_id
    JOIN gradebook.oferta o ON o.id=i.oferta_id JOIN gradebook.turma t ON t.id=o.turma_id
    JOIN gradebook.vinculo v ON v.turma_id=t.id AND v.aluno_id=n.aluno_id
    ORDER BY t.codigo,v.numero,i.trimestre,i.slot`)
  ).rows;
}

beforeEach(async () => {
  fixture = await createRelationalImportIdempotencyFixtureV11();
}, 30_000);
afterEach(async () => {
  await fixture?.close();
});

describe('H1/H2: real V11 idempotency against ordered relational and Portal facts', () => {
  it('H-I01: applies the same Relation and notes three times, with no new facts or revisions after the first', async () => {
    const firstRelation = await stableThree(relation());
    expect(firstRelation.counts.lifecycleCalls).toBe(1);
    expect(
      (await fixture.pg.query('SELECT eligibility FROM student_portal.account ORDER BY id')).rows,
    ).toEqual(Array.from({ length: 6 }, () => ({ eligibility: 'eligible' })));
    const firstNotes = await stableThree(notes());
    expect(firstNotes.counts.dml['nota:insert']?.affectedRows).toBe(72);
    expect(firstNotes.counts.revisionCalls).toBe(1);
    expect(firstNotes.counts.lifecycleCalls).toBe(0);
    expect(
      (await fixture.pg.query('SELECT count(*)::integer AS qty FROM gradebook.nota_historico'))
        .rows,
    ).toEqual([{ qty: 0 }]);
    expect(
      (
        await fixture.pg.query(
          'SELECT count(*)::integer AS qty FROM gradebook.instrumento_historico',
        )
      ).rows,
    ).toEqual([{ qty: 0 }]);
  });

  it('H-I04: identical and SQL-trim-equivalent professor labels require no catalog update', async () => {
    await seed();
    await fixture.execute(notes());
    await stableThree(notes(), 'no-changes');
    await stableThree({ ...notes(), professor: '  SYNTHETIC TEACHER  ' }, 'no-changes');
  });

  it('H-I05: a SQL-equivalent professor spelling writes only non-academic catalog metadata and then stabilizes', async () => {
    await seed();
    await fixture.execute(notes());
    const beforeRevision = await fixture.revision();
    const beforeNotes = await currentNotes();
    const first = await stableThree({ ...notes(), professor: '  Synthetic Teacher  ' });
    expect(first.response).toMatchObject({
      summary: { committedWrites: { total: 1, academicRecordVersions: 1 } },
    });
    expect(first.counts.dml).toEqual({ 'professor:update': { statements: 1, affectedRows: 1 } });
    expect(first.diagnostics.confirmed?.professor.update).toBe(1);
    expect(first.diagnostics.confirmed?.nota).toEqual({ insert: 0, update: 0, delete: 0 });
    expect(first.metrics.bufferedLogicalMutations).toBe(0);
    expect(await fixture.revision()).toEqual({
      academic: beforeRevision.academic,
      reset: beforeRevision.reset + 1,
    });
    expect(await currentNotes()).toEqual(beforeNotes);
  });

  it('H-I06: divergent capitalization of a shared discipline legitimately oscillates catalog presentation, without changing notes', async () => {
    await seed();
    const a = notes();
    const b = notes(a.ofertas.map((item) => ({ ...item, disciplina: 'Synthetic Subject' })));
    await stableThree(a);
    const before = await currentNotes();
    const revision = await fixture.revision();
    const changed = await stableThree(b);
    expect(changed.counts.dml).toEqual({ 'disciplina:update': { statements: 1, affectedRows: 1 } });
    expect(changed.diagnostics.confirmed?.disciplina.update).toBe(1);
    expect(changed.diagnostics.confirmed?.nota).toEqual({ insert: 0, update: 0, delete: 0 });
    expect(changed.metrics.bufferedLogicalMutations).toBe(0);
    expect(await fixture.revision()).toEqual({
      academic: revision.academic + 1,
      reset: revision.reset + 1,
    });
    expect(await currentNotes()).toEqual(before);
    const restored = await stableThree(a);
    expect(restored.counts.dml).toEqual(changed.counts.dml);
    expect(await currentNotes()).toEqual(before);
  });

  it('H-I07: several offers sharing one SQL-normalized label see the updated catalog map', async () => {
    await seed(3);
    const source = notes(
      Array.from({ length: 3 }, (_, index) => ({
        ...offer(index),
        disciplina: index % 2 ? '  SYNTHETIC SUBJECT  ' : 'SYNTHETIC SUBJECT',
      })),
    );
    const first = await stableThree(source);
    expect(first.counts.dml['disciplina:insert']?.affectedRows).toBe(1);
    expect(first.counts.dml['disciplina:update']).toBeUndefined();
    expect(first.counts.dml['oferta:insert']?.affectedRows).toBe(3);
  });

  it('H-I07: SQL-equivalent divergent labels in one request repeat only the two legitimate spelling transitions', async () => {
    await seed(3);
    const source = notes(
      Array.from({ length: 3 }, (_, index) => ({
        ...offer(index),
        disciplina: index === 2 ? 'SYNTHETIC SUBJECT' : 'Synthetic Subject',
      })),
    );
    expect(inspectGradebookImportPersistenceRequestV9(source)).toBe('ready');
    const first = await fixture.execute(structuredClone(source));
    expect(first.response.state).toBe('applied');
    expect(first.counts.dml['disciplina:insert']?.affectedRows).toBe(1);
    expect(first.counts.dml['disciplina:update']?.affectedRows).toBe(1);
    const stableNotes = await currentNotes();
    const stableCatalog = (await fixture.snapshot())['gradebook.disciplina'];
    for (let run = 2; run <= 3; run++) {
      const revision = await fixture.revision();
      const repeated = await fixture.execute(structuredClone(source));
      // The first spelling undoes the final spelling and the third restores it.
      // The identical second spelling must preserve, rather than write stale state.
      expect(repeated.response).toMatchObject({
        state: 'applied',
        summary: { committedWrites: { total: 2 } },
      });
      expect(repeated.counts.dml).toEqual({
        'disciplina:update': { statements: 2, affectedRows: 2 },
      });
      expect(repeated.metrics.bufferedLogicalMutations).toBe(0);
      expect(await currentNotes()).toEqual(stableNotes);
      expect((await fixture.snapshot())['gradebook.disciplina']).toEqual(stableCatalog);
      expect(await fixture.revision()).toEqual({
        academic: revision.academic + 1,
        reset: revision.reset + 1,
      });
    }
  });

  it('H-I08: description/max changes reconcile once, preserve unavailable fields and do not mutate V11 normalization inputs', async () => {
    await seed();
    const placeholder = notes([
      mapTerms(offer(), (term) => ({
        ...term,
        instrumentos: [
          [1, 10_000, 'SYNTHETIC AV1'],
          [2, 10_000],
          [3, null],
          [11, null, '1.0'],
        ],
        alunos: [[1, [1_000, 0, null, null], null]],
      })),
    ]);
    await stableThree(placeholder);
    expect(
      (
        await fixture.pg.query(
          'SELECT count(*)::integer AS qty FROM gradebook.instrumento WHERE slot=11',
        )
      ).rows,
    ).toEqual([{ qty: 0 }]);
    const active = notes([
      mapTerms(placeholder.ofertas[0]!, (term) => ({
        ...term,
        instrumentos: [
          [1, 10_000, 'RENAMED SYNTHETIC AV1'],
          [2, 12_000],
          [3, null],
          [11, 5_000, '1.0'],
        ],
        alunos: [[1, [1_000, 0, null, 0], null]],
      })),
    ]);
    const changed = await stableThree(active);
    expect(changed.metrics.instrumentsUpdated).toBe(6);
    expect(changed.metrics.instrumentsCreated).toBe(3);
    const unavailable = notes([
      mapTerms(active.ofertas[0]!, (term) => ({
        ...term,
        instrumentos: [
          [1, 10_000, 'RENAMED SYNTHETIC AV1'],
          [2, 12_000],
          [3, null],
          [11, null],
        ],
        unavailableMaximumSlots: [11],
        unavailableDescriptionSlots: [11],
        alunos: [[1, [1_000, 0, null, ['u']], null]],
      })),
    ]);
    await stableThree(unavailable, 'no-changes');
  });

  it('H-I09: observed null, absent observation, zero and unavailable remain distinct across rereads and student slices', async () => {
    await seed();
    const source = notes([
      mapTerms(offer(), (term) => ({
        ...term,
        alunos: [
          [1, [null, 0, ['u'], 4_000], null],
          [2, [2_500, null, 6_000, null], null],
        ],
      })),
    ]);
    await stableThree(source);
    const firstTerm = (await currentNotes()).filter((row) => row.trimestre === 1);
    const outsideSlice = (await currentNotes()).filter((row) => row.numero === 2);
    expect(firstTerm).toEqual([
      { codigo: 'SYN-1', numero: 1, trimestre: 1, slot: 1, valor: null },
      { codigo: 'SYN-1', numero: 1, trimestre: 1, slot: 2, valor: 0 },
      { codigo: 'SYN-1', numero: 1, trimestre: 1, slot: 11, valor: 4_000 },
      { codigo: 'SYN-1', numero: 2, trimestre: 1, slot: 1, valor: 2_500 },
      { codigo: 'SYN-1', numero: 2, trimestre: 1, slot: 2, valor: null },
      { codigo: 'SYN-1', numero: 2, trimestre: 1, slot: 3, valor: 6_000 },
      { codigo: 'SYN-1', numero: 2, trimestre: 1, slot: 11, valor: null },
    ]);
    const unavailable = notes([
      mapTerms(source.ofertas[0]!, (term) => ({
        ...term,
        alunos: [[1, [['u'], ['u'], ['u'], ['u']], ['u']]],
      })),
    ]);
    await stableThree(unavailable, 'no-changes');
    const observed = notes([
      mapTerms(source.ofertas[0]!, (term) => ({
        ...term,
        alunos: [[1, [['u'], ['u'], null, ['u']], ['u']]],
      })),
    ]);
    const first = await stableThree(observed);
    expect(first.counts.dml['nota:insert']?.affectedRows).toBe(3);
    expect(first.metrics.groupCounts['note-delete']).toBe(0);
    expect((await currentNotes()).filter((row) => row.numero === 2)).toEqual(outsideSlice);
  });

  it('H-I10: a qualitative first/last blank observation survives partial slices until authoritative definition retirement', async () => {
    await seed();
    const source = notes([
      mapTerms(offer(), (term) => ({
        ...term,
        instrumentos: [
          [1, 10_000],
          [2, 10_000],
          [3, null],
          [11, null, 'SYNTHETIC NAMED ACTIVITY'],
        ],
        alunos: [[1, [null, null, null, null], null]],
      })),
    ]);
    await stableThree(source);
    const secondStudent = notes([
      mapTerms(source.ofertas[0]!, (term) => ({
        ...term,
        alunos: [[2, [null, null, null, null], null]],
      })),
    ]);
    const added = await stableThree(secondStudent);
    expect(added.counts.dml['nota:insert']?.affectedRows).toBe(12);
    expect(added.metrics.instrumentsRetired).toBe(0);
    const absent = notes([mapTerms(source.ofertas[0]!, (term) => ({ ...term, alunos: [] }))]);
    await stableThree(absent, 'no-changes');
    expect(
      (
        await fixture.pg.query(`SELECT count(*)::integer AS qty FROM gradebook.nota n
      JOIN gradebook.instrumento i ON i.id=n.instrumento_id WHERE i.slot=11 AND n.valor IS NULL`)
      ).rows,
    ).toEqual([{ qty: 6 }]);
    const retired = notes([
      mapTerms(source.ofertas[0]!, (term) => ({
        ...term,
        instrumentos: term.instrumentos.slice(0, 3),
        alunos: [],
      })),
    ]);
    const removed = await stableThree(retired);
    expect(removed.metrics.instrumentsRetired).toBe(3);
    expect(
      (
        await fixture.pg.query(
          'SELECT count(*)::integer AS qty FROM gradebook.instrumento WHERE slot=11',
        )
      ).rows,
    ).toEqual([{ qty: 0 }]);
  });

  it('H-I11: AM/REC/U and NC/RR masks stabilize; unavailable preserves and explicit clears retain closing history', async () => {
    await seed();
    const source = notes([
      {
        ...mapTerms(offer(), (term) => ({
          ...term,
          alunos: [
            [1, [1_000, 1_000, null, 1_000], ([0, 8_000, 9_000] as const)[term.trimestre - 1]!],
          ],
        })),
        recuperacao: [[1, ['n'], ['r'], 0, 21_000]],
      },
    ]);
    await stableThree(source);
    const changed = notes([
      {
        ...mapTerms(source.ofertas[0]!, (term) => ({
          ...term,
          alunos: [
            [1, [1_000, 1_000, null, 1_000], ([['u'], null, 0] as const)[term.trimestre - 1]!],
          ],
        })),
        recuperacao: [[1, ['u'], null, ['n'], ['u']]],
      },
    ]);
    const first = await stableThree(changed);
    expect(first.metrics.groupCounts['closing-update']).toBe(1);
    expect(first.counts.dml['fechamento_historico:insert']?.affectedRows).toBe(4);
    expect(
      (
        await fixture.pg.query(`SELECT am1_fonte,am2_fonte,am3_fonte,rec1,rec2,rec3,
      rec_nc_mask,rec_rr_mask,u_fonte FROM gradebook.fechamento`)
      ).rows,
    ).toEqual([
      {
        am1_fonte: 0,
        am2_fonte: null,
        am3_fonte: 0,
        rec1: null,
        rec2: null,
        rec3: null,
        rec_nc_mask: 5,
        rec_rr_mask: 0,
        u_fonte: 21_000,
      },
    ]);
    const cleared = notes([
      {
        ...mapTerms(changed.ofertas[0]!, (term) => ({
          ...term,
          alunos: [[1, [1_000, 1_000, null, 1_000], null]],
        })),
        recuperacao: [[1, null, null, null, null]],
      },
    ]);
    expect((await stableThree(cleared)).metrics.groupCounts['closing-delete']).toBe(1);
    expect(
      (await fixture.pg.query('SELECT count(*)::integer AS qty FROM gradebook.fechamento')).rows,
    ).toEqual([{ qty: 0 }]);
  });

  it('H-I12: legitimate Relation movement records history once and V10 filters historical class notes and closings', async () => {
    await seed();
    const base = relation();
    const moved: GradebookRelationImportRequestV9 = {
      ...base,
      turmas: [
        {
          ...base.turmas[0]!,
          alunos: [[1, 'SYNTHETIC STUDENT 1-1', 6, 'SYN-2'], ...base.turmas[0]!.alunos.slice(1)],
        },
        {
          ...base.turmas[1]!,
          alunos: [...base.turmas[1]!.alunos, [4, 'SYNTHETIC STUDENT 1-1', 7, 'SYN-1']],
        },
      ],
    };
    const changed = await stableThree(moved);
    expect(changed.counts.dml['vinculo_historico:insert']?.affectedRows).toBe(1);
    expect(changed.counts.lifecycleCalls).toBe(1);
    const source = notes([
      offer(0),
      { ...offer(1, 4), recuperacao: [[4, ['n'], ['r'], ['u'], 20_000]] },
    ]);
    await stableThree(source);
    expect(
      (await currentNotes()).filter((row) => row.codigo === 'SYN-1' && row.numero === 1),
    ).toEqual([]);
    expect(
      (await currentNotes()).filter((row) => row.codigo === 'SYN-2' && row.numero === 4),
    ).toHaveLength(12);
    expect(
      (
        await fixture.pg.query(`SELECT count(*)::integer AS qty FROM gradebook.fechamento f
      JOIN gradebook.oferta o ON o.id=f.oferta_id JOIN gradebook.turma t ON t.id=o.turma_id
      JOIN gradebook.vinculo v ON v.turma_id=t.id AND v.aluno_id=f.aluno_id
      WHERE t.codigo='SYN-1' AND v.numero=1`)
      ).rows,
    ).toEqual([{ qty: 0 }]);
  });

  it('H-I13: A -> B -> A and repeated divergent A -> B batches contain legitimate intermediate note writes', async () => {
    await seed();
    const a = notes();
    const b = notes(
      a.ofertas.map((item) =>
        mapTerms(item, (term) => ({
          ...term,
          alunos: term.alunos.map(
            ([numero, values, am]) => [numero, values.map(() => 2_000), am] as const,
          ),
        })),
      ),
    );
    await stableThree(a);
    expect((await stableThree(b)).counts.dml['nota:update']?.affectedRows).toBe(72);
    expect((await stableThree(a)).counts.dml['nota:update']?.affectedRows).toBe(72);
    let finalB: Awaited<ReturnType<Fixture['snapshot']>> | undefined;
    for (let batch = 0; batch < 2; batch++) {
      const first = await fixture.execute(a);
      if (batch === 0) assertNoWrites(first);
      else expect(first.counts.dml['nota:update']?.affectedRows).toBe(72);
      const last = await fixture.execute(b);
      expect(last.response.state).toBe('applied');
      expect(last.counts.dml['nota:update']?.affectedRows).toBe(72);
      const current = await currentNotes();
      expect(current.every((row) => row.valor === 2_000)).toBe(true);
      const snapshot = await fixture.snapshot();
      if (finalB) {
        expect(snapshot['gradebook.nota']).toEqual(finalB['gradebook.nota']);
        expect(snapshot['gradebook.instrumento']).toEqual(finalB['gradebook.instrumento']);
        expect(snapshot['student_portal.academic_revision']).not.toEqual(
          finalB['student_portal.academic_revision'],
        );
      }
      finalB = snapshot;
    }
  });

  it('H-I14: shared catalog identity across 33 offers and read-set blocks stabilizes without stale associations', async () => {
    await seed(33);
    const source = notes(Array.from({ length: 33 }, (_, index) => offer(index)));
    const first = await stableThree(source);
    expect(first.metrics.readSetBlocks).toBe(2);
    expect(first.metrics.readSetOffers).toBe(33);
    expect(first.counts.dml['disciplina:insert']?.affectedRows).toBe(1);
    expect(first.counts.dml['oferta:insert']?.affectedRows).toBe(33);
    expect(first.counts.dml['nota:insert']?.affectedRows).toBe(1_188);
    expect(fixture.lastMetrics().readSetBlocks).toBe(2);
    expect(fixture.lastMetrics().readSetOffers).toBe(33);
    const renamed = notes(
      source.ofertas.map((item) => ({
        ...item,
        disciplina: 'Synthetic Subject',
      })),
    );
    const changed = await stableThree(renamed);
    expect(changed.counts.dml).toEqual({
      'disciplina:update': { statements: 1, affectedRows: 1 },
    });
    expect(changed.metrics.readSetBlocks).toBe(2);
    expect(changed.metrics.bufferedLogicalMutations).toBe(0);
  }, 30_000);

  it.each([3, 64])(
    'H-I01/H-I14: counts physical and logical writes with %i students below/above buffer capacity',
    async (students) => {
      await seed(2, students);
      const slots = [1, 2, 3, 11, 12, 13, 14, 15, 16, 17, 18, 19] as const;
      const source = notes([
        offer(
          0,
          students,
          slots.map((slot) => [slot, 10_000, `SYNTHETIC SLOT ${slot}`]),
        ),
      ]);
      const first = await stableThree(source);
      const expectedNotes = students * slots.length * 3;
      expect(first.metrics.groupCounts['note-insert']).toBe(
        first.counts.dml['nota:insert']?.statements,
      );
      expect(first.counts.dml['nota:insert']?.affectedRows).toBe(expectedNotes);
      expect(first.metrics.maximumGroupRows).toBeLessThanOrEqual(
        IMPORT_JSON_STATEMENT_LIMITS_V1.maximumRows,
      );
      expect(first.metrics.maximumPendingRows).toBeLessThanOrEqual(
        IMPORT_PENDING_LIMITS_V1.maximumRows,
      );
      expect(first.metrics.flushReasonCounts['row-limit']).toBe(students === 64 ? 1 : 0);
      const dmlRows = Object.values(first.counts.dml).reduce(
        (sum, category) => sum + category.affectedRows,
        0,
      );
      expect(first.response).toMatchObject({ summary: { committedWrites: { total: dmlRows } } });
      expect(dmlRows).toBe(expectedNotes + students * 4 + slots.length * 3 + 4);
      // Legacy academicRecordVersions counts all committed writes except importacao,
      // including catalogs/history; it is not the number of notes.
      expect(first.metrics.bufferedLogicalMutations).toBe(expectedNotes + students * 4);
      expect(JSON.stringify(first.counts)).not.toContain('SYNTHETIC');
    },
    30_000,
  );

  it.each(['after-note-flush', 'after-revision', 'after-lifecycle'] as const)(
    'H-I15: failure %s rolls back all facts, history, revision and Portal effects; a retry stabilizes',
    async (failure) => {
      await seed();
      if (failure === 'after-lifecycle')
        await fixture.pg.exec(`
        INSERT INTO student_portal.session (id,account_id,token_hash,security_version,expires_at,persistent)
        SELECT gen_random_uuid(),id,'synthetic-idempotency-session-'||id,security_version,
          now()+interval '1 day',false FROM student_portal.account`);
      const source =
        failure === 'after-lifecycle'
          ? {
              ...relation(),
              turmas: relation().turmas.map((item) => ({
                ...item,
                alunos: item.alunos.map(([numero, nome]) => [numero, nome, 3] as const),
              })),
            }
          : notes();
      const before = await fixture.snapshot();
      fixture.setFailure(failure);
      await expect(fixture.execute(source)).rejects.toThrow(`synthetic-${failure}`);
      expect(fixture.lastCommitDiagnostics()).toMatchObject({
        transaction: 'rejected',
        confirmed: null,
      });
      expect(fixture.lastCounts()).toMatchObject({ commits: 0, rollbacks: 1 });
      expect(await fixture.snapshot()).toEqual(before);
      fixture.setFailure('none');
      await stableThree(source);
      if (failure === 'after-lifecycle') {
        expect(
          (await fixture.pg.query('SELECT eligibility FROM student_portal.account ORDER BY id'))
            .rows,
        ).toEqual(Array.from({ length: 6 }, () => ({ eligibility: 'exit' })));
        expect(
          (
            await fixture.pg.query(
              'SELECT revoked_at IS NOT NULL AS revoked FROM student_portal.session ORDER BY id',
            )
          ).rows,
        ).toEqual(Array.from({ length: 6 }, () => ({ revoked: true })));
      }
    },
  );

  it('H-I16: a real change with the already-seen manifest still applies after stable repetitions', async () => {
    await seed();
    const source = notes();
    await stableThree(source);
    const before = await fixture.revision();
    const changed = notes([
      mapTerms(source.ofertas[0]!, (term) => ({
        ...term,
        alunos: term.alunos.map(
          ([numero, values, am]) =>
            [
              numero,
              values.map((value, index): GradebookImportCellV9 =>
                term.trimestre === 2 && numero === 1 && index === 0 ? 0 : value,
              ),
              am,
            ] as const,
        ),
      })),
      source.ofertas[1]!,
    ]);
    expect(changed.manifest).toEqual(source.manifest);
    const first = await stableThree(changed);
    expect(first.metrics.groupCounts['note-update']).toBe(1);
    expect(first.response).toMatchObject({ summary: { committedWrites: { total: 1 } } });
    expect(await fixture.revision()).toEqual({
      academic: before.academic + 1,
      reset: before.reset + 1,
    });
  });
});
