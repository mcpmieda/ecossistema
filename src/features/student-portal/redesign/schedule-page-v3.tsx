import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent,
} from 'react';
import { CalendarOff, Flag } from 'lucide-react';
import { Alert } from '@heroui/react/alert';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Chip } from '@heroui/react/chip';
import { ProgressBar } from '@heroui/react/progress-bar';
import { Spinner } from '@heroui/react/spinner';
import { ToggleButton } from '@heroui/react/toggle-button';
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
import { subjectStyleV3 } from './subject-style-v3';
import { officialSubjectV1 } from '../../../../shared/student-portal-contracts/official-subjects-v1';

/*
 * Horário in a page of its own (owner decisions 22–23/10/2026, preview only): the weekly grid of the
 * student's class as the Smecel has it, read by the collector from "Grade de horários". Only the
 * subject, by its official name (the Notas' "PORTUGUÊS" for the Smecel's "LINGUA PORTUGUESA",
 * official-subjects-v1), with its own colour and icon; never the teacher; a free position ("VAGA")
 * is a blank space.
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
  const monday =
    Date.parse(`${today}T12:00:00Z`) +
    (todayWeekday === 6 ? 2 : todayWeekday === 0 ? 1 : 1 - todayWeekday) * 86_400_000;
  return new Date(monday + (weekday - 1) * 86_400_000).toISOString().slice(0, 10);
};
const shortDate = (date: string) => `${date.slice(8)}/${date.slice(5, 7)}`;
/** A long name may break after a "/" ("ATIVIDADE DE VIDA DIÁRIA / PRÁTICA"), never mid-word. */
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
/** The subject of a position, by its official name (owner decision 23/10/2026: "COMPUTAÇÃO"). */
const subjectAt = (lessons: readonly ScheduleLessonV3[], weekday: number, slot: number) => {
  const subject = lessons.find(
    (lesson) => lesson.weekday === weekday && lesson.slot === slot,
  )?.subject;
  return subject ? officialSubjectV1(subject) : null;
};
const timeText = (item: { start: string; end: string }) => `${item.start} – ${item.end}`;

type RowV3 =
  | {
      kind: 'aula';
      slot: number;
      subject: string | null;
      time: { start: string; end: string } | null;
    }
  | { kind: 'intervalo'; start: string; end: string }
  | { kind: 'parada'; start: string; end: string };
/**
 * A day's rows: its positions up to its own last lesson (owner request 23/10/2026: no 6th on a day
 * without one), each with its time, and the break before the first lesson that starts after it.
 */
function rowsOf(item: ScheduleClassV3, weekday: WeekdayV3): RowV3[] {
  const last = Math.max(
    0,
    ...item.lessons.filter((lesson) => lesson.weekday === weekday).map((lesson) => lesson.slot),
  );
  const bells = item.bells?.[weekday] ?? null;
  const pause = bells?.find((bell) => bell.kind === 'intervalo') ?? null;
  const rows: RowV3[] = [];
  let paused = false;
  // The parada (owner decision 23/10/2026) before the first lesson, on a day with lessons.
  const firstTime = bellLessonV1(bells, 1);
  for (const bell of bells ?? [])
    if (
      bell.kind === 'parada' &&
      last &&
      firstTime &&
      bellMinutesV1(bell.end) <= bellMinutesV1(firstTime.start)
    )
      rows.push({ kind: 'parada', start: bell.start, end: bell.end });
  for (let slot = 1; slot <= last; slot += 1) {
    const time = bellLessonV1(bells, slot);
    if (pause && !paused && time && bellMinutesV1(time.start) >= bellMinutesV1(pause.end)) {
      rows.push({ kind: 'intervalo', start: pause.start, end: pause.end });
      paused = true;
    }
    rows.push({
      kind: 'aula',
      slot,
      subject: subjectAt(item.lessons, weekday, slot),
      time: time ? { start: time.start, end: time.end } : null,
    });
  }
  // And after the last one (Friday afternoon, until 18:00).
  const lastTime = bellLessonV1(bells, last);
  for (const bell of bells ?? [])
    if (
      bell.kind === 'parada' &&
      lastTime &&
      bellMinutesV1(bell.start) >= bellMinutesV1(lastTime.end)
    )
      rows.push({ kind: 'parada', start: bell.start, end: bell.end });
  return rows;
}

