import { z } from 'zod';
import { studentUidV1 } from '../student-identity/student-identity-v1';

export const FREQUENCY_CONTRACT_V2 = 2;
export const FREQUENCY_BODY_BYTES_V2 = 16 * 1024 * 1024;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uid = studentUidV1;
const year = z.literal(2026);
const civilDate = z.iso.date();
const label = z.string().trim().min(1).max(300);
const recordKey = z.string().min(1).max(200);
const slot = z.number().int().min(1).max(6);
const slots = z.array(slot).min(1).max(6).refine(v => new Set(v).size === v.length);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);
export const frequencyScheduleV2 = z.object({
  // Named IANA zone with its exact spelling. Offsets such as "-03:00" have the
  // opposite sign in PostgreSQL AT TIME ZONE, and the Windows collector (zoneinfo)
  // rejects offsets and other capitalizations.
  timezone: z.string().min(1).max(80).regex(/^[A-Za-z][\w+-]*(?:\/[\w+-]+)*$/u).refine(value => {
    try { return new Intl.DateTimeFormat('pt-BR', { timeZone: value }).resolvedOptions().timeZone === value; } catch { return false; }
  }),
  rules: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    shift: z.enum(['matutino', 'vespertino']),
    enabled: z.boolean(),
    times: z.array(time).max(48).refine(v => new Set(v).size === v.length),
    recheck: time.nullable(),
  }).strict().refine(r => r.recheck === null || (r.times.length < 48 && r.times.every(t => t < r.recheck!)), {
    message: 'Rechecagem deve ocorrer após os horários e respeitar o limite diário.',
  })).length(14).refine(v => new Set(v.map(r => `${r.weekday}:${r.shift}`)).size === 14),
}).strict();
/** Collection budget of one school day, across both shifts (times and rechecks). */
export const FREQUENCY_MAX_DAILY_SLOTS_V2 = 48;
export const FREQUENCY_MIN_SLOT_GAP_MINUTES_V2 = 5;
/** Index = weekday as stored (0 = Sunday), for messages that name the day. */
const WEEKDAY_NAMES_V2 = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'] as const;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/**
 * What a save may write. Reads stay on the tolerant frequencyScheduleV2 so an
 * agenda stored earlier is never unreadable; new agendas must be executable:
 * an enabled shift has a time, a day has at most 48 distinct moments and two
 * moments are at least 5 minutes apart.
 */
