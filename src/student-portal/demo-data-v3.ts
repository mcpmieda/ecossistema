import {
  frequencyCountV2,
  type FrequencyDayV2,
  type FrequencySummaryV2,
  type FrequencyYearSummaryV2,
} from '../../shared/attendance-contracts/frequency-v2';
import type { StudentFrequencyClientV2 } from '../features/student-portal/frequency/client-v2';
import type { StudentScheduleClientV1 } from '../features/student-portal/schedule/client-v1';
import type { StudentIncidentV1, StudentIncidentsClientV1 } from '../features/student-portal/incidents/client-v1';
import { schoolDateOnDeviceV3 } from '../features/student-portal/redesign/frequency-page-v3';
import { officialCalendar2026V1 } from '../../shared/student-portal-contracts/school-calendar-2026-start-v1';
import { schoolDaysOffOfV1, schoolDaysOfV1, schoolYearProgressOfV1, schoolYearSpanOfV1 } from '../../shared/student-portal-contracts/school-calendar-v1';
import { BELLS_VALID_FROM_V1, officialBells2026V1 } from '../../shared/student-portal-contracts/school-bells-v1';
import { frequencyCommentV2, type FrequencyCommentKindV2 } from '../../shared/attendance-contracts/frequency-comment-v2';

const demoCalendarV3 = officialCalendar2026V1;

/** The official summary with its Smecel lesson days (`days`, attendance 0008). */
type DemoFrequencyV3 = FrequencySummaryV2 & { days: FrequencyDayV2[] };

/*
 * Invented frequency, schedule and incidents for the one Portal preview (ui-preview.html), through
 * clients shaped like the real APIs, so it needs no session and asks nothing of the server.
 */

/**
 * Lessons of a school day, as the Smecel diary gives them (owner decision 20/10/2026): five on most
 * days, six on Tuesdays and Thursdays; no configuration involved, the preview just imitates the diary.
 */
const lessonsOn = (date: string) => ([2, 4].includes(new Date(`${date}T12:00:00Z`).getUTCDay()) ? 6 : 5);
/**
 * The preview diary's lesson days: the school days of the official calendar, the only ones the
 * server counts (owner request 27/10/2026: the ring's "dias já se passaram" as in the real portal).
 */
const SCHOOL_DAYS = new Set(schoolDaysOfV1(demoCalendarV3()));
/** A school Saturday is a compensation day with automatic attendance: never an absence. */
const isSaturday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() === 6;
const pad = (value: number) => String(value).padStart(2, '0');
/** Today as the school's clock reads it (the same helper as the real page). */
const previewTodayV3 = schoolDateOnDeviceV3;
/**
 * The preview's clock: the real time, or a simulated one with ?hora=15:35 in the address (owner
 * request 23/10/2026: "simula o intervalo"), today at that time in Brasília, running from there.
 */
const SIMULATED_AT_V3 = (() => {
  const hora = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('hora');
  if (!hora || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(hora)) return null;
  return { at: Date.parse(`${schoolDateOnDeviceV3()}T${hora}:00-03:00`), loadedAt: Date.now() };
})();
const previewNowV3 = () =>
  new Date(SIMULATED_AT_V3 ? SIMULATED_AT_V3.at + (Date.now() - SIMULATED_AT_V3.loadedAt) : Date.now()).toISOString();

