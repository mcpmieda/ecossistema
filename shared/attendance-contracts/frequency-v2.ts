import { z } from 'zod';
import { studentUidV1 } from '../student-identity/student-identity-v1';
import { reportRowV1, REPORT_MAX_ROWS_V1 } from '../student-identity/reconciliation-v1';

export const FREQUENCY_BODY_BYTES_V2 = 16 * 1024 * 1024;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uid = studentUidV1;
const year = z.literal(2026);
const civilDate = z.iso.date();
const label = z.string().trim().min(1).max(300);
const recordKey = z.string().min(1).max(200);
const slot = z.number().int().min(1).max(6);
const slots = z
  .array(slot)
  .min(1)
  .max(6)
  .refine((v) => new Set(v).size === v.length);
const optionalSlots = slots.optional();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);
const profileText = z.string().min(1).max(300).nullable();
const profileDigits = (shape: RegExp) => z.string().regex(shape).nullable();
const profileFlag = z.boolean().nullable();
/**
 * The enrolment form's data of one row of the Smecel report (coletor#91), for the online
 * re-enrolment: what the guardian checks, what the guardian may update and what only the printed
 * form shows. The Coletor already normalized it: documents, CEP and phones as digits, SIM/NAO as a
 * boolean, anything empty or out of its shape as null. Personal data (documents, address, phones,
 * health): kept only in attendance.student_report_profile_v2, never in a receipt, a note, the
 * Conciliação or a log.
 */
export const studentReportProfileV2 = z
  .object({
    sex: profileText,
    nationality: profileText,
    birthState: profileText,
    birthCity: profileText,
    cpf: profileDigits(/^\d{11}$/u),
    filiation2: profileText,
    filiation1Rg: profileText,
    filiation2Rg: profileText,
    rg: profileText,
    rgIssuer: profileText,
    rgIssuerState: profileText,
    sus: profileDigits(/^\d{1,20}$/u),
    race: profileText,
    mobile: profileDigits(/^\d{1,20}$/u),
    cep: profileDigits(/^\d{8}$/u),
    address: profileText,
    addressNumber: profileText,
    addressComplement: profileText,
    district: profileText,
    city: profileText,
    state: profileText,
    filiation1Phone: profileDigits(/^\d{1,20}$/u),
    filiation2Phone: profileDigits(/^\d{1,20}$/u),
    guardianName: profileText,
    /** 1 = Irmão/Irmã, 2 = Tio/Tia, 3 = Avô/Avó, 4 = Outro, as the Smecel's student form. */
    guardianDegree: z.number().int().min(1).max(4).nullable(),
    guardianCpf: profileDigits(/^\d{11}$/u),
    schoolTransport: profileFlag,
    allergy: profileFlag,
    allergyDetail: profileText,
    bolsaFamilia: profileFlag,
    disability: profileFlag,
    lowVision: profileFlag,
    blindness: profileFlag,
    hearingDisability: profileFlag,
    physicalDisability: profileFlag,
    intellectualDisability: profileFlag,
    autism: profileFlag,
  })
  .strict();
export type StudentReportProfileV2 = z.infer<typeof studentReportProfileV2>;
/** A report row as the Coletor sends it: the Conciliação's row and, optionally, its profile. */
const studentReportRowV2 = reportRowV1.extend({ profile: studentReportProfileV2.optional() });
/** Zones already accepted, so a parse builds the Intl check once per zone. Only valid IANA names enter. */
const VALID_ZONES_V2 = new Set<string>();
export const frequencyScheduleV2 = z
  .object({
    // Named IANA zone with its exact spelling. Offsets such as "-03:00" have the
    // opposite sign in PostgreSQL AT TIME ZONE, and the Windows collector (zoneinfo)
    // rejects offsets and other capitalizations.
    timezone: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z][\w+-]*(?:\/[\w+-]+)*$/u)
      .refine((value) => {
        if (VALID_ZONES_V2.has(value)) return true;
        try {
          if (
            new Intl.DateTimeFormat('pt-BR', { timeZone: value }).resolvedOptions().timeZone !==
            value
          )
            return false;
        } catch {
          return false;
        }
        VALID_ZONES_V2.add(value);
        return true;
      }),
    rules: z
      .array(
        z
          .object({
            weekday: z.number().int().min(0).max(6),
            shift: z.enum(['matutino', 'vespertino']),
            enabled: z.boolean(),
            times: z
              .array(time)
              .max(48)
              .refine((v) => new Set(v).size === v.length),
            recheck: time.nullable(),
          })
          .strict()
          .refine(
            (r) =>
              r.recheck === null || (r.times.length < 48 && r.times.every((t) => t < r.recheck!)),
            {
              message: 'Rechecagem deve ocorrer após os horários e respeitar o limite diário.',
            },
          ),
      )
      .length(14)
      .refine((v) => new Set(v.map((r) => `${r.weekday}:${r.shift}`)).size === 14),
  })
  .strict();
