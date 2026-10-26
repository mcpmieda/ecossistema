import { z } from 'zod';
import {
  selfResponseV1,
  type SelfResponseV1,
} from '../../../shared/student-portal-contracts/self-v1';
import { academicVersionSchemaV1 } from '../../../shared/gradebook-contracts/student-portal/academic-revision-v1';
import { compareSourceSubjectPresentationV1 } from '../../../shared/gradebook-contracts/source/subject-abbreviations-v1';
import { AcademicStudentReaderPostgresV1, academicToSelfV1 } from '../academic/academic-reader-v1';
import { accessGateV1, applyPublishedVisibilityV1 } from '../policies/calendar-v1';
import type { StudentPortalPostgresQueryV1 } from '../persistence/postgres-persistence-v1';
import type { publicationContextV1 } from './self-projection-reader-v1';
import { dataVectorV1, PERIODS_V1, publicationDigestV1 } from './state-v1';
import { readLatestSourceV2, readScopedSourcesV2, readStudentKeyV2 } from './scoped-source-v2';
import {
  attachTermClosingsV1,
  buildTermClosingsV1,
  endedPeriodsV1,
  termClosingTargetsV1,
} from './term-closing-self-v1';
import { settingsValueV1 } from '../../../shared/student-portal-contracts/policy-v1';

type ContextV2 = NonNullable<Awaited<ReturnType<typeof publicationContextV1>>>;
export type ScopedSelfSourceReaderV2 = {
  scoped(context: ContextV2): ReturnType<typeof readScopedSourcesV2>;
  latest(studentId: number): ReturnType<typeof readLatestSourceV2>;
  studentKey(accountId: string): ReturnType<typeof readStudentKeyV2>;
};
type SubjectV2 = SelfResponseV1['subjects'][number];
type SourceV2 = NonNullable<ReturnType<AcademicStudentReaderPostgresV1['projectPreparedSourceV2']>>;
type ScopedRowV2 = Awaited<ReturnType<typeof readScopedSourcesV2>>[number];
type PeriodSelectionV2 = {
  available: readonly SubjectV2[];
  acceptedRevision: string | null;
  source?: SourceV2;
  explicitWithdrawal: boolean;
};

const hasFacts = (period: SubjectV2['periods'][number]) =>
  period.final.kind !== 'absent' ||
  Boolean(
    period.partials?.some((partial) => partial.mark.kind === 'score' || partial.notDone === true),
  );

function sourceRevisionV2(source: SourceV2) {
  return BigInt(source.student.dataVersion.split(':')[1]!);
}

function newestSourceV2(current: SourceV2 | undefined, candidate: SourceV2 | undefined) {
  if (!candidate) return current;
  if (!current || sourceRevisionV2(candidate) > sourceRevisionV2(current)) return candidate;
  return current;
}

const preparedPayloadV2 = z.record(z.string(), z.unknown());

function preparedSourceV2(
  row: ScopedRowV2,
  revision: string,
  reader: AcademicStudentReaderPostgresV1,
  decoded: Map<string, SourceV2>,
  context: ContextV2,
) {
  const cached = decoded.get(revision);
  if (cached) return cached;
  const accountId = context.account.id;
  const source = reader.projectPreparedSourceV2(context.account.link!, revision, {
    ...preparedPayloadV2.parse(row.payload_json),
    account_id: accountId,
    data_version: revision,
  });
  if (source?.student.profile.classId !== context.policy.classId)
    throw new Error('student-portal-prepared-source-invalid');
  decoded.set(revision, source);
  return source;
}

/** A released period is served only from its prepared edition; there is no legacy fallback. */
function selectPeriodV2(
  row: ScopedRowV2,
  context: ContextV2,
  reader: AcademicStudentReaderPostgresV1,
  decoded: Map<string, SourceV2>,
): PeriodSelectionV2 {
  const explicitWithdrawal = row.decision_version !== null && row.approved_revision === null;
  const revision = academicVersionSchemaV1.nullable().parse(row.target_revision);
  if (revision === null || row.payload_json === null || row.edition_class_id !== context.policy.classId)
    return { available: [], acceptedRevision: null, explicitWithdrawal };
  const source = preparedSourceV2(row, revision, reader, decoded, context);
  return {
    available: academicToSelfV1(source.student, context.account.id).subjects,
    acceptedRevision: revision,
    source,
    explicitWithdrawal,
  };
}

