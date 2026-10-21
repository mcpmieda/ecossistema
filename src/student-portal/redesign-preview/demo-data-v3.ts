import { selfResponseV1, type SelfResponseV1 } from '../../../shared/student-portal-contracts/self-v1';
import type { FrequencyDayV2, FrequencySummaryV2 } from '../../../shared/attendance-contracts/frequency-v2';

/** The official summary with its Smecel lesson days (`days`, attendance 0008). */
export type DemoFrequencyV3 = FrequencySummaryV2 & { days: FrequencyDayV2[] };

/*
 * Redesign preview (owner request 20/10/2026): invented data only, self-contained so the product
 * code and the official preview stay untouched. Delete the redesign-preview folder and
 * redesign-preview.html to undo it.
 */
const TERM_MAXIMUM = { T1: 30, T2: 30, T3: 40 } as const;
const score = (value: number, maximum: number) => ({
  kind: 'score' as const,
  value,
  maximum,
  meetsMinimum: value * 100 >= maximum * 60,
});
let nextId = 960000;
const partial = (label: string, value: number, maximum: number) => ({
  assessmentId: ++nextId,
  label,
  mark: score(value, maximum),
  ...(/^Avaliação \d/u.test(label) ? { assessment: true as const } : {}),
});
type TermV1 = readonly [av1: number, av2: number, work: number, list: number, class_: number];
const term = (period: 'T1' | 'T2' | 'T3', [av1, av2, work, list, class_]: TermV1) => {
  const assessmentMax = period === 'T3' ? 15 : 10;
  return {
    period,
    final: score(av1 + av2 + work + list + class_, TERM_MAXIMUM[period]),
    partials: [
      partial('Avaliação 1', av1, assessmentMax),
      partial('Avaliação 2', av2, assessmentMax),
      partial('TRABALHO EM GRUPO', work, 4),
      partial('LISTA DE EXERCÍCIOS', list, 3),
      partial('PARTICIPAÇÃO', class_, 3),
    ],
  };
};
const CASES: readonly [label: string, t1: TermV1, t2: TermV1, t3: TermV1][] = [
  ['MATEMÁTICA', [10, 9.5, 4, 3, 2.5], [10, 10, 4, 3, 2.5], [15, 14, 4, 3, 2.5]],
  ['INGLÊS', [9.5, 9.5, 4, 3, 2.5], [8, 8.5, 3.5, 2.5, 2.5], [13, 13, 3.5, 2.5, 2.5]],
  ['PORTUGUÊS', [7, 7, 3, 2, 2], [8, 8, 3, 2.5, 2.5], [12, 12, 3, 2.5, 2.5]],
  ['HISTÓRIA', [7.5, 7, 3, 2.5, 2], [4.5, 4, 2, 1.5, 2], [10, 9, 2.5, 2, 2]],
  ['CIÊNCIAS', [6, 6, 3, 2, 2], [3, 2.5, 1, 1, 2], [11, 10, 3, 2, 2]],
  ['ARTE', [6.5, 6.5, 3, 2, 2], [6.5, 6.5, 3, 2, 2], [10, 10, 3, 2, 2]],
  ['GEOGRAFIA', [6, 5.5, 2.5, 2, 2], [6.5, 6, 3, 2, 2], [9, 9, 2.5, 1.5, 2]],
];

export const REDESIGN_SELF_V3: SelfResponseV1 = selfResponseV1.parse({
  contractVersion: 1,
  requestId: '33333333-3333-4333-8333-333333333333',
  state: 'ready',
  profile: {
    accountId: '33333333-3333-4333-8333-333333333333',
    link: { academicYear: 2026, studentId: 930001 },
    name: 'ALUNO ARTIFICIAL',
    classLabel: 'TURMA ARTIFICIAL',
    academicState: 'regular',
    result: 'in-progress',
  },
  revisions: {
    dataVersion: 'preview:academic:3',
    policyVersion: 'preview:policy:3',
    publicationVersion: 'preview:publication:3',
  },
  generatedAt: '2026-12-10T12:00:00-03:00',
  endedPeriods: ['T1', 'T2', 'T3'],
  showFrequency: true,
  subjects: CASES.map(([label, t1, t2, t3], order) => ({
    subjectId: 970001 + order,
    label,
    order,
    periods: [term('T1', t1), term('T2', t2), term('T3', t3)],
  })),
});

/**
 * Lessons of a school day, as the Smecel diary gives them (owner decision 20/10/2026): five on most
 * days, six on Tuesdays and Thursdays; no configuration involved, the preview just imitates the diary.
 */
const lessonsOn = (date: string) => ([2, 4].includes(new Date(`${date}T12:00:00Z`).getUTCDay()) ? 6 : 5);
/** A holiday in the preview: the diary's calendar icon, so no lessons that day. */
const HOLIDAYS = new Set(['2026-10-12']);
const pad = (value: number) => String(value).padStart(2, '0');
/** A fixed "today" so the preview always tells the same story. */
export const PREVIEW_TODAY_V3 = '2026-10-20';

