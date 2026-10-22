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
/**
 * Today as the school's clock reads it (owner question 21/10/2026: "hoje" must follow the real
 * day). The school's time zone, not the phone's, so a phone set to another zone still agrees.
 * MERGE: on the real portal the server must send this date (it already works out the school's
 * "today" in America/Bahia for the collector, service-v2 checkCollectionClock).
 */
export const previewTodayV3 = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());

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
function marksOf(month: string, today: string): FrequencySummaryV2['marks'] {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const random = seeded(monthNumber * 97);
  const marks: FrequencySummaryV2['marks'] = [];
  for (let day = 1; day <= days; day++) {
    const date = `${month}-${pad(day)}`;
    if (date > today) break;
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
function daysOf(month: string, today: string): DemoFrequencyV3['days'] {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const result: DemoFrequencyV3['days'] = [];
  for (let day = 1; day <= days; day++) {
    const date = `${month}-${pad(day)}`;
    if (date > today) break;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6 || HOLIDAYS.has(date)) continue;
    result.push({ date, shift: 'MATUTINO', slots: Array.from({ length: lessonsOn(date) }, (_, index) => index + 1), complete: true });
  }
  return result;
}

/**
 * The month's summary as the Portal's frequency API returns it TODAY (withLessonDaysV2 in
 * server/attendance/service-v2.ts), so the page is built against the real shape: the totals count
 * every lesson day sent, today's included; reliable only when every day was read in full; without
 * lesson days the month is 'unavailable' (or 'incomplete' with marks) and the totals are null.
 * The page never shows these totals: it counts from `days` and `marks` without today (owner
 * decision 20/10/2026). `today` is the page's own clock, so one render never mixes two days.
 */
export function demoFrequencyV3(month: string, today: string): DemoFrequencyV3 {
  const marks = marksOf(month, today);
  const days = daysOf(month, today);
  const reliable = days.length > 0 && days.every((day) => day.complete);
  const denominator = days.reduce((total, day) => total + day.slots.length, 0);
  const absences = marks.filter((mark) => mark.mark === 'X').length;
  // As the server: the time a mark last changed (here, the end of the last day with one, never
  // later than yesterday), and nothing for a month without marks.
  const lastMarked = marks.filter((mark) => mark.date < today).at(-1)?.date;
  return {
    contractVersion: 2,
    state: 'ready',
    month,
    absences: reliable ? absences : null,
    justified: reliable ? marks.length - absences : null,
    denominator: reliable ? denominator : null,
    percentage: reliable ? Math.round(((denominator - absences) / denominator) * 1000) / 10 : null,
    coverage: reliable ? 'reliable' : marks.length ? 'incomplete' : 'unavailable',
    observedAt: lastMarked ? `${lastMarked}T17:40:00-03:00` : null,
    receivedAt: lastMarked ? `${lastMarked}T17:45:00-03:00` : null,
    marks,
    conflicts: 0,
    days,
  };
}

/**
 * The class's weekly grid (owner decision 22/10/2026), shaped like a real Smecel "Grade de
 * horários": subjects as the Smecel names them, no teacher, a free position left out (it shows as a
 * blank space). Monday, Wednesday and Friday have no 6th lesson.
 */
const WEEK: readonly (readonly (string | null)[])[] = [
  // Monday … Friday, per lesson position.
  ['ARTE', 'CIENCIAS', 'ETICA E CIDADANIA', 'REDACAO', 'LINGUA PORTUGUESA'],
  ['LINGUA PORTUGUESA', 'EDUCACAO FISICA', 'INFORMATICA/COMPUTACAO', 'REDACAO', 'LINGUA PORTUGUESA'],
  ['LINGUA PORTUGUESA', 'ARTE', 'ENSINO RELIGIOSO', 'GEOGRAFIA', 'CIENCIAS'],
  ['LINGUA INGLESA', 'LINGUA PORTUGUESA', 'MATEMATICA', 'ETICA E CIDADANIA', 'GEOGRAFIA'],
  ['HISTORIA', 'MATEMATICA', 'MATEMATICA', 'CIENCIAS', 'EDUCACAO FISICA'],
  [null, 'MATEMATICA', null, 'HISTORIA', null],
];
export const demoScheduleV3 = () => [
  {
    label: 'TURMA ARTIFICIAL',
    observedAt: `${previewTodayV3()}T10:12:00Z`,
    lessons: WEEK.flatMap((row, index) =>
      row.flatMap((subject, day) => (subject ? [{ weekday: day + 1, slot: index + 1, subject }] : [])),
    ),
  },
];
