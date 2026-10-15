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
  timezone: z.string().min(1).max(80).refine(value => {
    try { new Intl.DateTimeFormat('pt-BR', { timeZone: value }); return true; } catch { return false; }
  }),
  rules: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    shift: z.enum(['matutino', 'vespertino']),
    enabled: z.boolean(),
    times: z.array(time).max(16).refine(v => new Set(v).size === v.length),
    recheck: time.nullable(),
  }).strict().refine(r => r.recheck === null || (r.times.length < 16 && r.times.every(t => t < r.recheck!)), {
    message: 'Rechecagem deve ocorrer após os horários e respeitar o limite diário.',
  })).length(14).refine(v => new Set(v.map(r => `${r.weekday}:${r.shift}`)).size === 14),
}).strict();
const read = { academicYear: year };
const mutation = { ...read, requestId: uid };
const fenced = { ...mutation, fencingToken: revision };
export const frequencyRequestV2 = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status'), ...read }).strict(),
  z.object({ operation: z.literal('receipt'), ...mutation }).strict(),
  z.object({ operation: z.literal('save-settings'), ...mutation, expectedRevision: revision, schedule: frequencyScheduleV2 }).strict(),
  z.object({ operation: z.literal('set-paused'), ...mutation, expectedRevision: revision, paused: z.boolean() }).strict(),
  z.object({ operation: z.literal('rename-device'), ...mutation, deviceId: uid, label: z.string().trim().min(1).max(80) }).strict(),
  z.object({ operation: z.literal('revoke-device'), ...mutation, deviceId: uid }).strict(),
  z.object({ operation: z.literal('lease'), ...mutation, durationSeconds: z.number().int().min(15).max(300) }).strict(),
  z.object({ operation: z.literal('heartbeat'), ...fenced, status: z.enum(['ready', 'collecting', 'login-required', 'error']), classId: z.number().int().positive().nullable(), code: z.string().regex(/^[A-Z_]{1,60}$/u).nullable() }).strict(),
  z.object({ operation: z.literal('release'), ...fenced, code: z.string().regex(/^[A-Z_]{1,60}$/u).nullable() }).strict(),
  z.object({ operation: z.literal('collect'), ...fenced,
    classId: z.number().int().positive(), expectedRevision: revision,
    sourceVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    sourceClassId: z.string().regex(/^[1-9]\d{0,9}$/u), sourceClassLabel: label,
    observedAt: z.iso.datetime({ offset: true }), rosterComplete: z.boolean(),
    records: z.array(z.object({ recordKey, originalName: label, originalClass: label }).strict()).min(1).max(64),
    coverage: z.array(z.object({ recordKey, date: civilDate, slots, complete: z.boolean() }).strict()).max(24_000),
    marks: z.array(z.object({ recordKey, date: civilDate, slot, mark: z.enum(['X', 'J']) }).strict()).max(130_000),
  }).strict(),
  z.object({ operation: z.literal('resolve-conflict'), ...mutation, conflictId: uid, expectedRevision: revision, mark: z.enum(['X','J']).nullable(), reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ operation: z.literal('monthly-summary'), ...read, studentUid: uid, month: z.string().regex(/^2026-(0[1-9]|1[0-2])$/u) }).strict(),
]);
export type FrequencyRequestV2 = z.infer<typeof frequencyRequestV2>;
export type FrequencyCollectionV2 = Extract<FrequencyRequestV2, { operation: 'collect' }>;
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
};
export type FrequencySummaryV2 = {
  contractVersion: 2; state: 'ready'; month: string;
  absences: number | null; justified: number | null; denominator: number | null; percentage: number | null;
  coverage: 'reliable' | 'incomplete' | 'unavailable'; observedAt: string | null; receivedAt: string | null;
  marks: { date: string; slot: number; shift: string; mark: 'X' | 'J'; classLabels: string[] }[];
  conflicts: number;
};

/** Same UTF-8 bytes in Python and JS; no locale-sensitive key ordering. */
function compareCanonicalKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
export function canonicalFrequencyJsonV2(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFrequencyJsonV2).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort(compareCanonicalKeys).map(key => `${JSON.stringify(key)}:${canonicalFrequencyJsonV2((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function frequencyPayloadHashV2(value: unknown): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalFrequencyJsonV2(value))));
  return btoa(String.fromCodePoint(...hash)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
