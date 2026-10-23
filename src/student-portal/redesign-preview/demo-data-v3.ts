import { selfResponseV1, type SelfResponseV1 } from '../../../shared/student-portal-contracts/self-v1';
import {
  frequencyCountV2,
  type FrequencyDayV2,
  type FrequencySummaryV2,
  type FrequencyYearSummaryV2,
} from '../../../shared/attendance-contracts/frequency-v2';
import type { StudentFrequencyClientV2 } from '../../features/student-portal/frequency/client-v2';
import type { StudentScheduleClientV1 } from '../../features/student-portal/schedule/client-v1';
import { schoolDateOnDeviceV3 } from '../../features/student-portal/redesign/frequency-page-v3';
import { officialCalendar2026V1 } from '../../../shared/student-portal-contracts/school-calendar-2026-start-v1';
import { schoolYearProgressOfV1 } from '../../../shared/student-portal-contracts/school-calendar-v1';
import { frequencyCommentV2, type FrequencyCommentKindV2 } from '../../../shared/attendance-contracts/frequency-comment-v2';

const demoCalendarV3 = officialCalendar2026V1;

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
  showSchedule: true,
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
/** The first school day of 2026, as in the real diary (23/02). */
const FIRST_SCHOOL_DAY = '2026-02-23';
const pad = (value: number) => String(value).padStart(2, '0');
/** Today as the school's clock reads it (the same helper as the real page). */
export const previewTodayV3 = schoolDateOnDeviceV3;

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
    if (date < FIRST_SCHOOL_DAY) continue;
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
    if (date < FIRST_SCHOOL_DAY) continue;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6 || HOLIDAYS.has(date)) continue;
    result.push({ date, shift: 'MATUTINO', slots: Array.from({ length: lessonsOn(date) }, (_, index) => index + 1), complete: true });
  }
  return result;
}

/**
 * The month as the Portal's frequency API answers it (portalFrequencySummaryV2 in
 * server/attendance/service-v2.ts), so the page is built against the real shape: the totals by
 * the owner's rule (frequencyCountV2: today never counts), the school's today, the year so far
 * (null while any month is unknown) and the class's last reading.
 */
export function demoFrequencyV3(month: string, today: string): DemoFrequencyV3 {
  const monthOf = (key: string) => {
    const marks = marksOf(key, today);
    const days = daysOf(key, today);
    const count = frequencyCountV2({ marks, conflicts: 0, days }, today);
    const reliable = days.length > 0 && count.reliable;
    // As the server: the time a mark last changed, and nothing for a month without marks.
    const lastMarked = marks.filter((mark) => mark.date < today).at(-1)?.date;
    return {
      contractVersion: 2 as const,
      state: 'ready' as const,
      month: key,
      absences: reliable ? count.absences : null,
      justified: reliable ? marks.filter((mark) => mark.mark === 'J' && mark.date < today).length : null,
      denominator: reliable ? count.lessons : null,
      percentage:
        reliable && count.lessons ? Math.round(((count.lessons - count.absences) / count.lessons) * 1000) / 10 : null,
      coverage: reliable ? ('reliable' as const) : marks.length ? ('incomplete' as const) : ('unavailable' as const),
      observedAt: lastMarked ? `${lastMarked}T17:40:00-03:00` : null,
      receivedAt: lastMarked ? `${lastMarked}T17:45:00-03:00` : null,
      marks,
      conflicts: 0,
      days,
    };
  };
  let lessons = 0;
  let absences = 0;
  let known = true;
  for (let index = 1; index <= 12; index++) {
    const key = `2026-${pad(index)}`;
    if (key > today.slice(0, 7)) break;
    const count = frequencyCountV2(monthOf(key), today);
    known &&= count.reliable;
    lessons += count.lessons;
    absences += count.absences;
  }
  return {
    ...monthOf(month),
    today,
    year: known && lessons ? { lessons, absences } : null,
    // The collector read the diary this morning (an unchanged reading still moves this time).
    lastReadAt: `${today}T07:10:00-03:00`,
  };
}

