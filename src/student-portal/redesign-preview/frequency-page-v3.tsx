import { useMemo, useRef, useState, type TouchEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, Clock3, FileCheck2, X } from 'lucide-react';
import type { FrequencySummaryV2 } from '../../../shared/attendance-contracts/frequency-v2';
import { PREVIEW_TODAY_V3 } from './demo-data-v3';

/*
 * Frequência in a page of its own (owner request 20/10/2026, preview only): one month at a time,
 * read in DAYS, about absences only (owner request 21/10/2026). A day is "com falta" or not marked; how
 * much of it had absences is a LEVEL (the tile fills in proportion to the lessons with an
 * absence), never a label: no "arrived late", "left early" or "partly", which would be the portal
 * interpreting the diary (owner decisions 21/10/2026). Which lessons only shows in the lesson
 * tiles of the day. The official attendance stays the legal one, by lessons.
 */
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const WEEKDAYS_SHORT = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const WEEKDAYS_LONG = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const FIRST_MONTH = '2026-02';
/**
 * Attendance required over the whole year (LDB, art. 24, VI), counted in lessons. A month is only
 * compared with it as a reference: one month below it does not fail the year.
 */
const MINIMUM_PERCENT = 75;
const SHIFT_LABELS: Record<string, string> = { MATUTINO: 'Manhã', VESPERTINO: 'Tarde', NOTURNO: 'Noite', INTEGRAL: 'Integral' };

/** A school day: with or without an absence (89,7% of the school's days have none, 21/10/2026). */
type DayKindV3 = 'clear' | 'missed';
/** The calendar's state of a date: a day kind, or a date with nothing to judge yet. */
type DayStateV3 = DayKindV3 | 'pending' | 'off' | 'unknown' | 'future';
type MarkV3 = FrequencySummaryV2['marks'][number];
type ShiftLessonsV3 = { shift: string; slots: number[]; complete: boolean };
/** `share`: lessons with an absence ÷ lessons of the day, drawn as the tile's tone. */
type DayV3 = { kind: DayKindV3; justified: boolean; missed: MarkV3[]; lessons: number; share: number };

const pad = (value: number) => String(value).padStart(2, '0');
const monthKey = (year: number, month: number) => `${year}-${pad(month)}`;
const shiftMonth = (key: string, step: number) => {
  const [year, month] = key.split('-').map(Number) as [number, number];
  const date = new Date(Date.UTC(year, month - 1 + step, 1));
  return monthKey(date.getUTCFullYear(), date.getUTCMonth() + 1);
};
const monthLabel = (key: string) => {
  const [year, month] = key.split('-').map(Number) as [number, number];
  return `${MONTHS[month - 1]} de ${year}`;
};
const dayLabel = (date: string) => {
  const parsed = new Date(`${date}T12:00:00Z`);
  return `${WEEKDAYS_LONG[parsed.getUTCDay()]}, ${parsed.getUTCDate()} de ${MONTHS[parsed.getUTCMonth()]!.toLowerCase()}`;
};
/** The calendar day before, "ontem" (a weekend or holiday included). */
const dayBefore = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** The shift as people say it; an unknown value is left out rather than guessed. */
const shiftLabel = (shift: string) => SHIFT_LABELS[shift.trim().toUpperCase()] ?? null;
/** A lesson is one position of one shift: two shifts may both have a "1ª aula". */
const lessonKey = (shift: string, slot: number) => `${shift}:${slot}`;

/** The day's lessons in order (shift, then position) and which of them were missed. */
function dayOf(lessons: readonly ShiftLessonsV3[], marks: readonly MarkV3[]): DayV3 {
  const order = lessons.flatMap((group) => group.slots.map((slot) => lessonKey(group.shift, slot)));
  const missedAt = new Map(marks.map((mark) => [lessonKey(mark.shift, mark.slot), mark]));
  const missed = order.map((key) => missedAt.has(key));
  const count = missed.filter(Boolean).length;
  return {
    kind: count === 0 ? 'clear' : 'missed',
    justified: count > 0 && marks.every((mark) => mark.mark === 'J'),
    missed: [...marks],
    lessons: order.length,
    share: order.length ? count / order.length : 0,
  };
}

