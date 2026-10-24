import { z } from 'zod';

/*
 * Horário das aulas (owner decision 23/10/2026): the time of each lesson and of the break, per
 * shift and weekday, marked in the ADM (Portal do Aluno → Políticas → Calendário), one for the whole
 * school. The Portal's "Horário" shows each lesson with its time and the break in its place.
 *
 * The "parada" (owner decision 23/10/2026) is the students' drill, the ordem unida, before the
 * lessons and, on Friday afternoons, after the last one until 18:00: a time of the school day, never
 * a lesson (no number, no subject, never counted as one).
 */
export const BELL_SHIFTS_V1 = ['matutino', 'vespertino'] as const;
export type BellShiftV1 = (typeof BELL_SHIFTS_V1)[number];
export const BELL_WEEKDAYS_V1 = ['1', '2', '3', '4', '5'] as const;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);
export const bellItemV1 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('aula'), slot: z.number().int().min(1).max(6), start: time, end: time }).strict(),
  z.object({ kind: z.literal('intervalo'), start: time, end: time }).strict(),
  z.object({ kind: z.literal('parada'), start: time, end: time }).strict(),
]);
export type BellItemV1 = z.infer<typeof bellItemV1>;

/**
 * A day's items in time order, never overlapping, lessons numbered 1, 2, 3… with one break at most
 * and a parada at most before the lessons and after them (never between two lessons).
 */
export const bellDayV1 = z
  .array(bellItemV1)
  .max(10)
  .superRefine((items, ctx) => {
    let previousEnd = '';
    let slot = 0;
    let breaks = 0;
    for (const [index, item] of items.entries()) {
      if (item.end <= item.start) ctx.addIssue({ code: 'custom', message: 'Ends before it starts' });
      if (item.start < previousEnd) ctx.addIssue({ code: 'custom', message: 'Overlaps the previous one' });
      previousEnd = item.end;
      if (item.kind === 'intervalo') breaks += 1;
      else if (item.kind === 'parada') {
        if (index !== 0 && index !== items.length - 1)
          ctx.addIssue({ code: 'custom', message: 'A parada only before or after the lessons' });
      } else if (item.slot !== ++slot) ctx.addIssue({ code: 'custom', message: 'Lessons out of order' });
    }
    if (breaks > 1) ctx.addIssue({ code: 'custom', message: 'More than one break' });
  });
export type BellDayV1 = z.infer<typeof bellDayV1>;

export const schoolBellsDaysV1 = z
  .object({
    matutino: z.object({ 1: bellDayV1, 2: bellDayV1, 3: bellDayV1, 4: bellDayV1, 5: bellDayV1 }).strict(),
    vespertino: z.object({ 1: bellDayV1, 2: bellDayV1, 3: bellDayV1, 4: bellDayV1, 5: bellDayV1 }).strict(),
  })
  .strict();
export type SchoolBellsDaysV1 = z.infer<typeof schoolBellsDaysV1>;
export const schoolBellsV1 = z
  .object({ academicYear: z.literal(2026), version: z.number().int().nonnegative().safe(), bells: schoolBellsDaysV1 })
  .strict();
export type SchoolBellsV1 = z.infer<typeof schoolBellsV1>;

/**
 * The sheets the bells came from are "Horário 2026 — 22/06": a lesson's time (and, with the class's
 * current grid, its subject) is shown for an absence only from that day on, never for an older one
 * whose times may have been different.
 */
export const BELLS_VALID_FROM_V1 = '2026-06-22';

/** The shift a class's label names (Smecel labels end in "- MATUTINO", "- VESPERTINO (…)"). */
export function bellShiftOfLabelV1(label: string): BellShiftV1 | null {
  const found = [...label.toUpperCase().matchAll(/MATUTINO|VESPERTINO/gu)].at(-1)?.[0];
  if (found === 'MATUTINO') {
    return 'matutino';
  }
  if (found === 'VESPERTINO') {
    return 'vespertino';
  }
  return null;
}

const lessons = (times: readonly [string, string][], breakAfter: number, breakTimes: [string, string]): BellDayV1 =>
  times.flatMap(([start, end], index) => {
    const lesson: BellItemV1 = { kind: 'aula', slot: index + 1, start, end };
    return index + 1 === breakAfter ? [lesson, { kind: 'intervalo' as const, start: breakTimes[0], end: breakTimes[1] }] : [lesson];
  });