/**
 * On a phone, the day follows the finger (owner request 23/10/2026): dragged sideways, the card
 * slides and the next (or the previous) day shows as it slides in; let go past a fifth of the width,
 * it settles on that day, otherwise it slides back. A drag that starts up or down is the page's
 * scroll. Friday is followed by Monday, and Monday comes after Friday.
 */
const SLIDE_MS_V3 = 260;
const wrapWeekdayV3 = (weekday: number) => (((((weekday - 1) % 5) + 5) % 5) + 1) as WeekdayV3;
function DaySliderV3({
  shown,
  onChange,
  panel,
}: {
  shown: WeekdayV3;
  onChange: (weekday: WeekdayV3) => void;
  panel: (weekday: WeekdayV3, current: boolean) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; axis: 'x' | 'y' | null; dx: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [settling, setSettling] = useState(false);
  // The card is as tall as the day shown (a longer neighbour never leaves an empty space below).
  const currentPanel = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const element = currentPanel.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    setHeight(element.offsetHeight);
    return () => observer.disconnect();
  }, [shown]);
  const previous = wrapWeekdayV3(shown - 1);
  const next = wrapWeekdayV3(shown + 1);
  const settle = (to: -1 | 0 | 1) => {
    const width = box.current?.offsetWidth ?? 0;
    setSettling(true);
    setOffset(-to * width);
    window.setTimeout(() => {
      if (to) onChange(to === 1 ? next : previous);
      setSettling(false);
      setOffset(0);
    }, SLIDE_MS_V3);
  };
  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch || settling) return;
    drag.current = { x: touch.clientX, y: touch.clientY, axis: null, dx: 0 };
  };
  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    const current = drag.current;
    if (!touch || !current) return;
    const dx = touch.clientX - current.x;
    const dy = touch.clientY - current.y;
    if (!current.axis && (Math.abs(dx) > 8 || Math.abs(dy) > 8))
      current.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (current.axis !== 'x') return;
    current.dx = dx;
    setOffset(dx);
  };
  const onTouchEnd = () => {
    const current = drag.current;
    drag.current = null;
    if (!current || current.axis !== 'x') return;
    const width = box.current?.offsetWidth ?? 1;
    settle(current.dx < -width / 5 ? 1 : current.dx > width / 5 ? -1 : 0);
  };
  return (
    <div
      ref={box}
      className={'pa3-day-slider' + (offset || settling ? ' is-moving' : '')}
      style={height ? { height } : undefined}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div
        className={'pa3-day-track' + (settling ? ' is-settling' : '')}
        style={{ transform: `translateX(calc(-100% + ${offset}px))` }}
      >
        {[previous, shown, next].map((weekday, index) => (
          <div
            key={`${index}-${weekday}`}
            ref={index === 1 ? currentPanel : undefined}
            className="pa3-day-panel"
            aria-hidden={index !== 1 || undefined}
            inert={index !== 1 || undefined}
          >
            {panel(weekday, index === 1)}
          </div>
        ))}
      </div>
    </div>
  );
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
  if (load.data)
    return (
      <ScheduleWeekV3 classes={load.data.classes} daysOff={load.data.daysOff} ticking={active} />
    );
  const [message, action]: [string, [string, () => void] | null] = !load.error
    ? ['Carregando horário…', null]
    : load.error === 'unauthenticated'
      ? [
          'Sua sessão expirou. Entre novamente para ver o horário.',
          onLogin ? ['Entrar', onLogin] : null,
        ]
      : load.error === 'forbidden'
        ? ['O horário não está disponível no momento.', null]
        : [
            'Não foi possível carregar o horário agora. Vamos tentar de novo em instantes.',
            ['Tentar agora', load.retry],
          ];
  return (
    <ScheduleWeekV3
      classes={null}
      status={
        <Card className="pa3-card pa3-status" role={load.error ? 'alert' : undefined}>
          {load.error ? (
            <Alert status={load.error === 'unauthenticated' ? 'warning' : 'danger'}>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{message}</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : (
            <output className="pa3-status-loading">
              <Spinner size="sm" /> {message}
            </output>
          )}
          {action ? (
            <Button size="sm" variant="secondary" className="pa3-status-action" onPress={action[1]}>
              {action[0]}
            </Button>
          ) : null}
        </Card>
      }
    />
  );
}

