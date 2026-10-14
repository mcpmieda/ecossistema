// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  attendanceRequestV1,
  type AttendanceCollectionV1,
} from '../../shared/attendance-contracts/attendance-v1';
import {
  attendanceCandidatesV1,
  attendanceMonthlySummaryV1,
  normalizeAttendanceTextV1,
  validateAttendanceCollectionV1,
} from '../../server/attendance/domain-v1';

const uid = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const scope = { academicYear: 2026, classId: 101 };
const record = {
  recordKey: 'report-row-a',
  originalName: 'ALUNA SINTÉTICA',
  originalClass: '6A',
  identityBasis: 'durable' as const,
};
const student = {
  studentUid: uid,
  originalName: 'Aluna sintetica',
  originalClass: '6A',
  classId: 101,
};
const batch = {
  sourceVersion: 'synthetic-v1',
  reportIdentity: 'synthetic-report',
  rosterComplete: true,
};
const collection: AttendanceCollectionV1 = {
  operation: 'collect',
  scope,
  requestId: uid,
  expectedRevision: 0,
  collectorId: uid,
  fencingToken: 1,
  ...batch,
  reportKind: 'annual-detailed-collective',
  observedAt: '2026-01-10T12:00:00Z',
  records: [record],
  coverage: [
    { recordKey: record.recordKey, date: '2026-01-05', slots: [1, 2, 3, 4, 5, 6], complete: true },
  ],
  marks: [
    { recordKey: record.recordKey, date: '2026-01-05', slot: 6, mark: 'X' },
    { recordKey: record.recordKey, date: '2026-01-05', slot: 1, mark: 'J' },
  ],
};

