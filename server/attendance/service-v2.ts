import {
  canonicalFrequencyJsonV2,
  frequencyClassKeyV2,
  frequencyContentHashV2,
  frequencyRequestV2,
  frequencyCountV2,
  frequencyPayloadHashV2,
  frequencyScheduleHashV2,
  type FrequencyRequestV2,
  type FrequencyActorV2,
  type FrequencyCollectionV2,
  type FrequencyScheduleCollectionV2,
  type FrequencyUnchangedV2,
  type FrequencyDeviceV2,
  type FrequencyFailureEntryV2,
  type FrequencyStatusV2,
  type FrequencySummaryV2,
  type FrequencyYearSummaryV2,
  type FrequencyScheduleV2,
  type FrequencyUnresolvedV2,
} from '../../shared/attendance-contracts/frequency-v2';
import { studentUidV1 } from '../../shared/student-identity/student-identity-v1';
import { frequencyCommentV2 } from '../../shared/attendance-contracts/frequency-comment-v2';
import { SCHOOL_DAYS_REQUIRED_V1 } from '../../shared/student-portal-contracts/school-calendar-v1';
import { normalizeStudentNameV1 } from '../../shared/student-identity/reconciliation-normalization-v1';
import { resolveReconciledSourcesV2 } from '../student-identity/reconciliation/resolve-source-batch-v2';
import { lockResetWriterV1 } from '../student-portal/integration/year-reset/writer-v1';
import { recordFrequencyResetWriteV2 } from '../student-portal/integration/year-reset/frequency-writer-v2';
import {
  FREQUENCY_FAILURE_RETENTION_DAYS_V2,
  insertFrequencyFailureV2,
  purgeFrequencyOperationalRowsV2,
} from './failure-log-v2';
import type {
  GradebookPostgresDatabaseV1,
  GradebookPostgresTransactionV1,
} from '../gradebook/persistence/postgres/postgres-database-v1';

export type { FrequencyRequestV2 } from '../../shared/attendance-contracts/frequency-v2';

type Tx = GradebookPostgresTransactionV1;
type Row = Record<string, unknown>;
type Mark = 'X' | 'J' | null;
type Source = { recordKey: string; originalName: string; originalClass: string };
type Eligibility = {
  sourceId: string;
  observationId: string;
  startsOn: string | null;
  endsOn: string | null;
};
type Resolution = Awaited<ReturnType<typeof centralMany>>[number];
type StoredSource = {
  record_key: string;
  original_name: string;
  original_class: string;
  resolution: string;
  student_uid: string | null;
  decision_version: number;
  source_ids_json: string[];
  observation_ids_json: string[];
  eligibility_json: Eligibility[];
};
type IncomingOccurrence = {
  uid: string;
  date: string;
  slot: number;
  mark: Mark;
  recordKey: string;
  changed: boolean;
};
type Mutation = Exclude<
  FrequencyRequestV2,
  { operation: 'status' | 'receipt' | 'monthly-summary' }
>;
type Context = { tx: Tx; row: Row; actor: FrequencyActorV2 };

const truth = (v: unknown) => v === true || v === 1;
const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
/** Database values arrive as primitives: the adapter already normalizes dates, numbers and JSON. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean')
    return `${value}`;
  if (value === null || value === undefined) return `${value}`;
  throw new FrequencyErrorV2('unavailable', 503, 'unexpected-database-value');
}
const iso = (v: unknown) => new Date(text(v)).toISOString();
const DEVICE_ONLY = new Set(['lease', 'collect', 'collect-unchanged', 'schedule-collect', 'heartbeat', 'release']);
/** Operations that write evidence under the live lease, as `collect` does. */
const COLLECTING = new Set(['collect', 'collect-unchanged', 'schedule-collect']);
const ADMIN_ONLY = new Set(['revoke-device', 'resolve-conflict', 'monthly-summary']);
const UNLEASED = new Set(['heartbeat', 'lease', 'release']);

export class FrequencyErrorV2 extends Error {
  /** `detail` is diagnostic only: it goes to the failure trail, never to the client. */
  constructor(
    public readonly code: string,
    public readonly status = 409,
    public readonly detail = '',
  ) {
    super(code);
  }
}
function fail(code: string, status = 409, detail = ''): never {
  throw new FrequencyErrorV2(code, status, detail);
}
function rejectSource(condition: boolean, detail: string): void {
  if (condition) fail('source-invalid', 400, detail);
}
function admin(actor: FrequencyActorV2) {
  if (actor.mode !== 'admin') fail('not-authorized', 403);
}
function device(actor: FrequencyActorV2): string {
  if (actor.mode !== 'device' || !actor.deviceId || !actor.deviceGeneration || !actor.keyThumbprint)
    fail('not-authorized', 403);
  return studentUidV1.parse(actor.deviceId);
}
async function lockDevice(tx: Tx, actor: FrequencyActorV2) {
  if (actor.mode !== 'device') return;
  const id = device(actor);
  const [row] = await tx.query<Row>(
    `SELECT collector_auth.lock_active_device_v2($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text) AS allowed`,
    [id, actor.tenantId, actor.actorId, actor.deviceGeneration!, actor.keyThumbprint!],
  );
  if (!truth(row?.allowed)) fail('not-authorized', 403);
}
async function school(tx: Tx, year: number, tenant: string): Promise<Row> {
  await tx.executeNative(
    `INSERT INTO attendance.school_state_v2(academic_year,tenant_id) VALUES($1,$2::uuid) ON CONFLICT DO NOTHING`,
    [year, tenant],
  );
  const [row] = await tx.query<Row>(
    'SELECT *,clock_timestamp()::text AS server_time FROM attendance.school_state_v2 WHERE academic_year=$1 FOR UPDATE',
    [year],
  );
  if (row?.tenant_id !== tenant) fail('not-authorized', 403);
  return row!;
}
async function liveLease(
  tx: Tx,
  input: { academicYear: number; fencingToken: number },
  actor: FrequencyActorV2,
  allowPaused = false,
) {
  const [row] = await tx.query<Row>(
    `SELECT lease_device::text,lease_actor::text,fencing_token,lease_until::text,paused,lease_until>clock_timestamp() AS live FROM attendance.school_state_v2 WHERE academic_year=$1`,
    [input.academicYear],
  );
  if (
    !row ||
    !truth(row.live) ||
    row.lease_device !== device(actor) ||
    row.lease_actor !== actor.actorId ||
    Number(row.fencing_token) !== input.fencingToken
  )
    fail('lease-fenced');
  if (!allowPaused && truth(row.paused)) fail('paused');
  return row;
}
async function centralMany(
  tx: Tx,
  year: number,
  sources: Source[],
  snapshotRef: string,
  classId: number,
  classLabel: string,
) {
  if (year !== 2026) fail('source-invalid', 400, 'year');
  const results = await resolveReconciledSourcesV2(
    tx,
    sources.map((source) => ({
      academicYear: year,
      name: source.originalName,
      classLabel,
      sourceSnapshotRef: snapshotRef,
      sourceRecordRef: source.recordKey,
    })),
  );
  const observationIds = [
    ...new Set(
      results.flatMap((result) => (result.state === 'resolved' ? result.observationIds : [])),
    ),
  ];
  const rows = await tx.query<Row>(
    `SELECT o.source_id::text,o.id::text,o.enrolled_at::text,o.transferred_at::text,c.gradebook_class_id,c.review_required
    FROM gradebook.student_source_observation_v1 o JOIN gradebook.student_report_class_v1 c ON c.id=o.report_class_id AND c.academic_year=o.academic_year
    WHERE o.academic_year=$1 AND o.id IN(SELECT value::uuid FROM jsonb_array_elements_text($2::text::jsonb))`,
    [year, JSON.stringify(observationIds)],
  );
  const byId = new Map(rows.map((r) => [text(r.id), r]));
  return results.map((result) => {
    if (result.state !== 'resolved') return { ...result, eligibility: [] as Eligibility[] };
    const found = result.observationIds
      .map((id) => byId.get(id))
      .filter((r): r is Row => r !== undefined);
    if (
      found.length !== result.observationIds.length ||
      !found.length ||
      found.some((r) => Number(r.gradebook_class_id) !== classId || truth(r.review_required))
    )
      return {
        state: 'ambiguous' as const,
        decisionVersion: result.decisionVersion,
        eligibility: [] as Eligibility[],
      };
    return {
      ...result,
      eligibility: found.map((r) => ({
        sourceId: text(r.source_id),
        observationId: text(r.id),
        startsOn: r.enrolled_at === null ? null : text(r.enrolled_at),
        endsOn: r.transferred_at === null ? null : text(r.transferred_at),
      })),
    };
  });
}
async function sourcesValid(tx: Tx, rows: readonly Row[]) {
  if (!rows.length) return [];
  const evidence = rows.map((r, index) => ({
    ordinal: index,
    year: Number(r.academic_year),
    uid: text(r.student_uid),
    class_id: Number(r.class_id),
    source_ids: json<string[]>(r.source_ids_json),
    observation_ids: json<string[]>(r.observation_ids_json),
  }));
  const results = await tx.query<Row>(
    `SELECT x.ordinal,
    gradebook.reconciliation_evidence_valid_v2(x.year::smallint,x.uid,x.class_id,x.source_ids,x.observation_ids) AS valid
    FROM jsonb_to_recordset($1::text::jsonb) AS x(ordinal integer,year smallint,uid uuid,class_id integer,source_ids jsonb,observation_ids jsonb) ORDER BY ordinal`,
    [JSON.stringify(evidence)],
  );
  return results.map((r) => truth(r.valid));
}
async function summaryInTx(
  tx: Tx,
  year: number,
  uid: string,
  month: string,
): Promise<FrequencySummaryV2> {
  const origins = await tx.query<Row>(
    `SELECT o.id::text AS occurrence_id,o.date::text,o.slot,o.shift,o.mark,c.id::text AS conflict_id,
    b.academic_year,b.class_id,b.id::text AS batch_id,b.source_class_label,
    (CASE WHEN cs.last_batch_id=b.id THEN cs.last_observed_at ELSE b.observed_at END)::text AS observed_at,
    (CASE WHEN cs.last_batch_id=b.id THEN cs.last_received_at ELSE b.received_at END)::text AS received_at,
    s.record_key,s.original_name,s.original_class,s.student_uid::text,s.source_ids_json,s.observation_ids_json
    FROM attendance.occurrence_v2 o JOIN attendance.origin_v2 p ON p.occurrence_id=o.id
    JOIN attendance.source_row_v2 s ON s.batch_id=p.batch_id AND s.record_key=p.record_key
    JOIN attendance.batch_v2 b ON b.id=p.batch_id
    LEFT JOIN attendance.class_state_v2 cs ON cs.academic_year=b.academic_year AND cs.class_id=b.class_id
    LEFT JOIN attendance.conflict_v2 c ON c.occurrence_id=o.id AND c.state='open'
    WHERE o.academic_year=$1 AND o.student_uid=$2::uuid AND o.date>=$3::date AND o.date<($3::date+interval '1 month')
    ORDER BY o.date,o.shift,o.slot,b.received_at`,
    [year, uid, `${month}-01`],
  );
  const coverage = await tx.query<Row>(LESSON_DAYS_SQL_V2, [year, uid, `${month}-01`]);
  const valid = await sourcesValid(tx, coverage);
  // The school's today, as the collector's clock check reads it (the agenda's timezone).
  const [clock] = await tx.query<Row>(
    `SELECT (clock_timestamp() AT TIME ZONE COALESCE((SELECT schedule_json->>'timezone' FROM attendance.school_state_v2 WHERE academic_year=$1),'America/Bahia'))::date::text AS today`,
    [year],
  );
  return withLessonDaysV2(
    await summarizeFrequencyOriginsV2(tx, origins, month),
    coverage.filter((_, index) => valid[index]),
    text(clock!.today),
  );
}
/**
 * The student's lesson days in the month: for each class, record and date, the latest coverage the
 * collector sent (each collection stores only the days that changed). Parameters: year, student
 * uid, first day of the month. The caller still checks each row's identity evidence.
 */