export const frequencyScheduleWriteV2 = frequencyScheduleV2.superRefine((schedule, ctx) => {
  schedule.rules.forEach((rule, index) => {
    if (rule.enabled && rule.times.length === 0 && rule.recheck === null)
      ctx.addIssue({ code: 'custom', path: ['rules', index], message: 'Turno ativo precisa de pelo menos um horário.' });
  });
  WEEKDAY_NAMES_V2.forEach((name, weekday) => {
    const day = [...new Set(schedule.rules
      .filter(r => r.enabled && r.weekday === weekday)
      .flatMap(r => [...r.times, ...(r.recheck ? [r.recheck] : [])]))].map(minutes).sort((a, b) => a - b);
    if (day.length > FREQUENCY_MAX_DAILY_SLOTS_V2)
      ctx.addIssue({ code: 'custom', path: ['rules'], message: `${name}: no máximo ${FREQUENCY_MAX_DAILY_SLOTS_V2} coletas por dia.` });
    if (day.some((value, i) => i > 0 && value - (day[i - 1] ?? value) < FREQUENCY_MIN_SLOT_GAP_MINUTES_V2))
      ctx.addIssue({ code: 'custom', path: ['rules'], message: `${name}: deixe pelo menos ${FREQUENCY_MIN_SLOT_GAP_MINUTES_V2} minutos entre as coletas.` });
  });
});
const read = { academicYear: year };
const classId = z.number().int().positive();
const sourceVersion = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const sourceClassId = z.string().regex(/^[1-9]\d{0,9}$/u);
const observedAt = z.iso.datetime({ offset: true });
const records = z.array(z.object({ recordKey, originalName: label, originalClass: label }).strict()).min(1).max(64);
/** frequencyPayloadHashV2 output: base64url SHA-256, no padding. */
const payloadHash = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
/** One lesson of a class's weekly grid: Monday (1) to Friday (5), the diary's position, the subject as the Smecel names it. */
const scheduleLesson = z.object({
  weekday: z.number().int().min(1).max(5), slot,
  subject: z.string().trim().min(1).max(120),
}).strict();
const mutation = { ...read, requestId: uid };
const fenced = { ...mutation, fencingToken: revision };
export const frequencyRequestV2 = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status'), ...read }).strict(),
  z.object({ operation: z.literal('receipt'), ...mutation }).strict(),
  z.object({ operation: z.literal('save-settings'), ...mutation, expectedRevision: revision, schedule: frequencyScheduleWriteV2 }).strict(),
  z.object({ operation: z.literal('set-paused'), ...mutation, expectedRevision: revision, paused: z.boolean() }).strict(),
  z.object({ operation: z.literal('rename-device'), ...mutation, deviceId: uid, label: z.string().trim().min(1).max(80) }).strict(),
  z.object({ operation: z.literal('revoke-device'), ...mutation, deviceId: uid }).strict(),
  z.object({ operation: z.literal('lease'), ...mutation, durationSeconds: z.number().int().min(15).max(300) }).strict(),
  z.object({ operation: z.literal('heartbeat'), ...fenced, status: z.enum(['ready', 'collecting', 'login-required', 'error']), classId: z.number().int().positive().nullable(), code: z.string().regex(/^[A-Z_]{1,60}$/u).nullable() }).strict(),
  z.object({ operation: z.literal('release'), ...fenced, code: z.string().regex(/^[A-Z_]{1,60}$/u).nullable() }).strict(),
  z.object({ operation: z.literal('collect'), ...fenced,
    classId, expectedRevision: revision, sourceVersion, sourceClassId, sourceClassLabel: label,
    observedAt, rosterComplete: z.boolean(), records,
    coverage: z.array(z.object({ recordKey, date: civilDate, slots, complete: z.boolean() }).strict()).max(24_000),
    marks: z.array(z.object({ recordKey, date: civilDate, slot, mark: z.enum(['X', 'J']) }).strict()).max(130_000),
  }).strict(),
  /**
   * The class's diary did not change since the content the collector last sent (owner decision
   * 22/10/2026): the same fields as `collect` but, instead of coverage and marks, their
   * frequencyContentHashV2. The server answers 'payload-required' unless it matches what it holds.
   */
  z.object({ operation: z.literal('collect-unchanged'), ...fenced,
    classId, expectedRevision: revision, sourceVersion, sourceClassId, sourceClassLabel: label,
    observedAt, rosterComplete: z.boolean(), records, contentHash: payloadHash,
  }).strict(),
  /** The school's weekly grid (Smecel "Grade de horários"), every linked class in one capture. */
  z.object({ operation: z.literal('schedule-collect'), ...fenced, sourceVersion, observedAt,
    classes: z.array(z.object({
      classId, sourceClassId, sourceClassLabel: label,
      lessons: z.array(scheduleLesson).max(30)
        .refine(v => new Set(v.map(l => `${l.weekday}:${l.slot}`)).size === v.length),
    }).strict()).min(1).max(64)
      .refine(v => new Set(v.map(c => c.classId)).size === v.length)
      .refine(v => new Set(v.map(c => c.sourceClassId)).size === v.length),
  }).strict(),
  z.object({ operation: z.literal('resolve-conflict'), ...mutation, conflictId: uid, expectedRevision: revision, mark: z.enum(['X','J']).nullable(), reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ operation: z.literal('monthly-summary'), ...read, studentUid: uid, month: z.string().regex(/^2026-(0[1-9]|1[0-2])$/u) }).strict(),
]);
export type FrequencyRequestV2 = z.infer<typeof frequencyRequestV2>;
export type FrequencyCollectionV2 = Extract<FrequencyRequestV2, { operation: 'collect' }>;
export type FrequencyUnchangedV2 = Extract<FrequencyRequestV2, { operation: 'collect-unchanged' }>;
export type FrequencyScheduleCollectionV2 = Extract<FrequencyRequestV2, { operation: 'schedule-collect' }>;
export type FrequencyScheduleLessonV2 = z.infer<typeof scheduleLesson>;
export type FrequencyScheduleV2 = z.infer<typeof frequencyScheduleV2>;