function mergePeriodSubjectsV2(
  subjects: Map<number, SubjectV2>,
  available: readonly SubjectV2[],
  period: (typeof PERIODS_V1)[number],
) {
  for (const subject of available) {
    const selected = subject.periods.filter((item) => item.period === period && hasFacts(item));
    if (!selected.length) continue;
    const existing = subjects.get(subject.subjectId);
    subjects.set(subject.subjectId, {
      subjectId: subject.subjectId,
      label: subject.label,
      order: subject.order,
      periods: [...(existing?.periods ?? []), ...selected],
    });
  }
}

function finalAuthorityV2(
  context: ContextV2,
  finalSource: SourceV2 | undefined,
  explicitWithdrawal: boolean,
): boolean {
  return (
    !explicitWithdrawal &&
    finalSource?.student.profile.academicState === context.profile.academicState &&
    finalSource.finalAuthority.global
  );
}

function orderedSubjectsV2(
  subjects: Map<number, SubjectV2>,
  finalSource: SourceV2 | undefined,
  accountId: string,
  finalAuthority: boolean,
) {
  const finalSubjects = finalSource ? academicToSelfV1(finalSource.student, accountId).subjects : [];
  return [...subjects.values()]
    .sort(
      (a, b) => compareSourceSubjectPresentationV1(a.label, b.label) || a.subjectId - b.subjectId,
    )
    .map((subject, order) => {
      const official = finalSubjects.find((item) => item.subjectId === subject.subjectId);
      const outcome = official?.officialOutcome;
      const hasAuthority = finalSource?.finalAuthority.subjectIds.includes(subject.subjectId) === true;
      // Final classifications need the same authority as officialOutcome. `recovery-pending`
      // exists precisely before the annual closure, so it is relayed from the accepted edition
      // and gated later by T3 disclosure (applyPublishedVisibilityV1).
      const situation = official?.annualSituation;
      const relaySituation =
        situation !== undefined &&
        ((finalAuthority && hasAuthority) || situation === 'recovery-pending');
      return {
        ...subject,
        order,
        periods: subject.periods.sort(
          (a, b) => PERIODS_V1.indexOf(a.period) - PERIODS_V1.indexOf(b.period),
        ),
        ...(finalAuthority && hasAuthority && outcome !== undefined
          ? { officialOutcome: outcome }
          : {}),
        ...(relaySituation ? { annualSituation: situation } : {}),
      };
    });
}

function profileSituationV2(context: ContextV2, finalSource: SourceV2 | undefined, finalAuthority: boolean) {
  if (finalSource?.student.profile.academicState !== context.profile.academicState) return undefined;
  const situation = finalSource.student.profile.annualSituation;
  // Same authority as `result`, except EM RECUPERAÇÃO, which precedes the annual closure.
  return finalAuthority || situation === 'in-recovery' ? situation : undefined;
}

/** Auth/session/current-link validation is owned by the caller. Only this student's prepared rows are loaded. */
export async function scopedSelfV2(
  tx: StudentPortalPostgresQueryV1,
  context: ContextV2,
  requestId: string,
  sources?: ScopedSelfSourceReaderV2,
): Promise<SelfResponseV1> {
  const accountId = context.account.id;
  const link = context.account.link!;
  const rows = sources ? await sources.scoped(context)
    : await readScopedSourcesV2(tx, accountId, link.studentId, context.policy.classId!);
  if (rows.length !== PERIODS_V1.length) throw new Error('student-portal-preparation-unavailable');
  const accepted: (string | null)[] = PERIODS_V1.map(() => null);
  const subjects = new Map<number, SubjectV2>();
  const reader = new AcademicStudentReaderPostgresV1(tx);
  const decoded = new Map<string, SourceV2>();
  let finalSource: SourceV2 | undefined;
  let explicitWithdrawal = false;

  for (const [index, period] of PERIODS_V1.entries()) {
    const row = rows.find((item) => item.period === period);
    if (!row) throw new Error('student-portal-preparation-unavailable');
    const selected = selectPeriodV2(row, context, reader, decoded);
    accepted[index] = selected.acceptedRevision;
    finalSource = newestSourceV2(finalSource, selected.source);
    explicitWithdrawal ||= selected.explicitWithdrawal;
    mergePeriodSubjectsV2(subjects, selected.available, period);
  }

  const finalAuthority = finalAuthorityV2(context, finalSource, explicitWithdrawal);
  const ordered = orderedSubjectsV2(subjects, finalSource, accountId, finalAuthority);
  const annualSituation = profileSituationV2(context, finalSource, finalAuthority);
  const projection = selfResponseV1.parse({
    contractVersion: 1,
    requestId,
    state: ordered.length ? 'ready' : 'no-publication',
    profile: {
      ...context.profile,
      result: finalAuthority && finalSource ? finalSource.student.profile.result : context.profile.result,
      ...(annualSituation === undefined ? {} : { annualSituation }),
    },
    subjects: ordered,
    generatedAt: context.now.toISOString(),
    revisions: {
      dataVersion: dataVectorV1(accepted),
      policyVersion: context.policy.policyVersion,
      publicationVersion: `pub:${publicationDigestV1(rows.map((row) => [row.period, row.target_revision, String(row.decision_version)]))}`,
    },
  });
  const visible = applyPublishedVisibilityV1(
    projection,
    context.policy.enforcedValue,
    context.now,
    finalAuthority,
  );
  const withClosings = await termClosingsV2(tx, context, visible, reader, decoded, sources);
  const endedPeriods = endedPeriodsV1(context.policy.enforcedValue, context.now);
  return selfResponseV1.parse({
    ...withClosings,
    ...(endedPeriods.length ? { endedPeriods } : {}),
    showFrequency: context.policy.enforcedValue.showFrequency,
    showSchedule: context.policy.enforcedValue.showSchedule,
  });
}