export const LESSON_DAYS_SQL_V2 = `SELECT DISTINCT ON(b.class_id,c.record_key,c.date) c.date::text,b.shift,c.slots_json,c.complete,
    b.academic_year,b.class_id,s.student_uid::text,s.source_ids_json,s.observation_ids_json
    FROM attendance.coverage_v2 c JOIN attendance.batch_v2 b ON b.id=c.batch_id
    JOIN attendance.source_row_v2 s ON s.batch_id=c.batch_id AND s.record_key=c.record_key
    WHERE b.academic_year=$1 AND s.student_uid=$2::uuid AND c.date>=$3::date AND c.date<($3::date+interval '1 month')
    ORDER BY b.class_id,c.record_key,c.date,b.received_at DESC,b.id DESC`;
/**
 * Adds the Smecel lesson days to a month's summary (owner decision 20/10/2026). The counts follow
 * the Smecel: lessons are the positions of the days, absences are X, justified are J (the yellow
 * icon and the blue X) and do not lower the attendance: 100 × (lessons − absences) / lessons.
 * TODAY never counts (owner decision 21/10/2026: its roll call may still be under way), so neither
 * its lessons nor its marks enter the totals, and its unfinished reading never makes the month
 * incomplete (frequencyCountV2). The totals are given only when every day already over was read
 * completely and nothing is in review; the marks and days are always given.
 */
