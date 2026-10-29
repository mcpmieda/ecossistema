import { describe, expect, it } from 'vitest';
import { applyStudentReportV2 } from '../../server/attendance/student-report-v2';
import { StudentReportPendingV2, type StudentReportPreviousV2 } from '../../server/attendance/service-v2';
import type { FrequencyStudentReportV2 } from '../../shared/attendance-contracts/frequency-v2';
import type {
  ReconciliationRequestV1,
  ReconciliationResponseV1,
} from '../../shared/student-identity/reconciliation-v1';

const context = { generation: '70000000-0000-4000-8000-000000000001', revision: 4, nameSource: 'relation' as const, relationAvailable: true };
const row = (sourceRow: number, fields: Record<string, unknown> = {}) => ({
  sourceRow, name: `ALUNA SINTETICA ${sourceRow}`, birthDate: 41640, filiation1: null, inep: null,
  enrollmentHash: `hash-${sourceRow}`, classLabel: '6A 2026 - MATUTINO', shift: 'MATUTINO',
  stageLabel: 'ENSINO FUNDAMENTAL DE 9 ANOS - 6º ANO', status: 'MATRICULADO', enrolledAt: 46023, transferredAt: null,
  ...fields,
});
const input = (rows = [row(2), row(3)]) => ({
  operation: 'student-report-collect', academicYear: 2026, requestId: '80000000-0000-4000-8000-000000000001',
  fencingToken: 1, sourceVersion: `sha256:${'f'.repeat(64)}`, observedAt: '2026-01-10T12:00:00Z', rows,
}) as FrequencyStudentReportV2;
const catalog: ReconciliationResponseV1 = {
  contractVersion: 1, state: 'ready', operation: 'catalog', context,
  classes: [{ id: 101, label: '6A', stage: 6 }],
  reportClasses: [{ id: 'c1', label: '6A 2026 - MATUTINO', shift: 'MATUTINO', stageLabel: 'ENSINO FUNDAMENTAL DE 9 ANOS - 6º ANO', classId: 101, reviewRequired: false }],
};
const prepared = (fields: Record<string, unknown> = {}) => ({
  contractVersion: 1, state: 'ready', operation: 'prepare', context: { ...context, revision: 5 },
  batchId: '90000000-0000-4000-8000-000000000001', batchState: 'preparing', expiresAt: '2026-01-11T12:00:00Z',
  differences: [], counts: { rows: 2, linked: 2, pending: 0 }, credentialsReady: false, ...fields,
}) as ReconciliationResponseV1;

/** A Conciliação that answers each operation from a queue, recording every request. */
function fake(answers: Partial<Record<ReconciliationRequestV1['operation'], ReconciliationResponseV1[]>>) {
  const requests: ReconciliationRequestV1[] = [];
  return {
    requests,
    reconciliation: {
      async execute(request: unknown) {
        const value = request as ReconciliationRequestV1;
        requests.push(value);
        const queue = answers[value.operation];
        if (value.operation === 'stage') return { contractVersion: 1, state: 'ready', operation: 'stage', ready: false, remaining: 0 } as ReconciliationResponseV1;
        if (!queue?.length) throw new Error(`unexpected ${value.operation}`);
        return queue.length > 1 ? queue.shift()! : queue[0]!;
      },
    },
  };
}
const ready = async () => ({ state: 'ready' as const, remaining: 0 });
const pending = (previous: StudentReportPreviousV2 | null = null) => new StudentReportPendingV2('h'.repeat(43), previous);
const committed = { contractVersion: 1, state: 'committed', context, operationId: 'x' } as ReconciliationResponseV1;