/**
 * The official "Horário Matutino / Vespertino 2026 — 22/06" of the school (owner decision
 * 23/10/2026: already filled in). Monday and Wednesday: five 55-minute lessons, the break after the
 * 3rd (morning) or 2nd (afternoon); Tuesday and Thursday: six 45-minute lessons, the break after the
 * 4th (morning) or 3rd (afternoon); Friday: five lessons, the break after the 3rd. The parada
 * comes first every day (06:45–07:00 in the morning, 06:45–07:45 on Friday; 13:00–13:15 in the
 * afternoon), and again after Friday afternoon's last lesson, 17:15–18:00.
 */
export function officialBells2026V1(): SchoolBellsDaysV1 {
  const morningLong = lessons(
    [['07:00', '07:55'], ['07:55', '08:50'], ['08:50', '09:45'], ['10:00', '10:55'], ['10:55', '11:45']],
    3,
    ['09:45', '10:00'],
  );
  const morningShort = lessons(
    [['07:00', '07:45'], ['07:45', '08:30'], ['08:30', '09:15'], ['09:15', '10:00'], ['10:15', '11:00'], ['11:00', '11:45']],
    4,
    ['10:00', '10:15'],
  );
  const morningFriday = lessons(
    [['07:45', '08:30'], ['08:30', '09:15'], ['09:15', '10:00'], ['10:15', '11:00'], ['11:00', '11:45']],
    3,
    ['10:00', '10:15'],
  );
  const afternoonLong = lessons(
    [['13:15', '14:10'], ['14:10', '15:05'], ['15:20', '16:15'], ['16:15', '17:10'], ['17:10', '18:00']],
    2,
    ['15:05', '15:20'],
  );
  const afternoonShort = lessons(
    [['13:15', '14:00'], ['14:00', '14:45'], ['14:45', '15:30'], ['15:45', '16:30'], ['16:30', '17:15'], ['17:15', '18:00']],
    3,
    ['15:30', '15:45'],
  );
  const afternoonFriday = lessons(
    [['13:15', '14:00'], ['14:00', '14:45'], ['14:45', '15:30'], ['15:45', '16:30'], ['16:30', '17:15']],
    3,
    ['15:30', '15:45'],
  );
  const parada = (start: string, end: string): BellItemV1 => ({ kind: 'parada', start, end });
  const morning = (day: BellDayV1) => [parada('06:45', '07:00'), ...day];
  const afternoon = (day: BellDayV1) => [parada('13:00', '13:15'), ...day];
  return {
    matutino: {
      1: morning(morningLong),
      2: morning(morningShort),
      3: morning(morningLong),
      4: morning(morningShort),
      5: [parada('06:45', '07:45'), ...morningFriday],
    },
    vespertino: {
      1: afternoon(afternoonLong),
      2: afternoon(afternoonShort),
      3: afternoon(afternoonLong),
      4: afternoon(afternoonShort),
      5: [...afternoon(afternoonFriday), parada('17:15', '18:00')],
    },
  };
}

/** "HH:MM" as minutes since midnight. */
export const bellMinutesV1 = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
/** The time of one lesson of a day, if the bells have it. */
export const bellLessonV1 = (day: BellDayV1 | null | undefined, slot: number) =>
  day?.find((item): item is Extract<BellItemV1, { kind: 'aula' }> => item.kind === 'aula' && item.slot === slot) ?? null;

/**
 * Where a day is at a moment (minutes since midnight, school time): before its first lesson, in a
 * lesson or in the break (with the next item), or over. `next` is what comes after the current one,
 * null when the current one is the last of the day.
 */
export type BellMomentV1 =
  | { state: 'before'; next: BellItemV1 }
  | { state: 'in'; current: BellItemV1; next: BellItemV1 | null }
  | { state: 'between'; next: BellItemV1 }
  | { state: 'over' };
export function bellMomentV1(day: BellDayV1, minutes: number): BellMomentV1 {
  if (!day.length) return { state: 'over' };
  if (minutes < bellMinutesV1(day[0]!.start)) return { state: 'before', next: day[0]! };
  for (const [index, item] of day.entries()) {
    const next = day[index + 1] ?? null;
    if (minutes >= bellMinutesV1(item.start) && minutes < bellMinutesV1(item.end)) return { state: 'in', current: item, next };
    if (next && minutes >= bellMinutesV1(item.end) && minutes < bellMinutesV1(next.start)) return { state: 'between', next };
  }
  return { state: 'over' };
}
