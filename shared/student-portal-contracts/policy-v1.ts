import { z } from 'zod';
import { instantV1, periodV1, policyScopeV1, versionV1 } from './core-v1';
import { accessScheduleV1 } from './access-schedule-v1';

const seconds = z.number().int().min(60).max(31_536_000);
export const riskPolicyV1 = z
  .object({
    persistentSeconds: seconds,
    shortSeconds: seconds,
    challengeAfter: z.number().int().min(1).max(10),
    blockAfter: z.number().int().min(2).max(20),
    blockSeconds: z.number().int().min(60).max(86400),
    failureWindowSeconds: z.number().int().min(60).max(86400),
    challengeTtlSeconds: z.number().int().min(30).max(600),
  })
  .strict()
  .refine(
    (v) => v.challengeAfter < v.blockAfter && v.shortSeconds <= v.persistentSeconds,
    'Inconsistent risk limits',
  );
export const DEFAULT_RISK_V1 = {
  persistentSeconds: 30 * 86400,
  shortSeconds: 12 * 3600,
  challengeAfter: 3,
  blockAfter: 5,
  blockSeconds: 900,
  failureWindowSeconds: 900,
  challengeTtlSeconds: 300,
} as const;
const periods = z
  .array(periodV1)
  .min(1)
  .max(6)
  .refine((p) => new Set(p).size === p.length, 'Duplicate period');
const periodDates = z
  .object({
    T1: instantV1.nullable(),
    T2: instantV1.nullable(),
    T3: instantV1.nullable(),
    REC1: instantV1.nullable(),
    REC2: instantV1.nullable(),
    REC3: instantV1.nullable(),
  })
  .strict();
/** A switch plus scheduled Mostrar/Ocultar, following the agenda like access (access-schedule-v1). */
export const agendaPlanV1 = z
  .object({ enabled: z.boolean(), schedule: accessScheduleV1 })
  .strict();
export type AgendaPlanV1 = z.infer<typeof agendaPlanV1>;
export const disclosureV1 = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('single'),
      at: instantV1.nullable(),
      endsAt: instantV1.nullable().optional(),
      periods,
    })
    .strict(),
  z
    .object({ mode: z.literal('per-period'), at: periodDates, endsAt: periodDates.optional() })
    .strict(),
  // Aba Notas (27/09/2026): each period follows its own agenda. "Períodos permitidos" no longer
  // applies once a scope uses this mode; the switch of each period replaces it.
  z
    .object({
      mode: z.literal('agenda'),
      periods: z
        .object({
          T1: agendaPlanV1,
          T2: agendaPlanV1,
          T3: agendaPlanV1,
          REC1: agendaPlanV1,
          REC2: agendaPlanV1,
          REC3: agendaPlanV1,
        })
        .strict(),
    })
    .strict(),
]);
export const calendarV1 = z
  .object({
    accessStartsAt: instantV1.nullable().optional(),
    accessEndsAt: instantV1.nullable().optional(),
    finalDisclosureEndsAt: instantV1.nullable().optional(),
    // Resultado anual on the Notas tab: when present it replaces showFinalResult and the two dates.
    finalAgenda: agendaPlanV1.optional(),
    timezone: z.literal('America/Sao_Paulo'),
    enrollmentStartsAt: instantV1.nullable(),
    yearStartsAt: instantV1.nullable(),
    t1EndsAt: instantV1.nullable(),
    t2StartsAt: instantV1.nullable().default(null),
    t2EndsAt: instantV1.nullable(),
    t3StartsAt: instantV1.nullable().default(null),
    t3EndsAt: instantV1.nullable(),
    recoveriesStartAt: instantV1.nullable(),
    yearEndsAt: instantV1.nullable(),
    finalDisclosureAt: instantV1.nullable(),
    disclosure: disclosureV1,
  })
  .strict()
  .superRefine((v, ctx) => {
    const interval = (
      start: string | null | undefined,
      end: string | null | undefined,
      path: string[],
    ) => {
      if (start && end && Date.parse(end) <= Date.parse(start))
        ctx.addIssue({ code: 'custom', path, message: 'End must be after start' });
    };
    interval(v.accessStartsAt ?? v.yearStartsAt, v.accessEndsAt ?? v.yearEndsAt, ['accessEndsAt']);
    interval(v.finalDisclosureAt, v.finalDisclosureEndsAt, ['finalDisclosureEndsAt']);
    // Grades follow their agenda: an "Ocultar" before a later "Liberar" hides them and the
    // "Liberar" shows them again. Only the same instant for both is ambiguous.
    const distinct = (
      at: string | null | undefined,
      end: string | null | undefined,
      path: string[],
    ) => {
      if (at && end && Date.parse(end) === Date.parse(at))
        ctx.addIssue({ code: 'custom', path, message: 'Show and hide need different times' });
    };
    if (v.disclosure.mode === 'single')
      distinct(v.disclosure.at, v.disclosure.endsAt, ['disclosure', 'endsAt']);
    else if (v.disclosure.mode === 'per-period')
      for (const period of periodV1.options)
        distinct(v.disclosure.at[period], v.disclosure.endsAt?.[period], [
          'disclosure',
          'endsAt',
          period,
        ]);
    const ordered = [
      'enrollmentStartsAt',
      'yearStartsAt',
      't1EndsAt',
      't2StartsAt',
      't2EndsAt',
      't3StartsAt',
      't3EndsAt',
      'recoveriesStartAt',
      'yearEndsAt',
    ] as const;
    let previous = -Infinity;
    for (const key of ordered) {
      const raw = v[key];
      if (raw === null) continue;
      const value = Date.parse(raw);
      if (value < previous)
        ctx.addIssue({ code: 'custom', path: [key], message: 'Calendar order conflict' });
      previous = value;
    }
  });
