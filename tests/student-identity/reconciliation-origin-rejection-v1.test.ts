// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  planStudentReconciliationV1,
  type ReconciliationReportRowV1,
  type ReconciliationSourceV1,
} from '../../server/student-identity/reconciliation/domain-v1';

const student = { studentUid: 'synthetic-uid-a', classId: 7, nameKey: 'SYNTHETIC HOMONYM' };
const row = (patch: Partial<ReconciliationReportRowV1> = {}): ReconciliationReportRowV1 => ({
  sourceRow: 2,
  name: 'SYNTHETIC HOMONYM',
  nameKey: 'SYNTHETIC HOMONYM',
  birthDate: '2013-03-04',
  filiation1: 'SYNTHETIC GUARDIAN A',
  filiation1Key: 'SYNTHETIC GUARDIAN A',
  inep: '001',
  inepKey: '001',
  enrollmentHash: 'synthetic-hash-a',
  classLabel: '7A 2026 - MATUTINO',
  classKey: '7A 2026 - MATUTINO',
  classId: 7,
  shift: 'MATUTINO',
  shiftKey: 'MATUTINO',
  stage: 7,
  status: 'CURSANDO',
  statusKey: 'CURSANDO',
  enrolledAt: null,
  transferredAt: null,
  ...patch,
});
const source = (current = row()): ReconciliationSourceV1 => ({
  sourceId: 'synthetic-source-a',
  studentUid: student.studentUid,
  current,
  history: [row({ enrollmentHash: 'synthetic-old-a' })],
});
const scenarios = (['swapped', 'reused', 'historical'] as const).flatMap((kind) =>
  [false, true].flatMap((reverseRows) =>
    [false, true].flatMap((reverseSources) =>
      (['both', 'inep', 'filiation', 'empty'] as const).flatMap((difference) =>
        [false, true].map((historicalRejection) => ({
          kind, reverseRows, reverseSources, difference, historicalRejection,
        })),
      ),
    ),
  ),
);