export function withLessonDaysV2(
  summary: FrequencySummaryV2,
  rows: readonly Row[],
  today: string,
): FrequencySummaryV2 {
  const byDay = new Map<string, { date: string; shift: string; slots: Set<number>; complete: boolean }>();
  for (const row of rows) {
    // A tombstone (no slots) only says the record has no lesson that day.
    if (!json<number[]>(row.slots_json).length) continue;
    const date = text(row.date);
    const shift = text(row.shift);
    const day = byDay.get(`${date}:${shift}`) ?? { date, shift, slots: new Set<number>(), complete: true };
    for (const slot of json<number[]>(row.slots_json)) day.slots.add(Number(slot));
    day.complete &&= truth(row.complete);
    byDay.set(`${date}:${shift}`, day);
  }
  const days = [...byDay.values()]
    .filter((day) => day.slots.size > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift))
    .map((day) => ({
      date: day.date,
      shift: day.shift,
      slots: [...day.slots].sort((a, b) => a - b),
      complete: day.complete,
    }));
  if (!days.length) return summary;
  const count = frequencyCountV2({ marks: summary.marks, conflicts: summary.conflicts, days }, today);
  const justified = summary.marks.filter((mark) => mark.mark === 'J' && mark.date < today).length;
  return {
    ...summary,
    days,
    absences: count.reliable ? count.absences : null,
    justified: count.reliable ? justified : null,
    denominator: count.reliable ? count.lessons : null,
    percentage:
      count.reliable && count.lessons
        ? Math.round(((count.lessons - count.absences) / count.lessons) * 1000) / 10
        : null,
    coverage: count.reliable ? 'reliable' : 'incomplete',
  };
}
export async function summarizeFrequencyOriginsV2(
  tx: Tx,
  origins: readonly Row[],
  month: string,
): Promise<FrequencySummaryV2> {
  const unique = [
    ...new Map(origins.map((r) => [`${text(r.batch_id)}:${text(r.record_key)}`, r])).values(),
  ];
  const valid = await sourcesValid(tx, unique);
  const validity = new Map(
    unique.map((r, i) => [`${text(r.batch_id)}:${text(r.record_key)}`, valid[i]!]),
  );
  return summarizeFrequencyPublicOriginsV2(
    origins.map((r) => ({
      ...r,
      mapping_valid: validity.get(`${text(r.batch_id)}:${text(r.record_key)}`)!,
    })),
    month,
  );
}
/** The private reader supplies mapping_valid after checking its central evidence. */
/** One read of the student's year (attendance 0012, read_portal_frequency_v4). */
export type PortalFrequencyYearReadV2 = {
  origins: readonly Row[];
  days: readonly Row[];
  today: string;
  lastReadAt: string | null;
  /** The database's clock at the read (0012), for the countdown. */
  now?: string;
};
/** One month of the year's read, by the owner's rule (today never counts). */
function monthOfReadV2(read: PortalFrequencyYearReadV2, key: string): FrequencySummaryV2 {
  return withLessonDaysV2(
    summarizeFrequencyPublicOriginsV2(
      read.origins.filter((row) => text(row.date).startsWith(`${key}-`)),
      key,
    ),
    read.days.filter((row) => text(row.date).startsWith(`${key}-`)),
    read.today,
  );
}
/** January to the school's current month (December once the year is over; none before it). */
function monthsSoFarV2(today: string): string[] {
  let current;
  if (today.startsWith('2026-')) {
    current = today.slice(0, 7);
  } else if (today < '2026') {
    current = null;
  } else {
    current = '2026-12';
  }
  if (current === null) return [];
  return Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`).filter(
    (key) => key <= current,
  );
}
/**
 * The year so far: every month from January to the current one by the same rule (today
 * excluded); a month with nothing adds nothing, one month not known in full leaves the year
 * unknown (null), as does a year with no lesson yet.
 */
function yearOfMonthsV2(months: readonly FrequencySummaryV2[], today: string) {
  let lessons = 0;
  let absences = 0;
  for (const month of months) {
    const count = frequencyCountV2(month, today);
    if (!count.reliable) return null;
    lessons += count.lessons;
    absences += count.absences;
  }
  return lessons > 0 ? { lessons, absences } : null;
}
const lastReadOfV2 = (read: PortalFrequencyYearReadV2) => (read.lastReadAt === null ? null : iso(read.lastReadAt));
/**
 * Only the school days of the calendar marked in the ADM count (owner decision 22/10/2026): a day
 * the diary has lessons on but the official calendar does not (the six compensation Saturdays of
 * 2026 the Secretaria did not list) neither adds lessons nor shows. Without a calendar, the diary.
 */
function onSchoolDaysV2(read: PortalFrequencyYearReadV2, schoolDays?: ReadonlySet<string>): PortalFrequencyYearReadV2 {
  if (!schoolDays) return read;
  const kept = (row: Row) => schoolDays.has(text(row.date));
  return { ...read, origins: read.origins.filter(kept), days: read.days.filter(kept) };
}
/**
 * The Portal's answer for one month (GET ?month=): the month's marks, lesson days and totals, plus
 * the school's today, the year so far and the class's last reading, from ONE read of the year.
 */
export function portalFrequencySummaryV2(
  whole: PortalFrequencyYearReadV2,
  month: string,
  schoolDays?: ReadonlySet<string>,
): FrequencySummaryV2 {
  const read = onSchoolDaysV2(whole, schoolDays);
  const months = monthsSoFarV2(read.today).map((key) => monthOfReadV2(read, key));
  return {
    ...(months.find((item) => item.month === month) ?? monthOfReadV2(read, month)),
    today: read.today,
    year: yearOfMonthsV2(months, read.today),
    lastReadAt: lastReadOfV2(read),
  };
}
/**
 * The whole year so far in one answer (GET ?year=2026, PR 1317): the Portal reads it with the
 * sign-in, so changing months is instant and never asks the server again.
 */
export function portalFrequencyYearV2(
  whole: PortalFrequencyYearReadV2,
  schoolDays?: ReadonlySet<string>,
  remainingSchoolDays = 0,
): FrequencyYearSummaryV2 {
  const read = onSchoolDaysV2(whole, schoolDays);
  const months = monthsSoFarV2(read.today).map((key) => monthOfReadV2(read, key));
  return {
    // The absence limit from the calendar's school days; the rule's 200 without a calendar.
    comment: frequencyCommentV2({
      months,
      today: read.today,
      schoolDays: schoolDays?.size || SCHOOL_DAYS_REQUIRED_V1,
      remainingSchoolDays,
    }),
    contractVersion: 2,
    state: 'ready',
    academicYear: 2026,
    today: read.today,
    year: yearOfMonthsV2(months, read.today),
    lastReadAt: lastReadOfV2(read),
    months,
    ...(read.now ? { serverNow: iso(read.now) } : {}),
  };
}
export function summarizeFrequencyPublicOriginsV2(
  origins: readonly Row[],
  month: string,
): FrequencySummaryV2 {
  const events = new Map<string, { row: Row; labels: Set<string>; valid: boolean }>();
  let observedAt: string | null = null;
  let receivedAt: string | null = null;
  const conflicts = new Set<string>();
  for (const origin of origins) {
    const id = text(origin.occurrence_id);
    const current = events.get(id) ?? { row: origin, labels: new Set<string>(), valid: true };
    current.valid &&= truth(origin.mapping_valid);
    current.labels.add(text(origin.source_class_label));
    events.set(id, current);
    if (origin.conflict_id) conflicts.add(text(origin.conflict_id));
    const observed = iso(origin.observed_at),
      received = iso(origin.received_at);
    if (observedAt === null || observed > observedAt) observedAt = observed;
    if (receivedAt === null || received > receivedAt) receivedAt = received;
  }
  const marks = [...events.values()]
    .filter((v) => v.valid && !v.row.conflict_id && v.row.mark !== null)
    .map((v) => ({
      date: text(v.row.date),
      slot: Number(v.row.slot),
      shift: text(v.row.shift),
      mark: text(v.row.mark) as 'X' | 'J',
      classLabels: [...v.labels].sort((left, right) => left.localeCompare(right, 'pt-BR')),
    }));
  // Calendar/slot counts are not approved productive sources. Known sparse marks never imply attendance.
  return {
    contractVersion: 2,
    state: 'ready',
    month,
    absences: null,
    justified: null,
    denominator: null,
    percentage: null,
    coverage: origins.length ? 'incomplete' : 'unavailable',
    observedAt,
    receivedAt,
    marks,
    conflicts: conflicts.size,
  };
}

function shiftName(turno: string): string {
  if (turno === 'M' || turno === 'MATUTINO') return 'matutino';
  if (turno === 'V' || turno === 'VESPERTINO') return 'vespertino';
  return 'unknown';
}
function deviceState(d: Row, paused: boolean, leaseDevice: unknown, live: boolean) {
  if (d.revoked_at !== null) return 'revoked';
  if (d.grant_state !== 'active') return 'login-required';
  if (!truth(d.online)) return 'offline';
  if (paused) return 'paused';
  if (d.state === 'login-required' || d.state === 'error') return d.state;
  if (leaseDevice === d.device_id && live) return text(d.state) as 'ready' | 'collecting';
  return 'reserve';
}
const isoOrNull = (v: unknown) => (v === null ? null : iso(v));
const numberOrNull = (v: unknown) => (v === null ? null : Number(v));
const textOrNull = (v: unknown) => (v === null ? null : text(v));
function deviceView(d: Row, state: string): FrequencyDeviceV2 {
  return {
    deviceId: text(d.device_id),
    label: d.label ? text(d.label) : 'Computador',
    state: state as FrequencyDeviceV2['state'],
    lastSeenAt: isoOrNull(d.last_seen_at),
    classId: numberOrNull(d.class_id),
    code: textOrNull(d.code),
    lastCollectionAt: isoOrNull(d.last_collection_at),
  };
}
function failureView(f: Row): FrequencyFailureEntryV2 {
  return {
    firstAt: iso(f.first_at),
    lastAt: iso(f.last_at),
    occurrences: Number(f.occurrences),
    origin: text(f.origin) as FrequencyFailureEntryV2['origin'],
    operation: text(f.operation),
    code: text(f.code),
    detail: text(f.detail),
    deviceId: textOrNull(f.device_id),
    classId: numberOrNull(f.class_id),
  };
}
function unresolvedView(u: Row): FrequencyUnresolvedV2 {
  const entry = json<{ name: string; classLabel: string; reason: string; marks: number }>(
    u.entry_json,
  );
  return {
    classId: Number(u.class_id),
    classLabel: entry.classLabel,
    name: entry.name,
    reason: entry.reason === 'ambiguous' ? 'ambiguous' : 'not_found',
    marks: Number(entry.marks),
    observedAt: iso(u.observed_at),
  };
}
async function adminDiagnostics(tx: Tx, year: number) {
  await purgeFrequencyOperationalRowsV2(tx);
  const conflicts = await tx.query<Row>(
    `SELECT c.id::text,c.revision,c.marks_json,o.student_uid::text,COALESCE(sp.name,a.nome,'Aluno') AS student_name,
    o.date::text,o.slot,o.shift,MIN(b.source_class_label) AS class_label
    FROM attendance.conflict_v2 c JOIN attendance.occurrence_v2 o ON o.id=c.occurrence_id
    JOIN attendance.origin_v2 p ON p.occurrence_id=o.id JOIN attendance.batch_v2 b ON b.id=p.batch_id
    LEFT JOIN gradebook.aluno a ON a.student_uid=o.student_uid AND a.ano=o.academic_year
    LEFT JOIN gradebook.student_presentation_v1 sp ON sp.student_id=a.id AND sp.academic_year=a.ano
    WHERE o.academic_year=$1 AND c.state='open' GROUP BY c.id,o.id,a.nome,sp.name ORDER BY o.date,o.slot,c.id`,
    [year],
  );
  const unresolved = await tx.query<Row>(
    `SELECT s.class_id,s.last_observed_at::text AS observed_at,e.value AS entry_json
    FROM attendance.class_state_v2 s CROSS JOIN LATERAL jsonb_array_elements(s.unresolved_json) e
    WHERE s.academic_year=$1 ORDER BY s.class_id`,
    [year],
  );
  const failures = await tx.query<Row>(
    `SELECT first_at::text,last_at::text,occurrences,origin,operation,code,detail,device_id::text,class_id
    FROM attendance.failure_v2 WHERE last_at>clock_timestamp()-make_interval(days=>$1)
    ORDER BY last_at DESC LIMIT 100`,
    [FREQUENCY_FAILURE_RETENTION_DAYS_V2],
  );
  return {
    conflicts: conflicts.map((c) => ({
      id: text(c.id),
      revision: Number(c.revision),
      studentUid: text(c.student_uid),
      studentName: text(c.student_name),
      classLabel: text(c.class_label),
      date: text(c.date),
      slot: Number(c.slot),
      shift: text(c.shift),
      marks: json<Mark[]>(c.marks_json),
    })),
    unresolved: unresolved.map(unresolvedView),
    failures: failures.map(failureView),
  };
}
async function status(tx: Tx, row: Row, actor: FrequencyActorV2): Promise<FrequencyStatusV2> {
  const year = Number(row.academic_year);
  const classes = await tx.query<Row>(
    `SELECT DISTINCT t.id AS class_id,c.label AS source_class_label,t.turno,COALESCE(s.revision,0) AS revision
    FROM gradebook.student_report_class_v1 c JOIN gradebook.turma t ON t.id=c.gradebook_class_id AND t.ano=c.academic_year
    LEFT JOIN attendance.class_state_v2 s ON s.academic_year=t.ano AND s.class_id=t.id WHERE c.academic_year=$1 AND NOT c.review_required ORDER BY t.id,c.label`,
    [year],
  );
  const devices = await tx.query<Row>(
    `SELECT p.device_id::text,p.revoked_at::text,p.grant_state,d.label,d.state,d.last_seen_at::text,d.class_id,d.code,d.last_collection_at::text,
    d.last_seen_at>clock_timestamp()-interval '2 minutes' AS online
    FROM collector_auth.device_public_v2 p LEFT JOIN attendance.device_status_v2 d ON d.device_id=p.device_id AND d.academic_year=$1
    WHERE p.tenant_id=$2::uuid ORDER BY d.label,p.device_id`,
    [year, actor.tenantId],
  );
  const collected = await tx.query<Row>(
    `SELECT DISTINCT ON(b.class_id) b.class_id,COALESCE(s.last_observed_at,b.observed_at)::text AS observed_at,COALESCE(s.last_received_at,b.received_at)::text AS received_at,b.resolved_records,b.unresolved_records,b.conflicts
    FROM attendance.batch_v2 b LEFT JOIN attendance.class_state_v2 s ON s.academic_year=b.academic_year AND s.class_id=b.class_id WHERE b.academic_year=$1 ORDER BY b.class_id,b.received_at DESC,b.id`,
    [year],
  );
  const diagnostics =
    actor.mode === 'admin'
      ? await adminDiagnostics(tx, year)
      : { conflicts: [], unresolved: [], failures: [] };
  const [clock] = await tx.query<Row>(
    `SELECT clock_timestamp()::text AS now,lease_until>clock_timestamp() AS live FROM attendance.school_state_v2 WHERE academic_year=$1`,
    [year],
  );
  const live = truth(clock!.live);
  const paused = truth(row.paused);
  return {
    contractVersion: 2,
    state: 'ready',
    academicYear: 2026,
    serverTime: iso(clock!.now),
    settings: {
      revision: Number(row.revision),
      paused,
      schedule: row.schedule_json === null ? null : json<FrequencyScheduleV2>(row.schedule_json),
    },
    lease: live
      ? {
          deviceId: text(row.lease_device),
          expiresAt: iso(row.lease_until),
          fencingToken: Number(row.fencing_token),
        }
      : null,
    classes: classes.map((c) => ({
      classId: Number(c.class_id),
      sourceClassLabel: text(c.source_class_label),
      shift: shiftName(text(c.turno)),
      revision: Number(c.revision),
    })),
    devices: devices.map((d) => deviceView(d, deviceState(d, paused, row.lease_device, live))),
    collections: collected.map((c) => ({
      classId: Number(c.class_id),
      observedAt: iso(c.observed_at),
      receivedAt: iso(c.received_at),
      resolvedRecords: Number(c.resolved_records),
      unresolvedRecords: Number(c.unresolved_records),
      conflicts: Number(c.conflicts),
    })),
    ...diagnostics,
  };
}

function validateCoverage(input: FrequencyCollectionV2, keys: Set<string>, cutoff: string) {
  const coverage = new Map<string, FrequencyCollectionV2['coverage'][number]>();
  for (const c of input.coverage) {
    const key = `${c.recordKey}:${c.date}`;
    rejectSource(!keys.has(c.recordKey), 'coverage-unknown-record');
    rejectSource(!c.date.startsWith('2026-'), 'coverage-other-year');
    rejectSource(c.date > cutoff, 'coverage-after-capture');
    rejectSource(coverage.has(key), 'coverage-duplicate');
    coverage.set(key, c);
  }
  return coverage;
}
function validateMarks(
  input: FrequencyCollectionV2,
  keys: Set<string>,
  coverage: Map<string, FrequencyCollectionV2['coverage'][number]>,
  cutoff: string,
) {
  const marks = new Set<string>();
  for (const m of input.marks) {
    const key = `${m.recordKey}:${m.date}:${m.slot}`;
    rejectSource(!keys.has(m.recordKey), 'mark-unknown-record');
    rejectSource(marks.has(key), 'mark-duplicate');
    rejectSource(
      !coverage.get(`${m.recordKey}:${m.date}`)?.slots.includes(m.slot),
      'mark-without-coverage',
    );
    rejectSource(!m.date.startsWith('2026-'), 'mark-other-year');
    rejectSource(m.date > cutoff, 'mark-after-capture');
    marks.add(key);
  }
}
function validateCollection(input: FrequencyCollectionV2, cutoff: string) {
  const keys = new Set(input.records.map((r) => r.recordKey));
  rejectSource(keys.size !== input.records.length, 'duplicate-record');
  validateMarks(input, keys, validateCoverage(input, keys, cutoff), cutoff);
}
async function addOccurrences(
  tx: Tx,
  year: number,
  shift: string,
  batch: string,
  events: IncomingOccurrence[],
) {
  if (!events.length) return;
  const data = JSON.stringify(events);
  const incoming = `jsonb_to_recordset(CASE WHEN $3::uuid IS NOT NULL THEN $4::text::jsonb ELSE '[]'::jsonb END) AS x(uid uuid,date date,slot smallint,mark text,"recordKey" text,changed boolean)`;
  await tx.executeNative(
    `INSERT INTO attendance.occurrence_v2(id,academic_year,student_uid,date,shift,slot,mark)
    SELECT gen_random_uuid(),$1,x.uid,x.date,$2,x.slot,x.mark FROM
    (SELECT DISTINCT ON(uid,date,slot) * FROM ${incoming} ORDER BY uid,date,slot,"recordKey") x
    ON CONFLICT(academic_year,student_uid,date,shift,slot) DO NOTHING`,
    [year, shift, batch, data],
  );
  await tx.executeNative(
    `INSERT INTO attendance.origin_v2(occurrence_id,batch_id,record_key,mark)
    SELECT o.id,$3::uuid,x."recordKey",x.mark FROM ${incoming}
    JOIN attendance.occurrence_v2 o ON o.academic_year=$1 AND o.student_uid=x.uid AND o.date=x.date AND o.shift=$2 AND o.slot=x.slot
    ON CONFLICT DO NOTHING`,
    [year, shift, batch, data],
  );
  await tx.executeNative(
    `WITH alternatives AS (
    SELECT o.id,o.mark FROM ${incoming} JOIN attendance.occurrence_v2 o
    ON o.academic_year=$1 AND o.student_uid=x.uid AND o.date=x.date AND o.shift=$2 AND o.slot=x.slot WHERE x.changed
    UNION SELECT o.id,x.mark FROM ${incoming} JOIN attendance.occurrence_v2 o
    ON o.academic_year=$1 AND o.student_uid=x.uid AND o.date=x.date AND o.shift=$2 AND o.slot=x.slot WHERE x.changed
    UNION SELECT c.occurrence_id,e.value#>>'{}' FROM attendance.conflict_v2 c
    JOIN attendance.occurrence_v2 o ON o.id=c.occurrence_id CROSS JOIN LATERAL jsonb_array_elements(c.marks_json) e
    WHERE c.state='open' AND o.academic_year=$1 AND EXISTS(SELECT 1 FROM ${incoming} WHERE x.uid=o.student_uid AND x.date=o.date AND x.slot=o.slot AND x.changed)
    ), proposals AS(SELECT id,jsonb_agg(mark ORDER BY mark NULLS LAST) AS marks FROM alternatives GROUP BY id HAVING count(*)>1)
    INSERT INTO attendance.conflict_v2(id,occurrence_id,marks_json) SELECT gen_random_uuid(),id,marks FROM proposals
    ON CONFLICT(occurrence_id) WHERE state='open' DO UPDATE SET marks_json=EXCLUDED.marks_json,revision=attendance.conflict_v2.revision+1
    WHERE attendance.conflict_v2.marks_json IS DISTINCT FROM EXCLUDED.marks_json`,
    [year, shift, batch, data],
  );
}

/**
 * Owner decisions (20/10/2026 and 23/10/2026): the Smecel's latest reading always prevails. When the
 * class's latest evidence of a lesson differs from the stored mark (X → J, J → X, or the absence
 * removed), the stored mark follows it without review: the open conflict is closed with a
 * correction row. The latest evidence is the class's newest batch that has the lesson; only when two
 * fichas of the student disagree in that same batch does the conflict stay open for a person.
 * An open conflict whose stored mark already matches the latest evidence is simply closed.
 */
export const FOLLOW_LATEST_READING_SQL = `WITH latest_batch AS (
    SELECT DISTINCT ON(p.occurrence_id) p.occurrence_id,p.batch_id FROM attendance.origin_v2 p
    JOIN attendance.batch_v2 b ON b.id=p.batch_id WHERE b.academic_year=$1 AND b.class_id=$2
    ORDER BY p.occurrence_id,b.received_at DESC,b.id DESC),
  latest AS (
    SELECT l.occurrence_id,min(p.mark) AS mark FROM latest_batch l
    JOIN attendance.origin_v2 p ON p.occurrence_id=l.occurrence_id AND p.batch_id=l.batch_id
    GROUP BY l.occurrence_id HAVING count(DISTINCT coalesce(p.mark,'-'))=1),
  targets AS (
    SELECT o.id,c.id AS conflict_id,o.mark AS before_mark,l.mark AS after_mark FROM latest l
    JOIN attendance.occurrence_v2 o ON o.id=l.occurrence_id
    JOIN attendance.conflict_v2 c ON c.occurrence_id=o.id AND c.state='open'),
  changed AS (
    UPDATE attendance.occurrence_v2 o SET mark=t.after_mark,revision=o.revision+1 FROM targets t
    WHERE o.id=t.id AND t.before_mark IS DISTINCT FROM t.after_mark RETURNING o.id),
  closed AS (
    UPDATE attendance.conflict_v2 c SET state='resolved',resolved_at=clock_timestamp(),revision=c.revision+1
    FROM targets t WHERE c.id=t.conflict_id RETURNING c.id)
  INSERT INTO attendance.correction_v2(id,conflict_id,actor_id,before_mark,after_mark,reason)
  SELECT gen_random_uuid(),t.conflict_id,$3::uuid,t.before_mark,t.after_mark,
    CASE WHEN t.after_mark='J' THEN 'Falta justificada no Smecel'
         WHEN t.after_mark IS NULL THEN 'Falta apagada no Smecel' ELSE 'Falta marcada no Smecel' END
  FROM targets t WHERE t.before_mark IS DISTINCT FROM t.after_mark AND t.id IN(SELECT id FROM changed)`;

async function followLatestReading(tx: Tx, year: number, classId: number, actorId: string) {
  await tx.executeNative(FOLLOW_LATEST_READING_SQL, [year, classId, actorId]);
}

/** A snapshot cannot certify evidence from a day after its own capture; the school zone governs both. */
async function checkCollectionClock(tx: Tx, input: FrequencyCollectionV2) {
  const [clock] = await tx.query<Row>(
    `SELECT clock_timestamp()::text AS now,
      (clock_timestamp() AT TIME ZONE COALESCE(schedule_json->>'timezone','America/Bahia'))::date::text AS today,
      ($2::timestamptz AT TIME ZONE COALESCE(schedule_json->>'timezone','America/Bahia'))::date::text AS observed_day
      FROM attendance.school_state_v2 WHERE academic_year=$1`,
    [input.academicYear, input.observedAt],
  );
  const today = text(clock!.today);
  const observedDay = text(clock!.observed_day);
  const cutoff = observedDay < today ? observedDay : today;
  validateCollection(input, cutoff);
  // The Windows collector diagnoses skew beyond five seconds using serverTime.
  // A capture whose clock is slightly ahead must not be rejected by the
  // server; future civil dates are still rejected against the school day.
  rejectSource(new Date(input.observedAt).getTime() > new Date(text(clock!.now)).getTime() + 5000,
    'observed-in-future');
  return cutoff;
}
/**
 * The Centro's Relatório/Relação link is the class authority. Spacing, accents
 * and punctuation never block a class; the matched report label feeds the
 * central resolver so the same rule applies to every student of the batch.
 */
async function matchSourceClass(
  tx: Tx,
  input: { academicYear: number; classId: number; sourceClassLabel: string },
) {
  const linked = await tx.query<Row>(
    `SELECT c.label,c.shift_key FROM gradebook.student_report_class_v1 c JOIN gradebook.turma t ON t.id=c.gradebook_class_id AND t.ano=c.academic_year
    WHERE c.academic_year=$1 AND c.gradebook_class_id=$2 AND NOT c.review_required ORDER BY c.label`,
    [input.academicYear, input.classId],
  );
  const key = frequencyClassKeyV2(input.sourceClassLabel);
  const matched = linked.filter((r) => frequencyClassKeyV2(text(r.label)) === key);
  if (!matched.length) fail('identity-review', 409, 'class-not-linked');
  if (new Set(matched.map((r) => text(r.shift_key))).size !== 1)
    fail('identity-review', 409, 'class-shift-ambiguous');
  const exact = normalizeStudentNameV1(input.sourceClassLabel);
  const label = matched.find((r) => normalizeStudentNameV1(text(r.label)) === exact) ?? matched[0]!;
  return { shift: text(label.shift_key), reportLabel: text(label.label) };
}
async function matchCollectionClass(tx: Tx, input: FrequencyCollectionV2) {
  const matched = await matchSourceClass(tx, input);
  const key = frequencyClassKeyV2(input.sourceClassLabel);
  rejectSource(
    input.records.some((r) => frequencyClassKeyV2(r.originalClass) !== key),
    'record-class-mismatch',
  );
  return matched;
}
async function lockClassState(tx: Tx, input: FrequencyCollectionV2) {
  await tx.executeNative(
    `INSERT INTO attendance.class_state_v2(academic_year,class_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [input.academicYear, input.classId],
  );
  const [classState] = await tx.query<Row>(
    `SELECT * FROM attendance.class_state_v2 WHERE academic_year=$1 AND class_id=$2 FOR UPDATE`,
    [input.academicYear, input.classId],
  );
  if (Number(classState!.revision) !== input.expectedRevision) fail('revision-conflict');
  if (
    classState!.last_observed_at &&
    new Date(text(classState!.last_observed_at)) > new Date(input.observedAt)
  )
    fail('source-invalid', 409, 'older-than-last-collection');
  return classState!;
}
async function touchCollectingDevice(
  tx: Tx,
  input: FrequencyCollectionV2,
  actor: FrequencyActorV2,
) {
  await tx.executeNative(
    `UPDATE attendance.device_status_v2 SET last_collection_at=clock_timestamp(),last_seen_at=clock_timestamp(),class_id=$3,state='ready',code=NULL WHERE academic_year=$1 AND device_id=$2::uuid`,
    [input.academicYear, device(actor), input.classId],
  );
}
/** Same evidence as the class's latest batch: only freshness and the receipt change. */
async function repeatCollection(
  tx: Tx,
  input: FrequencyCollectionV2,
  actor: FrequencyActorV2,
  classState: Row,
  evidenceHash: string,
): Promise<Row> {
  const [existing] = await tx.query<Row>(
    `SELECT * FROM attendance.batch_v2 WHERE academic_year=$1 AND class_id=$2 AND evidence_hash=$3 ORDER BY received_at DESC LIMIT 1`,
    [input.academicYear, input.classId, evidenceHash],
  );
  if (!existing) fail('unavailable', 503, 'repeated-batch-missing');
  const newer = new Date(input.observedAt) > new Date(text(classState.last_observed_at));
  const [fresh] = (
    await tx.executeNative<Row>(
      `UPDATE attendance.class_state_v2 SET revision=revision+$4,last_observed_at=$3::timestamptz,last_received_at=clock_timestamp() WHERE academic_year=$1 AND class_id=$2 RETURNING last_received_at::text`,
      [input.academicYear, input.classId, input.observedAt, newer ? 1 : 0],
    )
  ).rows;
  await touchCollectingDevice(tx, input, actor);
  await liveLease(tx, input, actor);
  return {
    classId: input.classId,
    revision: Number(classState.revision) + (newer ? 1 : 0),
    receivedAt: iso(fresh!.last_received_at),
    resolvedRecords: Number(existing.resolved_records),
    unresolvedRecords: Number(existing.unresolved_records),
    conflicts: Number(existing.conflicts),
  };
}
function storedSourcesOf(input: FrequencyCollectionV2, resolutions: Resolution[]): StoredSource[] {
  return input.records.map((source, index) => {
    const resolved = resolutions[index]!;
    const ok = resolved.state === 'resolved';
    return {
      record_key: source.recordKey,
      original_name: source.originalName,
      original_class: source.originalClass,
      resolution: resolved.state,
      student_uid: ok ? resolved.studentUid : null,
      decision_version: resolved.decisionVersion,
      source_ids_json: ok ? resolved.sourceIds : [],
      observation_ids_json: ok ? resolved.observationIds : [],
      eligibility_json: resolved.eligibility,
    };
  });
}
const sourceShape = (s: Row | StoredSource) => ({
  record_key: s.record_key,
  original_name: s.original_name,
  original_class: s.original_class,
  resolution: s.resolution,
  student_uid: s.student_uid,
  source_ids: json<string[]>(s.source_ids_json),
  observation_ids: json<string[]>(s.observation_ids_json),
  eligibility: json<Eligibility[]>(s.eligibility_json),
});
async function changedSourceKeys(tx: Tx, input: FrequencyCollectionV2, stored: StoredSource[]) {
  const prior = await tx.query<Row>(
    `SELECT DISTINCT ON(s.record_key) s.* FROM attendance.source_row_v2 s JOIN attendance.batch_v2 b ON b.id=s.batch_id WHERE b.academic_year=$1 AND b.class_id=$2 ORDER BY s.record_key,b.received_at DESC,b.id`,
    [input.academicYear, input.classId],
  );
  const previous = new Map(prior.map((s) => [text(s.record_key), s]));
  return new Set(
    stored
      .filter((s) => {
        const before = previous.get(s.record_key);
        return (
          !before ||
          canonicalFrequencyJsonV2(sourceShape(s)) !== canonicalFrequencyJsonV2(sourceShape(before))
        );
      })
      .map((s) => s.record_key),
  );
}
/**
 * The coverage rows to store: the days that changed, plus a tombstone (no slots, complete) for each
 * day up to the capture that a record of this collection had before and no longer has. The diary is
 * annual, so a missing day has no lesson for that record now (the Smecel lists a student twice and
 * swaps the rows' order, or the days became "fora do período de matrícula"). Without it the old row
 * stays the latest and the readers keep an incomplete day. A tombstone never proposes removing a
 * mark: the occurrence belongs to the student and another record may still hold it.
 */
