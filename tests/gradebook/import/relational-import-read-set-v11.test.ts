// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installResetSchemaFixtureV1, installReconciliationSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresWritePortV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createGradebookRelationalImportServiceV11 } from '../../../server/gradebook/application/import/import-relational-service-v11';
import {
  loadRelationalImportReadSetV11,
  resolveRelationalImportCatalogV11,
} from '../../../server/gradebook/persistence/postgres/relational-import-read-set-v11';
import { inspectGradebookImportPersistenceRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type {
  GradebookImportTermV9,
  GradebookNotesImportRequestV9,
  GradebookRelationImportRequestV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
const calls: string[] = [];
let commits = 0;
let failure: 'none' | 'last-block' = 'none';
const manifest = {
  fileName: 'SYNTHETIC READSET.xlsb',
  sha256: 'a'.repeat(64),
  parserVersion: 'synthetic-readset',
};
function notes(count: number, label = 'SYNTHETIC SUBJECT'): GradebookNotesImportRequestV9 {
  return {
    transportVersion: 9,
    operation: 'persist-notas',
    ano: 2026,
    manifest,
    professor: 'SYNTHETIC TEACHER',
    granularObservationVersion: 1,
    ofertas: Array.from({ length: count }, (_, index) => ({
      turmaCodigo: `SYN-${index}`,
      disciplina: label,
      trimestres: [1, 2, 3].map((trimestre) => ({
        trimestre,
        definitionSnapshotVersion: 1,
        instrumentos: [
          [1, 10_000, 'AV1'],
          [3, null],
          [11, 5000, 'SYNTHETIC ACTIVITY'],
        ],
        alunos: [[1, [0, ['u'], null], 7000]],
      })) as unknown as readonly [
        GradebookImportTermV9,
        GradebookImportTermV9,
        GradebookImportTermV9,
      ],
      recuperacao: [[1, ['n'], ['r'], ['u'], 21000]],
    })),
  };
}
function whitespaceNotes(count: number, label: string): GradebookNotesImportRequestV9 {
  const source = notes(count, label);
  const completeTerm = (term: GradebookImportTermV9): GradebookImportTermV9 => ({
    ...term,
    instrumentos: [...term.instrumentos, [2, 10000, 'AV2']],
    alunos: term.alunos.map(([number, values, am]) => [number, [...values, ['u']], am]),
  });
  return {
    ...source,
    ofertas: source.ofertas.map((offer) => ({
      ...offer,
      trimestres: [
        completeTerm(offer.trimestres[0]),
        completeTerm(offer.trimestres[1]),
        completeTerm(offer.trimestres[2]),
      ],
    })),
  };
}
const relation: GradebookRelationImportRequestV9 = {
  transportVersion: 9,
  operation: 'persist-relacao',
  ano: 2026,
  manifest,
  turmas: Array.from({ length: 33 }, (_, index) => ({
    codigo: `SYN-${index}`,
    nome: `SYNTHETIC CLASS ${index}`,
    etapa: 6,
    turno: 'M',
    alunos: [
      [1, `SYNTHETIC STUDENT ${index}`, 0],
      [2, `SYNTHETIC OUTSIDE ${index}`, 0],
    ],
  })),
};
const file = (name: string) => readFileSync(`migrations/gradebook-simplified/${name}`, 'utf8');
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(file('0001_current_schema.sql'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  for (const name of [
    '0003_council_session_v3.sql',
    '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql',
    '0009_granular_observations_names_v1.sql',
  ])
    await pg.exec(file(name));
  await installResetSchemaFixtureV1(pg);
  await installReconciliationSchemaFixtureV1(pg);
  const run = async (
    client: Pick<PGlite, 'query'>,
    text: string,
    values: readonly unknown[] = [],
  ) => {
    calls.push(text);
    if (
      failure === 'last-block' &&
      text.includes('import-read-set:instruments') &&
      calls.filter((sql) => sql.includes('import-read-set:instruments')).length === 2
    )
      throw new Error('synthetic-last-block');
    const result = await client.query<Record<string, unknown>>(text, [...values]);
    // PostgreSQL does not promise row order. Exercise association by identity on every RETURNING/read.
    return Object.assign([...result.rows].reverse(), {
      count: result.affectedRows ?? result.rows.length,
    });
  };
  database = createGradebookPostgresDatabaseFromSqlV1({
    unsafe: (text, values) => run(pg, text, values),
    begin: async (operation) => {
      const result = await pg.transaction((tx) =>
        operation({ unsafe: (text, values) => run(tx, text, values) }),
      );
      commits++;
      return result;
    },
    end: () => pg.close(),
  });
  expect((await createGradebookRelationalImportServiceV11(database).execute(relation)).state).toBe(
    'applied',
  );
}, 30000);
afterAll(async () => database?.close());

describe('V11 bounded read sets through the canonical service chain', () => {
  it.each([1, 2, 15, 33])(
    'reads three categories per block for %i offers and reimports without DML',
    async (count) => {
      const request = notes(count);
      const service = createGradebookRelationalImportServiceV11(database);
      expect((await service.execute(request)).state).toBe('applied');
      calls.length = 0;
      const before = commits;
      expect(await service.execute(request)).toMatchObject({
        state: 'no-changes',
        summary: { committedWrites: { total: 0 } },
      });
      expect(commits - before).toBe(1);
      for (const category of ['instruments', 'notes', 'closings'])
        expect(calls.filter((sql) => sql.includes(`import-read-set:${category}`))).toHaveLength(
          Math.ceil(count / 32),
        );
      expect(calls.filter((sql) => sql.includes('import-catalog:disciplines-read'))).toHaveLength(
        1,
      );
      expect(calls.filter((sql) => sql.includes('import-catalog:offers-read'))).toHaveLength(1);
      expect(calls.some((sql) => /^(INSERT|UPDATE|DELETE)/u.test(sql))).toBe(false);
      expect(calls.some((sql) => sql.includes('record_gradebook_change_v1'))).toBe(false);
    },
  );

  it('keeps zero, observed null outside the source slice, and all REC/AM/U fields', async () => {
    await pg.exec(`INSERT INTO gradebook.nota (instrumento_id, aluno_id, valor)
      SELECT i.id, v.aluno_id, NULL FROM gradebook.instrumento i JOIN gradebook.oferta o ON o.id=i.oferta_id
      JOIN gradebook.vinculo v ON v.turma_id=o.turma_id AND v.numero=2 WHERE i.slot=11`);
    const offerId = (
      await pg.query<{ id: number }>('SELECT id FROM gradebook.oferta ORDER BY id LIMIT 1')
    ).rows[0]!.id;
    calls.length = 0;
    const state = (await loadRelationalImportReadSetV11(database, 2026, [offerId])).get(offerId)!;
    const qualitative = state.instruments.get('1:11')!;
    const zero = state.instruments.get('1:1')!;
    expect(state.observedInstruments.has(qualitative.id)).toBe(true);
    expect([...state.notes].filter(([key]) => key.startsWith(`${qualitative.id}:`))).toHaveLength(
      2,
    );
    expect(
      [...state.notes].filter(([key]) => key.startsWith(`${zero.id}:`)).map(([, value]) => value),
    ).toEqual([0]);
    expect([...state.closing.values()]).toEqual([
      {
        exists: true,
        am: [7000, 7000, 7000],
        rec: [null, null, null],
        ncMask: 1,
        rrMask: 2,
        u: 21000,
      },
    ]);
    expect(calls).toHaveLength(3);
    calls.length = 0;
    expect((await loadRelationalImportReadSetV11(database, 2026, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('retains sequential display-label changes for SQL-equivalent subject names', async () => {
    const request = notes(2);
    const variant = {
      ...request,
      ofertas: request.ofertas.map((offer, index) => ({
        ...offer,
        disciplina: index === 0 ? 'Synthetic Subject' : 'SYNTHETIC SUBJECT',
      })),
    };
    const response = await createGradebookRelationalImportServiceV11(database).execute(variant);
    expect(response).toMatchObject({
      state: 'applied',
      summary: { committedWrites: { total: 2 } },
    });
    expect((await pg.query('SELECT nome FROM gradebook.disciplina')).rows).toEqual([
      { nome: 'SYNTHETIC SUBJECT' },
    ]);
    const reset = calls.filter((sql) => sql.includes('record_gradebook_change_v1'));
    expect(reset.length).toBeGreaterThan(0);
  });

  it('retains unavailable definitions and then retires all notes before their parent with exact counts', async () => {
    const request = notes(1);
    const withoutQualitative = {
      ...request,
      ofertas: request.ofertas.map((source) => ({
        ...source,
        trimestres: source.trimestres.map((term) => ({
          ...term,
          instrumentos: term.instrumentos.slice(0, 2),
          alunos: term.alunos.map(([number, values, am]) => [number, values.slice(0, 2), am]),
          unavailableValueSlots: [11],
        })) as unknown as typeof source.trimestres,
      })),
    } as GradebookNotesImportRequestV9;
    const service = createGradebookRelationalImportServiceV11(database);
    expect((await service.execute(withoutQualitative)).state).toBe('no-changes');
    const idsBefore = (
      await pg.query<{ id: number; oferta_id: number; trimestre: number; slot: number }>(
        'SELECT id,oferta_id,trimestre,slot FROM gradebook.instrumento ORDER BY id',
      )
    ).rows;
    const removed = {
      ...withoutQualitative,
      ofertas: withoutQualitative.ofertas.map((source) => ({
        ...source,
        trimestres: source.trimestres.map((term) => ({
          ...term,
          unavailableValueSlots: [],
        })) as unknown as typeof source.trimestres,
      })),
    };
    calls.length = 0;
    expect(await service.execute(removed)).toMatchObject({
      state: 'applied',
      summary: { committedWrites: { total: 9 } },
    });
    const childIndex = calls.findIndex((sql) => sql.includes('import-instruments:retire-notes'));
    const parentIndex = calls.findIndex((sql) => sql.includes('import-instruments:retire */'));
    expect(childIndex).toBeGreaterThan(-1);
    expect(parentIndex).toBeGreaterThan(childIndex);
    expect(
      (
        await pg.query<{ id: number; oferta_id: number; trimestre: number; slot: number }>(
          'SELECT id,oferta_id,trimestre,slot FROM gradebook.instrumento ORDER BY id',
        )
      ).rows,
    ).toEqual(
      idsBefore.filter((row) => row.oferta_id !== idsBefore[0]!.oferta_id || row.slot !== 11),
    );
    expect(
      (await pg.query('SELECT count(*)::integer AS n FROM gradebook.nota_historico')).rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (await pg.query('SELECT count(*)::integer AS n FROM gradebook.instrumento_historico')).rows,
    ).toEqual([{ n: 0 }]);
    // Restore the reference snapshot so the subsequent last-block rollback compares the same state.
    expect((await service.execute(request)).state).toBe('applied');
  });

  it('keeps different teachers as different full offer identities', async () => {
    const request = { ...notes(1), professor: 'SYNTHETIC SECOND TEACHER' };
    expect((await createGradebookRelationalImportServiceV11(database).execute(request)).state).toBe(
      'applied',
    );
    expect(
      (
        await pg.query(
          `SELECT count(*)::integer AS n FROM gradebook.oferta o JOIN gradebook.turma t ON t.id=o.turma_id WHERE t.codigo='SYN-0'`,
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
  });

  it('shares a SQL-normalized offer identity across source positions without duplicating catalog rows', async () => {
    const teacher = (
      await pg.query<{ id: number }>(
        "SELECT id FROM gradebook.professor WHERE nome='SYNTHETIC TEACHER'",
      )
    ).rows[0]!.id;
    const turma = (
      await pg.query<{ id: number }>("SELECT id FROM gradebook.turma WHERE codigo='SYN-0'")
    ).rows[0]!.id;
    const catalog = await resolveRelationalImportCatalogV11(
      database,
      2026,
      teacher,
      [
        { sourceIndex: 0, turmaId: turma, name: 'SYNTHETIC SUBJECT' },
        { sourceIndex: 1, turmaId: turma, name: 'SYNTHETIC SUBJECT' },
      ],
      async () => {
        throw new Error('unexpected-fallback');
      },
    );
    expect(catalog.writes).toBe(0);
    expect(catalog.offers.get(0)).toEqual(catalog.offers.get(1));
  });

  it('rolls back earlier blocks on a failure while retaining a single transaction', async () => {
    const before = (
      await pg.query(
        'SELECT to_jsonb(n) AS row FROM gradebook.nota n ORDER BY instrumento_id,aluno_id',
      )
    ).rows;
    const request = notes(33);
    const changed = {
      ...request,
      ofertas: request.ofertas.map((offer) => ({
        ...offer,
        trimestres: offer.trimestres.map((term) => ({
          ...term,
          alunos: [[1, [2000, ['u'], null], 7000]],
        })) as unknown as typeof offer.trimestres,
      })),
    };
    calls.length = 0;
    failure = 'last-block';
    const beforeCommits = commits;
    await expect(
      createGradebookRelationalImportServiceV11(database).execute(changed),
    ).rejects.toThrow('synthetic-last-block');
    failure = 'none';
    expect(commits).toBe(beforeCommits);
    expect(
      calls.some(
        (sql) =>
          sql.includes('INSERT INTO gradebook.nota') || sql.includes('UPDATE gradebook.nota'),
      ),
    ).toBe(true);
    expect(calls.some((sql) => sql.includes('record_gradebook_change_v1'))).toBe(false);
    expect(
      (
        await pg.query(
          'SELECT to_jsonb(n) AS row FROM gradebook.nota n ORDER BY instrumento_id,aluno_id',
        )
      ).rows,
    ).toEqual(before);
  });
  it.each(['\t', '\u00a0'])(
    'preserves accepted raw subject whitespace %j and its legacy repeated conflict',
    async (whitespace) => {
      const service = createGradebookRelationalImportServiceV11(database);
      await service.execute(notes(1));
      const label = whitespace === '\t' ? 'SYNTHETIC TAB SUBJECT' : 'SYNTHETIC NBSP SUBJECT';
      const request = whitespaceNotes(1, `${whitespace}${label}${whitespace}`);
      expect(inspectGradebookImportPersistenceRequestV9(request)).toBe('ready');
      expect(await service.execute(request)).toMatchObject({
        state: 'applied',
        summary: { committedWrites: { total: 28 } },
      });
      expect(
        (await pg.query('SELECT nome FROM gradebook.disciplina WHERE nome=$1', [label])).rows,
      ).toEqual([{ nome: label }]);
      const before = (
        await pg.query(
          'SELECT to_jsonb(n) AS row FROM gradebook.nota n ORDER BY instrumento_id,aluno_id',
        )
      ).rows;
      const beforeCommits = commits;
      expect((await service.execute(request)).state).toBe('conflict');
      expect(commits).toBe(beforeCommits);
      expect(
        (
          await pg.query(
            'SELECT to_jsonb(n) AS row FROM gradebook.nota n ORDER BY instrumento_id,aluno_id',
          )
        ).rows,
      ).toEqual(before);
    },
  );

  it('preserves source order when raw-whitespace and plain subject labels share the inserted identity', async () => {
    const service = createGradebookRelationalImportServiceV11(database);
    await service.execute(notes(2));
    const label = 'SYNTHETIC MIXED WHITESPACE SUBJECT';
    const source = whitespaceNotes(2, label);
    const request = {
      ...source,
      ofertas: source.ofertas.map((offer, index) => ({
        ...offer,
        disciplina: index === 0 ? `\t${label}\t` : label,
      })),
    };
    expect(inspectGradebookImportPersistenceRequestV9(request)).toBe('ready');
    expect(await service.execute(request)).toMatchObject({
      state: 'applied',
      summary: { committedWrites: { total: 54 } },
    });
    expect(
      (
        await pg.query(
          `SELECT d.nome,count(o.id)::integer AS offers FROM gradebook.disciplina d JOIN gradebook.oferta o ON o.disciplina_id=d.id WHERE d.nome=$1 GROUP BY d.nome`,
          [label],
        )
      ).rows,
    ).toEqual([{ nome: label, offers: 2 }]);
    const reverseLabel = 'SYNTHETIC REVERSED WHITESPACE SUBJECT';
    const reverse = {
      ...source,
      ofertas: source.ofertas.map((offer, index) => ({
        ...offer,
        disciplina: index === 0 ? reverseLabel : `\t${reverseLabel}\t`,
      })),
    };
    expect(inspectGradebookImportPersistenceRequestV9(reverse)).toBe('ready');
    const beforeCommits = commits;
    expect((await service.execute(reverse)).state).toBe('conflict');
    expect(commits).toBe(beforeCommits);
    expect(
      (await pg.query('SELECT nome FROM gradebook.disciplina WHERE nome=$1', [reverseLabel])).rows,
    ).toEqual([]);
  });
});

it.each(['missing-column', 'duplicate-row', 'unexpected-offer'] as const)(
  'rejects malformed read-set results: %s',
  async (mode) => {
    const row = {
      id: 10,
      oferta_id: mode === 'unexpected-offer' ? 2 : 1,
      trimestre: 1,
      slot: 1,
      maximo: 0,
      ...(mode === 'missing-column' ? {} : { descricao: null }),
    };
    const fake: GradebookPostgresWritePortV1 = {
      query: async () => [],
      executeNative: async <T extends Record<string, unknown>>() => ({
        rows: (mode === 'duplicate-row' ? [row, row] : [row]) as unknown as readonly T[],
        changes: 0,
      }),
    };
    await expect(loadRelationalImportReadSetV11(fake, 2026, [1])).rejects.toThrow();
  },
);

it('rejects incomplete or duplicated catalog association without inventing identifiers', async () => {
  for (const rows of [
    [],
    [
      { source_index: 0, normalized: 'test', id: null, nome: null },
      { source_index: 0, normalized: 'test', id: null, nome: null },
    ],
  ]) {
    const fake: GradebookPostgresWritePortV1 = {
      query: async () => [],
      executeNative: async <T extends Record<string, unknown>>() => ({
        rows: rows as unknown as readonly T[],
        changes: 0,
      }),
    };
    await expect(
      resolveRelationalImportCatalogV11(
        fake,
        2026,
        1,
        [{ sourceIndex: 0, turmaId: 1, name: 'TEST' }],
        async () => {
          throw new Error('unexpected-fallback');
        },
      ),
    ).rejects.toThrow();
  }
});
