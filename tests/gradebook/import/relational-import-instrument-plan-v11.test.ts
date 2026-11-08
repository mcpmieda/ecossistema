// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildRelationalImportInstrumentPlanV11 } from '../../../server/gradebook/application/import/import-relational-instrument-plan-v11';
import { materializeRelationalImportInstrumentPlanV11 } from '../../../server/gradebook/persistence/postgres/relational-import-instrument-batch-v11';
import type {
  ImportInstrumentStateV11,
  ImportOfferReadStateV11,
} from '../../../server/gradebook/persistence/postgres/relational-import-read-set-v11';
import type { GradebookPostgresWritePortV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import type {
  GradebookImportOfferV9,
  GradebookImportTermV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

function offer(term: Partial<GradebookImportTermV9> = {}): GradebookImportOfferV9 {
  return {
    turmaCodigo: 'SYN',
    disciplina: 'SYNTHETIC',
    recuperacao: null,
    trimestres: [
      { trimestre: 1, definitionSnapshotVersion: 1 as const, instrumentos: [[11, null]], alunos: [[1, [null], null]], ...term },
      { trimestre: 2, definitionSnapshotVersion: 1 as const, instrumentos: [], alunos: [] },
      { trimestre: 3, definitionSnapshotVersion: 1 as const, instrumentos: [], alunos: [] },
    ],
  };
}
function plan(
  source: GradebookImportOfferV9,
  instruments = new Map<string, ImportInstrumentStateV11>(),
) {
  return buildRelationalImportInstrumentPlanV11({
    ofertaId: 50,
    offer: source,
    instruments,
  });
}
const current = () =>
  new Map([['1:11', { id: 10, maximo: 5000, descricao: 'SYNTHETIC ACTIVITY' }]]);

describe('instrument planning delegates to the established V9 decisions', () => {
  it('clears fields the snapshot observed as empty', () => {
    expect(plan(offer(), current()).entries[0]).toMatchObject({
      action: 'update',
      metadata: { maximo: null, descricao: null },
    });
  });
  it('preserves unavailable fields, and each unavailable mask separately prevents retirement', () => {
    expect(
      plan(
        offer({
          definitionSnapshotVersion: 1,
          unavailableMaximumSlots: [11],
          unavailableDescriptionSlots: [11],
        }),
        current(),
      ).entries[0],
    ).toMatchObject({ action: 'preserve' });
    for (const mask of [
      'unavailableMaximumSlots',
      'unavailableDescriptionSlots',
      'unavailableValueSlots',
    ] as const) {
      expect(
        plan(
          offer({ definitionSnapshotVersion: 1, instrumentos: [], alunos: [], [mask]: [11] }),
          current(),
        ).retirements,
      ).toHaveLength(0);
    }
    expect(
      plan(offer({ definitionSnapshotVersion: 1, instrumentos: [], alunos: [] }), current())
        .retirements,
    ).toEqual([{ key: '1:11', id: 10, ofertaId: 50 }]);
  });
  it('keeps zero significant, ignores an unobserved empty column, and retains granular slot3', () => {
    expect(plan(offer()).entries).toHaveLength(0);
    expect(plan(offer({ alunos: [[1, [0], null]] })).entries[0]).toMatchObject({
      action: 'create',
      hasValue: true,
    });
    expect(plan(offer({ alunos: [] })).entries).toHaveLength(0);
    expect(plan(offer({ instrumentos: [[3, null]], alunos: [] })).entries[0]).toMatchObject({
      action: 'create',
      hasValue: false,
    });
  });
  it('does not mutate request or existing metadata and preserves the source order across terms', () => {
    const source = offer({
      instrumentos: [
        [1, 10_000, 'AV1'],
        [11, 5000, 'SYNTHETIC ACTIVITY'],
      ],
      alunos: [[1, [0, ['u']], null]],
    });
    const before = JSON.stringify(source);
    const instruments = current();
    const result = plan(source, instruments);
    expect(result.entries.map((entry) => entry.key)).toEqual(['1:1', '1:11']);
    expect(JSON.stringify(source)).toBe(before);
    expect(instruments).toEqual(current());
  });
});

function state(instruments = new Map<string, ImportInstrumentStateV11>()): ImportOfferReadStateV11 {
  return { instruments, notes: new Map(), observedInstruments: new Set(), closing: new Map() };
}
function materializerFake(
  mode: 'valid' | 'missing' | 'duplicate' | 'changes' | 'wrong-id' = 'valid',
) {
  const calls: string[] = [];
  const database: GradebookPostgresWritePortV1 = {
    query: async () => [],
    executeNative: async <T extends Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[],
    ) => {
      calls.push(sql);
      const input = parameters[1] as { jsonText: string };
      const records = JSON.parse(input.jsonText) as Array<Record<string, unknown>>;
      let rows = records
        .map((record, index) => ({
          ...record,
          id: mode === 'wrong-id' ? 9999 : (record.id ?? index + 100),
        }))
        .reverse();
      if (mode === 'missing') rows = rows.slice(1);
      if (mode === 'duplicate') rows = rows.map(() => rows[0]!);
      const changes = sql.includes('retire-notes') ? 2 : records.length;
      return {
        rows: rows as unknown as readonly T[],
        changes: mode === 'changes' ? changes + 1 : changes,
      };
    },
  };
  return { database, calls };
}

it('materializes every term before notes, associates reversed RETURNING rows by identity, and skips unchanged metadata', async () => {
  const source = offer({
    instrumentos: [
      [1, 10_000, 'AV1'],
      [11, 5000, 'SYNTHETIC'],
    ],
    alunos: [],
  });
  const target = state();
  const { database, calls } = materializerFake();
  expect(
    await materializeRelationalImportInstrumentPlanV11(database, 2026, plan(source), target),
  ).toBe(2);
  expect(target.instruments.get('1:1')).toEqual({ id: 100, maximo: 10_000, descricao: 'AV1' });
  expect(target.instruments.get('1:11')).toEqual({ id: 101, maximo: 5000, descricao: 'SYNTHETIC' });
  expect(calls).toHaveLength(1);
  const before = calls.length;
  expect(
    await materializeRelationalImportInstrumentPlanV11(
      database,
      2026,
      plan(source, target.instruments),
      target,
    ),
  ).toBe(0);
  expect(calls).toHaveLength(before);
});

it('removes all observations including null outside the source before the retired parent', async () => {
  const target = state(current());
  target.notes.set('10:1', 0);
  target.notes.set('10:2', null);
  target.observedInstruments.add(10);
  const { database, calls } = materializerFake();
  expect(
    await materializeRelationalImportInstrumentPlanV11(
      database,
      2026,
      plan(
        offer({ definitionSnapshotVersion: 1, instrumentos: [], alunos: [] }),
        target.instruments,
      ),
      target,
    ),
  ).toBe(3);
  expect(calls[0]).toContain('import-instruments:retire-notes');
  expect(calls[1]).toContain('import-instruments:retire */');
  expect(target.instruments.size).toBe(0);
  expect(target.notes.size).toBe(0);
  expect(target.observedInstruments.size).toBe(0);
});

it.each(['missing', 'duplicate', 'changes'] as const)(
  'rejects invalid physical materialization: %s',
  async (mode) => {
    const source = offer({
      instrumentos: [
        [1, 10000],
        [11, 5000],
      ],
      alunos: [],
    });
    await expect(
      materializeRelationalImportInstrumentPlanV11(
        materializerFake(mode).database,
        2026,
        plan(source),
        state(),
      ),
    ).rejects.toThrow();
  },
);
it('rejects an existing instrument returning a different ID', async () => {
  const target = state(current());
  await expect(
    materializeRelationalImportInstrumentPlanV11(
      materializerFake('wrong-id').database,
      2026,
      plan(offer({ definitionSnapshotVersion: 1 }), target.instruments),
      target,
    ),
  ).rejects.toThrow('unexpected-id');
});