/** The whole year so far, as GET /api/student/frequency?year=2026 answers it. */
export function demoFrequencyYearV3(today: string): FrequencyYearSummaryV2 {
  const months = Array.from({ length: 12 }, (_, index) => `2026-${pad(index + 1)}`).filter((key) => key <= today.slice(0, 7));
  const answers = months.map((key) => demoFrequencyV3(key, today));
  const first = answers[0] ?? demoFrequencyV3('2026-01', today);
  const schoolYear = schoolYearProgressOfV1(demoCalendarV3(), today);
  return {
    comment: frequencyCommentV2({ months: answers, today, remainingSchoolDays: schoolYear.remaining }),
    contractVersion: 2,
    state: 'ready',
    academicYear: 2026,
    today,
    year: first.year ?? null,
    lastReadAt: first.lastReadAt ?? null,
    // The official calendar of 2026 (200 school days).
    schoolYear,
    months: answers.map(({ today: _today, year: _year, lastReadAt: _read, ...month }) => {
      void _today;
      void _year;
      void _read;
      return month;
    }),
  };
}

/** After a short wait like a real request. */
const later = <T,>(value: () => T, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(value()), 250);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
/**
 * One example of each sentence about the absences (owner decisions 22/10/2026), for the "Simular
 * admin" panel: the same wording the server writes, with invented numbers.
 */
export const DEMO_FREQUENCY_COMMENTS_V3: Record<FrequencyCommentKindV2, { label: string; tone: 'alert' | 'good'; text: string }> = {
  'over-limit': { label: 'Já passou do limite', tone: 'alert', text: 'Já faltou cerca de 52 dias. Passou do limite da lei (50 dias).' },
  'will-pass': { label: 'Vai passar do limite', tone: 'alert', text: 'Já faltou cerca de 43 dias. Faltando assim, vai passar do limite da lei (50 dias).' },
  'near-limit': { label: 'Perto do limite', tone: 'alert', text: 'Já faltou cerca de 35 dias. Está perto do limite da lei (50 dias).' },
  'in-a-row': { label: 'Dias seguidos sem vir', tone: 'alert', text: 'Não vem à escola desde 19/10 (3 dias seguidos).' },
  rising: { label: 'Faltando mais', tone: 'alert', text: 'Faltou cerca de 6 dias nas últimas 4 semanas. Antes, faltava menos.' },
  weekday: { label: 'Dia da semana', tone: 'alert', text: 'Falta muito às segundas-feiras.' },
  improving: { label: 'Melhorando', tone: 'good', text: 'Está faltando menos dias. Continue assim!' },
  'none-recently': { label: 'Sem faltas em 4 semanas', tone: 'good', text: 'Nenhuma falta nas últimas 4 semanas. Muito bem!' },
  'none-this-year': { label: 'Sem faltas no ano', tone: 'good', text: 'Nenhuma falta este ano. Parabéns!' },
};
export type DemoCommentChoiceV3 = 'auto' | 'none' | FrequencyCommentKindV2;

/** The preview's frequency "API": the same answers as the real one; a sentence may be forced. */
export const createDemoFrequencyClientV3 = (comment: DemoCommentChoiceV3 = 'auto'): StudentFrequencyClientV2 => ({
  read: (month, signal) => later(() => demoFrequencyV3(month, previewTodayV3()), signal),
  readYear: (signal) =>
    later(() => {
      const year = demoFrequencyYearV3(previewTodayV3());
      if (comment === 'auto') return year;
      if (comment === 'none') return { ...year, comment: null };
      const { tone, text } = DEMO_FREQUENCY_COMMENTS_V3[comment];
      return { ...year, comment: { kind: comment, tone, text } };
    }, signal),
});

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

/** The preview's schedule "API". */
export const createDemoScheduleClientV3 = (): StudentScheduleClientV1 => ({
  read: (signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(demoScheduleV3()), 250);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      });
    }),
});