async function coverageDelta(
  tx: Tx,
  input: FrequencyCollectionV2,
  changed: Set<string>,
  cutoff: string,
) {
  const prior = await tx.query<Row>(
    `SELECT DISTINCT ON(c.record_key,c.date) c.record_key,c.date::text,c.slots_json,c.complete FROM attendance.coverage_v2 c JOIN attendance.batch_v2 b ON b.id=c.batch_id WHERE b.academic_year=$1 AND b.class_id=$2 ORDER BY c.record_key,c.date,b.received_at DESC,b.id DESC`,
    [input.academicYear, input.classId],
  );
  const previous = new Map(prior.map((c) => [`${text(c.record_key)}:${text(c.date)}`, c]));
  const delta: { recordKey: string; date: string; slots: number[]; complete: boolean }[] =
    input.coverage.filter((c) => {
      const p = previous.get(`${c.recordKey}:${c.date}`);
      return (
        changed.has(c.recordKey) ||
        !p ||
        truth(p.complete) !== c.complete ||
        canonicalFrequencyJsonV2(json<number[]>(p.slots_json)) !== canonicalFrequencyJsonV2(c.slots)
      );
    });
  const records = new Set(input.records.map((r) => r.recordKey));
  const current = new Set(input.coverage.map((c) => `${c.recordKey}:${c.date}`));
  for (const p of prior) {
    const recordKey = text(p.record_key);
    const date = text(p.date);
    const tombstone = truth(p.complete) && json<number[]>(p.slots_json).length === 0;
    if (records.has(recordKey) && date <= cutoff && !tombstone && !current.has(`${recordKey}:${date}`))
      delta.push({ recordKey, date, slots: [], complete: true });
  }
  return delta;
}
function outsideEnrollment(eligibility: Eligibility[], date: string): boolean {
  return (
    eligibility.length > 0 &&
    eligibility.every(
      (e) => (e.startsOn !== null && date < e.startsOn) || (e.endsOn !== null && date > e.endsOn),
    )
  );
}
function sourceEvents(
  input: FrequencyCollectionV2,
  source: StoredSource,
  previous: Map<string, Mark>,
): IncomingOccurrence[] {
  const uid = text(source.student_uid);
  const recordKey = source.record_key;
  const current = input.marks.filter((m) => m.recordKey === recordKey);
  const events: IncomingOccurrence[] = current.map((mark) => {
    rejectSource(outsideEnrollment(source.eligibility_json, mark.date), 'mark-outside-enrollment');
    const key = `${mark.date}:${mark.slot}`;
    return {
      uid,
      date: mark.date,
      slot: mark.slot,
      mark: mark.mark,
      recordKey,
      changed: !previous.has(key) || previous.get(key) !== mark.mark,
    };
  });
  // Only explicit complete slot evidence can propose removal (then applied by followLatestReading).
  for (const coverage of input.coverage.filter((c) => c.recordKey === recordKey && c.complete))
    for (const slot of coverage.slots) {
      const key = `${coverage.date}:${slot}`;
      const stillMarked = current.some((m) => m.date === coverage.date && m.slot === slot);
      if (previous.has(key) && previous.get(key) !== null && !stillMarked)
        events.push({ uid, date: coverage.date, slot, mark: null, recordKey, changed: true });
    }
  return events;
}
export async function collectionEvents(tx: Tx, input: FrequencyCollectionV2, sources: StoredSource[]) {
  const allPrior = await tx.query<Row>(
    `SELECT DISTINCT ON(p.record_key,o.student_uid,o.date,o.slot) p.record_key,o.student_uid::text,o.date::text,o.slot,p.mark FROM attendance.origin_v2 p JOIN attendance.occurrence_v2 o ON o.id=p.occurrence_id JOIN attendance.source_row_v2 s ON s.batch_id=p.batch_id AND s.record_key=p.record_key JOIN attendance.batch_v2 b ON b.id=p.batch_id WHERE b.academic_year=$1 AND b.class_id=$2 AND b.id<>$3::uuid ORDER BY p.record_key,o.student_uid,o.date,o.slot,b.received_at DESC,b.id DESC`,
    [input.academicYear, input.classId, input.requestId],
  );
  return sources.flatMap((source) => {
    const previous = new Map(
      allPrior
        .filter((p) => p.student_uid === source.student_uid && p.record_key === source.record_key)
        .map((p) => [
          `${text(p.date)}:${Number(p.slot)}`,
          p.mark === null ? null : (text(p.mark) as Mark),
        ]),
    );
    return sourceEvents(input, source, previous);
  });
}
function unresolvedOf(input: FrequencyCollectionV2, stored: StoredSource[]) {
  return stored
    .filter((s) => s.resolution !== 'resolved')
    .map((s) => ({
      name: s.original_name,
      classLabel: input.sourceClassLabel,
      reason: s.resolution === 'ambiguous' ? 'ambiguous' : 'not_found',
      marks: input.marks.filter((m) => m.recordKey === s.record_key).length,
    }));
}
async function insertBatchRows(
  tx: Tx,
  input: FrequencyCollectionV2,
  rows: { sources: StoredSource[]; coverage: unknown[]; marks: unknown[] },
) {
  await tx.executeNative(
    `INSERT INTO attendance.source_row_v2 SELECT $1::uuid,x.* FROM jsonb_to_recordset($2::text::jsonb) AS x(record_key text,original_name text,original_class text,resolution text,student_uid uuid,decision_version bigint,source_ids_json jsonb,observation_ids_json jsonb,eligibility_json jsonb)`,
    [input.requestId, JSON.stringify(rows.sources)],
  );
  await tx.executeNative(
    `INSERT INTO attendance.coverage_v2 SELECT $1::uuid,x."recordKey",x.date,to_jsonb(x.slots),x.complete FROM jsonb_to_recordset($2::text::jsonb) AS x("recordKey" text,date date,slots smallint[],complete boolean)`,
    [input.requestId, JSON.stringify(rows.coverage)],
  );
  await tx.executeNative(
    `INSERT INTO attendance.source_mark_v2 SELECT $1::uuid,x."recordKey",x.date,x.slot,x.mark FROM jsonb_to_recordset($2::text::jsonb) AS x("recordKey" text,date date,slot smallint,mark text)`,
    [input.requestId, JSON.stringify(rows.marks)],
  );
}
async function collect(
  tx: Tx,
  input: FrequencyCollectionV2,
  actor: FrequencyActorV2,
): Promise<Row> {
  await liveLease(tx, input, actor);
  const cutoff = await checkCollectionClock(tx, input);
  const { shift, reportLabel } = await matchCollectionClass(tx, input);
  const classState = await lockClassState(tx, input);
  const contentHash = await frequencyContentHashV2(input);
  const resolutions = await centralMany(
    tx,
    input.academicYear,
    input.records,
    input.sourceVersion,
    input.classId,
    reportLabel,
  );
  const evidenceHash = await frequencyPayloadHashV2({ contentHash, resolutions });
  const existingRows = await tx.query<Row>(
    `SELECT content_hash FROM attendance.batch_v2 WHERE academic_year=$1 AND class_id=$2 AND source_version=$3`,
    [input.academicYear, input.classId, input.sourceVersion],
  );
  if (existingRows.some((existing) => existing.content_hash !== contentHash))
    fail('source-invalid', 409, 'source-version-reused');
  if (classState.last_payload_hash === evidenceHash)
    return repeatCollection(tx, input, actor, classState, evidenceHash);
  const [schoolRow] = await tx.query<Row>(
    `SELECT generation::text FROM attendance.school_state_v2 WHERE academic_year=$1`,
    [input.academicYear],
  );
  const [batch] = (
    await tx.executeNative<Row>(
      `INSERT INTO attendance.batch_v2(id,academic_year,generation,class_id,source_class_id,source_class_label,shift,source_version,content_hash,observed_at,roster_complete,actor_id,device_id,evidence_hash)
    VALUES($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::integer::boolean,$12::uuid,$13::uuid,$14) RETURNING received_at::text`,
      [
        input.requestId,
        input.academicYear,
        text(schoolRow!.generation),
        input.classId,
        input.sourceClassId,
        input.sourceClassLabel,
        shift,
        input.sourceVersion,
        contentHash,
        input.observedAt,
        input.rosterComplete ? 1 : 0,
        actor.actorId,
        device(actor),
        evidenceHash,
      ],
    )
  ).rows;
  const storedSources = storedSourcesOf(input, resolutions);
  const resolvedRecords = storedSources.filter((s) => s.resolution === 'resolved').length;
  const unresolvedRecords = storedSources.length - resolvedRecords;
  const changedSources = await changedSourceKeys(tx, input, storedSources);
  const deltaCoverage = await coverageDelta(tx, input, changedSources, cutoff);
  const events = await collectionEvents(
    tx,
    input,
    storedSources.filter((s) => s.resolution === 'resolved'),
  );
  const deltaEvents = events.filter((e) => e.changed || changedSources.has(e.recordKey));
  const changedMarks = new Set(
    deltaEvents.filter((e) => e.mark !== null).map((e) => `${e.recordKey}:${e.date}:${e.slot}`),
  );
  const deltaMarks = input.marks.filter(
    (m) =>
      changedSources.has(m.recordKey) || changedMarks.has(`${m.recordKey}:${m.date}:${m.slot}`),
  );
  const touched = new Set([
    ...changedSources,
    ...deltaCoverage.map((c) => c.recordKey),
    ...deltaMarks.map((m) => m.recordKey),
    ...deltaEvents.map((e) => e.recordKey),
  ]);
  await insertBatchRows(tx, input, {
    sources: storedSources.filter((s) => touched.has(s.record_key)),
    coverage: deltaCoverage,
    marks: deltaMarks,
  });
  await addOccurrences(tx, input.academicYear, shift, input.requestId, deltaEvents);
  await followLatestReading(tx, input.academicYear, input.classId, actor.actorId);
  const [count] = await tx.query<Row>(
    `SELECT count(DISTINCT c.id)::integer AS count FROM attendance.conflict_v2 c JOIN attendance.origin_v2 p ON p.occurrence_id=c.occurrence_id WHERE p.batch_id=$1::uuid AND c.state='open'`,
    [input.requestId],
  );
  const conflicts = Number(count!.count);
  await tx.executeNative(
    `UPDATE attendance.batch_v2 SET resolved_records=$2,unresolved_records=$3,conflicts=$4 WHERE id=$1::uuid`,
    [input.requestId, resolvedRecords, unresolvedRecords, conflicts],
  );
  await tx.executeNative(
    `UPDATE attendance.class_state_v2 SET revision=revision+1,last_observed_at=$3::timestamptz,last_received_at=clock_timestamp(),last_payload_hash=$4,last_batch_id=$5::uuid,unresolved_json=$6::text::jsonb WHERE academic_year=$1 AND class_id=$2`,
    [
      input.academicYear,
      input.classId,
      input.observedAt,
      evidenceHash,
      input.requestId,
      JSON.stringify(unresolvedOf(input, storedSources)),
    ],
  );
  await touchCollectingDevice(tx, input, actor);
  await liveLease(tx, input, actor); // Recheck after every database wait, before committing the batch.
  return {
    classId: input.classId,
    revision: Number(classState.revision) + 1,
    receivedAt: iso(batch!.received_at),
    resolvedRecords,
    unresolvedRecords,
    conflicts,
  };
}

