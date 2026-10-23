import { z } from 'zod';

/*
 * The school's calendar of the year (owner decision 22/10/2026): marked in the ADM (Portal do Aluno
 * → Políticas → Calendário), one for the whole school, never per shift, class or student. The rule
 * is 200 school days ("a regra é 200 dias"); the Portal counts the year's countdown and the
 * absence limit from it. A date not marked has no school.
 */
export const SCHOOL_DAYS_REQUIRED_V1 = 200;

export const SCHOOL_DAY_KINDS_V1 = [
  'letivo',
  'sabado-letivo',
  'evento-letivo',
  'feriado',
  'recesso',
  'evento',
] as const;
export const schoolDayKindV1 = z.enum(SCHOOL_DAY_KINDS_V1);
export type SchoolDayKindV1 = z.infer<typeof schoolDayKindV1>;
/** The kinds that are a school day (they count toward the 200). */
export const SCHOOL_DAY_COUNTS_V1: Record<SchoolDayKindV1, boolean> = {
  letivo: true,
  'sabado-letivo': true,
  'evento-letivo': true,
  feriado: false,
  recesso: false,
  evento: false,
};

export const schoolCalendarDayV1 = z
  .object({
    date: z.iso.date(),
    kind: schoolDayKindV1,
    // What the day is, in the school's words ("Padroeiro da cidade", "Recesso junino").
    note: z.string().trim().max(80).optional(),
  })
  .strict();
export type SchoolCalendarDayV1 = z.infer<typeof schoolCalendarDayV1>;

export const schoolCalendarDaysV1 = z
  .array(schoolCalendarDayV1)
  .max(366)
  .superRefine((days, ctx) => {
    const seen = new Set<string>();
    for (const day of days) {
      if (!day.date.startsWith('2026-'))
        ctx.addIssue({ code: 'custom', message: 'Day outside the school year' });
      if (seen.has(day.date)) ctx.addIssue({ code: 'custom', message: 'Duplicate day' });
      seen.add(day.date);
    }
    // Never more than the rule (owner decision 22/10/2026: "não passar disso").
    if (days.filter((day) => SCHOOL_DAY_COUNTS_V1[day.kind]).length > SCHOOL_DAYS_REQUIRED_V1)
      ctx.addIssue({ code: 'custom', message: 'More school days than the rule' });
  });

export const schoolCalendarV1 = z
  .object({
    academicYear: z.literal(2026),
    version: z.number().int().nonnegative().safe(),
    days: schoolCalendarDaysV1,
  })
  .strict();
export type SchoolCalendarV1 = z.infer<typeof schoolCalendarV1>;

/** The school days marked, in date order. */
export const schoolDaysOfV1 = (days: readonly SchoolCalendarDayV1[]) =>
  days
    .filter((day) => SCHOOL_DAY_COUNTS_V1[day.kind])
    .map((day) => day.date)
    .sort();

/**
 * What the Portal shows of the calendar (no notes, no other kinds): how many school days the year
 * has, how many are left counting today, and the last one (the countdown's end).
 */
export const schoolYearProgressV1 = z
  .object({
    schoolDays: z.number().int().nonnegative().max(366),
    remaining: z.number().int().nonnegative().max(366),
    firstDay: z.iso.date().nullable(),
    lastDay: z.iso.date().nullable(),
  })
  .strict();
export type SchoolYearProgressV1 = z.infer<typeof schoolYearProgressV1>;
export function schoolYearProgressOfV1(days: readonly SchoolCalendarDayV1[], today: string): SchoolYearProgressV1 {
  const school = schoolDaysOfV1(days);
  return {
    schoolDays: school.length,
    remaining: school.filter((date) => date >= today).length,
    firstDay: school[0] ?? null,
    lastDay: school.at(-1) ?? null,
  };
}
