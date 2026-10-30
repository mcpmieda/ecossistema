import { z } from 'zod';
import { FrequencyClientErrorV2 } from '../frequency/client-v2';

/*
 * The student's Smecel records and the family's "Estou ciente" (owner decisions 29/10/2026), from
 * GET /api/student/incidents and POST /api/student/incidents/acknowledge
 * (server/student-portal/composition/incidents-v1.ts). Same-origin, private, no cache; the session
 * decides the student. A confirmation names the version read: one the school edited or removed since
 * fails as 'changed', and the page reads again.
 */
const incident = z
  .object({
    /** The version of the record: an edit in the Smecel is another one, open again. */
    id: z.uuid(),
    kind: z.string().min(1).max(80),
    date: z.iso.date(),
    classLabel: z.string().min(1).max(300),
    /** A suspension's leave; the Smecel leaves any part blank at times (null). */
    leave: z
      .object({
        from: z.iso.date().nullable(),
        to: z.iso.date().nullable(),
        days: z.number().int().min(0).max(366).nullable(),
      })
      .strict()
      .nullable(),
    description: z.string().min(1).max(8000),
    acknowledgedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
const answer = z
  .object({ contractVersion: z.literal(1), state: z.literal('ready'), incidents: z.array(incident).max(500) })
  .strict();
const acknowledged = z
  .object({
    contractVersion: z.literal(1),
    state: z.literal('ready'),
    acknowledgedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const failure = z
  .object({
    contractVersion: z.literal(1),
    state: z.enum(['unauthenticated', 'forbidden', 'invalid-request', 'unavailable', 'changed']),
  })
  .passthrough();
export type StudentIncidentV1 = z.infer<typeof incident>;
export type StudentIncidentsClientV1 = {
  read(signal: AbortSignal): Promise<{ incidents: StudentIncidentV1[] }>;
  acknowledge(id: string): Promise<{ acknowledgedAt: string }>;
};

/** One request: the answer's body checked against `schema`, or the failure's state as the error. */
async function requestV1<T>(
  fetcher: typeof fetch,
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetcher(path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new FrequencyClientErrorV2('unauthenticated');
  if (response.status === 403) throw new FrequencyClientErrorV2('forbidden');
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new FrequencyClientErrorV2('unavailable');
  const text = await response.text();
  // A year of records with whole descriptions is far below this; anything larger is not ours.
  if (text.length > 2_000_000) throw new FrequencyClientErrorV2('unavailable');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FrequencyClientErrorV2('unavailable');
  }
  const failed = failure.safeParse(body);
  if (failed.success) throw new FrequencyClientErrorV2(failed.data.state);
  const parsed = schema.safeParse(body);
  if (!response.ok || !parsed.success) throw new FrequencyClientErrorV2('unavailable');
  return parsed.data;
}

export function createStudentIncidentsClientV1(
  fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
): StudentIncidentsClientV1 {
  return {
    async read(signal) {
      const { incidents } = await requestV1(fetcher, '/api/student/incidents', { signal }, answer);
      return { incidents };
    },
    async acknowledge(id) {
      const { acknowledgedAt } = await requestV1(
        fetcher,
        '/api/student/incidents/acknowledge',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        },
        acknowledged,
      );
      return { acknowledgedAt };
    },
  };
}