async function saveSettings(
  { tx, row }: Context,
  input: Extract<Mutation, { operation: 'save-settings' | 'set-paused' }>,
): Promise<Row> {
  if (Number(row.revision) !== input.expectedRevision) fail('revision-conflict');
  if (input.operation === 'save-settings')
    await tx.executeNative(
      `UPDATE attendance.school_state_v2 SET schedule_json=$2::text::jsonb,revision=revision+1 WHERE academic_year=$1`,
      [input.academicYear, JSON.stringify(input.schedule)],
    );
  else
    await tx.executeNative(
      `UPDATE attendance.school_state_v2 SET paused=$2::integer::boolean,revision=revision+1 WHERE academic_year=$1`,
      [input.academicYear, input.paused ? 1 : 0],
    );
  return { settingsRevision: Number(row.revision) + 1 };
}
async function changeDevice(
  { tx, actor }: Context,
  input: Extract<Mutation, { operation: 'rename-device' | 'revoke-device' }>,
): Promise<Row> {
  const [target] = await tx.query<Row>(
    `SELECT device_id FROM collector_auth.device_public_v2 WHERE device_id=$1::uuid AND tenant_id=$2::uuid`,
    [input.deviceId, actor.tenantId],
  );
  if (!target) fail('not-authorized', 403);
  if (input.operation === 'rename-device') {
    await tx.executeNative(
      `INSERT INTO attendance.device_status_v2(academic_year,device_id,label) VALUES($1,$2::uuid,$3) ON CONFLICT(academic_year,device_id) DO UPDATE SET label=EXCLUDED.label`,
      [input.academicYear, input.deviceId, input.label],
    );
    return { deviceId: input.deviceId };
  }
  const [revoked] = await tx.query<Row>(
    `SELECT collector_auth.revoke_device_admin_v2($1::uuid,$2::uuid,$3::uuid) AS revoked`,
    [input.deviceId, actor.tenantId, actor.actorId],
  );
  if (!truth(revoked?.revoked)) fail('not-authorized', 403);
  await tx.executeNative(
    `UPDATE attendance.school_state_v2 SET lease_device=NULL,lease_actor=NULL,lease_until=NULL,fencing_token=fencing_token+1 WHERE academic_year=$1 AND lease_device=$2::uuid`,
    [input.academicYear, input.deviceId],
  );
  return { deviceId: input.deviceId };
}
async function acquireLease(
  { tx, row, actor }: Context,
  input: Extract<Mutation, { operation: 'lease' }>,
): Promise<Row> {
  if (truth(row.paused)) fail('paused');
  const [clock] = await tx.query<Row>(
    `SELECT lease_until>clock_timestamp() AS live FROM attendance.school_state_v2 WHERE academic_year=$1`,
    [input.academicYear],
  );
  if (
    truth(clock!.live) &&
    (row.lease_device !== actor.deviceId || row.lease_actor !== actor.actorId)
  )
    fail('lease-busy');
  const [lease] = (
    await tx.executeNative<Row>(
      `UPDATE attendance.school_state_v2 SET lease_device=$2::uuid,lease_actor=$3::uuid,lease_until=clock_timestamp()+$4::integer*interval '1 second',fencing_token=fencing_token+1 WHERE academic_year=$1 RETURNING fencing_token,lease_until::text`,
      [input.academicYear, device(actor), actor.actorId, input.durationSeconds],
    )
  ).rows;
  await tx.executeNative(
    `INSERT INTO attendance.device_status_v2(academic_year,device_id,last_seen_at) VALUES($1,$2::uuid,clock_timestamp()) ON CONFLICT(academic_year,device_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at`,
    [input.academicYear, device(actor)],
  );
  return {
    fencingToken: Number(lease!.fencing_token),
    expiresAt: iso(lease!.lease_until),
    settingsRevision: Number(row.revision),
  };
}
async function heartbeat(
  tx: Tx,
  input: Extract<Mutation, { operation: 'heartbeat' }>,
  actor: FrequencyActorV2,
) {
  if (input.classId !== null) {
    const exists = await tx.query(`SELECT id FROM gradebook.turma WHERE id=$1 AND ano=$2`, [
      input.classId,
      input.academicYear,
    ]);
    rejectSource(!exists.length, 'heartbeat-class-unknown');
  }
  const [previous] = await tx.query<Row>(
    `SELECT state,code FROM attendance.device_status_v2 WHERE academic_year=$1 AND device_id=$2::uuid`,
    [input.academicYear, device(actor)],
  );
  await tx.executeNative(
    `UPDATE attendance.device_status_v2 SET last_seen_at=clock_timestamp(),state=$3,class_id=$4,code=$5 WHERE academic_year=$1 AND device_id=$2::uuid`,
    [input.academicYear, device(actor), input.status, input.classId, input.code],
  );
  // The computer's own problems (Smecel session, class, storage) join the seven-day trail.
  const problem = input.status === 'error' || input.status === 'login-required';
  if (problem && (previous?.state !== input.status || previous?.code !== input.code))
    await insertFrequencyFailureV2(tx, {
      origin: 'device-report',
      operation: 'heartbeat',
      code: input.code ?? input.status,
      deviceId: device(actor),
      classId: input.classId,
    });
}
async function reportOnLease(
  { tx, actor }: Context,
  input: Extract<Mutation, { operation: 'heartbeat' | 'release' }>,
): Promise<Row> {
  const lease = await liveLease(tx, input, actor, true);
  if (input.operation === 'heartbeat') await heartbeat(tx, input, actor);
  else {
    await tx.executeNative(
      `UPDATE attendance.school_state_v2 SET lease_device=NULL,lease_actor=NULL,lease_until=NULL WHERE academic_year=$1`,
      [input.academicYear],
    );
    await tx.executeNative(
      `UPDATE attendance.device_status_v2 SET last_seen_at=clock_timestamp(),state='ready',class_id=NULL,code=$3 WHERE academic_year=$1 AND device_id=$2::uuid`,
      [input.academicYear, device(actor), input.code],
    );
  }
  return {
    fencingToken: input.fencingToken,
    expiresAt: input.operation === 'release' ? null : iso(lease.lease_until),
  };
}
async function resolveConflict(
  { tx, actor }: Context,
  input: Extract<Mutation, { operation: 'resolve-conflict' }>,
): Promise<Row> {
  const [conflict] = await tx.query<Row>(
    `SELECT c.*,o.mark,o.academic_year FROM attendance.conflict_v2 c JOIN attendance.occurrence_v2 o ON o.id=c.occurrence_id WHERE c.id=$1::uuid FOR UPDATE OF c,o`,
    [input.conflictId],
  );
  if (
    Number(conflict?.academic_year) !== input.academicYear ||
    conflict?.state !== 'open' ||
    Number(conflict.revision) !== input.expectedRevision
  )
    fail('revision-conflict');
  if (!json<Mark[]>(conflict.marks_json).includes(input.mark))
    fail('source-invalid', 400, 'conflict-mark-not-offered');
  const evidence = await tx.query<Row>(
    `SELECT b.academic_year,b.class_id,b.id::text AS batch_id,s.* FROM attendance.origin_v2 p JOIN attendance.batch_v2 b ON b.id=p.batch_id JOIN attendance.source_row_v2 s ON s.batch_id=p.batch_id AND s.record_key=p.record_key WHERE p.occurrence_id=$1::uuid`,
    [text(conflict.occurrence_id)],
  );
  if ((await sourcesValid(tx, evidence)).some((v) => !v))
    fail('identity-review', 409, 'conflict-evidence-invalid');
  await tx.executeNative(
    `INSERT INTO attendance.correction_v2(id,conflict_id,actor_id,before_mark,after_mark,reason) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)`,
    [
      input.requestId,
      input.conflictId,
      actor.actorId,
      conflict.mark === null ? null : text(conflict.mark),
      input.mark,
      input.reason,
    ],
  );
  await tx.executeNative(
    `UPDATE attendance.occurrence_v2 SET mark=$2,revision=revision+1 WHERE id=$1::uuid`,
    [text(conflict.occurrence_id), input.mark],
  );
  await tx.executeNative(
    `UPDATE attendance.conflict_v2 SET state='resolved',resolved_at=clock_timestamp(),revision=revision+1 WHERE id=$1::uuid`,
    [input.conflictId],
  );
  return { conflictId: input.conflictId, revision: Number(conflict.revision) + 1 };
}
/**
 * The diary did not change since the content the collector last sent (owner decision 22/10/2026):
 * it sends the students and the content's hash instead of coverage and marks. Every guard of a
 * collection still applies (lease, device, clock, class, revision, order). The students are
 * resolved again, so a link made in the Centro since the last batch changes the evidence; only the
 * evidence the class already holds moves freshness, like a repeated payload. Anything else asks
 * for the whole diary ('payload-required'), so the collector's local copy never decides alone.
 */
