import type {
  AttendanceCandidateV1,
  AttendanceCollectionV1,
  AttendanceMonthlySummaryV1,
  AttendanceRelationStudentV1,
  AttendanceScopeV1,
  AttendanceSourceRecordV1,
} from '../../shared/attendance-contracts/attendance-v1';

export class AttendanceErrorV1 extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}

export function normalizeAttendanceTextV1(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').trim().replace(/\s+/gu, ' ').toUpperCase();
}

export function attendanceSchoolDateV1(instant: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function attendanceFingerprintV1(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export interface StoredAttendanceDecisionV1 {
  evidenceFingerprint: string;
  studentUid: string;
  decision: 'same-student' | 'different-students';
  revision: number;
  canConfirm?: boolean;
}

export async function attendanceCandidatesV1(
  scope: AttendanceScopeV1,
  batch: Pick<AttendanceCollectionV1, 'sourceVersion' | 'reportIdentity' | 'rosterComplete'>,
  records: readonly AttendanceSourceRecordV1[],
  relation: readonly AttendanceRelationStudentV1[],
  decisions: readonly StoredAttendanceDecisionV1[],
): Promise<AttendanceCandidateV1[]> {
  const norm = normalizeAttendanceTextV1;
  const nameKey = (r: AttendanceSourceRecordV1) =>
    `${norm(r.originalClass)}\u0000${norm(r.originalName)}`;
  const output = await Promise.all(
    records.map(async (record): Promise<AttendanceCandidateV1> => {
      const candidates = relation.filter((r) => norm(r.originalName) === norm(record.originalName));
      const fingerprint = await attendanceFingerprintV1({
        scope,
        reportIdentity: batch.reportIdentity,
        recordKey: record.recordKey,
        identityBasis: record.identityBasis,
        name: norm(record.originalName),
        class: norm(record.originalClass),
        // A report-local key is not a durable person identity. Never replay decisions across revisions.
        localVersion: record.identityBasis === 'report-local' ? batch.sourceVersion : null,
        candidates: candidates
          .map((r) => ({
            studentUid: r.studentUid,
            classId: r.classId,
            name: norm(r.originalName),
            class: norm(r.originalClass),
          }))
          .sort((a, b) => a.studentUid.localeCompare(b.studentUid)),
      });
      const latest = new Map<string, StoredAttendanceDecisionV1>();
      for (const d of [...decisions].sort((a, b) => a.revision - b.revision)) {
        if (d.evidenceFingerprint === fingerprint) latest.set(d.studentUid, d);
      }
      const accepted = [...latest.values()].filter(
        (d) =>
          d.decision === 'same-student' &&
          d.canConfirm !== false &&
          relation.some((r) => r.studentUid === d.studentUid && r.classId === scope.classId),
      );
      const exact = candidates.filter(
        (r) => r.classId === scope.classId && norm(r.originalClass) === norm(record.originalClass),
      );
      const sourceUnique = records.filter((r) => nameKey(r) === nameKey(record)).length === 1;
      const auto =
        batch.rosterComplete && exact.length === 1 && sourceUnique ? exact[0] : undefined;
      const rejected = auto && latest.get(auto.studentUid)?.decision === 'different-students';
      const selected =
        accepted.length === 1
          ? accepted[0]!.studentUid
          : !rejected && auto
            ? auto.studentUid
            : null;
      return {
        recordKey: record.recordKey,
        originalName: record.originalName,
        originalClass: record.originalClass,
        state:
          accepted.length === 1
            ? 'human-confirmed'
            : rejected
              ? 'rejected'
              : selected
                ? 'identified'
                : 'needs-review',
        studentUid: accepted.length > 1 ? null : selected,
        candidateUids: candidates
          .filter((r) => latest.get(r.studentUid)?.decision !== 'different-students')
          .map((r) => r.studentUid),
        evidenceFingerprint: fingerprint,
      };
    }),
  );
  // Human decisions and automatic suggestions must still form a one-to-one mapping.
  for (const candidate of output) {
    if (
      candidate.studentUid &&
      output.filter((r) => r.studentUid === candidate.studentUid).length > 1
    ) {
      candidate.state = 'needs-review';
    }
  }
  return output.map((c) => (c.state === 'needs-review' ? { ...c, studentUid: null } : c));
}

export function validateAttendanceCollectionV1(input: AttendanceCollectionV1): void {
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (
    !unique(input.records.map((r) => r.recordKey)) ||
    !unique(input.coverage.map((d) => `${d.recordKey}/${d.date}`)) ||
    !unique(input.marks.map((m) => `${m.recordKey}/${m.date}/${m.slot}`))
  ) {
    throw new AttendanceErrorV1('duplicate-source-evidence', 400);
  }
  const keys = new Set(input.records.map((r) => r.recordKey));
  const coverageByDay = new Map(input.coverage.map((c) => [`${c.recordKey}/${c.date}`, c]));
  const observedDate = attendanceSchoolDateV1(input.observedAt);
  for (const c of input.coverage) {
    if (
      !keys.has(c.recordKey) ||
      Number(c.date.slice(0, 4)) !== input.scope.academicYear ||
      c.date > observedDate
    ) {
      throw new AttendanceErrorV1('invalid-coverage', 400);
    }
  }
  for (const m of input.marks) {
    const c = coverageByDay.get(`${m.recordKey}/${m.date}`);
    if (!c?.slots.includes(m.slot)) throw new AttendanceErrorV1('mark-outside-coverage', 400);
  }
}

export function attendanceMonthlySummaryV1(input: {
  month: string;
  today: string;
  recordKey: string;
  calendar: { date: string; eligible: boolean; slots: number[] }[];
  enrollments: { startsOn: string; endsOn: string | null }[];
  collection: AttendanceCollectionV1;
}): AttendanceMonthlySummaryV1 {
  const eligible = input.calendar.filter(
    (d) =>
      d.eligible &&
      d.date.startsWith(input.month) &&
      d.date <= input.today &&
      input.enrollments.some(
        (e) => e.startsOn <= d.date && (e.endsOn === null || d.date <= e.endsOn),
      ),
  );
  const denominator = eligible.reduce((sum, d) => sum + d.slots.length, 0);
  const covered = eligible.every((d) => {
    const c = input.collection.coverage.find(
      (v) => v.recordKey === input.recordKey && v.date === d.date,
    );
    return (
      c?.complete &&
      d.date <= attendanceSchoolDateV1(input.collection.observedAt) &&
      d.slots.every((s) => c.slots.includes(s)) &&
      c.slots.every((s) => d.slots.includes(s))
    );
  });
  const reliable = input.collection.rosterComplete && denominator > 0 && covered;
  const datesAndLessons = input.collection.marks
    .filter((m) => m.recordKey === input.recordKey && eligible.some((d) => d.date === m.date))
    .map(({ date, slot, mark }) => ({ date, slot, mark }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.slot - b.slot);
  const x = datesAndLessons.filter((m) => m.mark === 'X').length;
  const j = datesAndLessons.filter((m) => m.mark === 'J').length;
  return {
    month: input.month,
    absences: reliable ? x : null,
    justified: reliable ? j : null,
    datesAndLessons,
    denominator: reliable ? denominator : null,
    // J stays separate. No claim that a justification removes an absent lesson from attendance.
    percentage: reliable ? ((denominator - x - j) * 100) / denominator : null,
    coverage: reliable ? 'reliable' : 'incomplete',
    lastUpdated: input.collection.observedAt,
  };
}
