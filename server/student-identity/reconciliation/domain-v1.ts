export interface NormalizedReportRowV1 {
  readonly sourceRow: number;
  readonly name: string;
  readonly nameKey: string;
  readonly birthDate: string;
  readonly filiation1: string | null;
  readonly filiation1Key: string | null;
  readonly inep: string | null;
  readonly inepKey: string | null;
  readonly enrollmentHash: string;
  readonly classLabel: string;
  readonly classKey: string;
  readonly shift: string;
  readonly shiftKey: string;
  readonly stage: number;
  readonly status: string;
  readonly statusKey: string;
  readonly enrolledAt: string | null;
  readonly transferredAt: string | null;
}

export interface ReconciliationReportRowV1 extends NormalizedReportRowV1 {
  readonly classId: number | null;
}

export interface ReconciliationStudentV1 {
  readonly studentUid: string;
  readonly classId: number;
  readonly nameKey: string;
}

export interface ReconciliationSourceV1 {
  readonly sourceId: string;
  readonly current: NormalizedReportRowV1;
  readonly studentUid: string | null;
  readonly history?: readonly NormalizedReportRowV1[];
  readonly reviewRequired?: boolean;
  readonly profileSelected?: boolean;
}

export interface ReconciliationRejectedPairV1 {
  readonly sourceId: string;
  readonly studentUid: string;
}

export type ReconciliationRuleV1 =
  'continuity' | 'name_class' | 'inep_birth' | 'name_birth_filiation';

export type ReconciliationPendingReasonV1 =
  | 'class_unlinked'
  | 'birth_conflict'
  | 'homonym'
  | 'identity_conflict'
  | 'source_conflict'
  | 'source_review'
  | 'rejected'
  | 'sibling_candidate'
  | 'no_match';

export interface ReconciliationRowPlanV1 {
  readonly sourceRow: number;
  readonly sourceId: string | null;
  readonly studentUid: string | null;
  readonly rule: ReconciliationRuleV1 | null;
  readonly reason: ReconciliationPendingReasonV1 | null;
  readonly candidateUids: readonly string[];
}

export interface ReconciliationProfilePlanV1 {
  readonly studentUid: string;
  readonly sourceRows: readonly number[];
  readonly selectedSourceRow: number | null;
  readonly reason: 'profile_conflict' | null;
}

export interface StudentReconciliationPlanV1 {
  readonly rows: readonly ReconciliationRowPlanV1[];
  readonly profiles: readonly ReconciliationProfilePlanV1[];
}

export type FieldComparisonV1 = 'equal' | 'different' | 'empty';

export function compareReconciliationFieldV1(
  left: string | null,
  right: string | null,
): FieldComparisonV1 {
  if (!left || !right) return 'empty';
  return left === right ? 'equal' : 'different';
}

function equalV1(left: string | null, right: string | null): boolean {
  return compareReconciliationFieldV1(left, right) === 'equal';
}

function personalAgreementV1(left: NormalizedReportRowV1, right: NormalizedReportRowV1): number {
  return [
    equalV1(left.nameKey, right.nameKey),
    equalV1(left.birthDate, right.birthDate),
    equalV1(left.inepKey, right.inepKey),
    equalV1(left.filiation1Key, right.filiation1Key),
  ].filter(Boolean).length;
}

function samePersonalV1(left: NormalizedReportRowV1, right: NormalizedReportRowV1): boolean {
  return (
    left.nameKey === right.nameKey &&
    left.birthDate === right.birthDate &&
    left.inepKey === right.inepKey &&
    left.filiation1Key === right.filiation1Key
  );
}

function observationsV1(source: ReconciliationSourceV1): readonly NormalizedReportRowV1[] {
  return [source.current, ...(source.history ?? [])];
}

function hasHashV1(source: ReconciliationSourceV1, hash: string): boolean {
  return hash !== '' && observationsV1(source).some((entry) => entry.enrollmentHash === hash);
}

function continuationCompatibleV1(
  row: NormalizedReportRowV1,
  source: ReconciliationSourceV1,
): boolean {
  if (personalAgreementV1(row, source.current) < 2) return false;
  if (row.birthDate === source.current.birthDate) return true;
  // The only automatic birth correction is within a uniquely retained origin.
  return (
    row.nameKey === source.current.nameKey &&
    (equalV1(row.inepKey, source.current.inepKey) ||
      equalV1(row.filiation1Key, source.current.filiation1Key))
  );
}