describe('automatic student report (Conciliação steps)', () => {
  it('prepares with the linked classes, prepares the credentials and applies confirming the differences', async () => {
    const { reconciliation, requests } = fake({ catalog: [catalog], prepare: [prepared({ batchState: 'review_required', differences: ['1 origem(ns) não encontrada(s) no relatório.'] })], apply: [committed] });
    // An AEE class is left out before anything is prepared, as the ADM's reader does.
    const outcome = await applyStudentReportV2(reconciliation, ready, input([row(2), row(3), row(4, { classLabel: 'AEE - SALA MULTIFUNCIONAL' })]), pending());
    expect(outcome).toMatchObject({ outcome: 'applied', changed: true, batchId: '90000000-0000-4000-8000-000000000001',
      notes: { counts: { linked: 2 }, differences: ['1 origem(ns) não encontrada(s) no relatório.'], invalid: [] } });
    const prepare = requests.find((r) => r.operation === 'prepare') as Extract<ReconciliationRequestV1, { operation: 'prepare' }>;
    expect(prepare).toMatchObject({ sourceYear: 2026, confirmYear: false, date1904: false, expectedRevision: 4,
      classLinks: [{ classLabel: '6A 2026 - MATUTINO', gradebookClassId: 101 }] });
    expect(prepare.rows.map((r) => r.sourceRow)).toEqual([2, 3]);
    expect(Date.parse(prepare.sourceGeneratedAt!)).toBeLessThanOrEqual(Date.parse('2026-01-10T12:00:00Z'));
    expect(requests.find((r) => r.operation === 'apply')).toMatchObject({ confirmDifferences: true, expectedRevision: 5 });
  });

  it('sets a row with an invalid cell aside, lists it and applies the rest', async () => {
    const invalid: ReconciliationResponseV1 = { contractVersion: 1, state: 'validation-failed',
      errors: [{ sourceRow: 3, name: 'ALUNA SINTETICA 3', classLabel: '6A 2026 - MATUTINO', field: 'birthDate', reason: 'nascimento ausente.' }] };
    const { reconciliation, requests } = fake({ catalog: [catalog], prepare: [invalid, prepared()], apply: [committed] });
    const outcome = await applyStudentReportV2(reconciliation, ready, input(), pending());
    expect(outcome.outcome).toBe('applied');
    expect(outcome.notes.invalid).toEqual([{ sourceRow: 3, name: 'ALUNA SINTETICA 3', classLabel: '6A 2026 - MATUTINO', field: 'birthDate', reason: 'nascimento ausente.' }]);
    const prepares = requests.filter((r) => r.operation === 'prepare') as Extract<ReconciliationRequestV1, { operation: 'prepare' }>[];
    expect(prepares.map((r) => r.rows.map((x) => x.sourceRow))).toEqual([[2, 3], [2]]);
  });

  it('nothing right: everything goes to the Conciliação and nothing is applied', async () => {
    const invalid: ReconciliationResponseV1 = { contractVersion: 1, state: 'validation-failed',
      errors: [2, 3].map((sourceRow) => ({ sourceRow, name: `ALUNA SINTETICA ${sourceRow}`, classLabel: '6A 2026 - MATUTINO', field: 'birthDate' as const, reason: 'nascimento ausente.' })) };
    const { reconciliation, requests } = fake({ catalog: [catalog], prepare: [invalid] });
    const outcome = await applyStudentReportV2(reconciliation, ready, input(), pending());
    expect(outcome).toMatchObject({ outcome: 'review', batchId: null, changed: true });
    expect(outcome.notes.invalid).toHaveLength(2);
    expect(outcome.notes.differences).toEqual(['Nenhuma linha do relatório pôde ser aplicada.']);
    expect(requests.some((r) => r.operation === 'apply')).toBe(false);
  });

  it('an unlinked class is listed; its rows wait for the link', async () => {
    const { reconciliation, requests } = fake({ catalog: [catalog], prepare: [prepared()], apply: [committed] });
    const outcome = await applyStudentReportV2(reconciliation, ready, input([row(2), row(3, { classLabel: '6Z 2026 - MATUTINO' })]), pending());
    expect(outcome.notes.differences[0]).toContain('6Z 2026 - MATUTINO sem ligação');
    const prepare = requests.find((r) => r.operation === 'prepare') as Extract<ReconciliationRequestV1, { operation: 'prepare' }>;
    expect(prepare.classLinks.find((l) => l.classLabel === '6Z 2026 - MATUTINO')?.gradebookClassId).toBeNull();
  });

  it('credentials not ready yet: the batch is kept and the same report goes on with it', async () => {
    const first = fake({ catalog: [catalog], prepare: [prepared()] });
    const slow = async () => ({ state: 'preparing' as const, remaining: 9 });
    const outcome = await applyStudentReportV2(first.reconciliation, slow, input(), pending());
    expect(outcome).toMatchObject({ outcome: 'preparing', batchId: '90000000-0000-4000-8000-000000000001' });
    const second = fake({ catalog: [{ ...catalog, context: { ...context, revision: 5 } } as ReconciliationResponseV1], apply: [committed] });
    const done = await applyStudentReportV2(second.reconciliation, ready, input(),
      pending({ evidenceHash: 'h'.repeat(43), outcome: 'preparing', batchId: outcome.batchId, notes: outcome.notes }));
    expect(done).toMatchObject({ outcome: 'applied', batchId: outcome.batchId });
    expect(second.requests.some((r) => r.operation === 'prepare')).toBe(false);
  });

  it('a Conciliação changed under it is read again and prepared anew', async () => {
    const conflict = { contractVersion: 1, state: 'conflict' } as ReconciliationResponseV1;
    const { reconciliation, requests } = fake({ catalog: [catalog], prepare: [prepared()], apply: [conflict, committed] });
    const outcome = await applyStudentReportV2(reconciliation, ready, input(), pending());
    expect(outcome.outcome).toBe('applied');
    expect(requests.filter((r) => r.operation === 'prepare')).toHaveLength(2);
  });

  it('still before the Relação, the same report is only freshness', async () => {
    const { reconciliation, requests } = fake({ catalog: [{ ...catalog, context: { ...context, relationAvailable: false } } as ReconciliationResponseV1] });
    const notes = { counts: { rows: 2, linked: 0, pending: 2 }, differences: [], invalid: [] };
    const outcome = await applyStudentReportV2(reconciliation, ready, input(),
      pending({ evidenceHash: 'h'.repeat(43), outcome: 'awaiting_relation', batchId: 'b', notes }));
    expect(outcome).toMatchObject({ outcome: 'awaiting_relation', changed: false, notes });
    expect(requests.map((r) => r.operation)).toEqual(['catalog']);
  });
});

describe('the report hash is the Coletor one', () => {
  it('studentReportHashV2 matches the value pinned in the Coletor (tests/test_student_report.py)', async () => {
    const { studentReportHashV2 } = await import('../../server/attendance/service-v2');
    const rows = [2, 3].map((sourceRow) => ({
      sourceRow, name: sourceRow === 2 ? 'ALUNA SINTETICA UM' : 'ALUNO SINTETICO DOIS', classLabel: '6A 2026 - MATUTINO',
      shift: 'MATUTINO', stageLabel: 'ENSINO FUNDAMENTAL DE 9 ANOS - 6º ANO', status: sourceRow === 2 ? 'MATRICULADO' : 'TRANSFERIDO',
      enrollmentHash: 'hash-sintetico', filiation1: 'MAE SINTETICA', inep: 123456789012, birthDate: 41640, enrolledAt: 46023,
      transferredAt: sourceRow === 2 ? null : 46300,
    }));
    expect(await studentReportHashV2({ rows: [...rows].reverse() })).toBe('LQ96URThFLmWCfKP4nKEFcuu0SV7jnbjc2NJEXLFiXM');
  });
});