/** Hand-written October, so the story is easy to follow; other months are generated. */
// Each kind of day (owner request 21/10/2026): whole days (one justified) and days absent in
// some lessons only (at the start, at the end, in the middle; one justified).
const OCTOBER: Record<string, readonly [slot: number, mark: 'X' | 'J'][]> = {
  '2026-10-06': [[1, 'X'], [2, 'X']],
  '2026-10-08': [[1, 'X'], [2, 'X'], [3, 'X'], [4, 'X'], [5, 'X'], [6, 'X']],
  '2026-10-09': [[1, 'J'], [2, 'J'], [3, 'J'], [4, 'J'], [5, 'J']],
  '2026-10-14': [[4, 'X'], [5, 'X']],
  '2026-10-15': [[6, 'J']],
  '2026-10-16': [[3, 'X']],
  // Today: shown on the calendar, not yet counted (the roll call may still be under way).
  '2026-10-20': [[1, 'X']],
};
/** Chance of a whole day and of one lesson missed: near the minimum in May, below it in August. */
const MONTH_ABSENCE_RATES: Record<string, readonly [wholeDay: number, oneLesson: number]> = {
  '2026-05': [0.17, 0.45],
  '2026-08': [0.3, 0.6],
};
/** Small deterministic generator: the same month always has the same absences. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}
function marksOf(month: string): FrequencySummaryV2['marks'] {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const random = seeded(monthNumber * 97);
  const marks: FrequencySummaryV2['marks'] = [];
  for (let day = 1; day <= days; day++) {
    const date = `${month}-${pad(day)}`;
    if (date > PREVIEW_TODAY_V3) break;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6 || HOLIDAYS.has(date)) continue;
    const planned = month === '2026-10' ? OCTOBER[date] : undefined;
    let dayMarks: readonly [number, 'X' | 'J'][] = planned ?? [];
    if (month !== '2026-10') {
      const roll = random();
      const lessons = lessonsOn(date);
      // May sits near the minimum and August below it, so the preview shows every state.
      const [wholeDay, oneLesson] = MONTH_ABSENCE_RATES[month] ?? [0.05, 0.14];
      if (roll < wholeDay) dayMarks = Array.from({ length: lessons }, (_, index) => [index + 1, random() < 0.25 ? 'J' : 'X'] as const);
      else if (roll < oneLesson) dayMarks = [[1 + Math.floor(random() * lessons), 'X']];
    }
    for (const [slot, mark] of dayMarks)
      marks.push({ date, slot, shift: 'MATUTINO', mark, classLabels: ['TURMA ARTIFICIAL'] });
  }
  return marks;
}
function daysOf(month: string): DemoFrequencyV3['days'] {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const result: DemoFrequencyV3['days'] = [];
  for (let day = 1; day <= days; day++) {
    const date = `${month}-${pad(day)}`;
    if (date > PREVIEW_TODAY_V3) break;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6 || HOLIDAYS.has(date)) continue;
    result.push({ date, shift: 'MATUTINO', slots: Array.from({ length: lessonsOn(date) }, (_, index) => index + 1), complete: true });
  }
  return result;
}

/** The month's summary in the same shape the Portal's frequency API returns. */
export function demoFrequencyV3(month: string): DemoFrequencyV3 {
  const marks = marksOf(month);
  const days = daysOf(month);
  // The server's rule (withLessonDaysV2): lessons of the days, X absences, J justified;
  // 100 × (lessons − absences) / lessons. Today stays out of the totals until it ends: its roll
  // call may still be under way, so a point there is not yet "no absence" (owner decision 20/10/2026).
  const counted = days.filter((day) => day.date < PREVIEW_TODAY_V3);
  const countedMarks = marks.filter((mark) => mark.date < PREVIEW_TODAY_V3);
  const denominator = counted.reduce((total, day) => total + day.slots.length, 0);
  const absences = countedMarks.filter((mark) => mark.mark === 'X').length;
  const justified = countedMarks.filter((mark) => mark.mark === 'J').length;
  // Read at the end of the last school day shown (a month of 30 or 31 days included), never before it.
  const lastDay = days.at(-1)?.date ?? `${month}-01`;
  return {
    contractVersion: 2,
    state: 'ready',
    month,
    absences,
    justified,
    denominator,
    percentage: denominator ? Math.round(((denominator - absences) / denominator) * 1000) / 10 : null,
    coverage: 'reliable',
    observedAt: `${lastDay}T17:40:00-03:00`,
    receivedAt: `${lastDay}T17:45:00-03:00`,
    marks,
    conflicts: 0,
    days,
  };
}
