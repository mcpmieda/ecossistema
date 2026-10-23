import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { CalendarOff, Coffee } from 'lucide-react';
import {
  bellLessonV1,
  bellMinutesV1,
  bellMomentV1,
  type BellDayV1,
  type BellItemV1,
} from '../../../../shared/student-portal-contracts/school-bells-v1';
import {
  schoolDayOffLabelV1,
  type SchoolDayOffV1,
} from '../../../../shared/student-portal-contracts/school-calendar-v1';
import type { StudentScheduleClientV1 } from '../schedule/client-v1';
import { portalNowV1, PortalTimerV1, syncPortalClockV1 } from '../shell/portal-notices-v1';
import { usePortalPageActiveV3 } from './portal-pages-v3';
import { useCachedReadV3 } from './use-cached-read-v3';

/*
 * Horário in a page of its own (owner decisions 22–23/10/2026, preview only): the weekly grid of the
 * student's class as the Smecel has it, read by the collector from "Grade de horários". Only the
 * subject, exactly as the Smecel names it ("LINGUA PORTUGUESA", no accent added); never the
 * teacher; a free position ("VAGA") is a blank space.
 *
 * With the times marked in the ADM (Políticas → Horário), each lesson shows its time and the break
 * sits in its place; a day shows its lessons only (no 6th position on a day without a 6th lesson).
 * On top, the lesson going on now with a short clock to the break, the next lesson or the end of the
 * day, on the server's clock; on a day without school (ADM calendar), why there is none. On a phone,
 * one day at a time (today first); on a computer, the whole week side by side.
 *
 * Data: GET /api/student/schedule (createStudentScheduleClientV1), read with the sign-in and kept
 * (useCachedReadV3); shown only when the self response says `showSchedule === true`.
 */
export type ScheduleLessonV3 = { weekday: number; slot: number; subject: string };
export type ScheduleClassV3 = {
  label: string;
  observedAt: string;
  lessons: readonly ScheduleLessonV3[];
  /** The times of this class's shift, Monday (1) to Friday (5); null or absent: no times marked. */
  bells?: Readonly<Record<1 | 2 | 3 | 4 | 5, BellDayV1>> | null;
};

const DAYS = [
  { weekday: 1, short: 'Seg', long: 'Segunda-feira' },
  { weekday: 2, short: 'Ter', long: 'Terça-feira' },
  { weekday: 3, short: 'Qua', long: 'Quarta-feira' },
  { weekday: 4, short: 'Qui', long: 'Quinta-feira' },
  { weekday: 5, short: 'Sex', long: 'Sexta-feira' },
] as const;
type WeekdayV3 = (typeof DAYS)[number]['weekday'];