function recognizeOriginsV1(
  rows: readonly ReconciliationReportRowV1[],
  sources: readonly ReconciliationSourceV1[],
): ReadonlyMap<number, ReconciliationSourceV1> {
  const proposals = new Map<number, readonly ReconciliationSourceV1[]>();
  const hashes = new Set(rows.map((row) => row.enrollmentHash));
  for (const row of rows) {
    const byHash = sources.filter((source) => hasHashV1(source, row.enrollmentHash));
    if (byHash.length > 0) {
      proposals.set(
        row.sourceRow,
        byHash.length === 1 && continuationCompatibleV1(row, byHash[0]!) ? byHash : [],
      );
    } else {
      proposals.set(
        row.sourceRow,
        sources.filter(
          (source) =>
            !observationsV1(source).some((observation) => hashes.has(observation.enrollmentHash)) &&
            samePersonalV1(row, source.current),
        ),
      );
    }
  }
  const usage = new Map<string, number>();
  for (const candidates of proposals.values()) {
    for (const source of candidates)
      usage.set(source.sourceId, (usage.get(source.sourceId) ?? 0) + 1);
  }
  const result = new Map<number, ReconciliationSourceV1>();
  for (const [row, candidates] of proposals) {
    const source = candidates[0];
    if (candidates.length === 1 && source && usage.get(source.sourceId) === 1)
      result.set(row, source);
  }
  return result;
}

interface RowCandidatesV1 {
  readonly row: ReconciliationReportRowV1;
  readonly origin: ReconciliationSourceV1 | undefined;
  readonly rules: ReadonlyMap<string, ReconciliationRuleV1>;
  readonly candidates: ReadonlySet<string>;
  readonly priorBirthConflict: boolean;
  readonly homonym: boolean;
  readonly rejected: boolean;
  readonly sourceConflict: boolean;
  readonly sourceReview: boolean;
  readonly sibling: boolean;
}

function rejectionEvidenceV1(row: NormalizedReportRowV1, source: ReconciliationSourceV1): boolean {
  return observationsV1(source).some(
    (previous) =>
      previous.enrollmentHash === row.enrollmentHash ||
      personalAgreementV1(row, previous) >= 2 ||
      (previous.nameKey === row.nameKey && previous.classKey === row.classKey),
  );
}

function candidatesForRowV1(
  row: ReconciliationReportRowV1,
  origin: ReconciliationSourceV1 | undefined,
  students: readonly ReconciliationStudentV1[],
  sources: readonly ReconciliationSourceV1[],
  rejectedPairs: readonly ReconciliationRejectedPairV1[],
): RowCandidatesV1 {
  const rules = new Map<string, ReconciliationRuleV1>();
  const candidates = new Set<string>();
  const nameMatches = new Set(
    students
      .filter((student) => student.classId === row.classId && student.nameKey === row.nameKey)
      .map((student) => student.studentUid),
  );
  for (const uid of nameMatches) {
    rules.set(uid, 'name_class');
    candidates.add(uid);
  }
  let priorBirthConflict = false;
  let sourceReview = origin?.reviewRequired === true;
  let sibling = false;
  const selectedUids = new Set(
    sources.filter((source) => source.profileSelected).map((source) => source.studentUid),
  );
  for (const source of sources) {
    if (!source.studentUid) continue;
    if (selectedUids.has(source.studentUid) && !source.profileSelected) continue;
    const previous = source.current;
    const sameInep = equalV1(row.inepKey, previous.inepKey);
    const sameName = row.nameKey === previous.nameKey;
    const sameBirth = row.birthDate === previous.birthDate;
    const sameFiliation = equalV1(row.filiation1Key, previous.filiation1Key);
    const differentInep =
      compareReconciliationFieldV1(row.inepKey, previous.inepKey) === 'different';
    const personalCandidate = sameInep || (sameName && sameBirth && sameFiliation);
    if (personalCandidate) candidates.add(source.studentUid);
    if (sameInep && sameBirth) rules.set(source.studentUid, 'inep_birth');
    if (sameName && sameBirth && sameFiliation && differentInep) {
      rules.set(source.studentUid, 'name_birth_filiation');
    }
    if (!sameName && sameBirth && sameFiliation && differentInep) {
      candidates.add(source.studentUid);
      sibling = true;
    }
    const relevant = personalCandidate || nameMatches.has(source.studentUid);
    if (relevant && source.reviewRequired) sourceReview = true;
    const approvedBirthCorrection = source.sourceId === origin?.sourceId;
    if (relevant && !sameBirth && !approvedBirthCorrection) priorBirthConflict = true;
  }
  if (origin?.studentUid) {
    candidates.add(origin.studentUid);
    rules.set(origin.studentUid, 'continuity');
  }
  let rejected = false;
  for (const pair of rejectedPairs) {
    const rejectedSource = sources.find((source) => source.sourceId === pair.sourceId);
    if (
      rejectedSource &&
      (origin?.sourceId === pair.sourceId || rejectionEvidenceV1(row, rejectedSource))
    ) {
      candidates.add(pair.studentUid);
      rejected = true;
    }
  }
  const hashSources = sources.filter((source) => hasHashV1(source, row.enrollmentHash));
  return {
    row,
    origin,
    rules,
    candidates,
    priorBirthConflict,
    homonym: nameMatches.size > 1,
    rejected,
    sourceConflict: hashSources.length > 0 && origin === undefined,
    sourceReview,
    sibling,
  };
}