/**
 * The break's mug (owner request 23/10/2026): its steam rises while the break is going on. The cup
 * is lucide's "coffee"; the three wisps of steam are drawn wavy so they can drift up and fade.
 */
function MugV3({ steaming }: { steaming: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={'pa3-mug' + (steaming ? ' is-steaming' : '')}
      aria-hidden="true"
    >
      <path className="pa3-mug-steam" d="M6 5c-.6-.8.6-1.6 0-2.6" />
      <path className="pa3-mug-steam" d="M10 5c-.6-.8.6-1.6 0-2.6" />
      <path className="pa3-mug-steam" d="M14 5c-.6-.8.6-1.6 0-2.6" />
      <path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1" />
    </svg>
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
    !!item &&
    minute !== null &&
    minute >= bellMinutesV1(item.start) &&
    minute < bellMinutesV1(item.end);
  // Already over, while today's lessons go on: faded, still readable. Once the day is over, nothing
  // is faded (owner request 23/10/2026: the day is checked after the lessons too).
  const ends = rows.flatMap((row) =>
    row.kind !== 'aula' ? [row.end] : row.time ? [row.time.end] : [],
  );
  const dayOver =
    minute !== null && ends.length > 0 && ends.every((end) => minute >= bellMinutesV1(end));
  const isDone = (item: { start: string; end: string } | null) =>
    !!item && minute !== null && !dayOver && minute >= bellMinutesV1(item.end);
  return (
    <ol className="pa3-schedule-list" aria-label={label}>
      {rows.map((row) =>
        row.kind === 'parada' ? (
          <li
            key={'parada' + row.start}
            aria-current={isNow(row) ? 'time' : undefined}
            className={
              'pa3-schedule-row pa3-schedule-parada' +
              (isNow(row) ? ' is-now' : '') +
              (isDone(row) ? ' is-done' : '')
            }
          >
            <span className="pa3-schedule-slot" aria-hidden="true">
              <Flag size={16} />
            </span>
            <span className="pa3-schedule-subject">Parada</span>
            <span className="pa3-schedule-time">
              {isNow(row) ? (
                <Chip size="sm" variant="primary" color="accent" className="pa3-schedule-now">
                  agora
                </Chip>
              ) : null}
              {timeText(row)}
            </span>
          </li>
        ) : row.kind === 'intervalo' ? (
          <li
            key="intervalo"
            aria-current={isNow(row) ? 'time' : undefined}
            className={
              'pa3-schedule-row pa3-schedule-break' +
              (isNow(row) ? ' is-now' : '') +
              (isDone(row) ? ' is-done' : '')
            }
          >
            <span className="pa3-schedule-slot" aria-hidden="true">
              <MugV3 steaming={isNow(row)} />
            </span>
            <span className="pa3-schedule-subject">Intervalo</span>
            <span className="pa3-schedule-time">
              {isNow(row) ? (
                <Chip size="sm" variant="primary" color="warning" className="pa3-schedule-now">
                  agora
                </Chip>
              ) : null}
              {timeText(row)}
            </span>
          </li>
        ) : (
          <li
            key={row.slot}
            className={
              'pa3-schedule-row' +
              (row.subject
                ? ` pa3-subject pa3-subject--${subjectStyleV3(row.subject).tone}`
                : ' is-free') +
              (isNow(row.time) ? ' is-now' : '') +
              (isDone(row.time) ? ' is-done' : '')
            }
            aria-current={isNow(row.time) ? 'time' : undefined}
          >
            <span className="pa3-schedule-slot" aria-hidden="true">
              {row.slot}ª
            </span>
            {/* A free position is a blank space; a screen reader hears "6ª aula: sem aula". */}
            <span className="pa3-schedule-subject">
              <span className="pa-visually-hidden">{`${row.slot}ª aula: `}</span>
              {row.subject ? (
                <>
                  {(() => {
                    const { Icon } = subjectStyleV3(row.subject);
                    return <Icon size={16} className="pa3-subject-icon" aria-hidden="true" />;
                  })()}
                  <span className="pa3-subject-name">{subjectText(row.subject)}</span>
                </>
              ) : (
                <span className="pa-visually-hidden">sem aula</span>
              )}
            </span>
            {row.time ? (
              <span className="pa3-schedule-time">
                {isNow(row.time) ? (
                  <Chip size="sm" variant="primary" color="accent" className="pa3-schedule-now">
                    agora
                  </Chip>
                ) : null}
                {timeText(row.time)}
              </span>
            ) : null}
          </li>
        ),
      )}
    </ol>
  );
}

/** Why a date has no school, as the ADM calendar says ("Feriado · Finados"). */
function DayOffV3({ day, today }: { day: SchoolDayOffV1; today: boolean }) {
  return (
    <Alert status="default" className="pa3-schedule-off" role="note">
      <Alert.Indicator>
        <CalendarOff size={18} aria-hidden="true" />
      </Alert.Indicator>
      <Alert.Content>
        <Alert.Title>{today ? 'Sem aula hoje' : `Sem aula em ${shortDate(day.date)}`}</Alert.Title>
        <Alert.Description>{schoolDayOffLabelV1(day)}</Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

/**
 * The next school day after today with lessons and times for this class: a weekday the ADM calendar
 * does not mark as a day without school, looked for up to two months ahead (the July recess and the
 * January holidays keep the clock running to the first day back).
 */
function nextSchoolDayOf(item: ScheduleClassV3, today: string, daysOff: readonly SchoolDayOffV1[]) {
  const off = new Set(daysOff.map((day) => day.date));
  for (let ahead = 1; ahead <= 62; ahead += 1) {
    const date = new Date(Date.parse(`${today}T12:00:00Z`) + ahead * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const weekday = weekdayOf(date);
    if (weekday < 1 || weekday > 5 || off.has(date)) continue;
    const rows = rowsOf(item, weekday as WeekdayV3);
    const first = rows.find((row) => row.kind === 'aula');
    const bell =
      first?.kind === 'aula' ? bellLessonV1(item.bells?.[weekday as WeekdayV3], first.slot) : null;
    // The day starts with the parada when it has one (the students arrive for it).
    const head = rows[0];
    const parada = head?.kind === 'parada' ? head : null;
    if (first?.kind === 'aula' && bell)
      return {
        ahead,
        date,
        weekday: weekday as WeekdayV3,
        slot: first.slot,
        start: parada ? parada.start : bell.start,
        parada: parada !== null,
      };
  }
  return null;
}

const itemName = (item: BellItemV1, subject: string | null) =>
  item.kind === 'intervalo'
    ? 'Intervalo'
    : item.kind === 'parada'
      ? 'Parada'
      : `${item.slot}ª aula${subject ? ` · ${subject}` : ''}`;
/**
 * Today, now (owner decision 23/10/2026): the lesson going on and a short clock to what comes next
 * ("Intervalo em", "Saída em"), then what follows. Before the day starts (with the parada, when
 * there is one), when it starts; after it, the clock runs to the next school day.
 */
function NowCardV3({
  item,
  today,
  schoolToday,
  daysOff,
  seconds,
  named,
}: {
  item: ScheduleClassV3;
  today: string;
  /** Today is a weekday with school (not a weekend, not a day off of the ADM calendar). */
  schoolToday: boolean;
  daysOff: readonly SchoolDayOffV1[];
  seconds: number;
  named: boolean;
}) {
  const weekday = weekdayOf(today) as WeekdayV3;
  const bells = schoolToday ? (item.bells?.[weekday] ?? []) : [];
  // Only the day's own lessons: a position past its last lesson is not "next".
  const shown = schoolToday ? rowsOf(item, weekday) : [];
  const lastSlot = Math.max(0, ...shown.flatMap((row) => (row.kind === 'aula' ? [row.slot] : [])));
  // The day's own items: its lessons, the break and the paradas around them (rowsOf's order).
  const day = shown.flatMap((row): BellItemV1[] =>
    row.kind === 'aula'
      ? row.time
        ? [{ kind: 'aula', slot: row.slot, start: row.time.start, end: row.time.end }]
        : []
      : [{ kind: row.kind, start: row.start, end: row.end }],
  );
  const moment =
    lastSlot && bells.length ? bellMomentV1(day, seconds / 60) : ({ state: 'over' } as const);
  if (moment.state === 'over') {
    // After the day's last lesson, on a weekend or a day off: the clock runs to the next lessons.
    const next = nextSchoolDayOf(item, today, daysOff);
    if (!next) return null;
    const when = next.ahead === 1 ? 'amanhã' : DAYS[next.weekday - 1]!.long.toLowerCase();
    return (
      <Card className="pa3-card pa3-now" role="status" aria-live="off">
        {named ? <p className="pa3-schedule-class">{item.label}</p> : null}
        <Card.Header className="pa3-now-head">
          <Card.Title className="pa3-now-title">Próximas aulas: {when}</Card.Title>
          <Chip size="sm" variant="soft" color="accent" className="pa3-now-until">
            {shortDate(next.date)} · {next.start}
          </Chip>
        </Card.Header>
        <div className="pa3-now-clock pa-countdown">
          <span className="pa3-now-label">Começa em</span>
          <PortalTimerV1
            seconds={next.ahead * 86_400 + bellMinutesV1(next.start) * 60 - seconds}
            label="Começa em"
          />
        </div>
        <p className="pa3-now-after">
          {next.parada ? 'Começa com a parada · ' : ''}
          Primeira: {next.slot}ª aula
          {subjectAt(item.lessons, next.weekday, next.slot)
            ? ` · ${subjectAt(item.lessons, next.weekday, next.slot)}`
            : ''}
        </p>
      </Card>
    );
  }
  const subjectOf = (bell: BellItemV1 | null) =>
    bell?.kind === 'aula' ? subjectAt(item.lessons, weekday, bell.slot) : null;
  const until = (time: string) => bellMinutesV1(time) * 60 - seconds;
  const [title, clockLabel, target, after] =
    moment.state === 'in'
      ? [
          `Agora: ${itemName(moment.current, subjectOf(moment.current))}`,
          moment.current.kind === 'intervalo'
            ? 'Volta em'
            : moment.current.kind === 'parada'
              ? moment.next
                ? 'Aulas começam em'
                : 'Saída em'
              : moment.next?.kind === 'intervalo'
                ? 'Intervalo em'
                : moment.next?.kind === 'parada'
                  ? 'Parada em'
                  : moment.next
                    ? 'Próxima aula em'
                    : 'Saída em',
          moment.current.end,
          moment.next
            ? moment.next.kind === 'intervalo'
              ? (day[day.indexOf(moment.next) + 1] ?? null)
              : moment.next
            : null,
        ]
      : [
          moment.state === 'before'
            ? moment.next.kind === 'parada'
              ? `Hoje a parada começa às ${moment.next.start}`
              : `Hoje as aulas começam às ${moment.next.start}`
            : `Próxima: ${itemName(moment.next, subjectOf(moment.next))}`,
          'Começa em',
          moment.next.start,
          // Before the day: its first lesson (after the parada, when the day starts with one).
          moment.state === 'before'
            ? moment.next.kind === 'parada'
              ? (day.find((bell) => bell.kind === 'aula') ?? null)
              : moment.next
            : null,
        ];
  return (
    <Card className="pa3-card pa3-now" role="status" aria-live="off">
      {named ? <p className="pa3-schedule-class">{item.label}</p> : null}
      <Card.Header className="pa3-now-head">
        <Card.Title className="pa3-now-title">{title}</Card.Title>
        {moment.state === 'in' ? (
          <Chip size="sm" variant="soft" color="accent" className="pa3-now-until">
            até {moment.current.end}
          </Chip>
        ) : null}
      </Card.Header>
      <div className="pa3-now-clock pa-countdown">
        <span className="pa3-now-label">{clockLabel}</span>
        <PortalTimerV1 seconds={until(target)} label={clockLabel} />
      </div>
      {moment.state === 'in' ? (
        <ProgressBar
          className="pa3-now-progress"
          aria-label={`Quanto já passou ${moment.current.kind === 'intervalo' ? 'do intervalo' : moment.current.kind === 'parada' ? 'da parada' : 'da aula'}`}
          size="sm"
          color={moment.current.kind === 'intervalo' ? 'warning' : 'accent'}
          value={Math.min(
            100,
            Math.max(
              0,
              (100 * (seconds - bellMinutesV1(moment.current.start) * 60)) /
                ((bellMinutesV1(moment.current.end) - bellMinutesV1(moment.current.start)) * 60),
            ),
          )}
        >
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      ) : null}
      {after ? (
        <p className="pa3-now-after">
          {moment.state === 'before'
            ? `Primeira: ${itemName(after, subjectOf(after))}`
            : `Depois: ${itemName(after, subjectOf(after))} · ${after.start}`}
        </p>
      ) : null}
    </Card>
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
  const offAt = (weekday: number) =>
    daysOff.find((day) => day.date === dateOfWeekday(today, weekday)) ?? null;
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
        <Card className="pa3-card">
          <p className="pa3-schedule-empty">O horário da turma ainda não está disponível.</p>
        </Card>
      ) : (
        <>
          {/* Today without school: why (ADM calendar). Otherwise the lesson going on now. */}
          {todayOff ? <DayOffV3 day={todayOff} today /> : null}
          {classes.map((item) =>
            item.bells ? (
              <NowCardV3
                key={'now' + item.label}
                item={item}
                today={today}
                schoolToday={schoolDay && !todayOff}
                daysOff={daysOff}
                seconds={clock.seconds}
                named={classes.length > 1}
              />
            ) : null,
          )}

          {/* Phone: the day's lessons, one day at a time. */}
          <div className="pa3-week-chips" role="group" aria-label="Dia da semana">
            {DAYS.map((day) => (
              <ToggleButton
                key={day.weekday}
                className={
                  'pa3-week-chip' +
                  (isToday(day.weekday) ? ' is-today' : '') +
                  (offAt(day.weekday) ? ' is-off' : '')
                }
                isSelected={day.weekday === shown}
                aria-label={
                  day.long +
                  (isToday(day.weekday) ? ' (hoje)' : '') +
                  (offAt(day.weekday) ? ', sem aula' : '')
                }
                onChange={() => setPicked(day.weekday)}
              >
                <span>{day.short}</span>
                {isToday(day.weekday) ? (
                  <span className="pa3-week-chip-today">hoje</span>
                ) : offAt(day.weekday) ? (
                  <span className="pa3-week-chip-today">sem aula</span>
                ) : null}
              </ToggleButton>
            ))}
          </div>

          {classes.map((item) => (
            <Card key={item.label} className="pa3-card pa3-schedule-card">
              {/* The class's name only when the student has more than one (regular + integral, AEE). */}
              {classes.length > 1 ? <p className="pa3-schedule-class">{item.label}</p> : null}

              <div className="pa3-schedule-day">
                <DaySliderV3
                  shown={shown}
                  onChange={setPicked}
                  panel={(weekday, current) => {
                    const day = DAYS[weekday - 1]!;
                    const dayOff = offAt(weekday);
                    return (
                      <>
                        <h3 aria-live={current ? 'polite' : undefined}>
                          {isToday(weekday) ? `Hoje, ${day.long.toLowerCase()}` : day.long}
                        </h3>
                        {dayOff ? (
                          <DayOffV3 day={dayOff} today={isToday(weekday)} />
                        ) : (
                          <DayListV3
                            rows={rowsOf(item, weekday)}
                            now={isToday(weekday) ? clock.seconds : null}
                            label={`Aulas de ${day.long.toLowerCase()}`}
                          />
                        )}
                      </>
                    );
                  }}
                />
              </div>

              {/* Computer: the whole week side by side, today's column marked (a break may sit
                    after a different lesson each day, so each day is its own column). */}
              <div
                className="pa3-schedule-week"
                aria-label={`Horário da semana${classes.length > 1 ? `, ${item.label}` : ''}`}
                role="group"
              >
                {DAYS.map((day) => {
                  const dayOff = offAt(day.weekday);
                  return (
                    <Card
                      key={day.weekday}
                      variant="secondary"
                      className={'pa3-schedule-column' + (isToday(day.weekday) ? ' is-today' : '')}
                    >
                      <h3>
                        {day.long.replace('-feira', '')}
                        {isToday(day.weekday) ? (
                          <span className="pa3-week-chip-today">hoje</span>
                        ) : null}
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
                    </Card>
                  );
                })}
              </div>
            </Card>
          ))}

          {/* When the class's grid was last read (owner request 23/10/2026: no source name). */}
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