const SCHOOL_TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Bahia',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
/** The school's date and the seconds since its midnight, at a moment (server clock). */
function schoolClockAt(at: number) {
  const parts = SCHOOL_TIME.formatToParts(new Date(at));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '00';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    seconds: Number(part('hour')) * 3600 + Number(part('minute')) * 60 + Number(part('second')),
  };
}
/** The school's clock, a tick a second (only while something on screen counts). */
function useSchoolClockV3(ticking: boolean) {
  const [now, setNow] = useState(() => schoolClockAt(portalNowV1()));
  useEffect(() => {
    setNow(schoolClockAt(portalNowV1()));
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(schoolClockAt(portalNowV1())), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

/** 0 (Sunday) to 6 (Saturday), for a YYYY-MM-DD date. */
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
/** The date of a weekday in the week shown: this week, or the next one from Saturday on. */
const dateOfWeekday = (today: string, weekday: number) => {
  const todayWeekday = weekdayOf(today);
  const monday = Date.parse(`${today}T12:00:00Z`) + (todayWeekday === 6 ? 2 : todayWeekday === 0 ? 1 : 1 - todayWeekday) * 86_400_000;
  return new Date(monday + (weekday - 1) * 86_400_000).toISOString().slice(0, 10);
};
const shortDate = (date: string) => `${date.slice(8)}/${date.slice(5, 7)}`;
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
const timeText = (item: { start: string; end: string }) => `${item.start} – ${item.end}`;

type RowV3 =
  | { kind: 'aula'; slot: number; subject: string | null; time: { start: string; end: string } | null }
  | { kind: 'intervalo'; start: string; end: string };
/**
 * A day's rows: its positions up to its own last lesson (owner request 23/10/2026: no 6th on a day
 * without one), each with its time, and the break before the first lesson that starts after it.
 */
function rowsOf(item: ScheduleClassV3, weekday: WeekdayV3): RowV3[] {
  const last = Math.max(0, ...item.lessons.filter((lesson) => lesson.weekday === weekday).map((lesson) => lesson.slot));
  const bells = item.bells?.[weekday] ?? null;
  const pause = bells?.find((bell) => bell.kind === 'intervalo') ?? null;
  const rows: RowV3[] = [];
  let paused = false;
  for (let slot = 1; slot <= last; slot += 1) {
    const time = bellLessonV1(bells, slot);
    if (pause && !paused && time && bellMinutesV1(time.start) >= bellMinutesV1(pause.end)) {
      rows.push({ kind: 'intervalo', start: pause.start, end: pause.end });
      paused = true;
    }
    rows.push({ kind: 'aula', slot, subject: subjectAt(item.lessons, weekday, slot), time: time ? { start: time.start, end: time.end } : null });
  }
  return rows;
}

export function SchedulePageV3({
  client,
  onLogin,
  onAuthenticationLost,
}: {
  client: StudentScheduleClientV1;
  onLogin?: () => void;
  onAuthenticationLost?: () => void;
}) {
  const read = useCallback(
    async (signal: AbortSignal) => {
      const value = await client.read(signal);
      // "Agora" and its clock run on the database's time, never on a phone set wrong.
      syncPortalClockV1(value.now);
      return value;
    },
    [client],
  );
  // Read with the sign-in and kept (read again only when opened after ten minutes).
  const active = usePortalPageActiveV3();
  const load = useCachedReadV3(read, active, onAuthenticationLost);
  if (load.data) return <ScheduleWeekV3 classes={load.data.classes} daysOff={load.data.daysOff} ticking={active} />;
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

/** One day's lessons as a list: time, subject, the break in its place, the lesson going on now. */
function DayListV3({
  rows,
  now,
  label,
}: {
  rows: readonly RowV3[];
  /** Seconds since the school's midnight when this day is today, else null. */
  now: number | null;
  label: string;
}) {
  const minute = now === null ? null : now / 60;
  const isNow = (item: { start: string; end: string } | null) =>
    !!item && minute !== null && minute >= bellMinutesV1(item.start) && minute < bellMinutesV1(item.end);
  return (
    <ol className="pa3-schedule-list" aria-label={label}>
      {rows.map((row) =>
        row.kind === 'intervalo' ? (
          <li key="intervalo" className={'pa3-schedule-row pa3-schedule-break' + (isNow(row) ? ' is-now' : '')}>
            <span className="pa3-schedule-slot" aria-hidden="true">
              <Coffee size={15} />
            </span>
            <span className="pa3-schedule-subject">Intervalo</span>
            <span className="pa3-schedule-time">{timeText(row)}</span>
          </li>
        ) : (
          <li
            key={row.slot}
            className={'pa3-schedule-row' + (row.subject ? '' : ' is-free') + (isNow(row.time) ? ' is-now' : '')}
            aria-current={isNow(row.time) ? 'time' : undefined}
          >
            <span className="pa3-schedule-slot" aria-hidden="true">
              {row.slot}ª
            </span>
            {/* A free position is a blank space; a screen reader hears "6ª aula: sem aula". */}
            <span className="pa3-schedule-subject">
              <span className="pa-visually-hidden">{`${row.slot}ª aula: `}</span>
              {row.subject ? subjectText(row.subject) : <span className="pa-visually-hidden">sem aula</span>}
            </span>
            {row.time ? <span className="pa3-schedule-time">{timeText(row.time)}</span> : null}
          </li>
        ),
      )}
    </ol>
  );
}

/** Why a date has no school, as the ADM calendar says ("Feriado · Finados"). */
function DayOffV3({ day, today }: { day: SchoolDayOffV1; today: boolean }) {
  return (
    <div className="pa3-schedule-off" role="note">
      <CalendarOff size={18} aria-hidden="true" />
      <p>
        <b>{today ? 'Sem aula hoje' : `Sem aula em ${shortDate(day.date)}`}</b>
        <span>{schoolDayOffLabelV1(day)}</span>
      </p>
    </div>
  );
}

const itemName = (item: BellItemV1, subject: string | null) =>
  item.kind === 'intervalo' ? 'Intervalo' : `${item.slot}ª aula${subject ? ` · ${subject}` : ''}`;
/**
 * Today, now (owner decision 23/10/2026): the lesson going on and a short clock to what comes next
 * ("Intervalo em", "Saída em"), then what follows. Before the first lesson, when it starts; after the
 * last one, nothing.
 */
function NowCardV3({ item, bells, weekday, seconds, named }: {
  item: ScheduleClassV3;
  bells: BellDayV1;
  weekday: WeekdayV3;
  seconds: number;
  named: boolean;
}) {
  // Only the day's own lessons: a position past its last lesson is not "next".
  const shown = rowsOf(item, weekday);
  const lastSlot = Math.max(0, ...shown.flatMap((row) => (row.kind === 'aula' ? [row.slot] : [])));
  if (!lastSlot) return null;
  const day = bells.filter((bell) => bell.kind === 'intervalo' || bell.slot <= lastSlot);
  const moment = bellMomentV1(day, seconds / 60);
  if (moment.state === 'over') return null;
  const subjectOf = (bell: BellItemV1 | null) => (bell?.kind === 'aula' ? subjectAt(item.lessons, weekday, bell.slot) : null);
  const until = (time: string) => bellMinutesV1(time) * 60 - seconds;
  const [title, clockLabel, target, after] =
    moment.state === 'in'
      ? [
          `Agora: ${itemName(moment.current, subjectOf(moment.current))}`,
          moment.current.kind === 'intervalo'
            ? 'Volta em'
            : moment.next?.kind === 'intervalo'
              ? 'Intervalo em'
              : moment.next
                ? 'Próxima aula em'
                : 'Saída em',
          moment.current.end,
          moment.next ? (moment.next.kind === 'intervalo' ? day[day.indexOf(moment.next) + 1] ?? null : moment.next) : null,
        ]
      : [
          moment.state === 'before'
            ? `Hoje as aulas começam às ${moment.next.start}`
            : `Próxima: ${itemName(moment.next, subjectOf(moment.next))}`,
          'Começa em',
          moment.next.start,
          moment.state === 'before' ? moment.next : null,
        ];
  return (
    <div className="pa3-card pa3-now" role="status" aria-live="off">
      {named ? <p className="pa3-schedule-class">{item.label}</p> : null}
      <div className="pa3-now-head">
        <p className="pa3-now-title">{title}</p>
        {moment.state === 'in' ? <p className="pa3-now-until">até {moment.current.end}</p> : null}
      </div>
      <div className="pa3-now-clock pa-countdown">
        <span className="pa3-now-label">{clockLabel}</span>
        <PortalTimerV1 seconds={until(target)} label={clockLabel} />
      </div>
      {after ? (
        <p className="pa3-now-after">
          {moment.state === 'before'
            ? `Primeira: ${itemName(after, subjectOf(after))}`
            : `Depois: ${itemName(after, subjectOf(after))} · ${after.start}`}
        </p>
      ) : null}
    </div>
  );
}

/** The week as read; `classes` null while it has not come yet (then `status` says why). */
export function ScheduleWeekV3({
  classes,
  daysOff = [],
  status,
  ticking = true,
}: {
  classes: readonly ScheduleClassV3[] | null;
  /** The weekdays without school the ADM calendar names, with their description. */
  daysOff?: readonly SchoolDayOffV1[];
  status?: ReactNode;
  /** The page is on screen: "Agora" counts every second (nothing while hidden). */
  ticking?: boolean;
}) {
  const hasBells = !!classes?.some((item) => item.bells);
  const clock = useSchoolClockV3(ticking && hasBells);
  const today = clock.date;
  const todayWeekday = weekdayOf(today);
  const schoolDay = todayWeekday >= 1 && todayWeekday <= 5;
  // Today first; on a weekend, Monday (the next school day). A day the reader picks stays.
  const [picked, setPicked] = useState<number | null>(null);
  const shown = (picked ?? (schoolDay ? todayWeekday : 1)) as WeekdayV3;
  const shownDay = DAYS[shown - 1]!;
  const offAt = (weekday: number) => daysOff.find((day) => day.date === dateOfWeekday(today, weekday)) ?? null;
  const todayOff = schoolDay ? offAt(todayWeekday) : null;
  const isToday = (weekday: number) => schoolDay && weekday === todayWeekday;
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
          {/* Today without school: why (ADM calendar). Otherwise the lesson going on now. */}
          {todayOff ? (
            <div className="pa3-card">
              <DayOffV3 day={todayOff} today />
            </div>
          ) : schoolDay ? (
            classes.map((item) =>
              item.bells ? (
                <NowCardV3
                  key={'now' + item.label}
                  item={item}
                  bells={item.bells[todayWeekday as WeekdayV3]}
                  weekday={todayWeekday as WeekdayV3}
                  seconds={clock.seconds}
                  named={classes.length > 1}
                />
              ) : null,
            )
          ) : null}

          {/* Phone: the day's lessons, one day at a time. */}
          <div className="pa3-week-chips" role="group" aria-label="Dia da semana">
            {DAYS.map((day) => (
              <button
                key={day.weekday}
                type="button"
                className={
                  'pa3-week-chip' + (isToday(day.weekday) ? ' is-today' : '') + (offAt(day.weekday) ? ' is-off' : '')
                }
                aria-pressed={day.weekday === shown}
                aria-label={
                  day.long + (isToday(day.weekday) ? ' (hoje)' : '') + (offAt(day.weekday) ? ', sem aula' : '')
                }
                onClick={() => setPicked(day.weekday)}
              >
                <span>{day.short}</span>
                {isToday(day.weekday) ? (
                  <span className="pa3-week-chip-today">hoje</span>
                ) : offAt(day.weekday) ? (
                  <span className="pa3-week-chip-today">sem aula</span>
                ) : null}
              </button>
            ))}
          </div>

          {classes.map((item) => {
            const off = offAt(shown);
            return (
              <div key={item.label} className="pa3-card pa3-schedule-card">
                {/* The class's name only when the student has more than one (regular + integral, AEE). */}
                {classes.length > 1 ? <p className="pa3-schedule-class">{item.label}</p> : null}

                <div className="pa3-schedule-day">
                  <h3 aria-live="polite">
                    {isToday(shown) ? `Hoje, ${shownDay.long.toLowerCase()}` : shownDay.long}
                  </h3>
                  {off ? (
                    <DayOffV3 day={off} today={isToday(shown)} />
                  ) : (
                    <DayListV3
                      rows={rowsOf(item, shown)}
                      now={isToday(shown) ? clock.seconds : null}
                      label={`Aulas de ${shownDay.long.toLowerCase()}`}
                    />
                  )}
                </div>

                {/* Computer: the whole week side by side, today's column marked (a break may sit
                    after a different lesson each day, so each day is its own column). */}
                <div className="pa3-schedule-week" aria-label={`Horário da semana${classes.length > 1 ? `, ${item.label}` : ''}`} role="group">
                  {DAYS.map((day) => {
                    const dayOff = offAt(day.weekday);
                    return (
                      <div key={day.weekday} className={'pa3-schedule-column' + (isToday(day.weekday) ? ' is-today' : '')}>
                        <h3>
                          {day.long.replace('-feira', '')}
                          {isToday(day.weekday) ? <span className="pa3-week-chip-today">hoje</span> : null}
                        </h3>
                        {dayOff ? (
                          <DayOffV3 day={dayOff} today={isToday(day.weekday)} />
                        ) : (
                          <DayListV3
                            rows={rowsOf(item, day.weekday)}
                            now={isToday(day.weekday) ? clock.seconds : null}
                            label={`Aulas de ${day.long.toLowerCase()}`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* When the class's grid was last read (owner request 23/10/2026: without "Conforme o Smecel"). */}
          {latest ? (
            <p className="pa3-footnote">
              Atualizado em{' '}
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
