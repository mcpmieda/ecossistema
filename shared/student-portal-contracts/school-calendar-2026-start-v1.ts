import type { SchoolCalendarDayV1, SchoolDayKindV1 } from './school-calendar-v1';

/*
 * The official "Calendário Escolar — Ano Letivo 2026" of the Secretaria Municipal de Educação de
 * Medeiros Neto (owner decision 22/10/2026: "seguir esse à risca"), 200 school days. The ADM starts
 * from it; from then on the ADM is the only source. Per month: Feb 6, Mar 23, Apr 20, May 21,
 * Jun 22, Jul 13, Aug 22, Sep 22, Oct 20, Nov 20, Dec 11. Trimesters: 23/02–15/05, 18/05–31/08,
 * 01/09–15/12; recovery studies 16–22/12. (The Smecel's own calendar had six more Saturdays: 18/04,
 * 09/05, 16/05, 27/06, 04/07 and 18/07, which are not school days.)
 */
const MARKED: readonly [date: string, kind: SchoolDayKindV1, note?: string][] = [
  ['2026-02-02', 'evento', 'Escolas abertas / matrículas'],
  ['2026-02-03', 'evento', 'Escolas abertas / matrículas'],
  ['2026-02-04', 'evento', 'Escolas abertas / matrículas'],
  ['2026-02-05', 'evento', 'Escolas abertas / matrículas'],
  ['2026-02-06', 'evento', 'Escolas abertas / matrículas'],
  ['2026-02-09', 'evento', 'Jornada pedagógica'],
  ['2026-02-10', 'evento', 'Jornada pedagógica'],
  ['2026-02-11', 'evento', 'Jornada pedagógica'],
  ['2026-02-12', 'evento', 'Jornada pedagógica'],
  ['2026-02-13', 'evento', 'Escola aberta / matrículas'],
  ['2026-02-16', 'feriado', 'Carnaval / Cinzas'],
  ['2026-02-17', 'feriado', 'Carnaval / Cinzas'],
  ['2026-02-18', 'feriado', 'Carnaval / Cinzas'],
  ['2026-02-19', 'feriado', 'Carnaval / Cinzas'],
  ['2026-02-20', 'feriado', 'Carnaval / Cinzas'],
  ['2026-02-23', 'evento-letivo', 'Início do ano letivo'],
  ['2026-02-28', 'sabado-letivo'],
  ['2026-03-21', 'sabado-letivo'],
  ['2026-04-02', 'recesso', 'Ponto facultativo'],
  ['2026-04-03', 'feriado', 'Paixão de Cristo'],
  ['2026-04-21', 'feriado', 'Tiradentes'],
  ['2026-04-25', 'sabado-letivo'],
  ['2026-05-01', 'feriado', 'Dia do Trabalhador'],
  ['2026-05-23', 'sabado-letivo'],
  ['2026-06-04', 'feriado', 'Corpus Christi'],
  ['2026-06-05', 'recesso', 'Ponto facultativo'],
  ['2026-06-13', 'sabado-letivo'],
  ['2026-06-20', 'sabado-letivo'],
  ['2026-07-02', 'feriado', 'Independência da Bahia'],
  ['2026-07-11', 'sabado-letivo'],
  ['2026-07-20', 'recesso', 'Férias / recesso escolar'],
  ['2026-07-21', 'recesso', 'Férias / recesso escolar'],
  ['2026-07-22', 'recesso', 'Férias / recesso escolar'],
  ['2026-07-23', 'recesso', 'Férias / recesso escolar'],
  ['2026-07-24', 'recesso', 'Férias / recesso escolar'],
  ['2026-07-27', 'recesso', 'Férias / recesso escolar'],
  ['2026-07-28', 'recesso', 'Férias / recesso escolar'],
  ['2026-07-29', 'recesso', 'Férias / recesso escolar'],
  ['2026-07-30', 'recesso', 'Férias / recesso escolar'],
  ['2026-07-31', 'recesso', 'Férias / recesso escolar'],
  ['2026-08-14', 'evento-letivo', 'Show de talentos'],
  ['2026-08-15', 'sabado-letivo'],
  ['2026-09-04', 'evento-letivo', 'Jogos da Independência'],
  ['2026-09-07', 'feriado', 'Independência do Brasil'],
  ['2026-09-12', 'sabado-letivo'],
  ['2026-10-12', 'feriado', 'Nossa Senhora Aparecida'],
  ['2026-10-13', 'feriado', 'Antecipação do dia 15'],
  ['2026-10-14', 'feriado', 'Antecipação do dia 28'],
  ['2026-10-24', 'sabado-letivo'],
  ['2026-11-02', 'feriado', 'Finados'],
  ['2026-11-14', 'sabado-letivo'],
  ['2026-11-20', 'feriado', 'Consciência Negra'],
  ['2026-12-05', 'sabado-letivo'],
  ['2026-12-08', 'feriado', 'Padroeiro da cidade'],
  ['2026-12-16', 'evento', 'Estudos e avaliações de recuperação'],
  ['2026-12-17', 'evento', 'Estudos e avaliações de recuperação'],
  ['2026-12-18', 'evento', 'Estudos e avaliações de recuperação'],
  ['2026-12-21', 'evento', 'Estudos e avaliações de recuperação'],
  ['2026-12-22', 'evento', 'Estudos e avaliações de recuperação'],
];
/** Every other weekday from the second school day to the last one is a plain school day. */
const FIRST_PLAIN_DAY = '2026-02-24';
const LAST_SCHOOL_DAY = '2026-12-15';

const weekdaysBetween = (from: string, to: string) => {
  const dates: string[] = [];
  for (let at = Date.parse(`${from}T12:00:00Z`); ; at += 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10);
    if (date > to) break;
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(date);
  }
  return dates;
};

export function officialCalendar2026V1(): SchoolCalendarDayV1[] {
  const marked = new Map<string, SchoolCalendarDayV1>(
    MARKED.map(([date, kind, note]) => [date, { date, kind, ...(note ? { note } : {}) }]),
  );
  // 01 a 31/01: férias coletivas (the weekdays, as the official calendar colours them).
  for (const date of weekdaysBetween('2026-01-01', '2026-01-31'))
    marked.set(date, { date, kind: 'recesso', note: 'Férias coletivas' });
  for (const date of weekdaysBetween(FIRST_PLAIN_DAY, LAST_SCHOOL_DAY))
    if (!marked.has(date)) marked.set(date, { date, kind: 'letivo' });
  return [...marked.values()].sort((left, right) => left.date.localeCompare(right.date));
}