describe('rejected homonyms cannot consume another origin', () => {
  it.each(scenarios)(
    '$kind/$difference, historical rejection $historicalRejection, rows $reverseRows, sources $reverseSources',
    ({ kind, difference, historicalRejection, reverseRows, reverseSources }) => {
      const a = row();
      const b = row({
        sourceRow: 3,
        inep: difference === 'empty' ? null : difference === 'filiation' ? a.inep : '002',
        inepKey: difference === 'empty' ? null : difference === 'filiation' ? a.inepKey : '002',
        filiation1: difference === 'empty' ? null : difference === 'inep' ? a.filiation1 : 'GUARDIAN B',
        filiation1Key: difference === 'empty' ? null : difference === 'inep' ? a.filiation1Key : 'GUARDIAN B',
        enrollmentHash: 'synthetic-hash-b',
      });
      const rejected: ReconciliationSourceV1 = {
        sourceId: 'synthetic-source-b',
        studentUid: null,
        current: historicalRejection ? row({
          sourceRow: 3, name: 'RENAMED B', nameKey: 'RENAMED B',
          inep: '003', inepKey: '003', filiation1: 'RENAMED GUARDIAN',
          filiation1Key: 'RENAMED GUARDIAN', enrollmentHash: 'synthetic-current-b',
        }) : b,
        history: historicalRejection ? [b] : [],
      };
      const rows = [
        { ...a, enrollmentHash: kind === 'swapped' ? b.enrollmentHash : 'synthetic-new-a' },
        { ...b, enrollmentHash: kind === 'historical' ? 'synthetic-old-a' : a.enrollmentHash },
      ];
      const sources = [source(), rejected];
      const input = {
        rows: reverseRows ? [...rows].reverse() : rows,
        sources: reverseSources ? [...sources].reverse() : sources,
        students: [student],
        rejectedPairs: [{ sourceId: rejected.sourceId, studentUid: student.studentUid }],
      };
      const before = structuredClone(input);
      const result = planStudentReconciliationV1(input);
      expect(result.rows.find((entry) => entry.sourceRow === 3)).toMatchObject({
        sourceId: null, studentUid: null, reason: 'rejected',
      });
      // Neither side of the rejection may acquire the other person's current observation.
      expect(result.rows.every((entry) => entry.sourceId === null)).toBe(true);
      expect(result.profiles).toEqual([]);
      expect(input).toEqual(before);
    },
  );

  it.each(['synthetic-hash-a', 'synthetic-new-hash'])(
    'does not outvote a rejected INEP with corrected name/filiation: %s', (enrollmentHash) => {
      const result = planStudentReconciliationV1({
        rows: [row({ enrollmentHash, inep: '002', inepKey: '002' })],
        sources: [source(), {
          sourceId: 'synthetic-source-b', studentUid: null,
          current: row({ name: 'OTHER', nameKey: 'OTHER', inep: '002', inepKey: '002',
            filiation1: 'OTHER GUARDIAN', filiation1Key: 'OTHER GUARDIAN', enrollmentHash: 'synthetic-hash-b' }),
        }],
        students: [student],
        rejectedPairs: [{ sourceId: 'synthetic-source-b', studentUid: student.studentUid }],
      });
      expect(result.rows[0]).toMatchObject({ sourceId: null, studentUid: null, reason: 'rejected' });
      expect(result.profiles).toEqual([]);
    },
  );

  it('does not treat name/birth plus two explicit conflicts as continuity without a rejection', () => {
    const result = planStudentReconciliationV1({
      rows: [row({ inep: '002', inepKey: '002', filiation1: 'OTHER', filiation1Key: 'OTHER' })],
      sources: [source()], students: [student], rejectedPairs: [],
    });
    expect(result.rows[0]).toMatchObject({ sourceId: null, studentUid: null, reason: 'source_conflict' });
    expect(result.profiles).toEqual([]);
  });

  it.each([
    { name: 'CORRECTED', nameKey: 'CORRECTED' },
    { inep: '009', inepKey: '009' },
    { filiation1: 'CORRECTED', filiation1Key: 'CORRECTED' },
    { birthDate: '2012-03-04' },
    { inep: null, inepKey: null, filiation1: null, filiation1Key: null },
    { enrollmentHash: 'synthetic-new-hash' },
  ])('retains legitimate corrections and explicit empty fields: %j', (patch) => {
    const result = planStudentReconciliationV1({
      rows: [row(patch)], sources: [source()], students: [student], rejectedPairs: [],
    });
    expect(result.rows[0]).toMatchObject({ studentUid: student.studentUid, rule: 'continuity', reason: null });
  });

  it.each([false, true])('retains settled twins with cross-rejections, new hashes %s', (changed) => {
    const b = row({ sourceRow: 3, name: 'TWIN B', nameKey: 'TWIN B', inep: '002', inepKey: '002', enrollmentHash: 'synthetic-hash-b' });
    const twin = { studentUid: 'synthetic-uid-b', classId: 7, nameKey: b.nameKey };
    const result = planStudentReconciliationV1({
      rows: [row(), b].map((entry) => ({ ...entry, enrollmentHash: entry.enrollmentHash + (changed ? '-new' : '') })),
      sources: [source(), { sourceId: 'synthetic-source-b', studentUid: twin.studentUid, current: b }],
      students: [student, twin],
      rejectedPairs: [
        { sourceId: 'synthetic-source-a', studentUid: twin.studentUid },
        { sourceId: 'synthetic-source-b', studentUid: student.studentUid },
      ],
    });
    expect(result.rows.map((entry) => entry.studentUid)).toEqual([student.studentUid, twin.studentUid]);
    expect(result.rows.every((entry) => entry.reason === null)).toBe(true);
  });

  it('does not use a new hash to override equally specific historical rejected evidence', () => {
    const result = planStudentReconciliationV1({
      rows: [row({ enrollmentHash: 'synthetic-new-hash' })],
      sources: [source(), {
        sourceId: 'synthetic-source-b', studentUid: null,
        current: row({ name: 'OTHER', nameKey: 'OTHER', inep: '002', inepKey: '002', enrollmentHash: 'synthetic-hash-b' }),
        history: [row({ enrollmentHash: 'synthetic-old-b' })],
      }],
      students: [student],
      rejectedPairs: [{ sourceId: 'synthetic-source-b', studentUid: student.studentUid }],
    });
    expect(result.rows[0]).toMatchObject({ sourceId: null, studentUid: null, reason: 'rejected' });
  });
});
