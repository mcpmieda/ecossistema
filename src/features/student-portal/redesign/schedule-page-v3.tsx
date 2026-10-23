import { Fragment, useCallback, useState, type ReactNode } from 'react';
import type { StudentScheduleClientV1 } from '../schedule/client-v1';
import { usePortalPageActiveV3 } from './portal-pages-v3';
import { useCachedReadV3 } from './use-cached-read-v3';
import { useTodayV3 } from './frequency-page-v3';

/*
 * Horário in a page of its own (owner decision 22/10/2026, preview only): the weekly grid of the
 * student's class as the Smecel has it, read by the collector from "Grade de horários". Only the
 * subject, exactly as the Smecel names it ("LINGUA PORTUGUESA", no accent added); never the
 * teacher; a free position ("VAGA") is a blank space. On a phone, one day at a time (today first);
 * on a computer, the whole week with today's column marked.
 *
 * Data: GET /api/student/schedule (createStudentScheduleClientV1), read with the sign-in and
 * kept (useCachedReadV3); shown only when the self response says `showSchedule === true` (the admin's
 * "Horário" policy key; the API answers 403 otherwise).
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

export function SchedulePageV3({
  client,
  onLogin,
  onAuthenticationLost,
}: {
  client: StudentScheduleClientV1;
  onLogin?: () => void;
  onAuthenticationLost?: () => void;
}) {
  const read = useCallback((signal: AbortSignal) => client.read(signal), [client]);
  // Read with the sign-in and kept (read again only when opened after ten minutes).
  const load = useCachedReadV3(read, usePortalPageActiveV3(), onAuthenticationLost);
  const classes = load.data;
  if (classes) return <ScheduleWeekV3 classes={classes} />;
  const [message, action]: [string, [string, () => void] | null] = !load.error
    ? ['Carregando horário…', null]
    : load.error === 'unauthenticated'
      ? ['Sua sessão expirou. Entre novamente para ver o horário.', onLogin ? ['Entrar', onLogin] : null]
      : load.error === 'forbidden'
        ? ['O horário não está disponível no momento.', null]
        : ['Não foi possível carregar o horário agora. Vamos tentar de novo em instantes.', ['Tentar agora', load.retry]];
  return (
    <ScheduleWeekV3
      classes={null}
      status={
        <div className="pa3-card pa3-status" role={load.error ? 'alert' : undefined}>
          {load.error ? <p>{message}</p> : <output>{message}</output>}
          {action ? (
            <button type="button" className="pa3-status-action" onClick={action[1]}>
              {action[0]}
            </button>
          ) : null}
        </div>
      }
    />
  );
}

/** The week as read; `classes` null while it has not come yet (then `status` says why). */
export function ScheduleWeekV3({
  classes,
  status,
}: {
  classes: readonly ScheduleClassV3[] | null;
  status?: ReactNode;
}) {
  const today = useTodayV3();
  const todayWeekday = weekdayOf(today);
  const schoolDay = todayWeekday >= 1 && todayWeekday <= 5;
  // Today first; on a weekend, Monday (the next school day). A day the reader picks stays.
  const [picked, setPicked] = useState<number | null>(null);
  const shown = picked ?? (schoolDay ? todayWeekday : 1);
  const shownDay = DAYS[shown - 1]!;
  const latest = (classes ?? [])
    .map((item) => item.observedAt)
    .sort()
    .at(-1);

  return (
    <section className="pa3-schedule" aria-labelledby="pa3-schedule-title">
      <h2 id="pa3-schedule-title" className="pa3-page-title" tabIndex={-1}>
        Horário
      </h2>

      {classes === null ? (
        status
      ) : classes.length === 0 ? (
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
                  <h3 aria-live="polite">
                    {schoolDay && shown === todayWeekday
                      ? `Hoje, ${shownDay.long.toLowerCase()}`
                      : shownDay.long}
                  </h3>
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
