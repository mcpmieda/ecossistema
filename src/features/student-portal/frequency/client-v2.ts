import { z } from 'zod';
import type {
  FrequencySummaryV2,
  FrequencyYearSummaryV2,
} from '../../../../shared/attendance-contracts/frequency-v2';
import { BELL_SHIFTS_V1, schoolBellsDaysV1 } from '../../../../shared/student-portal-contracts/school-bells-v1';
import { schoolDaysOffV1 } from '../../../../shared/student-portal-contracts/school-calendar-v1';

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
    // Smecel lesson days (attendance 0008); accepted before any screen uses them.
    days: z
      .array(
        z
          .object({
            date: z.iso.date(),
            shift: z.string().max(80),
            slots: z.array(z.number().int().min(1).max(6)).min(1).max(6),
            complete: z.boolean(),
          })
          .strict(),
      )
      .max(62)
      .optional(),
    // The school's today, the year so far and the class's last reading (attendance 0012).
    today: z.iso.date().optional(),
    year: z
      .object({ lessons: z.number().int().positive().max(100_000), absences: z.number().int().nonnegative().max(100_000) })
      .strict()
      .refine((value) => value.absences <= value.lessons)
      .nullable()
      .optional(),
    lastReadAt: timestamp.optional(),
  })
  .strict();

const yearCounts = z
  .object({
    lessons: z.number().int().positive().max(100_000),
    absences: z.number().int().nonnegative().max(100_000),
  })
  .strict()
  .refine((value) => value.absences <= value.lessons);
const wholeYear = z
  .object({
    contractVersion: z.literal(2),
    state: z.literal('ready'),
    academicYear: z.literal(2026),
    today: z.iso.date(),
    year: yearCounts.nullable(),
    lastReadAt: timestamp,
    months: z.array(summary).max(12),
    serverNow: z.iso.datetime({ offset: true }).optional(),
    schoolYear: z
      .object({
        schoolDays: z.number().int().nonnegative().max(366),
        remaining: z.number().int().nonnegative().max(366),
        firstDay: z.iso.date().nullable(),
        lastDay: z.iso.date().nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    comment: z
      .object({
        kind: z.enum(['over-limit', 'will-pass', 'near-limit', 'in-a-row', 'rising', 'weekday', 'improving', 'none-recently', 'none-this-year']),
        tone: z.enum(['alert', 'good']),
        text: z.string().min(1).max(200),
      })
      .strict()
      .nullable()
      .optional(),
    // The days without school, each lesson's time and the week's subjects (owner decision 23/10/2026).
    daysOff: schoolDaysOffV1.optional(),
    bells: schoolBellsDaysV1.nullable().optional(),
    // From when those times hold (the ADM's last save, or the official sheets' day).
    bellsValidFrom: z.iso.date().nullable().optional(),
    grid: z
      .array(
        z
          .object({
            shift: z.enum(BELL_SHIFTS_V1),
            lessons: z
              .array(
                z
                  .object({
                    weekday: z.number().int().min(1).max(5),
                    slot: z.number().int().min(1).max(6),
                    subject: z.string().min(1).max(120),
                  })
                  .strict(),
              )
              .max(30),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();

export type StudentFrequencyClientV2 = {
  read(month: string, signal: AbortSignal): Promise<FrequencySummaryV2>;
  /** The whole school year so far in one answer (read with the sign-in, PR 1317). */
  readYear(signal: AbortSignal): Promise<FrequencyYearSummaryV2>;
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
    async readYear(signal) {
      const parsed = wholeYear.safeParse(
        await frequencyJsonV2(fetcher, '/api/student/frequency?year=2026', { signal }),
      );
      if (
        !parsed.success ||
        parsed.data.months.some(
          (month, index) =>
            month.month !== `2026-${String(index + 1).padStart(2, '0')}` ||
            month.marks.some((mark) => !mark.date.startsWith(month.month + '-')),
        )
      )
        throw new FrequencyClientErrorV2('unavailable');
      return parsed.data;
    },
  };
}