/** Server-created only, after Entra session or payload-bound device proof. */
export type FrequencyActorV2 = {
  actorId: string; tenantId: string; mode: 'admin' | 'device';
  deviceId?: string; deviceGeneration?: number; keyThumbprint?: string;
};
export type FrequencyClassV2 = { classId: number; sourceClassLabel: string; shift: string; revision: number };
export type FrequencyDeviceV2 = {
  deviceId: string; label: string; state: 'ready' | 'collecting' | 'reserve' | 'paused' | 'login-required' | 'error' | 'offline' | 'revoked';
  lastSeenAt: string | null; classId: number | null; code: string | null; lastCollectionAt: string | null;
};
export type FrequencyConflictV2 = {
  id: string; revision: number; studentUid: string; studentName: string;
  classLabel: string; date: string; slot: number; shift: string; marks: ('X' | 'J' | null)[];
};
export type FrequencyStatusV2 = {
  contractVersion: 2; state: 'ready'; academicYear: 2026; serverTime: string;
  settings: { revision: number; paused: boolean; schedule: FrequencyScheduleV2 | null };
  lease: { deviceId: string; expiresAt: string; fencingToken: number } | null;
  classes: FrequencyClassV2[]; devices: FrequencyDeviceV2[];
  collections: { classId: number; observedAt: string; receivedAt: string; resolvedRecords: number; unresolvedRecords: number; conflicts: number }[];
  conflicts: FrequencyConflictV2[];
  /** Administrator view only; empty for a collector device. */
  unresolved: FrequencyUnresolvedV2[];
  failures: FrequencyFailureEntryV2[];
};
/** Smecel rows of the latest collection that no reconciled student matches yet. */
export type FrequencyUnresolvedV2 = {
  classId: number; classLabel: string; name: string;
  reason: 'not_found' | 'ambiguous'; marks: number; observedAt: string;
};
export type FrequencyFailureEntryV2 = {
  firstAt: string; lastAt: string; occurrences: number;
  origin: 'collector' | 'admin' | 'device-report'; operation: string; code: string; detail: string;
  deviceId: string | null; classId: number | null;
};
/**
 * One school day of the student in the Smecel diary (owner decision 20/10/2026): the lesson positions
 * that existed that day (a point, an X or a justified mark), so 5- or 6-lesson days, weekends,
 * holidays and days outside the enrolment need no configuration. `complete`: the collector read
 * every position of the day.
 */
export type FrequencyDayV2 = { date: string; shift: string; slots: number[]; complete: boolean };
export type FrequencySummaryV2 = {
  contractVersion: 2; state: 'ready'; month: string;
  absences: number | null; justified: number | null; denominator: number | null; percentage: number | null;
  coverage: 'reliable' | 'incomplete' | 'unavailable'; observedAt: string | null; receivedAt: string | null;
  marks: { date: string; slot: number; shift: string; mark: 'X' | 'J'; classLabels: string[] }[];
  conflicts: number;
  /** Lesson days of the month; absent from a server before the Smecel lesson days. */
  days?: FrequencyDayV2[];
  /** The school's date (attendance 0012): today never counts and the page marks it "HOJE". */
  today?: string;
  /** Lessons and absences of the year so far, today excluded; null while any month is unknown. */
  year?: { lessons: number; absences: number } | null;
  /** The last reading of the diary of the student's class(es), for "Atualizado em". */
  lastReadAt?: string | null;
};

/**
 * The student's whole school year so far in one answer (GET /api/student/frequency?year=2026): one
 * summary per month from January to the current one, the school's today, the year's counts and the
 * class's last reading. Read with the sign-in, so changing months never asks the server again.
 */
