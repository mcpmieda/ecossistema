import { Fragment, useState } from 'react';
import { useTodayV3 } from './frequency-page-v3';

/*
 * Horário in a page of its own (owner decision 22/10/2026, preview only): the weekly grid of the
 * student's class as the Smecel has it, read by the collector from "Grade de horários". Only the
 * subject, exactly as the Smecel names it ("LINGUA PORTUGUESA", no accent added); never the
 * teacher; a free position ("VAGA") is a blank space. On a phone, one day at a time (today first);
 * on a computer, the whole week with today's column marked.
 *
 * MERGE (portal real): read GET /api/student/schedule (server/student-portal/composition/
 * schedule-v1.ts: { contractVersion: 1, state: 'ready', classes }) with loading, error and
 * expired-session (401 → sign in again) states, and show the page only when the self response
 * says `showSchedule === true` (the admin's "Horário" policy key; 403 otherwise).
 */
export type ScheduleLessonV3 = { weekday: number; slot: number; subject: string };
export type ScheduleClassV3 = {
  label: string;
  observedAt: string;
  lessons: readonly ScheduleLessonV3[];
};

const DAYS = [
  { weekday: 1, short: 'Seg', long: 'Segunda-feira' },
  { weekday: 2, short: 'Ter', long: 'Terça-feira' },
  { weekday: 3, short: 'Qua', long: 'Quarta-feira' },
  { weekday: 4, short: 'Qui', long: 'Quinta-feira' },
  { weekday: 5, short: 'Sex', long: 'Sexta-feira' },
] as const;

/** 0 (Sunday) to 6 (Saturday), for a YYYY-MM-DD date. */
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
/** The positions a class's grid has: up to its last lesson of the week, so a free one shows blank. */
const positionsOf = (lessons: readonly ScheduleLessonV3[]) =>
  Array.from(
    { length: Math.max(0, ...lessons.map((lesson) => lesson.slot)) },
    (_, index) => index + 1,
  );
/** The name as the Smecel has it; a long one may break after a "/" (INFORMATICA/COMPUTACAO), not mid-word. */
const subjectText = (subject: string) =>
  subject.split('/').map((part, index) => (
    <Fragment key={index}>
      {index ? (
        <>
          /<wbr />
        </>
      ) : null}
      {part}
    </Fragment>
  ));
const subjectAt = (lessons: readonly ScheduleLessonV3[], weekday: number, slot: number) =>
  lessons.find((lesson) => lesson.weekday === weekday && lesson.slot === slot)?.subject ?? null;

export function SchedulePageV3({ classes }: { classes: readonly ScheduleClassV3[] }) {
  const today = useTodayV3();
  const todayWeekday = weekdayOf(today);
  const schoolDay = todayWeekday >= 1 && todayWeekday <= 5;
  // Today first; on a weekend, Monday (the next school day). A day the reader picks stays.
  const [picked, setPicked] = useState<number | null>(null);
  const shown = picked ?? (schoolDay ? todayWeekday : 1);
  const shownDay = DAYS[shown - 1]!;
  const latest = classes
    .map((item) => item.observedAt)
    .sort()
    .at(-1);

  return (
    <section className="pa3-schedule" aria-labelledby="pa3-schedule-title">
      <h1 id="pa3-schedule-title" className="pa3-page-title" tabIndex={-1}>
        Horário
      </h1>

      {classes.length === 0 ? (
        <div className="pa3-card">
          <p className="pa3-schedule-empty">O horário da turma ainda não foi lido do Smecel.</p>
        </div>
      ) : (
        <>
          {/* Phone: the day's lessons, one day at a time. */}
          <div className="pa3-week-chips" role="group" aria-label="Dia da semana">
            {DAYS.map((day) => (
              <button
                key={day.weekday}
                type="button"
                className={
                  'pa3-week-chip' + (schoolDay && day.weekday === todayWeekday ? ' is-today' : '')
                }
                aria-pressed={day.weekday === shown}
                aria-label={day.long + (schoolDay && day.weekday === todayWeekday ? ' (hoje)' : '')}
                onClick={() => setPicked(day.weekday)}
              >
                <span>{day.short}</span>
                {schoolDay && day.weekday === todayWeekday ? (
                  <span className="pa3-week-chip-today">hoje</span>
                ) : null}
              </button>
            ))}
          </div>

          {classes.map((item) => {
            const positions = positionsOf(item.lessons);
            return (
              <div key={item.label} className="pa3-card pa3-schedule-card">
                {/* The class's name only when the student has more than one (regular + integral, AEE). */}
                {classes.length > 1 ? <p className="pa3-schedule-class">{item.label}</p> : null}

                <div className="pa3-schedule-day">
                  <h2 aria-live="polite">
                    {schoolDay && shown === todayWeekday
                      ? `Hoje, ${shownDay.long.toLowerCase()}`
                      : shownDay.long}
                  </h2>
                  <ol className="pa3-schedule-list">
                    {positions.map((slot) => {
                      const subject = subjectAt(item.lessons, shown, slot);
                      return (
                        <li key={slot} className={'pa3-schedule-row' + (subject ? '' : ' is-free')}>
                          <span className="pa3-schedule-slot" aria-hidden="true">
                            {slot}ª
                          </span>
                          {/* A free position is a blank space; a screen reader hears "6ª aula: sem aula". */}
                          <span className="pa3-schedule-subject">
                            <span className="pa-visually-hidden">{`${slot}ª aula: `}</span>
                            {subject ? (
                              subjectText(subject)
                            ) : (
                              <span className="pa-visually-hidden">sem aula</span>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </div>

                {/* Computer: the whole week, today's column marked. */}
                <table className="pa3-schedule-week">
                  <caption className="pa-visually-hidden">
                    Horário da semana{classes.length > 1 ? `, ${item.label}` : ''}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">
                        <span className="pa-visually-hidden">Aula</span>
                      </th>
                      {DAYS.map((day) => (
                        <th
                          key={day.weekday}
                          scope="col"
                          className={
                            schoolDay && day.weekday === todayWeekday ? 'is-today' : undefined
                          }
                        >
                          {day.long.replace('-feira', '')}
                          {schoolDay && day.weekday === todayWeekday ? (
                            <span className="pa3-week-chip-today">hoje</span>
                          ) : null}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((slot) => (
                      <tr key={slot}>
                        <th scope="row">{slot}ª</th>
                        {DAYS.map((day) => {
                          const subject = subjectAt(item.lessons, day.weekday, slot);
                          return (
                            <td
                              key={day.weekday}
                              className={
                                (schoolDay && day.weekday === todayWeekday ? 'is-today' : '') +
                                (subject ? '' : ' is-free')
                              }
                            >
                              {subject ? (
                                subjectText(subject)
                              ) : (
                                <span className="pa-visually-hidden">sem aula</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}

          {latest ? (
            <p className="pa3-footnote">
              Conforme o Smecel · lido em{' '}
              {new Date(latest).toLocaleString('pt-BR', {
                dateStyle: 'short',
                timeStyle: 'short',
                timeZone: 'America/Bahia',
              })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