async function collectUnchanged(tx: Tx, input: FrequencyUnchangedV2, actor: FrequencyActorV2): Promise<Row> {
  const { contentHash, ...fields } = input;
  const collection: FrequencyCollectionV2 = { ...fields, operation: 'collect', coverage: [], marks: [] };
  await liveLease(tx, collection, actor);
  await checkCollectionClock(tx, collection);
  const { reportLabel } = await matchCollectionClass(tx, collection);
  const classState = await lockClassState(tx, collection);
  const resolutions = await centralMany(
    tx,
    input.academicYear,
    input.records,
    input.sourceVersion,
    input.classId,
    reportLabel,
  );
  const evidenceHash = await frequencyPayloadHashV2({ contentHash, resolutions });
  if (classState.last_payload_hash !== evidenceHash)
    fail('payload-required', 409, 'evidence-changed');
  return repeatCollection(tx, collection, actor, classState, evidenceHash);
}
/**
 * The school's weekly grid (owner decision 22/10/2026): one capture of the Smecel "Grade de
 * horários" with every linked class. A class whose grid changed gets a new version (the history
 * stays); an unchanged one only moves its freshness. A class not linked in the Centro, or a
 * capture older than the class's last one, rejects the whole capture.
 */
async function collectSchedule(
  tx: Tx,
  input: FrequencyScheduleCollectionV2,
  actor: FrequencyActorV2,
): Promise<Row> {
  await liveLease(tx, input, actor);
  const [clock] = await tx.query<Row>(`SELECT clock_timestamp()::text AS now`, []);
  rejectSource(
    new Date(input.observedAt).getTime() > new Date(text(clock!.now)).getTime() + 5000,
    'observed-in-future',
  );
  const classes: { classId: number; changed: boolean }[] = [];
  for (const item of input.classes) {
    await matchSourceClass(tx, { academicYear: input.academicYear, ...item });
    const contentHash = await frequencyScheduleHashV2(item);
    const [state] = await tx.query<Row>(
      `SELECT s.last_observed_at::text,v.content_hash FROM attendance.schedule_state_v2 s
      JOIN attendance.schedule_version_v2 v ON v.id=s.current_version_id
      WHERE s.academic_year=$1 AND s.class_id=$2 FOR UPDATE OF s`,
      [input.academicYear, item.classId],
    );
    if (state && new Date(text(state.last_observed_at)) > new Date(input.observedAt))
      fail('source-invalid', 409, 'older-than-last-collection');
    if (state && text(state.content_hash) === contentHash) {
      await tx.executeNative(
        `UPDATE attendance.schedule_state_v2 SET last_observed_at=$3::timestamptz,last_received_at=clock_timestamp() WHERE academic_year=$1 AND class_id=$2`,
        [input.academicYear, item.classId, input.observedAt],
      );
      classes.push({ classId: item.classId, changed: false });
      continue;
    }
    const lessons = [...item.lessons].sort((a, b) => a.weekday - b.weekday || a.slot - b.slot);
    const [version] = (
      await tx.executeNative<Row>(
        `INSERT INTO attendance.schedule_version_v2(id,academic_year,class_id,source_version,source_class_id,source_class_label,content_hash,lessons_json,observed_at,actor_id,device_id)
        VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7::text::jsonb,$8::timestamptz,$9::uuid,$10::uuid) RETURNING id::text`,
        [
          input.academicYear,
          item.classId,
          input.sourceVersion,
          item.sourceClassId,
          item.sourceClassLabel,
          contentHash,
          JSON.stringify(lessons),
          input.observedAt,
          actor.actorId,
          device(actor),
        ],
      )
    ).rows;
    await tx.executeNative(
      `INSERT INTO attendance.schedule_state_v2(academic_year,class_id,current_version_id,last_observed_at,last_received_at)
      VALUES($1,$2,$3::uuid,$4::timestamptz,clock_timestamp())
      ON CONFLICT(academic_year,class_id) DO UPDATE SET current_version_id=EXCLUDED.current_version_id,
        last_observed_at=EXCLUDED.last_observed_at,last_received_at=EXCLUDED.last_received_at`,
      [input.academicYear, item.classId, text(version!.id), input.observedAt],
    );
    classes.push({ classId: item.classId, changed: true });
  }
  return { classes };
}
function mutate(context: Context, input: Mutation): Promise<Row> {
  switch (input.operation) {
    case 'save-settings':
    case 'set-paused':
      return saveSettings(context, input);
    case 'rename-device':
    case 'revoke-device':
      return changeDevice(context, input);
    case 'lease':
      return acquireLease(context, input);
    case 'heartbeat':
    case 'release':
      return reportOnLease(context, input);
    case 'collect':
      return collect(context.tx, input, context.actor);
    case 'collect-unchanged':
      return collectUnchanged(context.tx, input, context.actor);
    case 'schedule-collect':
      return collectSchedule(context.tx, input, context.actor);
    case 'resolve-conflict':
      return resolveConflict(context, input);
  }
}