export const settingsValueV1 = z
  .object({
    accessEnabled: z.boolean(),
    // Scheduled Abrir/Fechar for this level (access-schedule-v1). null: the older access window
    // in the Calendário still applies. Saved together with accessEnabled, as one unit.
    accessSchedule: accessScheduleV1.nullable(),
    showPartials: z.boolean(),
    autoUpdate: z.boolean(),
    showFinalResult: z.boolean(),
    // Fechamento do trimestre (#1132). The policy service reads a missing school row as off.
    showTermClosing: z.boolean(),
    // On: past-tense closing of ended trimesters. Off: present-tense reading of the one in progress.
    termClosingConclusive: z.boolean(),
    // Frequência no Portal do Aluno (owner request 20/10/2026). Off: the student sees no attendance
    // section and the frequency API refuses the read. A missing school row reads as off.
    showFrequency: z.boolean(),
    // Horário no Portal do Aluno (owner decision 22/10/2026). Off: no "Horário" tab and the schedule
    // API refuses the read. A missing school row reads as off.
    showSchedule: z.boolean(),
    allowedPeriods: z
      .array(periodV1)
      .max(6)
      .refine((p) => new Set(p).size === p.length, 'Duplicate period'),
    risk: riskPolicyV1,
    calendar: calendarV1,
  })
  .strict();
/**
 * Fields added after the first school seed (#1132, migration 0020). A school snapshot stored before
 * that migration reads them with these values; every reader of stored school rows must use
 * `completeStoredPolicyValueV1` so no screen depends on deploy/migration order.
 */
export const OPTIONAL_STORED_POLICY_DEFAULTS_V1 = {
  showTermClosing: false,
  termClosingConclusive: true,
  // Migration 0021 (agendamentos de acesso): no row means no schedule.
  accessSchedule: null,
  // Migration 0027 (frequência): no row means the attendance section stays hidden.
  showFrequency: false,
  // Migration 0028 (horário): no row means the "Horário" tab stays hidden.
  showSchedule: false,
} as const;
export const completeStoredPolicyValueV1 = (stored: unknown): unknown =>
  stored !== null && typeof stored === 'object' && !Array.isArray(stored)
    ? { ...OPTIONAL_STORED_POLICY_DEFAULTS_V1, ...stored }
    : stored;
/** Every policy option, as stored one row per option and scope. */
export const POLICY_FIELDS_V1 = [
  'accessEnabled', 'accessSchedule', 'showPartials', 'autoUpdate', 'showFinalResult',
  'showTermClosing', 'termClosingConclusive', 'showFrequency', 'showSchedule', 'allowedPeriods', 'risk', 'calendar',
] as const;
export const policyFieldV1 = z.enum(POLICY_FIELDS_V1);
export type PolicyFieldV1 = z.infer<typeof policyFieldV1>;
// Complete value per scope: partial field inheritance is expressed by explicit keys.
export const settingsOverrideV1 = settingsValueV1
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Empty override');
export const effectiveSettingsV1 = z
  .object({
    scope: policyScopeV1,
    version: versionV1,
    value: settingsValueV1,
    sources: z
      .object({
        accessEnabled: policyScopeV1,
        accessSchedule: policyScopeV1,
        showPartials: policyScopeV1,
        autoUpdate: policyScopeV1,
        showFinalResult: policyScopeV1,
        showTermClosing: policyScopeV1,
        termClosingConclusive: policyScopeV1,
        showFrequency: policyScopeV1,
        showSchedule: policyScopeV1,
        allowedPeriods: policyScopeV1,
        risk: policyScopeV1,
        calendar: policyScopeV1,
      })
      .strict(),
  })
  .strict();
export type EffectiveSettingsV1 = z.infer<typeof effectiveSettingsV1>;