function overlapV1(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].some((uid) => right.has(uid));
}

function reasonV1(
  entry: RowCandidatesV1,
  all: readonly RowCandidatesV1[],
): ReconciliationPendingReasonV1 | null {
  if (entry.row.classId === null) return 'class_unlinked';
  const conflictingBirth = all.some(
    (other) =>
      other.row.sourceRow !== entry.row.sourceRow &&
      other.row.birthDate !== entry.row.birthDate &&
      (overlapV1(entry.candidates, other.candidates) ||
        (entry.row.nameKey === other.row.nameKey && entry.row.classId === other.row.classId)),
  );
  if (entry.priorBirthConflict || conflictingBirth) return 'birth_conflict';
  if (entry.homonym) return 'homonym';
  if (entry.rejected) return 'rejected';
  if (entry.sourceReview) return 'source_review';
  if (entry.sourceConflict) return 'source_conflict';
  if (entry.candidates.size > 1) return 'identity_conflict';
  if (entry.sibling && entry.rules.size === 0) return 'sibling_candidate';
  if (entry.rules.size === 0) return 'no_match';
  return null;
}

/** A stable allowlisted representation; row position never establishes identity. */
export function reportRowContentV1(row: NormalizedReportRowV1): string {
  return JSON.stringify([
    row.name,
    row.nameKey,
    row.birthDate,
    row.filiation1,
    row.filiation1Key,
    row.inep,
    row.inepKey,
    row.enrollmentHash,
    row.classLabel,
    row.classKey,
    row.shift,
    row.shiftKey,
    row.stage,
    row.status,
    row.statusKey,
    row.enrolledAt,
    row.transferredAt,
  ]);
}

export function reportContentV1(rows: readonly NormalizedReportRowV1[]): string {
  return JSON.stringify({ normalizationVersion: 1, rows: rows.map(reportRowContentV1).sort(compareTextV1) });
}

// Canonical content must keep the same ordering regardless of the runtime locale.
function compareTextV1(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}

export function planStudentReconciliationV1(input: {
  readonly rows: readonly ReconciliationReportRowV1[];
  readonly students: readonly ReconciliationStudentV1[];
  readonly sources: readonly ReconciliationSourceV1[];
  readonly rejectedPairs: readonly ReconciliationRejectedPairV1[];
}): StudentReconciliationPlanV1 {
  const origins = recognizeOriginsV1(input.rows, input.sources);
  const candidates = input.rows.map((row) =>
    candidatesForRowV1(
      row,
      origins.get(row.sourceRow),
      input.students,
      input.sources,
      input.rejectedPairs,
    ),
  );
  const rows = candidates.map((entry): ReconciliationRowPlanV1 => {
    const reason = reasonV1(entry, candidates);
    const uid = reason === null ? [...entry.rules.keys()][0]! : null;
    return {
      sourceRow: entry.row.sourceRow,
      sourceId: entry.origin?.sourceId ?? null,
      studentUid: uid,
      rule: uid ? entry.rules.get(uid)! : null,
      reason,
      candidateUids: [...entry.candidates].sort(compareTextV1),
    };
  });
  const byUid = new Map<string, ReconciliationReportRowV1[]>();
  for (const plan of rows) {
    if (!plan.studentUid) continue;
    const group = byUid.get(plan.studentUid) ?? [];
    group.push(input.rows.find((row) => row.sourceRow === plan.sourceRow)!);
    byUid.set(plan.studentUid, group);
  }
  const profiles = [...byUid]
    .sort(([left], [right]) => compareTextV1(left, right))
    .map(([studentUid, group]): ReconciliationProfilePlanV1 => {
      const sorted = [...group].sort(
        (left, right) =>
          compareTextV1(reportRowContentV1(left), reportRowContentV1(right)) ||
          left.sourceRow - right.sourceRow,
      );
      const conflict = !sorted.every((row) => samePersonalV1(row, sorted[0]!));
      return {
        studentUid,
        sourceRows: group.map((row) => row.sourceRow).sort((left, right) => left - right),
        selectedSourceRow: conflict ? null : sorted[0]!.sourceRow,
        reason: conflict ? 'profile_conflict' : null,
      };
    });
  return { rows, profiles };
}

export function adoptedStudentNameV1(
  source: 'relation' | 'report',
  relationName: string | null,
  reportName: string | null,
): string | null {
  return source === 'relation' ? (relationName ?? reportName) : (reportName ?? relationName);
}