function authorizeOperation(input: FrequencyRequestV2, actor: FrequencyActorV2) {
  if (
    !studentUidV1.safeParse(actor.actorId).success ||
    !studentUidV1.safeParse(actor.tenantId).success
  )
    fail('not-authorized', 403);
  if (DEVICE_ONLY.has(input.operation)) device(actor);
  if (ADMIN_ONLY.has(input.operation)) admin(actor);
  if (
    input.operation === 'rename-device' &&
    actor.mode === 'device' &&
    input.deviceId !== device(actor)
  )
    fail('not-authorized', 403);
}
async function statusOperation(tx: Tx, row: Row, actor: FrequencyActorV2, year: number) {
  if (actor.mode === 'device') {
    const [operational] = (
      await tx.executeNative<Row>(
        `INSERT INTO attendance.device_status_v2(academic_year,device_id,last_seen_at) VALUES($1,$2::uuid,clock_timestamp()) ON CONFLICT(academic_year,device_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at RETURNING (xmax=0) AS inserted`,
        [year, device(actor)],
      )
    ).rows;
    if (truth(operational?.inserted)) await recordFrequencyResetWriteV2(tx, year);
  }
  const result = await status(tx, row, actor);
  await lockDevice(tx, actor);
  return result;
}
async function priorReceipt(
  tx: Tx,
  input: Mutation | Extract<FrequencyRequestV2, { operation: 'receipt' }>,
  actor: FrequencyActorV2,
) {
  const [retired] = await tx.query<Row>(
    `SELECT request_id FROM attendance.retired_request_v2 WHERE academic_year=$1 AND request_id=$2::uuid`,
    [input.academicYear, input.requestId],
  );
  if (retired) fail('revision-conflict', 409, 'request-retired');
  const [receipt] = await tx.query<Row>(
    `SELECT * FROM attendance.receipt_v2 WHERE academic_year=$1 AND request_id=$2::uuid`,
    [input.academicYear, input.requestId],
  );
  if (
    receipt &&
    (receipt.actor_id !== actor.actorId || receipt.device_id !== (actor.deviceId ?? null))
  )
    fail('not-authorized', 403);
  return receipt;
}
async function finishMutation(
  { tx, row, actor }: Context,
  input: Mutation,
  hash: string,
  result: Row,
) {
  await tx.executeNative(
    `INSERT INTO attendance.receipt_v2(academic_year,generation,request_id,actor_id,device_id,payload_hash,result_json) VALUES($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::text::jsonb)`,
    [
      input.academicYear,
      text(row.generation),
      input.requestId,
      actor.actorId,
      actor.deviceId ?? null,
      hash,
      JSON.stringify(result),
    ],
  );
  if (!UNLEASED.has(input.operation)) await recordFrequencyResetWriteV2(tx, input.academicYear);
  await lockDevice(tx, actor);
  if (COLLECTING.has(input.operation) || input.operation === 'heartbeat')
    await liveLease(tx, input as { academicYear: number; fencingToken: number }, actor, input.operation === 'heartbeat');
  if (input.operation === 'heartbeat') await purgeFrequencyOperationalRowsV2(tx);
  if (input.operation === 'lease')
    await liveLease(
      tx,
      { academicYear: input.academicYear, fencingToken: Number(result.fencingToken) },
      actor,
    );
}

