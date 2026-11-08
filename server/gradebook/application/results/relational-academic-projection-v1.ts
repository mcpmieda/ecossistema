import { ACTIVE_INSTRUMENT_PREDICATE_V1 } from '../../persistence/postgres/active-instrument-predicate-v1';
import type { GradebookPostgresReadPortV1 } from '../../persistence/postgres/postgres-database-v1';
import { createGradebookPostgresParametersV1 } from '../../persistence/postgres/postgres-parameters-v1';
import {
  resolveSimplifiedComponentRecoveryV1,
  resolveSimplifiedTermV1,
  type SimplifiedAcademicTermV1,
  type SimplifiedComponentRecoveryOutcomeV1,
  type SimplifiedInstrumentFactV1,
  type SimplifiedRecoveryValueV1,
  type SimplifiedTermOutcomeV1,
} from '../../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';

type Row = Record<string, unknown>;
type BindValue = string | number | null;

interface RelationalProjectionRequestV1 {
  readonly ofertaId: number;
  readonly alunoId: number;
}

// A technical bound for one read, not a limit on a class or an academic rule.
export const RELATIONAL_PROJECTION_BATCH_LIMIT_V1 = 1_000;

export type RelationalSourceComparisonV1 = 'match' | 'mismatch' | 'unavailable';

export interface RelationalTermProjectionV1 {
  readonly term: SimplifiedAcademicTermV1;
  readonly outcome: SimplifiedTermOutcomeV1;
  readonly sourceAmMilli: number | null;
  readonly sourceComparison: RelationalSourceComparisonV1;
}

export interface RelationalAcademicProjectionV1 {
  readonly ano: number;
  readonly ofertaId: number;
  readonly alunoId: number;
  readonly minimumApprovalMilli: number;
  readonly terms: readonly [
    RelationalTermProjectionV1,
    RelationalTermProjectionV1,
    RelationalTermProjectionV1,
  ];
  readonly recovery: SimplifiedComponentRecoveryOutcomeV1;
  readonly sourceUMilli: number | null;
  readonly sourceUComparison: RelationalSourceComparisonV1;
}

type RelationalAcademicProjectionErrorCodeV1 =
  | 'offer-student-not-found'
  | 'invalid-relational-row'
  | 'incomplete-offer-definition'
  | 'projection-batch-too-large';

class RelationalAcademicProjectionErrorV1 extends Error {
  constructor(readonly code: RelationalAcademicProjectionErrorCodeV1) {
    super(code);
    this.name = 'RelationalAcademicProjectionErrorV1';
  }
}

function asInteger(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new RelationalAcademicProjectionErrorV1('invalid-relational-row');
  }
  return number;
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return asInteger(value);
}

function validateRequest(input: RelationalProjectionRequestV1): void {
  if (
    !Number.isSafeInteger(input.ofertaId) || input.ofertaId <= 0 ||
    input.ofertaId > 2_147_483_647 ||
    !Number.isSafeInteger(input.alunoId) || input.alunoId <= 0 ||
    input.alunoId > 2_147_483_647
  ) {
    throw new RelationalAcademicProjectionErrorV1('invalid-relational-row');
  }
}

function requestKey(input: RelationalProjectionRequestV1): string {
  return `${input.ofertaId}:${input.alunoId}`;
}

async function all<T extends Row>(
  database: GradebookPostgresReadPortV1,
  sql: string,
  values: readonly BindValue[],
): Promise<readonly T[]> {
  return database.query<T>(sql, values);
}

function sourceComparison(
  calculated: number | null,
  source: number | null,
): RelationalSourceComparisonV1 {
  if (calculated === null || source === null) return 'unavailable';
  return calculated === source ? 'match' : 'mismatch';
}

function recoveryValue(
  row: Row | null,
  term: SimplifiedAcademicTermV1,
): SimplifiedRecoveryValueV1 {
  if (!row) return null;
  const mask = asInteger(row.rec_nc_mask ?? 0);
  const rrMask = asInteger(row.rec_rr_mask ?? 0);
  const bit = 1 << (term - 1);
  if ((rrMask & bit) !== 0) return 'RR';
  if ((mask & bit) !== 0) return 'NC';
  return nullableInteger(row[`rec${term}`]);
}

