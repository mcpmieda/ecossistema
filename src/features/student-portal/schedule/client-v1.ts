import { z } from 'zod';
import { FrequencyClientErrorV2 } from '../frequency/client-v2';
import { bellDayV1 } from '../../../../shared/student-portal-contracts/school-bells-v1';
import { schoolDaysOffV1, schoolYearSpanV1 } from '../../../../shared/student-portal-contracts/school-calendar-v1';

/*
 * The weekly grid of the student's own class(es) (owner decision 22/10/2026), from
 * GET /api/student/schedule (server/student-portal/composition/schedule-v1.ts). The subject exactly
 * as the Smecel names it, never a teacher; a free position is absent. Same-origin, private, no
 * cache; the student never asks for a class or a student (the session decides).
 */
const lesson = z
  .object({
    weekday: z.number().int().min(1).max(5),
    slot: z.number().int().min(1).max(6),
    subject: z.string().min(1).max(120),
  })
  .strict();
const answer = z
  .object({
    contractVersion: z.literal(1),
    state: z.literal('ready'),
    classes: z
      .array(
        z
          .object({
            label: z.string().min(1).max(300),
            observedAt: z.string().min(1).max(64),
            lessons: z.array(lesson).max(30),
            // The time of each lesson and of the break of this class's shift (ADM), or null.
            bells: z
              .object({ 1: bellDayV1, 2: bellDayV1, 3: bellDayV1, 4: bellDayV1, 5: bellDayV1 })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(8),
    // The school's today and the database's clock: "Agora" and its countdown never use the phone's.
    today: z.iso.date(),
    now: z.iso.datetime({ offset: true }),
    daysOff: schoolDaysOffV1,
    // The school year's first and last school day (ADM calendar), or null without a calendar.
    schoolYear: schoolYearSpanV1.nullable(),
  })
  .strict();
const failure = z
  .object({
    contractVersion: z.literal(1),
    state: z.enum(['unauthenticated', 'forbidden', 'invalid-request', 'unavailable']),
  })
  .passthrough();
export type StudentScheduleV1 = Omit<z.infer<typeof answer>, 'contractVersion' | 'state'>;
export type StudentScheduleClientV1 = { read(signal: AbortSignal): Promise<StudentScheduleV1> };

export function createStudentScheduleClientV1(
  fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
): StudentScheduleClientV1 {
  return {
    async read(signal) {
      const response = await fetcher('/api/student/schedule', {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (response.status === 401) throw new FrequencyClientErrorV2('unauthenticated');
      if (response.status === 403) throw new FrequencyClientErrorV2('forbidden');
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
        throw new FrequencyClientErrorV2('unavailable');
      const text = await response.text();
      // A week of 30 lessons in a few classes is a few kilobytes; anything far larger is not ours.
      if (text.length > 200_000) throw new FrequencyClientErrorV2('unavailable');
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new FrequencyClientErrorV2('unavailable');
      }
      const failed = failure.safeParse(body);
      if (failed.success) throw new FrequencyClientErrorV2(failed.data.state);
      const parsed = answer.safeParse(body);
      if (!response.ok || !parsed.success) throw new FrequencyClientErrorV2('unavailable');
      const { classes, today, now, daysOff, schoolYear } = parsed.data;
      return { classes, today, now, daysOff, schoolYear };
    },
  };
}