/** Hand-written October, so the story is easy to follow; other months are generated. */
// Each kind of day (owner request 21/10/2026): whole days (one justified) and days absent in
// some lessons only (at the start, at the end, in the middle; one justified).
const OCTOBER: Record<string, readonly [slot: number, mark: 'X' | 'J'][]> = {
  '2026-10-06': [[1, 'X'], [2, 'X']],
  '2026-10-08': [[1, 'X'], [2, 'X'], [3, 'X'], [4, 'X'], [5, 'X'], [6, 'X']],
  '2026-10-09': [[1, 'J'], [2, 'J'], [3, 'J'], [4, 'J'], [5, 'J']],
  '2026-10-19': [[4, 'X'], [5, 'X']],
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
/** A month other than October: a whole day missed, one lesson missed, or none, at the month's rates. */
function randomDayMarksV3(month: string, date: string, random: () => number): readonly [number, 'X' | 'J'][] {
  const roll = random();
  const lessons = lessonsOn(date);
  // May sits near the minimum and August below it, so the preview shows every state.
  const [wholeDay, oneLesson] = MONTH_ABSENCE_RATES[month] ?? [0.05, 0.14];
  if (roll < wholeDay) return Array.from({ length: lessons }, (_, index) => [index + 1, random() < 0.25 ? 'J' : 'X'] as const);
  if (roll < oneLesson) return [[1 + Math.floor(random() * lessons), 'X']];
  return [];
}
function marksOf(month: string, today: string): FrequencySummaryV2['marks'] {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const random = seeded(monthNumber * 97);
  const marks: FrequencySummaryV2['marks'] = [];
  for (let day = 1; day <= days; day++) {
    const date = `${month}-${pad(day)}`;
    if (date > today) break;
    if (!SCHOOL_DAYS.has(date) || isSaturday(date)) continue;
    const dayMarks = month === '2026-10' ? (OCTOBER[date] ?? []) : randomDayMarksV3(month, date, random);
    for (const [slot, mark] of dayMarks)
      marks.push({ date, slot, shift: 'VESPERTINO', mark, classLabels: ['TURMA ARTIFICIAL'] });
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
    if (!SCHOOL_DAYS.has(date)) continue;
    result.push({ date, shift: 'VESPERTINO', slots: Array.from({ length: lessonsOn(date) }, (_, index) => index + 1), complete: true });
  }
  return result;
}

/**
 * The month as the Portal's frequency API answers it (portalFrequencySummaryV2 in
 * server/attendance/service-v2.ts), so the page is built against the real shape: the totals by
 * the owner's rule (frequencyCountV2: today never counts), the school's today, the year so far
 * (null while any month is unknown) and the class's last reading.
 */
function demoFrequencyV3(month: string, today: string): DemoFrequencyV3 {
  const monthOf = (key: string) => {
    const marks = marksOf(key, today);
    const days = daysOf(key, today);
    const count = frequencyCountV2({ marks, conflicts: 0, days }, today);
    const reliable = days.length > 0 && count.reliable;
    // As the server: the time a mark last changed, and nothing for a month without marks.
    // findLast needs lib ES2023; the project targets ES2022.
    const lastMarked = marks.filter((mark) => mark.date < today).at(-1)?.date; // NOSONAR
    let coverage: 'reliable' | 'incomplete' | 'unavailable' = 'unavailable';
    if (reliable) coverage = 'reliable';
    else if (marks.length) coverage = 'incomplete';
    return {
      contractVersion: 2 as const,
      state: 'ready' as const,
      month: key,
      absences: reliable ? count.absences : null,
      justified: reliable ? marks.filter((mark) => mark.mark === 'J' && mark.date < today).length : null,
      denominator: reliable ? count.lessons : null,
      percentage:
        reliable && count.lessons ? Math.round(((count.lessons - count.absences) / count.lessons) * 1000) / 10 : null,
      coverage,
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
function demoFrequencyYearV3(today: string): FrequencyYearSummaryV2 {
  const months = Array.from({ length: 12 }, (_, index) => `2026-${pad(index + 1)}`).filter((key) => key <= today.slice(0, 7));
  const answers = months.map((key) => demoFrequencyV3(key, today));
  const first = answers[0] ?? demoFrequencyV3('2026-01', today);
  const schoolYear = schoolYearProgressOfV1(demoCalendarV3(), today);
  return {
    comment: frequencyCommentV2({
      months: answers,
      today,
      schoolDays: schoolYear.schoolDays,
      remainingSchoolDays: schoolYear.remaining,
    }),
    contractVersion: 2,
    state: 'ready',
    academicYear: 2026,
    today,
    year: first.year ?? null,
    lastReadAt: first.lastReadAt ?? null,
    // The official calendar of 2026 (200 school days), its days without school and the bells.
    schoolYear,
    daysOff: schoolDaysOffOfV1(demoCalendarV3()),
    bells: officialBells2026V1(),
    // The bells the system saved: the official sheets' day.
    bellsValidFrom: BELLS_VALID_FROM_V1,
    grid: [{ shift: 'vespertino', lessons: demoScheduleV3()[0]!.lessons }],
    months: answers.map(({ today: _today, year: _year, lastReadAt: _read, ...month }) => month),
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
  'over-limit': { label: 'Já passou do limite', tone: 'alert', text: 'Já faltou cerca de 52 dias. Pode reprovar por falta.' },
  'will-pass': { label: 'Vai passar do limite', tone: 'alert', text: 'Já faltou cerca de 43 dias. Faltando assim, pode reprovar por falta.' },
  'near-limit': { label: 'Perto do limite', tone: 'alert', text: 'Já faltou cerca de 35 dias. Mais faltas podem reprovar.' },
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
const demoScheduleV3 = () => [
  {
    label: 'TURMA ARTIFICIAL - VESPERTINO',
    // The school's official bells of the afternoon (sheets of 22/06): a class of the vespertino.
    bells: officialBells2026V1().vespertino,
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
      const timer = setTimeout(
        () =>
          resolve({
            classes: demoScheduleV3(),
            today: previewTodayV3(),
            now: previewNowV3(),
            daysOff: schoolDaysOffOfV1(demoCalendarV3()),
            schoolYear: schoolYearSpanOfV1(demoCalendarV3()),
          }),
        250,
      );
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      });
    }),
});

/*
 * The preview's Ocorrências (owner decisions 29/10/2026): invented records shaped like the Smecel's
 * (a suspension with its leave, one whose start the Smecel left blank, warnings, one "outras"), one
 * already confirmed. "Estou ciente" is kept in memory until the page is reloaded.
 */
const demoIncidentsV3 = (): StudentIncidentV1[] => [
  {
    id: 'demo-1', kind: 'ADVERTÊNCIA', date: '2026-09-29', leave: null,
    description: 'No dia 29/09/2026 o(a) aluno(a) foi advertido(a) conforme comunicação interna por usar o uniforme fora do padrão da escola, mesmo após orientação. Teve a perda de 0,10 ponto no seu cálculo, permanecendo no bom comportamento.',
    acknowledgedAt: null,
  },
  {
    id: 'demo-2', kind: 'SUSPENSÃO', date: '2026-10-22',
    leave: { from: '2026-10-22', to: '2026-10-28', days: 3 },
    description: 'No dia 22/10/2026 o(a) aluno(a) recebeu 3 dias de suspensão por desrespeito a um colega de classe, conforme o Regimento Interno. Teve a perda de 0,50 ponto no cálculo de classificação, permanecendo no bom comportamento.',
    acknowledgedAt: null,
  },
  {
    id: 'demo-3', kind: 'SUSPENSÃO', date: '2026-08-18',
    leave: { from: null, to: '2026-08-19', days: 1 },
    description: 'No dia 18/08/2026 o(a) aluno(a) recebeu 1 dia de suspensão por deixar a sala de aula sem autorização.',
    acknowledgedAt: null,
  },
  {
    id: 'demo-4', kind: 'OUTRAS', date: '2026-06-10', leave: null,
    description: 'O(A) aluno(a) foi comunicado(a) por trazer objeto não permitido para a escola. A família foi chamada para conversar com a coordenação.',
    acknowledgedAt: `2026-06-11T13:20:00Z`,
  },
  {
    id: 'demo-5', kind: 'ADVERTÊNCIA', date: '2026-04-27', leave: null,
    description: 'No dia 27/04/2026 o(a) aluno(a) foi advertido(a) por conversar durante a parada matinal, o que é fora do padrão.',
    acknowledgedAt: null,
  },
];

/** The preview's incidents "API". */
export const createDemoIncidentsClientV3 = (): StudentIncidentsClientV1 => {
  const incidents = demoIncidentsV3();
  return {
    read: (signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ incidents: structuredClone(incidents) }), 250);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      }),
    acknowledge: (id) =>
      new Promise((resolve) => {
        const acknowledgedAt = new Date().toISOString();
        const item = incidents.find((entry) => entry.id === id);
        if (item) item.acknowledgedAt = acknowledgedAt;
        setTimeout(() => resolve({ acknowledgedAt }), 300);
      }),
  };
};