export type FrequencyYearSummaryV2 = {
  contractVersion: 2; state: 'ready'; academicYear: 2026; today: string;
  year: { lessons: number; absences: number } | null; lastReadAt: string | null;
  months: FrequencySummaryV2[];
};

/** Lessons and absences (X) of the days already over; `reliable`: nothing of them is still unknown. */
export type FrequencyCountV2 = { lessons: number; absences: number; reliable: boolean };
/**
 * A month's counts by the owner's rule (20–21/10/2026): lessons are the positions of the days
 * already over (TODAY never counts: its roll call may still be under way), absences their X marks,
 * a J is not taken off. Reliable when every one of those days was read in full, no conflict is
 * open and every mark of them has its lesson day. The server's totals and the Portal agree on it.
 */
export function frequencyCountV2(
  summary: Pick<FrequencySummaryV2, 'marks' | 'conflicts' | 'days'>,
  today: string,
): FrequencyCountV2 {
  const lessonsOver = new Set(
    (summary.days ?? [])
      .filter((day) => day.date < today)
      .flatMap((day) => day.slots.map((slot) => `${day.date}|${day.shift}:${slot}`)),
  );
  const marksOver = summary.marks.filter((mark) => mark.date < today);
  return {
    lessons: lessonsOver.size,
    absences: marksOver.filter((mark) => mark.mark === 'X').length,
    reliable:
      summary.conflicts === 0 &&
      (summary.days ?? []).every((day) => day.date >= today || day.complete) &&
      marksOver.every((mark) => lessonsOver.has(`${mark.date}|${mark.shift}:${mark.slot}`)),
  };
}

/** Same UTF-8 bytes in Python and JS; no locale-sensitive key ordering. */
function compareCanonicalKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
export function canonicalFrequencyJsonV2(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalFrequencyJsonV2).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record).sort(compareCanonicalKeys)
      .map(key => JSON.stringify(key) + ':' + canonicalFrequencyJsonV2(record[key]));
    return '{' + members.join(',') + '}';
  }
  return JSON.stringify(value);
}
/**
 * Class identity between Smecel and the Centro: accents, case, spacing and
 * punctuation never distinguish classes ("8D 2026 -VESPERTINO"). The Windows
 * collector applies the same rule (NFD, drop marks, upper case, keep A-Z/0-9).
 */
export function frequencyClassKeyV2(label: string): string {
  return label.normalize('NFD').replace(/[̀-ͯ]/gu, '').toUpperCase().replace(/[^A-Z0-9]/gu, '');
}
export async function frequencyPayloadHashV2(value: unknown): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalFrequencyJsonV2(value))));
  return btoa(String.fromCodePoint(...hash)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
/**
 * The content of one class's diary, as the server compares it: the collector computes the same
 * value (canonical JSON, SHA-256, base64url) to know whether anything changed since its last send.
 */
export function frequencyContentHashV2(input: Pick<FrequencyCollectionV2,
  'classId' | 'sourceClassId' | 'sourceClassLabel' | 'rosterComplete' | 'records' | 'coverage' | 'marks'>): Promise<string> {
  return frequencyPayloadHashV2({
    classId: input.classId, sourceClassId: input.sourceClassId, sourceClassLabel: input.sourceClassLabel,
    rosterComplete: input.rosterComplete, records: input.records, coverage: input.coverage, marks: input.marks,
  });
}
/** One class's weekly grid as stored and compared: lessons in day then position order. */
export function frequencyScheduleHashV2(item: { classId: number; sourceClassId: string; sourceClassLabel: string;
  lessons: readonly FrequencyScheduleLessonV2[] }): Promise<string> {
  return frequencyPayloadHashV2({
    classId: item.classId, sourceClassId: item.sourceClassId, sourceClassLabel: item.sourceClassLabel,
    lessons: [...item.lessons].sort((a, b) => a.weekday - b.weekday || a.slot - b.slot),
  });
}