/** Collection budget of one school day, across both shifts (times and rechecks). */
const FREQUENCY_MAX_DAILY_SLOTS_V2 = 48;
const FREQUENCY_MIN_SLOT_GAP_MINUTES_V2 = 5;
/** Index = weekday as stored (0 = Sunday), for messages that name the day. */
const WEEKDAY_NAMES_V2 = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
] as const;
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
      ctx.addIssue({
        code: 'custom',
        path: ['rules', index],
        message: 'Turno ativo precisa de pelo menos um horário.',
      });
  });
  WEEKDAY_NAMES_V2.forEach((name, weekday) => {
    const day = [
      ...new Set(
        schedule.rules
          .filter((r) => r.enabled && r.weekday === weekday)
          .flatMap((r) => [...r.times, ...(r.recheck ? [r.recheck] : [])]),
      ),
    ]
      .map(minutes)
      .sort((a, b) => a - b);
    if (day.length > FREQUENCY_MAX_DAILY_SLOTS_V2)
      ctx.addIssue({
        code: 'custom',
        path: ['rules'],
        message: `${name}: no máximo ${FREQUENCY_MAX_DAILY_SLOTS_V2} coletas por dia.`,
      });
    if (
      day.some(
        (value, i) => i > 0 && value - (day[i - 1] ?? value) < FREQUENCY_MIN_SLOT_GAP_MINUTES_V2,
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['rules'],
        message: `${name}: deixe pelo menos ${FREQUENCY_MIN_SLOT_GAP_MINUTES_V2} minutos entre as coletas.`,
      });
  });
});
/** The shortest interval of the automatic student report. */
const REPORT_MIN_EVERY_MINUTES_V2 = 30;
/**
 * The agenda of the Smecel "Relatório de alunos", apart from the frequency's: every `every` minutes
 * from `from` to `to` on the chosen weekdays (0 = Sunday). The Coletor never runs it together with a
 * frequency run; its editor keeps the times apart.
 */