/** One physical transaction: reset lock, device lock, school row, then the operation and its receipt. */
async function runOperation(
  tx: Tx,
  input: FrequencyRequestV2,
  actor: FrequencyActorV2,
): Promise<Row | FrequencyStatusV2 | FrequencySummaryV2> {
  await lockResetWriterV1(tx, input.academicYear);
  await lockDevice(tx, actor);
  const row = await school(tx, input.academicYear, actor.tenantId);
  if (input.operation === 'status') return statusOperation(tx, row, actor, input.academicYear);
  if (input.operation === 'monthly-summary')
    return summaryInTx(tx, input.academicYear, input.studentUid, input.month);
  const receipt = await priorReceipt(tx, input, actor);
  if (input.operation === 'receipt')
    return {
      contractVersion: 2,
      state: 'ready',
      operation: 'receipt',
      requestId: input.requestId,
      result: receipt ? json<Row>(receipt.result_json) : null,
    };
  const hash = await frequencyPayloadHashV2(input);
  if (receipt) {
    if (receipt.payload_hash !== hash) fail('revision-conflict', 409, 'request-reused');
    return json<Row>(receipt.result_json);
  }
  const context = { tx, row, actor };
  const fields = await mutate(context, input);
  const result = {
    contractVersion: 2,
    state: 'committed',
    operation: input.operation,
    requestId: input.requestId,
    ...fields,
  };
  await finishMutation(context, input, hash, result);
  return result;
}
export function createFrequencyServiceV2(database: GradebookPostgresDatabaseV1) {
  return {
    async execute(
      payload: unknown,
      actor: FrequencyActorV2,
    ): Promise<Row | FrequencyStatusV2 | FrequencySummaryV2> {
      const parsed = frequencyRequestV2.safeParse(payload);
      if (!parsed.success) fail('invalid-request', 400);
      const input = parsed.data;
      authorizeOperation(input, actor);
      return database.transaction((tx) => runOperation(tx, input, actor));
    },
    async summary(
      year: number,
      studentUid: string,
      month: string,
      authorize: () => Promise<boolean>,
    ): Promise<FrequencySummaryV2> {
      if (!(await authorize())) fail('not-authorized', 403);
      const parsed = frequencyRequestV2.safeParse({
        operation: 'monthly-summary',
        academicYear: year,
        studentUid,
        month,
      });
      if (!parsed.success) fail('invalid-request', 400);
      return database.transaction(async (tx) => {
        await lockResetWriterV1(tx, year);
        const value = await summaryInTx(tx, year, studentUid, month);
        if (!(await authorize())) fail('not-authorized', 403);
        return value;
      });
    },
  };
}
export type FrequencyServiceV2 = ReturnType<typeof createFrequencyServiceV2>;
const yearlyTables = [
  'correction_v2',
  'conflict_v2',
  'origin_v2',
  // Evidence lines removed by the nightly pruning, archived with their school year (0009).
  'pruned_origin_v2',
  // The weekly grids (0010): the current pointer, then every version.
  'schedule_state_v2',
  'schedule_version_v2',
  'source_mark_v2',
  'coverage_v2',
  'source_row_v2',
  'batch_v2',
  'occurrence_v2',
  'class_state_v2',
  'device_status_v2',
  'receipt_v2',
] as const;
function yearPredicate(table: (typeof yearlyTables)[number]): string {
  if (table === 'correction_v2')
    return `conflict_id IN(SELECT c.id FROM attendance.conflict_v2 c JOIN attendance.occurrence_v2 o ON o.id=c.occurrence_id WHERE o.academic_year=$1)`;
  if (table === 'conflict_v2' || table === 'origin_v2')
    return `occurrence_id IN(SELECT id FROM attendance.occurrence_v2 WHERE academic_year=$1)`;
  if (table === 'source_mark_v2' || table === 'coverage_v2' || table === 'source_row_v2')
    return `batch_id IN(SELECT id FROM attendance.batch_v2 WHERE academic_year=$1)`;
  return 'academic_year=$1';
}
/** One statement: every count comes from the same snapshot. */
export async function frequencyYearCountsV2(tx: Tx, year: number): Promise<Record<string, number>> {
  const columns = yearlyTables.map(
    (table) =>
      `(SELECT count(*)::integer FROM attendance.${table} WHERE ${yearPredicate(table)}) AS ${table}`,
  );
  const [row] = await tx.query<Row>('SELECT ' + columns.join(','), [year]);
  return Object.fromEntries(yearlyTables.map((table) => [table, Number(row![table])]));
}
/**
 * Caller already owns the exclusive canonical annual reset lock. A single
 * statement deletes every yearly table; NO ACTION keys are checked at its end.
 */
export async function resetFrequencyYearV2(tx: Tx, year: number): Promise<Record<string, number>> {
  const counts = await frequencyYearCountsV2(tx, year);
  await tx.executeNative(
    `INSERT INTO attendance.retired_request_v2(academic_year,request_id) SELECT academic_year,request_id FROM attendance.receipt_v2 WHERE academic_year=$1 ON CONFLICT DO NOTHING`,
    [year],
  );
  const deletions = yearlyTables.map(
    (table, index) =>
      `d${index} AS (DELETE FROM attendance.${table} WHERE ${yearPredicate(table)} RETURNING 1)`,
  );
  await tx.executeNative('WITH ' + deletions.join(',') + ' SELECT 1', [year]);
  await tx.executeNative(
    `UPDATE attendance.school_state_v2 SET generation=gen_random_uuid(),revision=revision+1,paused=true,lease_device=NULL,lease_actor=NULL,lease_until=NULL,fencing_token=fencing_token+1 WHERE academic_year=$1`,
    [year],
  );
  return counts;
}
