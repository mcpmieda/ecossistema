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
  readonly legacyBirthYear?: number | null;
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
  // Equal name/birth can belong to homonyms. Two explicit conflicts cannot be explained by a hash.
  if (
    compareReconciliationFieldV1(row.inepKey, source.current.inepKey) === 'different' &&
    compareReconciliationFieldV1(row.filiation1Key, source.current.filiation1Key) === 'different'
  )
    return false;
  if (row.birthDate === source.current.birthDate) {
    // Birth and filiation alone also match siblings; a reused hash cannot settle their identity.
    return row.nameKey === source.current.nameKey || equalV1(row.inepKey, source.current.inepKey);
  }
  // The only automatic birth correction is within a uniquely retained origin.
  return (
    row.nameKey === source.current.nameKey &&
    (equalV1(row.inepKey, source.current.inepKey) ||
      equalV1(row.filiation1Key, source.current.filiation1Key))
  );
}

function rejectedOriginConflictsV1(
  sources: readonly ReconciliationSourceV1[],
  rejectedPairs: readonly ReconciliationRejectedPairV1[],
): ReadonlyMap<string, readonly ReconciliationSourceV1[]> {
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  const byUid = new Map<string, ReconciliationSourceV1[]>();
  for (const source of sources) {
    if (!source.studentUid) continue;
    const linked = byUid.get(source.studentUid) ?? [];
    linked.push(source);
    byUid.set(source.studentUid, linked);
  }
  const conflicts = new Map<string, ReconciliationSourceV1[]>();
  const add = (left: ReconciliationSourceV1, right: ReconciliationSourceV1) => {
    const others = conflicts.get(left.sourceId) ?? [];
    others.push(right);
    conflicts.set(left.sourceId, others);
  };
  for (const pair of rejectedPairs) {
    const rejected = byId.get(pair.sourceId);
    if (!rejected) continue;
    for (const linked of byUid.get(pair.studentUid) ?? []) {
      if (linked.sourceId === rejected.sourceId) continue;
      add(linked, rejected);
      add(rejected, linked);
    }
  }
  return conflicts;
}

function rejectionContestsOriginV1(
  row: NormalizedReportRowV1,
  origin: ReconciliationSourceV1,
  conflicts: ReadonlyMap<string, readonly ReconciliationSourceV1[]>,
): boolean {
  const agreement = personalAgreementV1(row, origin.current);
  // A rejection separates both origins. Do not consume either one's observation, even as pending,
  // when the other person's current/history explains the row at least as well or owns its INEP.
  // These exact-field comparisons only veto continuity; neither counts nor hashes prove identity.
  return (conflicts.get(origin.sourceId) ?? []).some((source) =>
    observationsV1(source).some(
      (previous) =>
        (equalV1(row.inepKey, previous.inepKey) && !equalV1(row.inepKey, origin.current.inepKey)) ||
        ((row.nameKey === previous.nameKey || equalV1(row.inepKey, previous.inepKey)) &&
          personalAgreementV1(row, previous) >= agreement),
    ),
  );
}