// Both read paths use exactly the same central engine and source comparison.
function projectRows(
  input: RelationalProjectionRequestV1,
  base: Row,
  instrumentRows: readonly Row[],
  closing: Row | null,
): RelationalAcademicProjectionV1 {
  const terms = [1, 2, 3].map((termValue) => {
    const term = termValue as SimplifiedAcademicTermV1;
    const facts: SimplifiedInstrumentFactV1[] = instrumentRows
      .filter((row) => asInteger(row.trimestre) === term)
      .map((row) => ({
        slot: asInteger(row.slot) as SimplifiedInstrumentFactV1['slot'],
        maximumMilli: nullableInteger(row.maximo),
        valueMilli: nullableInteger(row.valor),
      }));
    let outcome: SimplifiedTermOutcomeV1;
    try {
      outcome = resolveSimplifiedTermV1({ term, instruments: facts });
    } catch {
      throw new RelationalAcademicProjectionErrorV1('incomplete-offer-definition');
    }
    const sourceAmMilli = closing ? nullableInteger(closing[`am${term}_fonte`]) : null;
    return {
      term,
      outcome,
      sourceAmMilli,
      sourceComparison: sourceComparison(outcome.roundedMilli, sourceAmMilli),
    } satisfies RelationalTermProjectionV1;
  }) as unknown as RelationalAcademicProjectionV1['terms'];

  const minimumApprovalMilli = asInteger(base.minimo_aprovacao);
  const recovery = resolveSimplifiedComponentRecoveryV1({
    terms: [terms[0].outcome, terms[1].outcome, terms[2].outcome],
    recovery: {
      1: recoveryValue(closing, 1),
      2: recoveryValue(closing, 2),
      3: recoveryValue(closing, 3),
    },
    minimumApprovalMilli,
  });
  const sourceUMilli = closing ? nullableInteger(closing.u_fonte) : null;
  return {
    ano: asInteger(base.ano),
    ofertaId: input.ofertaId,
    alunoId: input.alunoId,
    minimumApprovalMilli,
    terms,
    recovery,
    sourceUMilli,
    sourceUComparison: sourceComparison(recovery.postRecoveryTotalMilli, sourceUMilli),
  };
}

export function createRelationalAcademicProjectionServiceV1(database: GradebookPostgresReadPortV1) {
  return {
    /**
     * One parameterized PostgreSQL statement for the whole bounded set. Instruments,
     * grades and closing facts share the statement snapshot; no per-pair SQL, writes,
     * persistent cache, source-authority switch or legacy record reconstruction.
     * Callers still own authorization and the requested institutional scope.
     */
    async projectMany(
      requests: readonly RelationalProjectionRequestV1[],
    ): Promise<readonly RelationalAcademicProjectionV1[]> {
      if (requests.length > RELATIONAL_PROJECTION_BATCH_LIMIT_V1) {
        throw new RelationalAcademicProjectionErrorV1('projection-batch-too-large');
      }
      if (requests.length === 0) return [];
      const requestedKeys = new Set<string>();
      for (const input of requests) {
        validateRequest(input);
        const key = requestKey(input);
        if (requestedKeys.has(key)) {
          throw new RelationalAcademicProjectionErrorV1('invalid-relational-row');
        }
        requestedKeys.add(key);
      }
      // Only placeholder syntax is interpolated. Identifiers are bound values.
      const { param, values } = createGradebookPostgresParametersV1();
      const placeholders = requests.map((input) =>
        `(${param(input.ofertaId)}::integer, ${param(input.alunoId)}::integer)`).join(', ');
      const rows = await all<Row>(
        database,
        `WITH requested(oferta_id, aluno_id) AS (VALUES ${placeholders})
         SELECT r.oferta_id, r.aluno_id, o.ano, y.minimo_aprovacao,
                i.trimestre, i.slot, i.maximo, n.valor,
                f.am1_fonte, f.am2_fonte, f.am3_fonte,
                f.rec1, f.rec2, f.rec3, f.rec_nc_mask,
                COALESCE((to_jsonb(f)->>'rec_rr_mask')::smallint, 0) AS rec_rr_mask,
                f.u_fonte
         FROM requested r
         JOIN gradebook.oferta o ON o.id = r.oferta_id
         JOIN gradebook.ano_letivo y ON y.ano = o.ano
         LEFT JOIN gradebook.instrumento i ON i.oferta_id = o.id AND ${ACTIVE_INSTRUMENT_PREDICATE_V1}
         LEFT JOIN gradebook.nota n ON n.instrumento_id = i.id AND n.aluno_id = r.aluno_id
         LEFT JOIN gradebook.fechamento f ON f.oferta_id = o.id AND f.aluno_id = r.aluno_id
         WHERE EXISTS (
           SELECT 1 FROM gradebook.vinculo v
           WHERE v.turma_id = o.turma_id AND v.ano = o.ano
             AND v.aluno_id = r.aluno_id AND COALESCE(v.situacao, 0) <> 6
         )
         ORDER BY r.oferta_id, r.aluno_id, i.trimestre, i.slot`,
        values,
      );
      const groups = new Map<string, { base: Row; instruments: Row[] }>();
      for (const row of rows) {
        const key = requestKey({
          ofertaId: asInteger(row.oferta_id),
          alunoId: asInteger(row.aluno_id),
        });
        if (!requestedKeys.has(key)) {
          throw new RelationalAcademicProjectionErrorV1('invalid-relational-row');
        }
        const group = groups.get(key) ?? { base: row, instruments: [] };
        if (row.trimestre !== null && row.trimestre !== undefined) group.instruments.push(row);
        groups.set(key, group);
      }
      // Missing membership is an error, never a synthetic zero/empty projection.
      if (groups.size !== requests.length) {
        throw new RelationalAcademicProjectionErrorV1('offer-student-not-found');
      }
      return requests.map((input) => {
        const group = groups.get(requestKey(input))!;
        return projectRows(input, group.base, group.instruments, group.base);
      });
    },
  };
}