/** One sentence a parent reads: only counts the diary records, never what they might mean. */
function daySentence(day: DayV3) {
  const reason = day.justified ? ' (justificada)' : day.missed.some((mark) => mark.mark === 'J') ? ' (parte justificada)' : '';
  // A Smecel point is "lesson planned or present": never claimed as a confirmed presence.
  if (day.kind === 'clear') return 'Nenhuma falta neste dia.';
  if (day.missed.length >= day.lessons) return `Falta em todas as ${plural(day.lessons, 'aula', 'aulas')}${reason}.`;
  return `${plural(day.missed.length, 'falta', 'faltas')} em ${plural(day.lessons, 'aula', 'aulas')}${reason}.`;
}
/**
 * The tile's colour (owner decision 21/10/2026): red when every lesson of the day had an absence,
 * light red when only some did, amber when the day's absences are all justified (some or all).
 */
const toneLevelOf = (day: DayV3 | null) => (!day || day.share <= 0 ? 0 : day.share >= 1 ? 3 : 1);

/**
 * The year so far (owner request 21/10/2026: "a régua sobre o ano"). The law's 75% is over all
 * the year's lessons, so the ruler adds up every month from the first one to now, with the
 * server's rule: 100 × (lessons − absences) / lessons, justified absences not taken off. Only
 * when every month with lessons is reliable; otherwise the year is still being worked out. On the real
 * portal the server sends this figure.
 */
function yearOf(read: (month: string) => FrequencySummaryV2, current: string) {
  let lessons = 0;
  let absences = 0;
  for (let month = FIRST_MONTH; month <= current; month = shiftMonth(month, 1)) {
    const data = read(month);
    // A month with nothing at all (before the student arrived, after they left) adds nothing; a
    // real database check (21/10/2026) found 14 students who started after February and 30 who
    // left before October.
    if (data.coverage === 'unavailable') continue;
    if (data.coverage !== 'reliable' || data.denominator === null || data.absences === null) return null;
    lessons += data.denominator;
    absences += data.absences;
  }
  return lessons ? Math.round(((lessons - absences) / lessons) * 1000) / 10 : null;
}

/**
 * The month's school days as a ring with guide lines (owner choice 21/10/2026: "a A com as
 * legendas ao lado das setinhas guias de cada banda", darker tones). One arc per kind of day
 * (frequented, with an absence, justified); from the middle of each arc a guide line goes out to
 * its number and name. The official attendance in lessons sits in the centre. When the month
 * opens, the arcs grow in turn and the labels appear after them (still with reduced motion).
 */