function recognizeOriginsV1(
  rows: readonly ReconciliationReportRowV1[],
  sources: readonly ReconciliationSourceV1[],
  rejectedPairs: readonly ReconciliationRejectedPairV1[],
): ReadonlyMap<number, ReconciliationSourceV1> {
  const rejectedOrigins = rejectedOriginConflictsV1(sources, rejectedPairs);
  const proposals = new Map<number, readonly ReconciliationSourceV1[]>();
  const hashes = new Set(rows.map((row) => row.enrollmentHash));
  for (const row of rows) {
    const byHash = sources.filter((source) => hasHashV1(source, row.enrollmentHash));
    if (byHash.length > 0) {
      proposals.set(
        row.sourceRow,
        byHash.length === 1 &&
          continuationCompatibleV1(row, byHash[0]!) &&
          !rejectionContestsOriginV1(row, byHash[0]!, rejectedOrigins)
          ? byHash
          : [],
      );
    } else {
      proposals.set(
        row.sourceRow,
        sources.filter(
          (source) =>
            !observationsV1(source).some((observation) => hashes.has(observation.enrollmentHash)) &&
            samePersonalV1(row, source.current) &&
            !rejectionContestsOriginV1(row, source, rejectedOrigins),
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
      equalV1(previous.inepKey, row.inepKey) ||
      personalAgreementV1(row, previous) >= 2 ||
      (previous.nameKey === row.nameKey && previous.classKey === row.classKey),
  );
}

function legacyBirthConflictV1(
  row: ReconciliationReportRowV1,
  origin: ReconciliationSourceV1 | undefined,
  students: readonly ReconciliationStudentV1[],
  nameMatches: ReadonlySet<string>,
): boolean {
  const year = Number(row.birthDate.slice(0, 4));
  return students.some(
    (student) =>
      nameMatches.has(student.studentUid) &&
      student.legacyBirthYear !== null &&
      student.legacyBirthYear !== undefined &&
      student.legacyBirthYear !== year &&
      origin?.studentUid !== student.studentUid,
  );
}

interface SourceEvidenceV1 {
  /** Same INEP, or same name, birth and Filiação 1. */
  readonly personal: boolean;
  readonly rule: ReconciliationRuleV1 | null;
  readonly sibling: boolean;
  readonly sameBirth: boolean;
}

function sourceEvidenceV1(
  row: NormalizedReportRowV1,
  previous: NormalizedReportRowV1,
  settled: boolean,
): SourceEvidenceV1 {
  const sameInep = equalV1(row.inepKey, previous.inepKey);
  const sameName = row.nameKey === previous.nameKey;
  const sameBirth = row.birthDate === previous.birthDate;
  const sameFiliation = equalV1(row.filiation1Key, previous.filiation1Key);
  const differentInep = compareReconciliationFieldV1(row.inepKey, previous.inepKey) === 'different';
  const samePerson = sameName && sameBirth && sameFiliation;
  let rule: ReconciliationRuleV1 | null = null;
  if (sameInep && sameBirth) rule = 'inep_birth';
  if (samePerson && differentInep) rule = 'name_birth_filiation';
  return {
    personal: sameInep || samePerson,
    rule,
    sibling: !sameName && sameBirth && sameFiliation && differentInep && !settled,
    sameBirth,
  };
}

interface RowContextV1 {
  readonly row: ReconciliationReportRowV1;
  readonly origin: ReconciliationSourceV1 | undefined;
  readonly sources: readonly ReconciliationSourceV1[];
  readonly nameMatches: ReadonlySet<string>;
  /** An origin already linked and not under review identifies the row by itself. A relative with
   * the same birth and filiation, or a rejection recorded for another pairing, does not reopen it. */
  readonly settledUid: string | null;
}

/** Evidence of the origins already linked to a person; fills the candidates and rules of the row. */
function linkedEvidenceV1(
  context: RowContextV1,
  rules: Map<string, ReconciliationRuleV1>,
  candidates: Set<string>,
) {
  const { row, origin, sources, nameMatches, settledUid } = context;
  const selectedUids = new Set(
    sources.filter((source) => source.profileSelected).map((source) => source.studentUid),
  );
  let sibling = false;
  let sourceReview = false;
  let birthConflict = false;
  for (const source of sources) {
    const uid = source.studentUid;
    if (!uid || (selectedUids.has(uid) && !source.profileSelected)) continue;
    const evidence = sourceEvidenceV1(row, source.current, settledUid !== null);
    if (evidence.personal || evidence.sibling) candidates.add(uid);
    if (evidence.rule) rules.set(uid, evidence.rule);
    const relevant = evidence.personal || nameMatches.has(uid);
    const approvedBirthCorrection = source.sourceId === origin?.sourceId;
    sibling ||= evidence.sibling;
    sourceReview ||= relevant && source.reviewRequired === true;
    birthConflict ||= relevant && !evidence.sameBirth && !approvedBirthCorrection;
  }
  return { sibling, sourceReview, birthConflict };
}

function rejectedCandidatesV1(
  context: RowContextV1,
  rejectedPairs: readonly ReconciliationRejectedPairV1[],
): readonly string[] {
  const { row, origin, sources, settledUid } = context;
  return rejectedPairs
    .filter(
      (pair) =>
        settledUid === null ||
        (pair.sourceId === origin?.sourceId && pair.studentUid === settledUid),
    )
    .filter((pair) => {
      const rejectedSource = sources.find((source) => source.sourceId === pair.sourceId);
      return (
        rejectedSource !== undefined &&
        (origin?.sourceId === pair.sourceId || rejectionEvidenceV1(row, rejectedSource))
      );
    })
    .map((pair) => pair.studentUid);
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
  const settledUid = origin?.studentUid && !origin.reviewRequired ? origin.studentUid : null;
  const context: RowContextV1 = { row, origin, sources, nameMatches, settledUid };
  const linked = linkedEvidenceV1(context, rules, candidates);
  if (origin?.studentUid) {
    candidates.add(origin.studentUid);
    rules.set(origin.studentUid, 'continuity');
  }
  const rejectedUids = rejectedCandidatesV1(context, rejectedPairs);
  for (const uid of rejectedUids) candidates.add(uid);
  const knownHash = sources.some((source) => hasHashV1(source, row.enrollmentHash));
  return {
    row,
    origin,
    rules,
    candidates,
    priorBirthConflict:
      legacyBirthConflictV1(row, origin, students, nameMatches) || linked.birthConflict,
    homonym: nameMatches.size > 1,
    rejected: rejectedUids.length > 0,
    sourceConflict: knownHash && origin === undefined,
    sourceReview: origin?.reviewRequired === true || linked.sourceReview,
    sibling: linked.sibling,
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
    // A report class keeps its first original label; spacing variants share its canonical content.
    row.classKey,
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
  return JSON.stringify({
    normalizationVersion: 1,
    rows: rows.map(reportRowContentV1).sort(compareTextV1),
  });
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
  const origins = recognizeOriginsV1(input.rows, input.sources, input.rejectedPairs);
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
