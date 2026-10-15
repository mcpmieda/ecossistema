import { z } from 'zod';
import {
  frequencyRequestV2,
  frequencyScheduleV2,
  type FrequencyRequestV2,
  type FrequencyStatusV2,
} from '../../../../shared/attendance-contracts/frequency-v2';
import { FrequencyClientErrorV2, frequencyJsonV2 } from '../../student-portal/frequency/client-v2';

const id = z.string().uuid();
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
const status = z
  .object({
    contractVersion: z.literal(2),
    state: z.literal('ready'),
    academicYear: z.literal(2026),
    serverTime: timestamp,
    settings: z
      .object({ revision, paused: z.boolean(), schedule: frequencyScheduleV2.nullable() })
      .strict(),
    lease: z
      .object({ deviceId: id, expiresAt: timestamp, fencingToken: revision })
      .strict()
      .nullable(),
    classes: z.array(
      z
        .object({
          classId: z.number().int().positive(),
          sourceClassLabel: z.string().min(1).max(300),
          shift: z.string().max(80),
          revision,
        })
        .strict(),
    ),
    devices: z.array(
      z
        .object({
          deviceId: id,
          label: z.string().min(1).max(80),
          state: z.enum([
            'ready',
            'collecting',
            'reserve',
            'paused',
            'login-required',
            'error',
            'offline',
            'revoked',
          ]),
          lastSeenAt: timestamp.nullable(),
          classId: z.number().int().positive().nullable(),
          code: z.string().max(60).nullable(),
          lastCollectionAt: timestamp.nullable(),
        })
        .strict(),
    ),
    collections: z.array(
      z
        .object({
          classId: z.number().int().positive(),
          observedAt: timestamp,
          receivedAt: timestamp,
          resolvedRecords: revision,
          unresolvedRecords: revision,
          conflicts: revision,
        })
        .strict(),
    ),
    conflicts: z.array(
      z
        .object({
          id,
          revision,
          studentUid: id,
          studentName: z.string().min(1).max(300),
          classLabel: z.string().min(1).max(300),
          date: z.iso.date(),
          slot: z.number().int().min(1).max(6),
          shift: z.string().max(80),
          marks: z
            .array(z.enum(['X', 'J']).nullable())
            .min(1)
            .max(64),
        })
        .strict(),
    ),
    unresolved: z
      .array(
        z
          .object({
            classId: z.number().int().positive(),
            classLabel: z.string().min(1).max(300),
            name: z.string().min(1).max(300),
            reason: z.enum(['not_found', 'ambiguous']),
            marks: z.number().int().nonnegative(),
            observedAt: timestamp,
          })
          .strict(),
      )
      .max(4096),
    failures: z
      .array(
        z
          .object({
            firstAt: timestamp,
            lastAt: timestamp,
            occurrences: z.number().int().positive(),
            origin: z.enum(['collector', 'admin', 'device-report']),
            operation: z.string().min(1).max(40),
            code: z.string().min(1).max(60),
            detail: z.string().max(200),
            deviceId: id.nullable(),
            classId: z.number().int().positive().nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type FrequencyAdminMutationV2 = Extract<
  FrequencyRequestV2,
  {
    operation:
      'save-settings' | 'set-paused' | 'rename-device' | 'revoke-device' | 'resolve-conflict';
  }
>;
type Command<T> = T extends FrequencyAdminMutationV2
  ? Omit<T, 'academicYear' | 'requestId'>
  : never;
export type FrequencyAdminCommandV2 = Command<FrequencyAdminMutationV2>;
export type FrequencyAdminClientV2 = {
  status(signal: AbortSignal): Promise<FrequencyStatusV2>;
  mutate(input: FrequencyAdminMutationV2, signal: AbortSignal): Promise<void>;
};
export function createFrequencyAdminClientV2(
  fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
): FrequencyAdminClientV2 {
  const send = (input: FrequencyRequestV2, signal: AbortSignal) =>
    frequencyJsonV2(fetcher, '/api/gradebook/frequency/v2', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(frequencyRequestV2.parse(input)),
    });
  return {
    async status(signal) {
      const parsed = status.safeParse(
        await send({ operation: 'status', academicYear: 2026 }, signal),
      );
      if (!parsed.success) throw new FrequencyClientErrorV2('unavailable');
      return parsed.data;
    },
    async mutate(input, signal) {
      const body = await send(input, signal);
      if (!committedSchema(input).safeParse(body).success)
        throw new FrequencyClientErrorV2('unavailable');
    },
  };
}
function committedSchema(input: FrequencyAdminMutationV2) {
  const common = {
    contractVersion: z.literal(2),
    state: z.literal('committed'),
    operation: z.literal(input.operation),
    requestId: z.literal(input.requestId),
  };
  if (input.operation === 'save-settings' || input.operation === 'set-paused')
    return z.object({ ...common, settingsRevision: revision }).strict();
  if (input.operation === 'resolve-conflict')
    return z.object({ ...common, conflictId: z.literal(input.conflictId), revision }).strict();
  return z.object({ ...common, deviceId: z.literal(input.deviceId) }).strict();
}