describe('attendance identity and sparse summary invariants', () => {
  it('normalizes only comparison and preserves original text', async () => {
    expect(normalizeAttendanceTextV1('  Aluna  sintética ')).toBe('ALUNA SINTETICA');
    const [candidate] = await attendanceCandidatesV1(scope, batch, [record], [student], []);
    expect(candidate).toMatchObject({
      state: 'identified',
      studentUid: uid,
      originalName: record.originalName,
    });
  });
  it('blocks homonyms, normalization collisions and source duplicates', async () => {
    const homonym = { ...student, studentUid: other, originalName: 'ALUNA SINTÉTICA' };
    expect(
      (await attendanceCandidatesV1(scope, batch, [record], [student, homonym], []))[0]!.studentUid,
    ).toBeNull();
    const duplicate = { ...record, recordKey: 'report-row-b' };
    expect(
      (await attendanceCandidatesV1(scope, batch, [record, duplicate], [student], [])).every(
        (c) => c.state === 'needs-review',
      ),
    ).toBe(true);
  });
  it('requires human choice on class divergence and partial rosters', async () => {
    expect(
      (
        await attendanceCandidatesV1(
          scope,
          batch,
          [{ ...record, originalClass: '6B' }],
          [student],
          [],
        )
      )[0]!.studentUid,
    ).toBeNull();
    expect(
      (
        await attendanceCandidatesV1(
          scope,
          { ...batch, rosterComplete: false },
          [record],
          [student],
          [],
        )
      )[0]!.studentUid,
    ).toBeNull();
  });
  it('suppresses rejected ambiguous candidates until relevant evidence changes', async () => {
    const homonym = { ...student, studentUid: other };
    const first = (
      await attendanceCandidatesV1(scope, batch, [record], [student, homonym], [])
    )[0]!;
    const decision = {
      evidenceFingerprint: first.evidenceFingerprint,
      studentUid: uid,
      decision: 'different-students' as const,
      revision: 1,
    };
    const next = (
      await attendanceCandidatesV1(
        scope,
        { ...batch, sourceVersion: 'v2' },
        [record],
        [student, homonym],
        [decision],
      )
    )[0]!;
    expect(next.candidateUids).toEqual([other]);
    const changed = (
      await attendanceCandidatesV1(
        scope,
        batch,
        [{ ...record, originalClass: '6B' }],
        [student, homonym],
        [decision],
      )
    )[0]!;
    expect(changed.candidateUids).toContain(uid);
    const cosmetic = (
      await attendanceCandidatesV1(
        scope,
        batch,
        [{ ...record, originalName: '  Aluna sintética ' }],
        [student, homonym],
        [decision],
      )
    )[0]!;
    expect(cosmetic.candidateUids).not.toContain(uid);
  });
  it('does not replay report-local decisions across source revisions', async () => {
    const local = {
      ...record,
      identityBasis: 'report-local' as const,
      originalName: 'NOME SINTETICO DIVERGENTE',
    };
    const first = (await attendanceCandidatesV1(scope, batch, [local], [student], []))[0]!;
    const decisions = [
      {
        evidenceFingerprint: first.evidenceFingerprint,
        studentUid: uid,
        decision: 'same-student' as const,
        revision: 1,
      },
    ];
    expect(
      (await attendanceCandidatesV1(scope, batch, [local], [student], decisions))[0]!.state,
    ).toBe('human-confirmed');
    expect(
      (
        await attendanceCandidatesV1(
          scope,
          { ...batch, sourceVersion: 'v2' },
          [local],
          [student],
          decisions,
        )
      )[0]!.studentUid,
    ).toBeNull();
  });
  it('keeps X and J separately and counts the sixth eligible position', () => {
    const summary = attendanceMonthlySummaryV1({
      month: '2026-01',
      today: '2026-01-10',
      recordKey: record.recordKey,
      calendar: [{ date: '2026-01-05', eligible: true, slots: [1, 2, 3, 4, 5, 6] }],
      enrollments: [{ startsOn: '2026-01-01', endsOn: null }],
      collection,
    });
    expect(summary).toMatchObject({
      absences: 1,
      justified: 1,
      denominator: 6,
      coverage: 'reliable',
    });
    expect(summary.percentage).toBeCloseTo((100 * 4) / 6);
    expect(summary.datesAndLessons).toHaveLength(2);
  });
  it('never treats absent/incomplete data as presence or zero absences', () => {
    const base = {
      month: '2026-01',
      today: '2026-01-10',
      recordKey: record.recordKey,
      calendar: [{ date: '2026-01-05', eligible: true, slots: [1, 2, 3, 4, 5, 6] }],
      enrollments: [{ startsOn: '2026-01-01', endsOn: null }],
    };
    for (const c of [
      { ...collection, coverage: [] },
      { ...collection, coverage: [{ ...collection.coverage[0]!, slots: [1, 2, 3, 4, 5] }] },
      { ...collection, coverage: [{ ...collection.coverage[0]!, complete: false }] },
    ]) {
      expect(attendanceMonthlySummaryV1({ ...base, collection: c })).toMatchObject({
        absences: null,
        justified: null,
        denominator: null,
        percentage: null,
        coverage: 'incomplete',
      });
    }
  });
  it('excludes nonteaching, future and outside-enrollment dates', () => {
    const summary = attendanceMonthlySummaryV1({
      month: '2026-01',
      today: '2026-01-04',
      recordKey: record.recordKey,
      calendar: [
        { date: '2026-01-05', eligible: true, slots: [1, 2, 3, 4, 5, 6] },
        { date: '2026-01-03', eligible: false, slots: [1] },
        { date: '2026-01-02', eligible: true, slots: [1] },
      ],
      enrollments: [{ startsOn: '2026-01-04', endsOn: null }],
      collection,
    });
    expect(summary).toMatchObject({ percentage: null, denominator: null, datesAndLessons: [] });
  });
  it('rejects empty batches, duplicate evidence and unobserved marks', () => {
    expect(attendanceRequestV1.safeParse({ ...collection, records: [] }).success).toBe(false);
    expect(attendanceRequestV1.safeParse({ ...collection, coverage: [] }).success).toBe(false);
    expect(() =>
      validateAttendanceCollectionV1({ ...collection, records: [record, record] }),
    ).toThrow('duplicate-source-evidence');
    expect(() =>
      validateAttendanceCollectionV1({
        ...collection,
        marks: [{ ...collection.marks[0]!, date: '2026-01-06' }],
      }),
    ).toThrow('mark-outside-coverage');
    expect(() =>
      validateAttendanceCollectionV1({ ...collection, observedAt: '2026-01-04T12:00:00Z' }),
    ).toThrow('invalid-coverage');
  });
  it('does not turn future coverage into presence as time advances', () => {
    const summary = attendanceMonthlySummaryV1({
      month: '2026-01',
      today: '2026-01-10',
      recordKey: record.recordKey,
      calendar: [{ date: '2026-01-05', eligible: true, slots: [1, 2, 3, 4, 5, 6] }],
      enrollments: [{ startsOn: '2026-01-01', endsOn: null }],
      collection: { ...collection, observedAt: '2026-01-04T12:00:00Z', marks: [] },
    });
    expect(summary.percentage).toBeNull();
  });
  it('does not discard the sixth Smecel position when calendar supplies only five', () => {
    const summary = attendanceMonthlySummaryV1({
      month: '2026-01',
      today: '2026-01-10',
      recordKey: record.recordKey,
      calendar: [{ date: '2026-01-05', eligible: true, slots: [1, 2, 3, 4, 5] }],
      enrollments: [{ startsOn: '2026-01-01', endsOn: null }],
      collection,
    });
    expect(summary).toMatchObject({ denominator: null, percentage: null, coverage: 'incomplete' });
    expect(summary.datesAndLessons).toContainEqual({ date: '2026-01-05', slot: 6, mark: 'X' });
  });
});
