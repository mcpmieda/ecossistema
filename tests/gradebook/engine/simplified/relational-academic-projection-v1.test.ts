// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { GradebookPostgresReadPortV1 } from '../../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createRelationalAcademicProjectionServiceV1 } from '../../../../server/gradebook/application/results/relational-academic-projection-v1';

type Row = Record<string, unknown>;

function fakeDatabase(input: {
  readonly base?: Row | null;
  readonly instruments?: readonly Row[];
  readonly closing?: Row | null;
  readonly queries?: string[];
}): GradebookPostgresReadPortV1 {
  return {
    // One joined read: every instrument row carries the offer, the year and the closing.
    async query<T extends Row>(sql: string, values: readonly unknown[] = []) {
      input.queries?.push(sql);
      if (!input.base) return [] as T[];
      const shared = { oferta_id: values[0], aluno_id: values[1], ...input.base, ...(input.closing ?? {}) };
      const instruments = input.instruments ?? [];
      return (instruments.length ? instruments.map((row) => ({ ...shared, ...row })) : [{ ...shared, trimestre: null }]) as unknown as T[];
    },
  };
}

function termRows(
  term: 1 | 2 | 3,
  values: { readonly av1: number; readonly av2: number; readonly qualitative: number; readonly parallel?: number | null },
): Row[] {
  const avMaximum = term === 3 ? 9_000 : 6_750;
  const qualitativeMaximum = term === 3 ? 22_000 : 16_500;
  const rows: Row[] = [
    { trimestre: term, slot: 1, maximo: avMaximum, valor: values.av1 },
    { trimestre: term, slot: 2, maximo: avMaximum, valor: values.av2 },
    { trimestre: term, slot: 11, maximo: qualitativeMaximum, valor: values.qualitative },
  ];
  if (values.parallel !== undefined) {
    rows.push({ trimestre: term, slot: 3, maximo: null, valor: values.parallel });
  }
  return rows;
}

const base = { ano: 2026, minimo_aprovacao: 60_000 } as const;

describe('relational academic projection v1', () => {
  it('projects canonical relational facts and homologates AM/U without persisting derived rows', async () => {
    const database = fakeDatabase({
      base,
      instruments: [
        ...termRows(1, { av1: 6_000, av2: 6_000, qualitative: 8_000 }),
        ...termRows(2, { av1: 6_000, av2: 6_000, qualitative: 8_000 }),
        ...termRows(3, { av1: 6_000, av2: 6_000, qualitative: 8_000 }),
      ],
      closing: {
        am1_fonte: 20_000,
        am2_fonte: 20_000,
        am3_fonte: 20_000,
        rec1: null,
        rec2: null,
        rec3: null,
        rec_nc_mask: 0,
        u_fonte: 60_000,
      },
    });

    const projection = await createRelationalAcademicProjectionServiceV1(database).projectMany([{
      ofertaId: 41,
      alunoId: 9,
    }]).then((values) => values[0]!);

    expect(projection.ano).toBe(2026);
    expect(projection.minimumApprovalMilli).toBe(60_000);
    expect(projection.terms.map((term) => term.sourceComparison)).toEqual(['match', 'match', 'match']);
    expect(projection.recovery.classification).toBe('approved-direct');
    expect(projection.recovery.postRecoveryTotalMilli).toBe(60_000);
    expect(projection.sourceUComparison).toBe('match');
  });

  it('requires the offer to belong to the current, non-FOI_PARA binding', async () => {
    const queries: string[] = [];
    const database = fakeDatabase({ base: null, queries });

    await expect(
      createRelationalAcademicProjectionServiceV1(database).projectMany([{ ofertaId: 99, alunoId: 12 }]).then((values) => values[0]!),
    ).rejects.toMatchObject({ code: 'offer-student-not-found' });

    expect(queries[0]).toContain('COALESCE(v.situacao, 0) <> 6');
  });

  it('treats an empty Z as no parallel gain while keeping the term complete', async () => {
    const database = fakeDatabase({
      base,
      instruments: [
        ...termRows(1, { av1: 2_000, av2: 2_000, qualitative: 10_000 }),
        ...termRows(2, { av1: 6_000, av2: 6_000, qualitative: 8_000 }),
        ...termRows(3, { av1: 8_000, av2: 8_000, qualitative: 8_000 }),
      ],
      closing: {
        am1_fonte: 14_000,
        am2_fonte: 20_000,
        am3_fonte: 24_000,
        rec1: null,
        rec2: null,
        rec3: null,
        rec_nc_mask: 0,
        u_fonte: null,
      },
    });

    const projection = await createRelationalAcademicProjectionServiceV1(database).projectMany([{
      ofertaId: 7,
      alunoId: 3,
    }]).then((values) => values[0]!);

    expect(projection.terms[0].outcome.parallelApplicable).toBe(true);
    expect(projection.terms[0].outcome.parallelMilli).toBeNull();
    expect(projection.terms[0].outcome.quantitativeConsideredMilli).toBe(4_000);
    expect(projection.terms[0].outcome.coverage.complete).toBe(true);
    expect(projection.terms[0].outcome.coverage.missingSlots).not.toContain(3);
    expect(projection.terms[0].sourceComparison).toBe('match');
  });

  it('preserves REC N/C from the bit mask and produces automatic no-show failure', async () => {
    const database = fakeDatabase({
      base,
      instruments: [
        ...termRows(1, { av1: 2_000, av2: 2_000, qualitative: 6_000 }),
        ...termRows(2, { av1: 6_000, av2: 6_000, qualitative: 8_000 }),
        ...termRows(3, { av1: 6_000, av2: 6_000, qualitative: 8_000 }),
      ],
      closing: {
        am1_fonte: 10_000,
        am2_fonte: 20_000,
        am3_fonte: 20_000,
        rec1: null,
        rec2: null,
        rec3: null,
        rec_nc_mask: 1,
        u_fonte: null,
      },
    });

    const projection = await createRelationalAcademicProjectionServiceV1(database).projectMany([{
      ofertaId: 5,
      alunoId: 2,
    }]).then((values) => values[0]!);

    expect(projection.recovery.originalTotalMilli).toBe(50_000);
    expect(projection.recovery.recoveryTerms[1]).toMatchObject({ applicable: true, source: 'NC' });
    expect(projection.recovery.classification).toBe('failed-no-show');
    expect(projection.sourceUComparison).toBe('unavailable');
  });

  it('surfaces a source mismatch without changing the canonical facts', async () => {
    const database = fakeDatabase({
      base,
      instruments: [
        ...termRows(1, { av1: 6_000, av2: 6_000, qualitative: 7_255 }),
        ...termRows(2, { av1: 6_000, av2: 6_000, qualitative: 8_000 }),
        ...termRows(3, { av1: 8_000, av2: 8_000, qualitative: 8_000 }),
      ],
      closing: {
        am1_fonte: 19_500,
        am2_fonte: 20_000,
        am3_fonte: 24_000,
        rec1: null,
        rec2: null,
        rec3: null,
        rec_nc_mask: 0,
        u_fonte: null,
      },
    });

    const projection = await createRelationalAcademicProjectionServiceV1(database).projectMany([{
      ofertaId: 6,
      alunoId: 4,
    }]).then((values) => values[0]!);

    expect(projection.terms[0].outcome.rawMilli).toBe(19_255);
    expect(projection.terms[0].outcome.roundedMilli).toBe(19_000);
    expect(projection.terms[0].sourceComparison).toBe('mismatch');
  });
});