export const frequencyReportScheduleV2 = z
  .object({
    timezone: frequencyScheduleV2.shape.timezone,
    enabled: z.boolean(),
    every: z.number().int().min(REPORT_MIN_EVERY_MINUTES_V2).max(720),
    from: time,
    to: time,
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict()
  .refine((v) => v.from <= v.to, { message: 'O horário final deve vir depois do inicial.' });
export type FrequencyReportScheduleV2 = z.infer<typeof frequencyReportScheduleV2>;
const read = { academicYear: year };
const classId = z.number().int().positive();
const sourceVersion = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const sourceClassId = z.string().regex(/^[1-9]\d{0,9}$/u);
const observedAt = z.iso.datetime({ offset: true });
const records = z
  .array(z.object({ recordKey, originalName: label, originalClass: label }).strict())
  .min(1)
  .max(64);
/** frequencyPayloadHashV2 output: base64url SHA-256, no padding. */
const payloadHash = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
/** One lesson of a class's weekly grid: Monday (1) to Friday (5), the diary's position, the subject as the Smecel names it. */
const scheduleLesson = z
  .object({
    weekday: z.number().int().min(1).max(5),
    slot,
    subject: z.string().trim().min(1).max(120),
  })
  .strict();
const smecelId = z.string().regex(/^[1-9]\d{0,11}$/u);
/**
 * One Smecel "Ocorrência" as its student's page shows it. Only a suspension has a leave; the Smecel
 * leaves its dates or its days blank at times (null), never all three.
 */
const incident = z
  .object({
    sourceIncidentId: smecelId,
    kind: z.string().trim().min(1).max(80),
    date: civilDate,
    sourceClassLabel: label,
    leave: z
      .object({
        from: civilDate.nullable(),
        to: civilDate.nullable(),
        days: z.number().int().min(0).max(366).nullable(),
      })
      .strict()
      .refine((v) => v.from !== null || v.to !== null || v.days !== null)
      .refine((v) => v.from === null || v.to === null || v.from <= v.to)
      .nullable(),
    description: z.string().trim().min(1).max(8000),
  })
  .strict();
const mutation = { ...read, requestId: uid };
const fenced = { ...mutation, fencingToken: revision };
export const frequencyRequestV2 = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status'), ...read }).strict(),
  z.object({ operation: z.literal('receipt'), ...mutation }).strict(),
  z
    .object({
      operation: z.literal('save-settings'),
      ...mutation,
      expectedRevision: revision,
      schedule: frequencyScheduleWriteV2,
    })
    .strict(),
  z
    .object({
      operation: z.literal('save-report-settings'),
      ...mutation,
      expectedRevision: revision,
      reportSchedule: frequencyReportScheduleV2.nullable(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('set-paused'),
      ...mutation,
      expectedRevision: revision,
      paused: z.boolean(),
    })
    .strict(),
  /** ADM only: the computer that sends the frequency while online; null = whichever asks first. */
  z
    .object({
      operation: z.literal('set-preferred-device'),
      ...mutation,
      expectedRevision: revision,
      deviceId: uid.nullable(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('rename-device'),
      ...mutation,
      deviceId: uid,
      label: z.string().trim().min(1).max(80),
    })
    .strict(),
  z.object({ operation: z.literal('revoke-device'), ...mutation, deviceId: uid }).strict(),
  z
    .object({
      operation: z.literal('lease'),
      ...mutation,
      durationSeconds: z.number().int().min(15).max(300),
    })
    .strict(),
  z
    .object({
      operation: z.literal('heartbeat'),
      ...fenced,
      status: z.enum(['ready', 'collecting', 'login-required', 'error']),
      classId: z.number().int().positive().nullable(),
      code: z
        .string()
        .regex(/^[A-Z_]{1,60}$/u)
        .nullable(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('release'),
      ...fenced,
      code: z
        .string()
        .regex(/^[A-Z_]{1,60}$/u)
        .nullable(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('collect'),
      ...fenced,
      classId,
      expectedRevision: revision,
      sourceVersion,
      sourceClassId,
      sourceClassLabel: label,
      observedAt,
      rosterComplete: z.boolean(),
      records,
      /**
       * `pending`: the day's positions the Smecel shows as FP ("frequência pendente", since
       * 18/11/2026: the teacher has not marked presence or absence yet), a part of `slots`. Sent
       * only when there is one. On the day itself they are "a confirmar"; once it is over, a
       * lesson without absence (pendingTodayV2).
       */
      coverage: z
        .array(
          z
            .object({
              recordKey,
              date: civilDate,
              slots,
              complete: z.boolean(),
              pending: optionalSlots,
            })
            .strict(),
        )
        .max(24_000),
      marks: z
        .array(z.object({ recordKey, date: civilDate, slot, mark: z.enum(['X', 'J']) }).strict())
        .max(130_000),
    })
    .strict(),
  /**
   * The class's diary did not change since the content the collector last sent: the same fields as
   * `collect` but, instead of coverage and marks, their frequencyContentHashV2. The server answers
   * 'payload-required' unless it matches what it holds.
   */
  z
    .object({
      operation: z.literal('collect-unchanged'),
      ...fenced,
      classId,
      expectedRevision: revision,
      sourceVersion,
      sourceClassId,
      sourceClassLabel: label,
      observedAt,
      rosterComplete: z.boolean(),
      records,
      contentHash: payloadHash,
    })
    .strict(),
  /** The school's weekly grid (Smecel "Grade de horários"), every linked class in one capture. */
  z
    .object({
      operation: z.literal('schedule-collect'),
      ...fenced,
      sourceVersion,
      observedAt,
      classes: z
        .array(
          z
            .object({
              classId,
              sourceClassId,
              sourceClassLabel: label,
              lessons: z
                .array(scheduleLesson)
                .max(30)
                .refine((v) => new Set(v.map((l) => `${l.weekday}:${l.slot}`)).size === v.length),
            })
            .strict(),
        )
        .min(1)
        .max(64)
        .refine((v) => new Set(v.map((c) => c.classId)).size === v.length)
        .refine((v) => new Set(v.map((c) => c.sourceClassId)).size === v.length),
    })
    .strict(),
  /**
   * The Smecel "Ocorrências" of the year, every student in one capture.
   * `classId` is the student's class linked in the Centro (null when none of the student's Smecel
   * classes is). `complete` says the collector read every page and every student, with the counts the
   * Smecel list shows: only then may a record missing from the capture be marked removed.
   */
  z
    .object({
      operation: z.literal('incident-collect'),
      ...fenced,
      sourceVersion,
      observedAt,
      complete: z.boolean(),
      students: z
        .array(
          z
            .object({
              sourceStudentId: smecelId,
              name: label,
              classId: classId.nullable(),
              sourceClassLabel: label.nullable(),
              incidents: z.array(incident).min(1).max(500),
            })
            .strict()
            .refine((v) => (v.classId === null) === (v.sourceClassLabel === null)),
        )
        .max(5000)
        .refine((v) => new Set(v.map((s) => s.sourceStudentId)).size === v.length)
        .refine((v) => {
          const ids = v.flatMap((s) => s.incidents.map((i) => i.sourceIncidentId));
          return new Set(ids).size === ids.length;
        }),
    })
    .strict(),
  /**
   * The Smecel "Relatório de alunos": every row of the export, read by the Coletor in memory with
   * the 11 fields the Conciliação uses and, from the Coletor that asks for it (coletor#91), the
   * enrolment form's data under `profile`. The server applies the rows with the Conciliação's own
   * prepare/apply and keeps each profile apart; an unchanged report only refreshes the dates.
   */
  z
    .object({
      operation: z.literal('student-report-collect'),
      ...fenced,
      sourceVersion,
      observedAt,
      rows: z
        .array(studentReportRowV2)
        .min(1)
        .max(REPORT_MAX_ROWS_V1)
        .refine((v) => new Set(v.map((r) => r.sourceRow)).size === v.length),
    })
    .strict(),
  /**
   * The same report as the one this computer last sent (its local copy):
   * only the content's hash (studentReportHashV2). The server answers 'payload-required' unless it
   * matches the last report it applied; the whole report goes then, and at least once a day.
   */
  z
    .object({
      operation: z.literal('student-report-unchanged'),
      ...fenced,
      sourceVersion,
      observedAt,
      rows: z.number().int().min(1).max(REPORT_MAX_ROWS_V1),
      contentHash: payloadHash,
    })
    .strict(),
  z
    .object({
      operation: z.literal('resolve-conflict'),
      ...mutation,
      conflictId: uid,
      expectedRevision: revision,
      mark: z.enum(['X', 'J']).nullable(),
      reason: z.string().trim().min(1).max(500),
    })
    .strict(),
  z
    .object({
      operation: z.literal('monthly-summary'),
      ...read,
      studentUid: uid,
      month: z.string().regex(/^2026-(0[1-9]|1[0-2])$/u),
    })
    .strict(),
]);
export type FrequencyRequestV2 = z.infer<typeof frequencyRequestV2>;
export type FrequencyCollectionV2 = Extract<FrequencyRequestV2, { operation: 'collect' }>;
export type FrequencyUnchangedV2 = Extract<FrequencyRequestV2, { operation: 'collect-unchanged' }>;
export type FrequencyScheduleCollectionV2 = Extract<
  FrequencyRequestV2,
  { operation: 'schedule-collect' }
>;
type FrequencyScheduleLessonV2 = z.infer<typeof scheduleLesson>;
export type FrequencyIncidentCollectionV2 = Extract<
  FrequencyRequestV2,
  { operation: 'incident-collect' }
>;
type FrequencyIncidentV2 = z.infer<typeof incident>;
export type FrequencyStudentReportV2 = Extract<
  FrequencyRequestV2,
  { operation: 'student-report-collect' }
>;
export type FrequencyStudentReportUnchangedV2 = Extract<
  FrequencyRequestV2,
  { operation: 'student-report-unchanged' }
>;
export type FrequencyScheduleV2 = z.infer<typeof frequencyScheduleV2>;

/** Server-created only, after Entra session or payload-bound device proof. */
export type FrequencyActorV2 = {
  actorId: string;
  tenantId: string;
  mode: 'admin' | 'device';
  deviceId?: string;
  deviceGeneration?: number;
  keyThumbprint?: string;
};
export type FrequencyClassV2 = {
  classId: number;
  sourceClassLabel: string;
  shift: string;
  revision: number;
};
export type FrequencyDeviceV2 = {
  deviceId: string;
  label: string;
  state:
    | 'ready'
    | 'collecting'
    | 'reserve'
    | 'paused'
    | 'login-required'
    | 'error'
    | 'offline'
    | 'revoked';
  lastSeenAt: string | null;
  classId: number | null;
  code: string | null;
  lastCollectionAt: string | null;
};
export type FrequencyConflictV2 = {
  id: string;
  revision: number;
  studentUid: string;
  studentName: string;
  classLabel: string;
  date: string;
  slot: number;
  shift: string;
  marks: ('X' | 'J' | null)[];
};
export type FrequencyStatusV2 = {
  contractVersion: 2;
  state: 'ready';
  academicYear: 2026;
  serverTime: string;
  settings: {
    revision: number;
    paused: boolean;
    schedule: FrequencyScheduleV2 | null;
    reportSchedule?: FrequencyReportScheduleV2 | null;
    /** The computer chosen in the ADM to send the frequency; null = whichever asks first. */
    preferredDeviceId?: string | null;
  };
  /** The last automatic student report (attendance 0015), or null before the first one. */
  studentReport?: FrequencyStudentReportStateV2 | null;
  lease: { deviceId: string; expiresAt: string; fencingToken: number } | null;
  classes: FrequencyClassV2[];
  devices: FrequencyDeviceV2[];
  collections: {
    classId: number;
    observedAt: string;
    receivedAt: string;
    resolvedRecords: number;
    unresolvedRecords: number;
    conflicts: number;
  }[];
  conflicts: FrequencyConflictV2[];
  /** Administrator view only; empty for a collector device. */
  unresolved: FrequencyUnresolvedV2[];
  failures: FrequencyFailureEntryV2[];
};
/** What the last automatic student report did; `notes` is what went to the Conciliação. */
export type FrequencyStudentReportStateV2 = {
  observedAt: string;
  receivedAt: string;
  changedAt: string;
  outcome: 'applied' | 'preparing' | 'awaiting_relation' | 'review';
  rows: number;
  notes: FrequencyStudentReportNotesV2;
};
export type FrequencyStudentReportNotesV2 = {
  counts: { rows: number; linked: number; pending: number } | null;
  differences: string[];
  invalid: { sourceRow: number; name: string; classLabel: string; field: string; reason: string }[];
};
/** Smecel rows of the latest collection that no reconciled student matches yet. */
export type FrequencyUnresolvedV2 = {
  classId: number;
  classLabel: string;
  name: string;
  reason: 'not_found' | 'ambiguous';
  marks: number;
  observedAt: string;
};
export type FrequencyFailureEntryV2 = {
  firstAt: string;
  lastAt: string;
  occurrences: number;
  origin: 'collector' | 'admin' | 'device-report';
  operation: string;
  code: string;
  detail: string;
  deviceId: string | null;
  classId: number | null;
};
/**
 * One school day of the student in the Smecel diary: the lesson positions that existed that day
 * (a point, an X or a justified mark), so 5- or 6-lesson days, weekends,
 * holidays and days outside the enrolment need no configuration. `complete`: the collector read
 * every position of the day. `pending`: positions still FP in the Smecel (the teacher has not marked
 * them yet), "a confirmar" on the day itself (pendingTodayV2); absent when there is none.
 */
export type FrequencyDayV2 = {
  date: string;
  shift: string;
  slots: number[];
  complete: boolean;
  pending?: number[];
};
export type FrequencySummaryV2 = {
  contractVersion: 2;
  state: 'ready';
  month: string;
  absences: number | null;
  justified: number | null;
  denominator: number | null;
  percentage: number | null;
  coverage: 'reliable' | 'incomplete' | 'unavailable';
  observedAt: string | null;
  receivedAt: string | null;
  marks: { date: string; slot: number; shift: string; mark: 'X' | 'J'; classLabels: string[] }[];
  conflicts: number;
  /** Lesson days of the month; absent from a server before the Smecel lesson days. */
  days?: FrequencyDayV2[];
  /** The school's date (attendance 0012): the page marks it "HOJE" (frequencyCountV2 says when it counts). */
  today?: string;
  /** Lessons and absences of the year so far (frequencyCountV2); null while any month is unknown. */
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
  contractVersion: 2;
  state: 'ready';
  academicYear: 2026;
  today: string;
  year: { lessons: number; absences: number } | null;
  lastReadAt: string | null;
  months: FrequencySummaryV2[];
  /** The school's calendar marked in the ADM (null before it is): the countdown to the year's end. */
  schoolYear?: {
    schoolDays: number;
    remaining: number;
    firstDay: string | null;
    lastDay: string | null;
  } | null;
  /** The database's clock when the year was read: the countdown runs on it, not on the phone's. */
  serverNow?: string;
  /** One sentence about the absences for the family (frequency-comment-v2.ts), or none. */
  comment?: { kind: string; tone: 'alert' | 'good'; text: string } | null;
  /** The weekdays without school the ADM calendar names, with their description (feriado, recesso…). */
  daysOff?: { date: string; kind: 'feriado' | 'recesso' | 'evento'; note?: string }[];
  /** Each lesson's and the break's time by shift and weekday (ADM, student-portal 0030), or null. */
  bells?: Record<
    'matutino' | 'vespertino',
    Record<
      1 | 2 | 3 | 4 | 5,
      (
        | { kind: 'aula'; slot: number; start: string; end: string }
        | { kind: 'intervalo' | 'parada'; start: string; end: string }
      )[]
    >
  > | null;
  /** From when those times hold (school-bells-v1 bellsValidFromV1); null without bells. */
  bellsValidFrom?: string | null;
  /** The subject of each position of the week by shift, only when the Horário is on for the student;
   * `validFrom`: the school day that grid was first read (attendance 0020), null when unknown. */
  grid?: {
    shift: 'matutino' | 'vespertino';
    validFrom?: string | null;
    lessons: { weekday: number; slot: number; subject: string }[];
  }[];
};

/**
 * Lessons and absences (X) and justified absences (J) of the days that count; `reliable`: nothing
 * of them is still unknown.
 */
type FrequencyCountV2 = { lessons: number; absences: number; justified: number; reliable: boolean };
/**
 * Whether a lesson day counts: a day already over, or today once it was read in full. Since the
 * Smecel's FP (18/11/2026) the teacher marks presence as well as absence during the lesson, and a
 * lesson not marked yet is FP (`pending`), so today's marked lessons are final at once.
 */
export const countedDayV2 = (day: Pick<FrequencyDayV2, 'date' | 'complete'>, today: string) =>
  day.date < today || (day.date === today && day.complete);
/**
 * The day's FP positions that are still "a confirmar": only today's (owner decision 19/11/2026).
 * During the day an FP may be a lesson still to come or one the teacher is about to mark. Once the
 * day is over it is a lesson without absence, as the Smecel showed it before its FP: the students
 * were dismissed, the whole day had no roll call, or the teacher did not mark it (an X marked later
 * still arrives with the next reading).
 */
export const pendingTodayV2 = (day: Pick<FrequencyDayV2, 'date' | 'pending'>, today: string) =>
  day.date >= today ? (day.pending ?? []) : [];
/**
 * A month's counts: lessons are the positions of the days that count (countedDayV2) except the
 * ones still "a confirmar" (pendingTodayV2: today's FP, neither a presence nor an absence until
 * the teacher marks them), absences their X marks, a J is not taken off. Reliable when every day
 * already over was read in full, no conflict is open and every mark counted has its lesson. A
 * pending lesson never makes the month unknown. The server's totals and the Portal agree on it.
 */
export function frequencyCountV2(
  summary: Pick<FrequencySummaryV2, 'marks' | 'conflicts' | 'days'>,
  today: string,
): FrequencyCountV2 {
  const days = summary.days ?? [];
  const counted = days.filter((day) => countedDayV2(day, today));
  const countedShifts = new Set(counted.map((day) => `${day.date}|${day.shift}`));
  const lessons = new Set(
    counted.flatMap((day) =>
      day.slots
        .filter((slot) => !pendingTodayV2(day, today).includes(slot))
        .map((slot) => `${day.date}|${day.shift}:${slot}`),
    ),
  );
  const marks = summary.marks.filter(
    (mark) => mark.date < today || countedShifts.has(`${mark.date}|${mark.shift}`),
  );
  return {
    lessons: lessons.size,
    absences: marks.filter((mark) => mark.mark === 'X').length,
    justified: marks.filter((mark) => mark.mark === 'J').length,
    reliable:
      summary.conflicts === 0 &&
      days.every((day) => day.date >= today || day.complete) &&
      marks.every((mark) => lessons.has(`${mark.date}|${mark.shift}:${mark.slot}`)),
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
    const members = Object.keys(record)
      .sort(compareCanonicalKeys)
      .map((key) => JSON.stringify(key) + ':' + canonicalFrequencyJsonV2(record[key]));
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
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, '');
}
export async function frequencyPayloadHashV2(value: unknown): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonicalFrequencyJsonV2(value)),
    ),
  );
  return btoa(String.fromCodePoint(...hash))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
/**
 * The content of one class's diary, as the server compares it: the collector computes the same
 * value (canonical JSON, SHA-256, base64url) to know whether anything changed since its last send.
 */
export function frequencyContentHashV2(
  input: Pick<
    FrequencyCollectionV2,
    | 'classId'
    | 'sourceClassId'
    | 'sourceClassLabel'
    | 'rosterComplete'
    | 'records'
    | 'coverage'
    | 'marks'
  >,
): Promise<string> {
  return frequencyPayloadHashV2({
    classId: input.classId,
    sourceClassId: input.sourceClassId,
    sourceClassLabel: input.sourceClassLabel,
    rosterComplete: input.rosterComplete,
    records: input.records,
    coverage: input.coverage,
    marks: input.marks,
  });
}
/** One Smecel record's content as stored and compared: an edit in the Smecel changes it. */
export function frequencyIncidentHashV2(item: FrequencyIncidentV2): Promise<string> {
  return frequencyPayloadHashV2({
    kind: item.kind,
    date: item.date,
    sourceClassLabel: item.sourceClassLabel,
    leave: item.leave,
    description: item.description,
  });
}
/** One class's weekly grid as stored and compared: lessons in day then position order. */
export function frequencyScheduleHashV2(item: {
  classId: number;
  sourceClassId: string;
  sourceClassLabel: string;
  lessons: readonly FrequencyScheduleLessonV2[];
}): Promise<string> {
  return frequencyPayloadHashV2({
    classId: item.classId,
    sourceClassId: item.sourceClassId,
    sourceClassLabel: item.sourceClassLabel,
    lessons: [...item.lessons].sort((a, b) => a.weekday - b.weekday || a.slot - b.slot),
  });
}
