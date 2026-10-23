import type { SchoolCalendarDayV1, SchoolDayKindV1 } from './school-calendar-v1';

/*
 * A starting point for 2026 (owner decision 22/10/2026): the Smecel "Calendário escolar 2026"
 * (Padrão 2026) as it was on 22/10/2026, offered once in the ADM's empty calendar ("Começar com o
 * calendário do Smecel") so nobody types the year by hand. From then on the ADM is the only source.
 * The Smecel counts 206 school days; the school's rule is 200, so the ADM shows the difference.
 */
const MARKED: readonly [date: string, kind: SchoolDayKindV1, note?: string][] = [
  ['2026-02-02', 'evento', 'Matrículas (escola aberta)'],
  ['2026-02-03', 'evento', 'Matrículas (escola aberta)'],
  ['2026-02-04', 'evento', 'Matrículas (escola aberta)'],
  ['2026-02-05', 'evento', 'Matrículas (escola aberta)'],
  ['2026-02-06', 'evento', 'Matrículas (escola aberta)'],
  ['2026-02-09', 'evento', 'Jornada pedagógica'],
  ['2026-02-10', 'evento', 'Jornada pedagógica'],
  ['2026-02-11', 'evento', 'Jornada pedagógica'],
  ['2026-02-12', 'evento', 'Jornada pedagógica'],
  ['2026-02-13', 'evento', 'Matrículas (escola aberta)'],
  ['2026-02-16', 'recesso', 'Recesso de Carnaval'],
  ['2026-02-17', 'recesso', 'Recesso de Carnaval'],
  ['2026-02-18', 'recesso', 'Recesso de Carnaval'],
  ['2026-02-19', 'recesso', 'Recesso de Carnaval'],
  ['2026-02-20', 'recesso', 'Recesso de Carnaval'],
  ['2026-02-23', 'evento-letivo', 'Início do ano letivo'],
  ['2026-02-28', 'sabado-letivo'],
  ['2026-03-21', 'sabado-letivo'],
  ['2026-04-02', 'recesso', 'Ponto facultativo'],
  ['2026-04-03', 'feriado', 'Paixão de Cristo'],
  ['2026-04-18', 'sabado-letivo'],
  ['2026-04-21', 'feriado', 'Tiradentes'],
  ['2026-04-25', 'sabado-letivo'],
  ['2026-05-01', 'feriado', 'Dia do Trabalhador'],
  ['2026-05-09', 'sabado-letivo'],
  ['2026-05-16', 'sabado-letivo'],
  ['2026-05-23', 'sabado-letivo'],
  ['2026-06-04', 'feriado', 'Corpus Christi'],
  ['2026-06-05', 'recesso', 'Ponto facultativo'],
  ['2026-06-13', 'sabado-letivo'],
  ['2026-06-20', 'sabado-letivo'],
  ['2026-06-27', 'sabado-letivo'],
  ['2026-07-02', 'feriado', 'Independência da Bahia'],
  ['2026-07-04', 'sabado-letivo'],
  ['2026-07-11', 'sabado-letivo'],
  ['2026-07-18', 'sabado-letivo'],
  ['2026-07-20', 'recesso', 'Recesso junino'],
  ['2026-07-21', 'recesso', 'Recesso junino'],
  ['2026-07-22', 'recesso', 'Recesso junino'],
  ['2026-07-23', 'recesso', 'Recesso junino'],
  ['2026-07-24', 'recesso', 'Recesso junino'],
  ['2026-07-27', 'recesso', 'Recesso junino'],
  ['2026-07-28', 'recesso', 'Recesso junino'],
  ['2026-07-29', 'recesso', 'Recesso junino'],
  ['2026-07-30', 'recesso', 'Recesso junino'],
  ['2026-07-31', 'recesso', 'Recesso junino'],
  ['2026-08-14', 'evento-letivo', 'Show de talentos'],
  ['2026-08-15', 'sabado-letivo'],
  ['2026-09-04', 'evento-letivo', 'Jogos da Independência'],
  ['2026-09-07', 'feriado', 'Independência do Brasil'],
  ['2026-09-12', 'sabado-letivo'],
  ['2026-10-12', 'feriado', 'Nossa Senhora Aparecida'],
  ['2026-10-13', 'feriado', 'Feriado antecipado (15/10)'],
  ['2026-10-14', 'feriado', 'Feriado antecipado (28/10)'],
  ['2026-10-24', 'sabado-letivo'],
  ['2026-11-02', 'feriado', 'Finados'],
  ['2026-11-14', 'sabado-letivo'],
  ['2026-11-20', 'feriado', 'Consciência Negra'],
  ['2026-12-05', 'sabado-letivo'],
  ['2026-12-08', 'feriado', 'Padroeiro da cidade'],
  ['2026-12-16', 'evento', 'Estudos e avaliação de recuperação'],
  ['2026-12-17', 'evento', 'Estudos e avaliação de recuperação'],
  ['2026-12-18', 'evento', 'Estudos e avaliação de recuperação'],
  ['2026-12-21', 'evento', 'Estudos e avaliação de recuperação'],
  ['2026-12-22', 'evento', 'Estudos e avaliação de recuperação'],
];
/** Every other weekday from the second school day to the last one is a plain school day. */
const FIRST_PLAIN_DAY = '2026-02-24';
const LAST_SCHOOL_DAY = '2026-12-15';

export function smecelCalendar2026V1(): SchoolCalendarDayV1[] {
  const marked = new Map(MARKED.map(([date, kind, note]) => [date, { date, kind, ...(note ? { note } : {}) }]));
  const days: SchoolCalendarDayV1[] = [...marked.values()];
  for (let at = Date.parse(`${FIRST_PLAIN_DAY}T12:00:00Z`); ; at += 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10);
    if (date > LAST_SCHOOL_DAY) break;
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !marked.has(date)) days.push({ date, kind: 'letivo' });
  }
  return days.sort((left, right) => left.date.localeCompare(right.date));
}
