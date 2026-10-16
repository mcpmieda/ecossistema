import { z } from 'zod';
import type { FrequencySummaryV2 } from '../../../../shared/attendance-contracts/frequency-v2';

export class FrequencyClientErrorV2 extends Error {
  constructor(readonly state: string) {
    super('frequency-request-failed');
  }
}

/** Private same-origin transport. Provider bodies never become UI error messages. */
export async function frequencyJsonV2(
  fetcher: typeof fetch,
  path: string,
  init: RequestInit,
): Promise<unknown> {
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
  const reader = response.body?.getReader();
  if (!reader) throw new FrequencyClientErrorV2('unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 2_000_000) throw new FrequencyClientErrorV2('unavailable');
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new FrequencyClientErrorV2('unavailable');
  }
  const failure = z
    .object({
      contractVersion: z.literal(2),
      state: z.enum([
        'unauthenticated',
        'forbidden',
        'invalid-request',
        'not-authorized',
        'unavailable',
        'revision-conflict',
        'lease-busy',
        'lease-fenced',
        'paused',
        'source-invalid',
        'identity-review',
      ]),
    })
    .strict()
    .safeParse(body);
  if (failure.success) throw new FrequencyClientErrorV2(failure.data.state);
  if (!response.ok) throw new FrequencyClientErrorV2('unavailable');
  return body;
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const timestamp = z.iso.datetime({ offset: true }).nullable();
const summary = z
  .object({
    contractVersion: z.literal(2),
    state: z.literal('ready'),
    month: z.string().regex(/^2026-(0[1-9]|1[0-2])$/u),
    absences: count,
    justified: count,
    denominator: count,
    percentage: z.number().finite().min(0).max(100).nullable(),
    coverage: z.enum(['reliable', 'incomplete', 'unavailable']),
    observedAt: timestamp,
    receivedAt: timestamp,
    marks: z
      .array(
        z
          .object({
            date: z.iso.date(),
            slot: z.number().int().min(1).max(6),
            shift: z.string().max(80),
            mark: z.enum(['X', 'J']),
            classLabels: z.array(z.string().min(1).max(300)).max(32),
          })
          .strict(),
      )
      .max(1000),
    conflicts: z.number().int().nonnegative(),
  })
  .strict();

export type StudentFrequencyClientV2 = {
  read(month: string, signal: AbortSignal): Promise<FrequencySummaryV2>;
};
export function createStudentFrequencyClientV2(
  fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
): StudentFrequencyClientV2 {
  return {
    async read(month, signal) {
      if (!/^2026-(0[1-9]|1[0-2])$/u.test(month))
        throw new FrequencyClientErrorV2('invalid-request');
      const parsed = summary.safeParse(
        await frequencyJsonV2(
          fetcher,
          '/api/student/frequency?month=' + encodeURIComponent(month),
          { signal },
        ),
      );
      if (
        !parsed.success ||
        parsed.data.month !== month ||
        parsed.data.marks.some((mark) => !mark.date.startsWith(month + '-'))
      )
        throw new FrequencyClientErrorV2('unavailable');
      return parsed.data;
    },
  };
}