const RING_VIEW_V3 = { width: 330, height: 172 };
const RING_CENTER_V3 = { x: 165, y: 86 };
const RING_RADIUS_V3 = 52;
const RING_STROKE_V3 = 19;
/** A small gap between arcs, in radians. */
const RING_GAP_V3 = 0.05;
const RING_KINDS_V3 = [
  { kind: 'clear', colour: '#166534', one: 'dia frequentado', many: 'dias frequentados' },
  { kind: 'missed', colour: '#991b1b', one: 'com falta', many: 'com falta' },
  { kind: 'justified', colour: '#b45309', one: 'justificada', many: 'justificadas' },
] as const;
const ringPoint = (radius: number, angle: number) => ({
  x: RING_CENTER_V3.x + radius * Math.cos(angle),
  y: RING_CENTER_V3.y + radius * Math.sin(angle),
});
const ringArc = (from: number, to: number) => {
  const start = ringPoint(RING_RADIUS_V3, from);
  const end = ringPoint(RING_RADIUS_V3, to);
  return `M${start.x.toFixed(2)} ${start.y.toFixed(2)} A${RING_RADIUS_V3} ${RING_RADIUS_V3} 0 ${to - from > Math.PI ? 1 : 0} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
};
/**
 * The month tag's calendar icon, its sheet turning over from top to bottom without end (owner
 * request 21/10/2026), like a flip calendar: the upper half folds down to the middle, the lower
 * half of the next sheet unfolds below it. Still with reduced motion.
 */
function CalendarFlipV3() {
  return (
    <svg className="pa3-flip" width={15} height={15} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M8 3v4M16 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <rect className="pa3-flip-sheet" x="7" y="10" width="10" height="4" rx="1" />
      <rect className="pa3-flip-sheet" x="7" y="14.6" width="10" height="3.6" rx="1" />
      <rect className="pa3-flip-sheet pa3-flip-top" x="7" y="10" width="10" height="4" rx="1" />
      <rect className="pa3-flip-sheet pa3-flip-bottom" x="7" y="14.6" width="10" height="3.6" rx="1" />
    </svg>
  );
}

/** Labels on one side never overlap: each keeps at least this vertical distance. */
const RING_LABEL_GAP_V3 = 34;
function spreadLabels<T extends { y: number }>(labels: T[]) {
  labels.sort((first, second) => first.y - second.y);
  for (let index = 1; index < labels.length; index++)
    labels[index]!.y = Math.max(labels[index]!.y, labels[index - 1]!.y + RING_LABEL_GAP_V3);
  const overflow = (labels.at(-1)?.y ?? 0) - (RING_VIEW_V3.height - 30);
  if (overflow > 0) for (const label of labels) label.y -= overflow;
  for (const label of labels) label.y = Math.max(20, label.y);
  return labels;
}
function DayRingV3({ totals, monthName }: { totals: { days: number; clear: number; missed: number; justified: number }; monthName: string }) {
  const counts = { clear: totals.clear, missed: totals.missed, justified: totals.justified };
  const shown = RING_KINDS_V3.filter(({ kind }) => counts[kind] > 0);
  let at = -Math.PI / 2;
  const arcs = shown.map((item, order) => {
    const size = (counts[item.kind] / totals.days) * 2 * Math.PI;
    const from = at;
    at += size;
    return { ...item, count: counts[item.kind], from, to: at, middle: from + size / 2, order };
  });
  // Each label starts level with its arc's middle, then the ones on each side are spread apart.
  const placed = arcs.map((arc) => {
    const side = Math.cos(arc.middle) >= 0 ? 1 : -1;
    // The pointer starts a little away from the ring, not touching it (owner request 21/10/2026).
    const near = ringPoint(RING_RADIUS_V3 + RING_STROKE_V3 / 2 + 7, arc.middle);
    const elbow = ringPoint(RING_RADIUS_V3 + RING_STROKE_V3 / 2 + 20, arc.middle);
    return { ...arc, side, near, elbow, y: elbow.y };
  });
  for (const side of [1, -1]) spreadLabels(placed.filter((label) => label.side === side));
  const single = arcs.length === 1;
  return (
    <svg
      className="pa3-guide-ring"
      viewBox={`0 0 ${RING_VIEW_V3.width} ${RING_VIEW_V3.height}`}
      role="img"
      aria-label={`${monthName}: ${totals.clear} dias frequentados, ${totals.missed} com falta e ${totals.justified} com falta justificada`}
    >
      <circle className="pa3-guide-track" cx={RING_CENTER_V3.x} cy={RING_CENTER_V3.y} r={RING_RADIUS_V3} strokeWidth={RING_STROKE_V3} />
      {placed.map((arc) =>
        single ? (
          <circle
            key={arc.kind}
            className="pa3-guide-arc"
            cx={RING_CENTER_V3.x}
            cy={RING_CENTER_V3.y}
            r={RING_RADIUS_V3}
            stroke={arc.colour}
            strokeWidth={RING_STROKE_V3}
            pathLength={100}
            transform={`rotate(-90 ${RING_CENTER_V3.x} ${RING_CENTER_V3.y})`}
            style={{ animationDelay: '0ms' }}
          />
        ) : (
          <path
            key={arc.kind}
            className="pa3-guide-arc"
            d={ringArc(arc.from + RING_GAP_V3 / 2, arc.to - RING_GAP_V3 / 2)}
            stroke={arc.colour}
            strokeWidth={RING_STROKE_V3}
            pathLength={100}
            style={{ animationDelay: `${arc.order * 180}ms` }}
          />
        ),
      )}
      {placed.map((label) => {
        const end = label.elbow.x + label.side * 14;
        const text = end + label.side * 4;
        const anchor = label.side > 0 ? 'start' : 'end';
        const name = label.count === 1 ? label.one : label.many;
        const [first, second] = name === 'dias frequentados' ? ['dias', 'frequentados'] : [name, null];
        return (
          <g key={label.kind} className="pa3-guide-label" style={{ animationDelay: `${450 + label.order * 160}ms` }}>
            <circle cx={label.near.x} cy={label.near.y} r={2.2} fill={label.colour} />
            <polyline
              points={`${label.near.x},${label.near.y} ${label.elbow.x},${label.y} ${end},${label.y}`}
              fill="none"
              stroke={label.colour}
              strokeWidth={1.3}
            />
            <text x={text} y={label.y - 3} textAnchor={anchor} className="pa3-guide-count" fill={label.colour}>
              {label.count}
            </text>
            <text x={text} y={label.y + 10} textAnchor={anchor} className="pa3-guide-name">
              {first}
            </text>
            {second ? (
              <text x={text} y={label.y + 22} textAnchor={anchor} className="pa3-guide-name">
                {second}
              </text>
            ) : null}
          </g>
        );
      })}
      {/* The month's days in the centre; the month's name is on the tag above the ring. */}
      <text x={RING_CENTER_V3.x} y={RING_CENTER_V3.y + 6} textAnchor="middle" className="pa3-guide-percent">
        {totals.days}
      </text>
      <text x={RING_CENTER_V3.x} y={RING_CENTER_V3.y + 20} textAnchor="middle" className="pa3-guide-caption">
        {totals.days === 1 ? 'dia' : 'dias'}
      </text>
    </svg>
  );
}

/**
 * A sideways swipe moves to the previous or next month, like the trimesters. One finger only: a
 * second finger (pinch to zoom) or a cancelled touch never changes the month.
 */
function useMonthSwipeV3(go: (step: number) => void, canBack: boolean, canForward: boolean) {
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  return {
    onTouchStart: (event: TouchEvent) => {
      const touch = event.touches[0];
      start.current = event.touches.length === 1 && touch ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : null;
    },
    onTouchMove: (event: TouchEvent) => {
      if (event.touches.length !== 1) start.current = null;
    },
    onTouchEnd: (event: TouchEvent) => {
      const origin = start.current;
      start.current = null;
      const touch = origin ? Array.from(event.changedTouches).find((item) => item.identifier === origin.id) : undefined;
      if (!origin || !touch || event.touches.length > 0) return;
      const dx = touch.clientX - origin.x;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(touch.clientY - origin.y) * 1.5) {
        if (dx < 0 && canForward) go(1);
        if (dx > 0 && canBack) go(-1);
      }
    },
    onTouchCancel: () => {
      start.current = null;
    },
  };
}

export function FrequencyPageV3({ read }: { read: (month: string) => FrequencySummaryV2 }) {
  const current = PREVIEW_TODAY_V3.slice(0, 7);
  const [month, setMonth] = useState(current);
  const data = useMemo(() => read(month), [read, month]);
  const reliable = data.coverage === 'reliable';
  // Lessons of each day, straight from the Smecel diary (data.days), kept per shift.
  const lessonsByDay = useMemo(() => {
    const map = new Map<string, ShiftLessonsV3[]>();
    for (const day of data.days ?? []) {
      const list = map.get(day.date) ?? [];
      const same = list.find((item) => item.shift === day.shift);
      if (same) {
        same.slots = [...new Set([...same.slots, ...day.slots])].sort((a, b) => a - b);
        same.complete &&= day.complete;
      } else list.push({ shift: day.shift, slots: [...day.slots].sort((a, b) => a - b), complete: day.complete });
      map.set(day.date, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.shift.localeCompare(b.shift));
    return map;
  }, [data]);
  const marksByDay = useMemo(() => {
    const map = new Map<string, MarkV3[]>();
    for (const mark of data.marks) map.set(mark.date, [...(map.get(mark.date) ?? []), mark]);
    for (const list of map.values()) list.sort((a, b) => a.shift.localeCompare(b.shift) || a.slot - b.slot);
    return map;
  }, [data]);
  const dayAt = (date: string) => {
    const lessons = lessonsByDay.get(date);
    return lessons ? dayOf(lessons, marksByDay.get(date) ?? []) : null;
  };
  // The days that count: over (today is still going on) and read in full.
  const countedDays = useMemo(
    () =>
      [...lessonsByDay.entries()]
        .filter(([date, lessons]) => date < PREVIEW_TODAY_V3 && lessons.every((item) => item.complete))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, lessons]) => ({ date, day: dayOf(lessons, marksByDay.get(date) ?? []) })),
    [lessonsByDay, marksByDay],
  );
  const totals = {
    days: countedDays.length,
    clear: countedDays.filter(({ day }) => day.kind === 'clear').length,
    missed: countedDays.filter(({ day }) => day.kind === 'missed' && !day.justified).length,
    justified: countedDays.filter(({ day }) => day.justified).length,
  };
  const daysWithMarks = [...marksByDay.keys()].sort().reverse();
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked && picked.startsWith(month) ? picked : (daysWithMarks[0] ?? null);
  const yearPercent = useMemo(() => yearOf(read, current), [read, current]);
  const yearTone = yearPercent === null ? 'none' : yearPercent < MINIMUM_PERCENT ? 'low' : 'good';
  const go = (step: number) => {
    setMonth((value) => shiftMonth(value, step));
    setPicked(null);
  };
  // Only the days area swipes: the month bar scrolls sideways on its own.
  const swipe = useMonthSwipeV3(go, month > FIRST_MONTH, month < current);

  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const stateOf = (date: string): DayStateV3 => {
    if (date > PREVIEW_TODAY_V3) return 'future';
    const lessons = lessonsByDay.get(date);
    if (!lessons) return reliable ? 'off' : marksByDay.has(date) ? 'pending' : 'unknown';
    const day = dayOf(lessons, marksByDay.get(date) ?? []);
    if (day.kind !== 'clear') return day.kind;
    // A day only reads "sem falta" when every lesson of it was read and the day is over.
    return date < PREVIEW_TODAY_V3 && lessons.every((item) => item.complete) ? 'clear' : 'pending';
  };
  const ariaOf = (date: string, state: DayStateV3) => {
    const day = dayAt(date);
    const today = date === PREVIEW_TODAY_V3 ? ' (hoje, dia em andamento: conta a partir de amanhã)' : '';
    const text: Record<DayStateV3, string> = {
      clear: 'nenhuma falta registrada',
      missed: day ? daySentence(day) : '',
      pending: 'leitura incompleta',
      off: 'sem aula',
      unknown: 'sem dados',
      future: 'data futura, frequência ainda não disponível',
    };
    return `${dayLabel(date)}: ${text[state]}${today}`;
  };
  const selectedLessons = selected ? (lessonsByDay.get(selected) ?? []) : [];
  const selectedDay = selected ? dayAt(selected) : null;
  const markAt = new Map((selected ? (marksByDay.get(selected) ?? []) : []).map((mark) => [lessonKey(mark.shift, mark.slot), mark]));
  const isToday = selected === PREVIEW_TODAY_V3;

  return (
    <section className="pa3-frequency" aria-labelledby="pa3-frequency-title">
      <h1 id="pa3-frequency-title" className="pa3-page-title" tabIndex={-1}>
        Frequência
      </h1>

      {/*
        The month at a glance (owner request 21/10/2026: "a rosca do A com a régua do B"): a ring
        of the month's school days (frequented, with an absence, justified) around the official
        attendance in lessons, and under it a 0–100% ruler with the year's 75% minimum.
        Always the same height, data or not, so the calendar below never moves when the month
        changes (owner request 21/10/2026).
      */}
      <div className={'pa3-summary pa3-summary--' + yearTone}>
        {/* The month's name on a tag at the top (owner request 21/10/2026: "sentindo falta do nome"). */}
        <p className="pa3-summary-title">
          <CalendarFlipV3 />
          {monthLabel(month)}
        </p>
        <DayRingV3 key={month} totals={totals} monthName={MONTHS[monthNumber - 1]!} />
        {/* The ruler is the year so far, not the month (owner request 21/10/2026): the 75% is the
            law's minimum over all the year's lessons, so only the year's figure meets it. */}
        <div className="pa3-ruler-wrap">
          <p className="pa3-year-head">
            <span>
              Presença no ano até agora
              {/* How the figure moves, in plain words (owner request 21/10/2026). */}
              <small>Cai quando o aluno falta e sobe quando ele vem às aulas. Faltas justificadas não prejudicam.</small>
            </span>
            {/* Whole number, rounded down (owner decision 20/10/2026): 74,9% never reads as 75%. */}
            <strong>{yearPercent === null ? 'em apuração' : `${Math.floor(yearPercent)}%`}</strong>
          </p>
          <div
            className="pa3-ruler"
            role="img"
            aria-label={
              yearPercent === null
                ? 'Presença do ano ainda em apuração'
                : `${Math.floor(yearPercent)}% de presença nas aulas do ano até agora; o mínimo do ano é ${MINIMUM_PERCENT}%`
            }
          >
            <span className="pa3-ruler-fill" style={{ width: `${yearPercent === null ? 0 : Math.max(0, Math.min(100, yearPercent))}%` }} />
            <span className="pa3-ruler-minimum" style={{ left: `${MINIMUM_PERCENT}%` }} aria-hidden="true">
              <span className="pa3-ruler-flag">mín. {MINIMUM_PERCENT}%</span>
            </span>
          </div>
          <div className="pa3-ruler-labels" aria-hidden="true">
            <span>0%</span>
            <span>100%</span>
          </div>
        </div>
      </div>

      <div className="pa3-card" {...swipe}>
        <div className="pa3-card-head">
          {/* The month and its arrows (owner request 21/10/2026): the month bar is gone. */}
          <h2 aria-live="polite">{monthLabel(month)}</h2>
          <div className="pa3-month-arrows">
            <button type="button" className="pa3-month-arrow" aria-label="Mês anterior" disabled={month <= FIRST_MONTH} onClick={() => go(-1)}>
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            <button type="button" className="pa3-month-arrow" aria-label="Próximo mês" disabled={month >= current} onClick={() => go(1)}>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
        <ul className="pa3-legend" aria-label="Legenda">
          <li><span className="pa3-dot pa3-kind--missed" data-tone="3" /> Com falta</li>
          {/* Light red (owner request 21/10/2026): absent in some of the day's lessons. */}
          <li><span className="pa3-dot pa3-kind--missed" data-tone="1" /> Falta parcial</li>
          <li><span className="pa3-dot pa3-kind--missed is-justified" data-tone="3" /> Justificada</li>
        </ul>
        {/* A visual grid of buttons; each button says its whole day, so no ARIA grid is needed. */}
        <div className="pa3-calendar" aria-label={`Dias de ${monthLabel(month)}`} role="group">
          {WEEKDAYS_SHORT.map((day, index) => (
            <span key={index} className="pa3-weekday" aria-hidden="true">
              {day}
            </span>
          ))}
          {Array.from({ length: firstWeekday }, (_, index) => (
            <span key={'blank' + index} aria-hidden="true" />
          ))}
          {Array.from({ length: daysInMonth }, (_, index) => {
            const date = `${month}-${pad(index + 1)}`;
            const state = stateOf(date);
            const justified = dayAt(date)?.justified ?? false;
            // Only a day with an absence (or today's, still open) is highlighted and opens.
            const pickable = state === 'missed' || state === 'pending';
            return (
              <button
                key={date}
                type="button"
                className={
                  'pa3-day pa3-day--' + state + ' pa3-kind--' + state +
                  (justified ? ' is-justified' : '') +
                  (selected === date ? ' is-selected' : '') +
                  (date === PREVIEW_TODAY_V3 ? ' is-today' : '')
                }
                disabled={!pickable}
                aria-pressed={selected === date}
                aria-label={ariaOf(date, state)}
                data-tone={state === 'missed' ? toneLevelOf(dayAt(date)) : undefined}
                onClick={() => setPicked(date)}
              >
                <span className="pa3-day-number">{index + 1}</span>
                {date === PREVIEW_TODAY_V3 ? <span className="pa3-day-today">HOJE</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      {selected && selectedDay ? (
        <div className="pa3-card pa3-day-detail" aria-live="polite">
          {/* Today and yesterday say so: "Hoje, quarta-feira, 21 de outubro" (owner request 21/10/2026), on one line. */}
          <h2 className="pa3-day-detail-title">
            {selected === PREVIEW_TODAY_V3
              ? `Hoje, ${dayLabel(selected).toLowerCase()}`
              : selected === dayBefore(PREVIEW_TODAY_V3)
                ? `Ontem, ${dayLabel(selected).toLowerCase()}`
                : dayLabel(selected)}
          </h2>
          {isToday ? <p className="pa3-today-note">Dia em andamento · conta a partir de amanhã</p> : null}
          <p className="pa3-day-detail-sub">
            {daySentence(selectedDay)}
          </p>
          {selectedLessons.map((group) => {
            const label = shiftLabel(group.shift);
            return (
              <div key={group.shift} className="pa3-shift">
                {label && selectedLessons.length > 1 ? <h3 className="pa3-shift-title">{label}</h3> : null}
                <ol className="pa3-lessons" data-count={group.slots.length}>
                  {group.slots.map((slot) => {
                    const mark = markAt.get(lessonKey(group.shift, slot));
                    // Today a lesson without a mark is still to be confirmed (the roll call may come later).
                    const state = mark?.mark === 'X' ? 'absent' : mark?.mark === 'J' ? 'justified' : isToday || !group.complete ? 'pending' : 'clear';
                    return (
                      <li key={slot} className={'pa3-lesson pa3-lesson--' + state}>
                        <span className="pa3-lesson-icon" aria-hidden="true">
                          {state === 'absent' ? <X size={16} strokeWidth={3} /> : state === 'justified' ? <FileCheck2 size={15} /> : state === 'pending' ? <Clock3 size={15} /> : <Check size={16} strokeWidth={3} />}
                        </span>
                        <span className="pa3-lesson-name">{slot}ª aula</span>
                        <span className="pa3-lesson-state">
                          {state === 'absent' ? 'Falta' : state === 'justified' ? 'Justificada' : state === 'pending' ? 'A confirmar' : 'Sem falta'}
                        </span>
                      </li>
                    );
                  })}
                </ol>
                {label && selectedLessons.length === 1 ? <p className="pa3-shift-foot">{label} · {plural(group.slots.length, 'aula', 'aulas')}</p> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Only a time the server gave: none is invented when the month has no reading. */}
      {data.receivedAt ? (
        <p className="pa3-footnote">
          Atualizado em {new Date(data.receivedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
        </p>
      ) : null}
    </section>
  );
}
