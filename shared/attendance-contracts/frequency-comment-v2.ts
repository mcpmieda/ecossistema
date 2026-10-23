import type { FrequencyDayV2, FrequencySummaryV2 } from './frequency-v2';

/*
 * One sentence about the student's absences at the top of the Portal's Frequência (owner decisions
 * 22/10/2026). Plain words for families: only absences WITHOUT justification (justified ones are
 * transport, medical appointments… and never count), told in days ("cerca de"): the student's
 * absences in lessons divided by their own average of lessons per day, rounded to the nearest
 * whole day. The law's 75% makes the limit 50 of the 200 school days, never told as days "permitidos"
 * (owner decision 22/10/2026: it is not a right to miss them). Saturdays are symbolic
 * compensation days with automatic attendance, so they never show a trend (only weekdays do).
 * Only the first sentence that applies is shown; with none, nothing is shown.
 */
export const MAXIMUM_ABSENCE_DAYS_V2 = 50;
/** "Perto do limite" from this many days of absence on. */
export const NEAR_LIMIT_DAYS_V2 = 30;
/** The last four weeks: the twenty most recent weekdays with lessons. */
const RECENT_WEEKDAYS = 20;

export type FrequencyCommentKindV2 =
  | 'over-limit'
  | 'will-pass'
  | 'near-limit'
  | 'in-a-row'
  | 'rising'
  | 'weekday'
  | 'improving'
  | 'none-recently'
  | 'none-this-year';
export type FrequencyCommentV2 = { kind: FrequencyCommentKindV2; tone: 'alert' | 'good'; text: string };

const WEEKDAY_PLURAL = ['', 'às segundas-feiras', 'às terças-feiras', 'às quartas-feiras', 'às quintas-feiras', 'às sextas-feiras'];
const days = (count: number) => (count === 1 ? '1 dia' : `${count} dias`);
const dateLabel = (date: string) => `${date.slice(8)}/${date.slice(5, 7)}`;

export function frequencyCommentV2({
  months,
  today,
  remainingSchoolDays,
}: {
  /** Every month so far, as the Portal reads them (marks and lesson days of the school calendar). */
  months: readonly Pick<FrequencySummaryV2, 'marks' | 'days'>[];
  today: string;
  /** School days left in the calendar, today included (0 without a calendar). */
  remainingSchoolDays: number;
}): FrequencyCommentV2 | null {
  // Each day already over: its lessons (every shift's positions) and its absences without justification.
  const lessons = new Map<string, Set<string>>();
  for (const day of months.flatMap((month) => month.days ?? []) as FrequencyDayV2[]) {
    if (day.date >= today) continue;
    const set = lessons.get(day.date) ?? new Set<string>();
    for (const slot of day.slots) set.add(`${day.shift}:${slot}`);
    lessons.set(day.date, set);
  }
  const absent = new Map<string, number>();
  for (const mark of months.flatMap((month) => month.marks))
    if (mark.mark === 'X' && lessons.get(mark.date)?.has(`${mark.shift}:${mark.slot}`))
      absent.set(mark.date, (absent.get(mark.date) ?? 0) + 1);
  const all = [...lessons.entries()]
    .map(([date, set]) => ({ date, lessons: set.size, absences: absent.get(date) ?? 0, weekday: new Date(`${date}T12:00:00Z`).getUTCDay() }))
    .filter((day) => day.lessons > 0)
    .sort((left, right) => right.date.localeCompare(left.date));
  if (!all.length) return null;
  const totalLessons = all.reduce((sum, day) => sum + day.lessons, 0);
  const totalAbsences = all.reduce((sum, day) => sum + day.absences, 0);
  const perDay = totalLessons / all.length;
  const absenceDays = totalAbsences / perDay;
  const shown = Math.round(absenceDays);

  // Trends on weekdays only (a Saturday never shows the student came back).
  const weekdays = all.filter((day) => day.weekday >= 1 && day.weekday <= 5);
  const recent = weekdays.slice(0, RECENT_WEEKDAYS);
  const before = weekdays.slice(RECENT_WEEKDAYS);
  const rate = (list: typeof weekdays) => {
    const total = list.reduce((sum, day) => sum + day.lessons, 0);
    return total ? list.reduce((sum, day) => sum + day.absences, 0) / total : 0;
  };
  const recentRate = rate(recent);
  const beforeRate = rate(before);
  const recentAbsenceDays = recent.reduce((sum, day) => sum + day.absences, 0) / perDay;
  const fullDays = weekdays.filter((day) => day.absences >= day.lessons);
  let streak = 0;
  for (const day of weekdays) {
    if (day.absences < day.lessons) break;
    streak += 1;
  }
  const byWeekday = [0, 0, 0, 0, 0, 0];
  for (const day of fullDays) byWeekday[day.weekday]! += 1;
  const topWeekday = byWeekday.indexOf(Math.max(...byWeekday));

  const alert = (kind: FrequencyCommentKindV2, text: string): FrequencyCommentV2 => ({ kind, tone: 'alert', text });
  const good = (kind: FrequencyCommentKindV2, text: string): FrequencyCommentV2 => ({ kind, tone: 'good', text });
  if (absenceDays > MAXIMUM_ABSENCE_DAYS_V2)
    return alert('over-limit', `Já faltou cerca de ${days(shown)}. Pode reprovar por falta.`);
  if (absenceDays + recentRate * remainingSchoolDays > MAXIMUM_ABSENCE_DAYS_V2)
    return alert('will-pass', `Já faltou cerca de ${days(shown)}. Faltando assim, pode reprovar por falta.`);
  // From 30 days on (owner decision 23/10/2026). No sentence names the limit (owner decision
  // 23/10/2026: a number of days reads as freedom to miss); it only decides when a warning shows.
  if (absenceDays >= NEAR_LIMIT_DAYS_V2)
    return alert('near-limit', `Já faltou cerca de ${days(shown)}. Mais faltas podem reprovar.`);
  if (streak >= 3)
    return alert('in-a-row', `Não vem à escola desde ${dateLabel(weekdays[streak - 1]!.date)} (${streak} dias seguidos).`);
  if (recentAbsenceDays >= 4 && recentRate >= 2 * beforeRate)
    return alert('rising', `Faltou cerca de ${days(Math.round(recentAbsenceDays))} nas últimas 4 semanas. Antes, faltava menos.`);
  if (fullDays.length >= 8 && byWeekday[topWeekday]! >= 0.4 * fullDays.length)
    return alert('weekday', `Falta muito ${WEEKDAY_PLURAL[topWeekday]}.`);
  if (before.length && beforeRate >= 0.1 && recentRate < 0.5 * beforeRate)
    return good('improving', 'Está faltando menos dias. Continue assim!');
  if (totalAbsences === 0) return good('none-this-year', 'Nenhuma falta este ano. Parabéns!');
  if (recent.length && recent.every((day) => day.absences === 0))
    return good('none-recently', 'Nenhuma falta nas últimas 4 semanas. Muito bem!');
  return null;
}