/** Fechamento do trimestre (#1132): read only when the policy and a closed trimester require it. */
async function termClosingsV2(
  tx: StudentPortalPostgresQueryV1,
  context: ContextV2,
  projection: SelfResponseV1,
  reader: AcademicStudentReaderPostgresV1,
  decoded: Map<string, SourceV2>,
  sources?: ScopedSelfSourceReaderV2,
): Promise<SelfResponseV1> {
  const targets = termClosingTargetsV1(
    context.policy.enforcedValue,
    context.profile.academicState,
    context.now,
  );
  if (targets.periods.length === 0) return projection;
  const source = await closingSourceV2(tx, context, reader, decoded, sources);
  return source ? attachTermClosingsV1({ projection, targets, ...source }) : projection;
}

/** Newest edition's closing codes; null when unreadable (the closing is supplementary). */
async function closingSourceV2(
  tx: StudentPortalPostgresQueryV1,
  context: ContextV2,
  reader: AcademicStudentReaderPostgresV1,
  decoded: Map<string, SourceV2>,
  sources?: ScopedSelfSourceReaderV2,
) {
  const latest = sources ? await sources.latest(context.account.link!.studentId)
    : await readLatestSourceV2(tx, context.account.link!.studentId);
  if (!latest || latest.payload_json === null || latest.class_id !== context.policy.classId) return null;
  try {
    const revision = academicVersionSchemaV1.parse(latest.revision);
    const source = preparedSourceV2({ payload_json: latest.payload_json } as ScopedRowV2, revision, reader, decoded, context);
    return {
      evaluations: source.closings,
      sourceSubjects: source.student.subjects,
      studentKey: sources ? await sources.studentKey(context.account.id)
        : await readStudentKeyV2(tx, context.account.id),
    };
  } catch {
    return null;
  }
}

/**
 * Admin preview (D12, R7): the same engine and variants the student receives, computed as if the
 * `showTermClosing` policy and access were on, so the school can review before enabling it.
 */
export async function termClosingPreviewV2(tx: StudentPortalPostgresQueryV1, context: ContextV2) {
  const value = settingsValueV1.parse(context.policy.enforcedValue);
  const targets = termClosingTargetsV1(
    { ...value, showTermClosing: true, accessEnabled: true, accessSchedule: null },
    context.profile.academicState,
    context.now,
  );
  const visibleToStudent = value.showTermClosing && accessGateV1(value, context.now) && targets.periods.length > 0;
  const source = targets.periods.length
    ? await closingSourceV2(tx, context, new AcademicStudentReaderPostgresV1(tx), new Map())
    : null;
  if (!source) return { mode: targets.mode, closedPeriods: targets.periods, visibleToStudent, subjects: [], summary: undefined };
  const { closings, summary } = buildTermClosingsV1({ targets, ...source });
  return {
    mode: targets.mode,
    closedPeriods: targets.periods,
    visibleToStudent,
    subjects: source.sourceSubjects
      .filter((subject) => closings.has(subject.subjectId))
      .map((subject) => ({ subjectId: subject.subjectId, label: subject.label, closings: closings.get(subject.subjectId)! })),
    summary,
  };
}
