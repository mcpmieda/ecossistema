import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { CalendarOff, Check, ChevronLeft, ChevronRight, Clock3, FileCheck2, PartyPopper, TriangleAlert, X } from 'lucide-react';
import {
  frequencyCountV2,
  type FrequencySummaryV2,
  type FrequencyYearSummaryV2,
} from '../../../../shared/attendance-contracts/frequency-v2';
import type { StudentFrequencyClientV2 } from '../frequency/client-v2';
import { Alert } from '@heroui/react/alert';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Chip } from '@heroui/react/chip';
import { Spinner } from '@heroui/react/spinner';
import {
  BELLS_VALID_FROM_V1,
  bellLessonV1,
  bellShiftOfLabelV1,
} from '../../../../shared/student-portal-contracts/school-bells-v1';
import { schoolDayOffLabelV1, type SchoolDayOffV1 } from '../../../../shared/student-portal-contracts/school-calendar-v1';
import { officialSubjectV1 } from '../../../../shared/student-portal-contracts/official-subjects-v1';
import { usePortalPageActiveV3, useReportFrequencyToneV3 } from './portal-pages-v3';
import { useCachedReadV3 } from './use-cached-read-v3';
import { PortalCountdownV1, syncPortalClockV1 } from '../shell/portal-notices-v1';

/*
 * Frequência in a page of its own (owner requests 20–21/10/2026, preview only): one month at a
 * time, read in DAYS and about absences only. Every school day already over is one of four kinds,
 * the same everywhere (calendar colour, legend, ring, sentence): "falta total" (an absence in every
 * lesson, one at least not justified), "falta parcial" (in some lessons only), "justificada" (every
 * absence of the day justified) or frequented (no absence). The portal never interprets the diary:
 * no "arrived late", "left early" or "partly" (owner decisions 21/10/2026); which lessons were
 * missed only shows in the lesson tiles of the day. The legal attendance stays by lessons, over the
 * whole year (the ruler).
 *
 * Data (PR 1317 checklist, 22/10/2026): the real client (createStudentFrequencyClientV2), one month
 * per request, kept per month so going back and forth never waits twice. The server works out the
 * month's and the year's counts by the same rule (frequencyCountV2: today never counts) and sends
 * the school's today and the class's last reading; the page only draws them.
 */
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const WEEKDAYS_SHORT = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const WEEKDAYS_LONG = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
/**
 * The school year shown: February to December of the student's academic year
 * (profile.link.academicYear). After December the page stays on December instead of asking for a
 * month the API would refuse.
 */
const firstMonthOf = (year: number) => `${year}-02`;
const lastMonthOf = (year: number) => `${year}-12`;
const SHIFT_LABELS: Record<string, string> = { MATUTINO: 'Manhã', VESPERTINO: 'Tarde', NOTURNO: 'Noite', INTEGRAL: 'Integral' };

/** A school day: with or without an absence (89,7% of the school's days have none, 21/10/2026). */
type DayKindV3 = 'clear' | 'missed';
/** The calendar's state of a date: a day kind, or a date with nothing to judge yet. */
type DayStateV3 = DayKindV3 | 'pending' | 'off' | 'holiday' | 'unknown' | 'future';
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

/**
 * One sentence a parent reads: only counts the diary records, never what they might mean. `open`:
 * today, or a past day not read in full yet — more marks may still come, so nothing is final.
 */
/** Today and yesterday say so: "Hoje, quarta-feira, 21 de outubro" (owner request 21/10/2026). */
function dayTitle(selected: string, today: string) {
  if (selected === today) return `Hoje, ${dayLabel(selected).toLowerCase()}`;
  if (selected === dayBefore(today)) return `Ontem, ${dayLabel(selected).toLowerCase()}`;
  return dayLabel(selected);
}

type LessonStateV3 = 'absent' | 'justified' | 'pending' | 'clear';
const LESSON_ICON: Record<LessonStateV3, ReactNode> = {
  absent: <X size={16} strokeWidth={3} />,
  justified: <FileCheck2 size={15} />,
  pending: <Clock3 size={15} />,
  clear: <Check size={16} strokeWidth={3} />,
};
const LESSON_STATE_LABEL: Record<LessonStateV3, string> = {
  absent: 'Faltou',
  justified: 'Justificada',
  pending: 'A confirmar',
  clear: 'Sem falta',
};

function daySentence(day: DayV3, open: boolean) {
  let reason: ' (justificada)' | ' (parte justificada)' | '';
  if (day.justified) {
    reason = ' (justificada)';
  } else if (day.missed.some((mark) => mark.mark === 'J')) {
    reason = ' (parte justificada)';
  } else {
    reason = '';
  }
  // A Smecel point is "lesson planned or present": never claimed as a confirmed presence.
  if (open)
    return day.kind === 'clear'
      ? 'Nenhuma falta registrada até agora.'
      : `${plural(day.missed.length, 'falta registrada', 'faltas registradas')} até agora${reason}.`;
  if (day.kind === 'clear') return 'Nenhuma falta neste dia.';
  if (day.missed.length >= day.lessons) return `Falta em todas as ${plural(day.lessons, 'aula', 'aulas')}${reason}.`;
  return `${plural(day.missed.length, 'falta', 'faltas')} em ${plural(day.lessons, 'aula', 'aulas')}${reason}.`;
}
/**
 * The tile's colour (owner decision 21/10/2026): red when every lesson of the day had an absence,
 * light red when only some did, amber when the day's absences are all justified (some or all).
 */
const toneLevelOf = (day: DayV3 | null) => {
  if (!day || day.share <= 0) {
    return 0;
  }
  if (day.share >= 1) {
    return 3;
  }
  return 1;
};

/**
 * The month's school days as a ring with guide lines (owner choices 21/10/2026: "a A com as
 * legendas ao lado das setinhas guias de cada banda", darker tones). One arc per kind of day (falta
 * total, falta parcial, justificada, frequentado); from the middle of each arc a curved guide line
 * goes out to its number and name. The centre shows how many days are counted (days already over;
 * today is not). When the month opens, the arcs grow in turn and the labels appear after them
 * (still with reduced motion).
 */
const RING_VIEW_V3 = { width: 330, height: 172 };
const RING_CENTER_V3 = { x: 165, y: 86 };
const RING_RADIUS_V3 = 52;
const RING_STROKE_V3 = 19;
/** A small gap between arcs, in radians. */
const RING_GAP_V3 = 0.05;
/**
 * The four kinds of day, the same as the calendar's colours (owner decision 21/10/2026: a student
 * who misses only some lessons, arriving at the third, did not miss the day). Every school day
 * already over falls in exactly one: no absence; an absence in every lesson (one at least not
 * justified); an absence in some lessons only (one at least not justified); every absence of the
 * day justified, all lessons or some.
 */
// `ink`: the number's colour. The light red arc stays light, but its number is darker so it reads
// at 4,5:1 on white even when the ring is scaled down on a narrow phone (#d45a4f was 3,9:1).
const RING_KINDS_V3 = [
  { kind: 'clear', colour: '#166534', ink: '#166534', one: 'dia frequentado', many: 'dias frequentados' },
  { kind: 'full', colour: '#991b1b', ink: '#991b1b', one: 'falta total', many: 'faltas totais' },
  { kind: 'partial', colour: '#d45a4f', ink: '#b42d22', one: 'falta parcial', many: 'faltas parciais' },
  { kind: 'justified', colour: '#b45309', ink: '#b45309', one: 'justificada', many: 'justificadas' },
] as const;
type RingTotalsV3 = { days: number; clear: number; full: number; partial: number; justified: number };
/**
 * The school days already over and read in full, by kind (today never counts), over the lesson
 * days and marks given: the whole year so far for the ring (owner request 22/10/2026: "os dados
 * do ano inteiro e não mais o mês, pra casar com a régua").
 */
function ringTotalsOf(days: readonly NonNullable<FrequencySummaryV2['days']>[number][], marks: readonly MarkV3[], today: string): RingTotalsV3 {
  const lessonsByDay = new Map<string, ShiftLessonsV3[]>();
  for (const day of days) {
    const list = lessonsByDay.get(day.date) ?? [];
    const same = list.find((item) => item.shift === day.shift);
    if (same) {
      same.slots = [...new Set([...same.slots, ...day.slots])];
      same.complete &&= day.complete;
    } else list.push({ shift: day.shift, slots: [...day.slots], complete: day.complete });
    lessonsByDay.set(day.date, list);
  }
  const marksByDay = new Map<string, MarkV3[]>();
  for (const mark of marks) marksByDay.set(mark.date, [...(marksByDay.get(mark.date) ?? []), mark]);
  const counted = [...lessonsByDay.entries()]
    .filter(([date, lessons]) => date < today && lessons.every((item) => item.complete))
    .map(([date, lessons]) => dayOf(lessons, marksByDay.get(date) ?? []));
  return {
    days: counted.length,
    clear: counted.filter((day) => day.kind === 'clear').length,
    full: counted.filter((day) => day.kind === 'missed' && !day.justified && day.share >= 1).length,
    partial: counted.filter((day) => day.kind === 'missed' && !day.justified && day.share < 1).length,
    justified: counted.filter((day) => day.justified).length,
  };
}
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
 * Labels on one side never overlap: each keeps at least this vertical distance, the height of a
 * label of two lines (the count, then "faltas / parciais"). At most three labels share a side.
 */
const RING_LABEL_GAP_V3 = 50;
type PointV3 = { x: number; y: number };
/** Whether a guide curve (a cubic Bézier) comes within the ring, with a hair of room. */
function curveCrossesRing(start: PointV3, first: PointV3, second: PointV3, end: PointV3) {
  for (let step = 1; step < 24; step++) {
    const t = step / 24;
    const u = 1 - t;
    const x = u * u * u * start.x + 3 * u * u * t * first.x + 3 * u * t * t * second.x + t * t * t * end.x;
    const y = u * u * u * start.y + 3 * u * u * t * first.y + 3 * u * t * t * second.y + t * t * t * end.y;
    if (Math.hypot(x - RING_CENTER_V3.x, y - RING_CENTER_V3.y) < RING_RADIUS_V3 + RING_STROKE_V3 / 2 + 3) return true;
  }
  return false;
}
/** The short level stroke from a line's bend to its words. */
const RING_LABEL_LEAD_V3 = 8;
function spreadLabels<T extends { y: number }>(labels: T[]) {
  // As close to the edges as the words allow: the count above a label's line, two lines below it.
  const top = 22;
  const bottom = RING_VIEW_V3.height - 25;
  labels.sort((first, second) => first.y - second.y);
  // Down from the top edge, each one at least a label's height below the one above it…
  for (const [index, label] of labels.entries())
    label.y = Math.max(label.y, index ? labels[index - 1]!.y + RING_LABEL_GAP_V3 : top);
  // …then up from the bottom edge the same way, so a label pushed past it brings the others up…
  for (let index = labels.length - 1; index >= 0; index--)
    labels[index]!.y = Math.min(labels[index]!.y, index < labels.length - 1 ? labels[index + 1]!.y - RING_LABEL_GAP_V3 : bottom);
  // …and never above the top (three labels always fit between the two edges).
  for (const [index, label] of labels.entries())
    label.y = Math.max(label.y, index ? labels[index - 1]!.y + RING_LABEL_GAP_V3 : top);
  return labels;
}
function DayRingV3({ totals, label }: Readonly<{ totals: RingTotalsV3; label: string }>) {
  const counts = { clear: totals.clear, full: totals.full, partial: totals.partial, justified: totals.justified };
  // Absences first, then the frequented days. The ring is turned so the absences sit centred on
  // the left and the frequented days on the right (owner request 21/10/2026): every arc then
  // points sideways, and every guide line runs out nearly level, with no hooks.
  const shown = [...RING_KINDS_V3.filter(({ kind }) => kind !== 'clear'), RING_KINDS_V3[0]].filter(({ kind }) => counts[kind] > 0);
  const absent = totals.days - totals.clear;
  let at = Math.PI - (absent / totals.days) * Math.PI;
  const arcs = shown.map((item, order) => {
    const size = (counts[item.kind] / totals.days) * 2 * Math.PI;
    const from = at;
    at += size;
    return { ...item, count: counts[item.kind], from, to: at, middle: from + size / 2, order };
  });
  // Each label goes on its arc's side, level with the arc's middle, then the ones on each side are
  // spread apart (three at most per side, which always fit). While the frequented days are at least
  // half the month, every absence label is on the left; in a month mostly of absences the absence
  // arcs wrap round past the bottom and some of their labels go to the right, next to their arcs
  // (an exhaustive check of every split up to 31 days found no overlap and no line crossing the ring).
  const placed = arcs.map((arc) => {
    const side = Math.cos(arc.middle) >= 0 ? 1 : -1;
    // The pointer starts a little away from the ring, not touching it (owner request 21/10/2026).
    const near = ringPoint(RING_RADIUS_V3 + RING_STROKE_V3 / 2 + 6, arc.middle);
    const elbow = ringPoint(RING_RADIUS_V3 + RING_STROKE_V3 / 2 + 14, arc.middle);
    return { ...arc, side, near, elbow, y: elbow.y };
  });
  for (const side of [1, -1]) spreadLabels(placed.filter((label) => label.side === side));
  const single = arcs.length === 1;
  return (
    <svg
      className="pa3-guide-ring"
      viewBox={`0 0 ${RING_VIEW_V3.width} ${RING_VIEW_V3.height}`}
      role="img"
      aria-label={`${label}, ${plural(totals.days, 'dia de aula contado', 'dias de aula contados')}: ${RING_KINDS_V3.map((kind) => plural(totals[kind.kind], kind.one, kind.many)).join(', ')}`}
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
        // One smooth curve, as short as it can be (owner requests 21/10/2026: no crooked arrows,
        // no needless bends, curves instead of corners): it leaves the arc pointing outwards and
        // reaches the words level. It goes further out only as far as the words need to clear
        // the ring at their own height.
        const outer = RING_RADIUS_V3 + RING_STROKE_V3 / 2;
        const above = Math.max(0, RING_CENTER_V3.y - (label.y + 25), label.y - 22 - RING_CENTER_V3.y);
        const needed = above >= outer ? 0 : Math.sqrt(outer * outer - above * above) + 5 - RING_LABEL_LEAD_V3;
        let reach = Math.max(Math.abs(label.elbow.x - RING_CENTER_V3.x), needed);
        const curveTo = (out: number) => {
          const post = RING_CENTER_V3.x + label.side * out;
          return [label.near, label.elbow, { x: post, y: label.y }, { x: post + label.side * RING_LABEL_LEAD_V3, y: label.y }] as const;
        };
        // A label moved up or down: its curve must not graze the ring either.
        while (reach < outer + 40 && curveCrossesRing(...curveTo(reach))) reach += 2;
        const [, bend, level, finish] = curveTo(reach);
        const end = finish.x;
        const text = end + label.side * 3;
        const anchor = label.side > 0 ? 'start' : 'end';
        const name = label.count === 1 ? label.one : label.many;
        // Two words on two lines ("dias / frequentados", "falta / parcial"); one word stays alone.
        const [first, second] = name.includes(' ') ? [name.slice(0, name.indexOf(' ')), name.slice(name.indexOf(' ') + 1)] : [name, null];
        return (
          <g key={label.kind} className="pa3-guide-label" style={{ animationDelay: `${450 + label.order * 160}ms` }}>
            <circle cx={label.near.x} cy={label.near.y} r={2.2} fill={label.colour} />
            <path
              d={`M${label.near.x.toFixed(1)} ${label.near.y.toFixed(1)} C${bend.x.toFixed(1)} ${bend.y.toFixed(1)} ${level.x.toFixed(1)} ${level.y.toFixed(1)} ${end.toFixed(1)} ${label.y.toFixed(1)}`}
              fill="none"
              stroke={label.colour}
              strokeWidth={1.3}
              strokeLinecap="round"
            />
            <text x={text} y={label.y - 3} textAnchor={anchor} className="pa3-guide-count" fill={label.ink}>
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
      {/* The school days of the year already over, in the centre (owner request 22/10/2026:
          "x dias já se passaram"), on two short lines so they stay inside the ring. */}
      <text x={RING_CENTER_V3.x} y={RING_CENTER_V3.y + 2} textAnchor="middle" className="pa3-guide-percent">
        {totals.days}
      </text>
      <text x={RING_CENTER_V3.x} y={RING_CENTER_V3.y + 15} textAnchor="middle" className="pa3-guide-caption">
        {totals.days === 1 ? 'dia já' : 'dias já'}
      </text>
      <text x={RING_CENTER_V3.x} y={RING_CENTER_V3.y + 25} textAnchor="middle" className="pa3-guide-caption">
        {totals.days === 1 ? 'se passou' : 'se passaram'}
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

/**
 * Today, kept current while the page stays open (owner request 21/10/2026): a phone left on the
 * portal overnight moves "HOJE" (and, on the 1st, the month) when the parent comes back to it, and
 * at midnight. The school's clock: America/Bahia, always UTC−3 (no daylight saving since 2012).
 * Frequência uses it only until the server's today arrives (a phone with a wrong clock never moves
 * "HOJE" there); Horário marks today's column with it.
 */
/** The phone's date in the school's time zone (America/Bahia), until the server's today arrives. */
export const schoolDateOnDeviceV3 = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());
const SCHOOL_UTC_OFFSET_MS = -3 * 3_600_000;
const DAY_MS = 86_400_000;
export function useTodayV3() {
  const [today, setToday] = useState(schoolDateOnDeviceV3);
  useEffect(() => {
    const check = () => setToday(schoolDateOnDeviceV3());
    const untilMidnight = () => DAY_MS - ((Date.now() + SCHOOL_UTC_OFFSET_MS) % DAY_MS) + 1000;
    let timer = window.setTimeout(function tick() {
      check();
      timer = window.setTimeout(tick, untilMidnight());
    }, untilMidnight());
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
    };
  }, []);
  return today;
}

type FrequencyPageV3Props = {
  client: StudentFrequencyClientV2;
  /** The student's school year (profile.link.academicYear). */
  academicYear?: number;
  /** "Entrar" after the session expired. */
  onLogin?: () => void;
  /** The session expired while reading (401): the app goes back to the sign-in. */
  onAuthenticationLost?: () => void;
};

/** The message for a failed read and the button that helps, when there is one. */
function frequencyFailureV3(
  error: string,
  onLogin: (() => void) | undefined,
  onRetry: () => void,
): [string, [string, () => void] | null] {
  if (error === 'unauthenticated')
    return ['Sua sessão expirou. Entre novamente para ver a frequência.', onLogin ? ['Entrar', onLogin] : null];
  if (error === 'forbidden') return ['A frequência não está disponível no momento.', null];
  return ['Não foi possível carregar a frequência agora. Vamos tentar de novo em instantes.', ['Tentar agora', onRetry]];
}

/** While the month has not come yet, or cannot be shown: what happened, in plain words. */
function FrequencyStatusV3({
  error,
  onLogin,
  onRetry,
  month,
}: Readonly<{
  error: string | null;
  onLogin?: () => void;
  onRetry: () => void;
  /** The month and its arrows, so a month that is slow to come never traps the reader. */
  month?: ReactNode;
}>) {
  if (!error)
    return (
      <Card className="pa3-card pa3-status">
        {month}
        <output className="pa3-status-loading">
          <Spinner size="sm" /> Carregando frequência…
        </output>
      </Card>
    );
  const [message, action] = frequencyFailureV3(error, onLogin, onRetry);
  return (
    <Card className="pa3-card pa3-status" role="alert">
      {month}
      <Alert status={error === 'unauthenticated' ? 'warning' : 'danger'}>
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{message}</Alert.Description>
        </Alert.Content>
      </Alert>
      {action ? (
        <Button size="sm" variant="secondary" className="pa3-status-action" onPress={action[1]}>
          {action[0]}
        </Button>
      ) : null}
    </Card>
  );
}

export function FrequencyPageV3({ client, academicYear = 2026, onLogin, onAuthenticationLost }: Readonly<FrequencyPageV3Props>) {
  // The whole school year so far, read once with the sign-in (owner request 22/10/2026: changing
  // months must never blink nor wait): every month, the school's today, the year's counts.
  const read = useCallback(
    async (signal: AbortSignal) => {
      const value = await client.readYear(signal);
      // The countdown runs on the database's clock, never on a phone set to the wrong time.
      if (value.serverNow) syncPortalClockV1(value.serverNow);
      return value;
    },
    [client],
  );
  const load = useCachedReadV3(read, usePortalPageActiveV3(), onAuthenticationLost);
  // The menu's icon: red with an X while the page shows a red warning, green otherwise.
  let tone: 'alert' | 'good' | null = null;
  if (load.data) tone = load.data.comment?.tone === 'alert' ? 'alert' : 'good';
  useReportFrequencyToneV3(tone);
  // The school's today as the server reads it (the collection agenda's timezone): a phone with a
  // wrong clock never moves "HOJE".
  const deviceToday = useTodayV3();
  const today = load.data?.today ?? deviceToday;
  const firstMonth = firstMonthOf(academicYear);
  const lastMonth = lastMonthOf(academicYear);
  // The current month, kept inside the school year: from January the page stays on December.
  const todayMonth = today.slice(0, 7);
  let current;
  if (todayMonth > lastMonth) {
    current = lastMonth;
  } else if (todayMonth < firstMonth) {
    current = firstMonth;
  } else {
    current = todayMonth;
  }
  // null: the current month, which follows the calendar (a new month on the 1st); a month the
  // parent picked stays until they leave the page.
  const [chosenMonth, setChosenMonth] = useState<string | null>(null);
  const month = chosenMonth && chosenMonth < current ? chosenMonth : current;
  const year = load.data;
  const totals = useMemo(
    () =>
      year
        ? ringTotalsOf(
            year.months.flatMap((item) => item.days ?? []),
            year.months.flatMap((item) => item.marks),
            year.today,
          )
        : null,
    [year],
  );
  return (
    <section className="pa3-frequency" aria-labelledby="pa3-frequency-title">
      <h2 id="pa3-frequency-title" className="pa3-page-title" tabIndex={-1}>
        Frequência do aluno
      </h2>
      {/* One sentence about the absences, first (owner decisions 22/10/2026); none, nothing. */}
      {year?.comment ? <FrequencyCommentV3 comment={year.comment} /> : null}
      {year && totals ? (
        <FrequencyMonthV3
          data={{
            ...(year.months.find((item) => item.month === month) ?? emptyMonthV3(month)),
            today: year.today,
            year: year.year,
            lastReadAt: year.lastReadAt,
          }}
          totals={totals}
          academicYear={academicYear}
          today={today}
          month={month}
          current={current}
          firstMonth={firstMonth}
          onMonth={(next) => setChosenMonth(next >= current ? null : next)}
          daysOff={year.daysOff}
          bells={year.bells}
          grid={year.grid}
          countdown={<SchoolYearCountdownV3 schoolYear={year.schoolYear ?? null} />}
        />
      ) : (
        <FrequencyStatusV3 error={load.error} onLogin={onLogin} onRetry={load.retry} />
      )}
    </section>
  );
}

/** The sentence for the family: a warning in amber, a good news in green. */
function FrequencyCommentV3({ comment }: Readonly<{ comment: NonNullable<FrequencyYearSummaryV2['comment']> }>) {
  const Icon = comment.tone === 'alert' ? TriangleAlert : PartyPopper;
  return (
    <Alert
      status={comment.tone === 'alert' ? 'danger' : 'success'}
      className="pa3-comment"
      role={comment.tone === 'alert' ? 'alert' : 'status'}
    >
      <Alert.Indicator>
        <Icon size={20} aria-hidden="true" />
      </Alert.Indicator>
      <Alert.Content>
        <Alert.Title>{comment.text}</Alert.Title>
      </Alert.Content>
    </Alert>
  );
}

/**
 * How long until the school year ends (owner request 22/10/2026), with the same split-flap clock as
 * the portal's opening countdown. It runs to the end of the last school day of the calendar marked
 * in the ADM, and says how many school days are left. Nothing while no calendar is marked.
 */
function SchoolYearCountdownV3({ schoolYear }: Readonly<{ schoolYear: NonNullable<FrequencyYearSummaryV2['schoolYear']> | null }>) {
  if (!schoolYear?.lastDay) return null;
  const [year, month, day] = schoolYear.lastDay.split('-');
  return (
    <Card className="pa3-card pa3-countdown">
      <PortalCountdownV1
        at={`${schoolYear.lastDay}T23:59:59-03:00`}
        title="O ano letivo termina em"
        when={`${day}/${month}/${year}`}
        done="O ano letivo terminou."
      />
      <p className="pa3-countdown-days">
        {schoolYear.remaining === 1
          ? 'Falta 1 dia letivo'
          : `Faltam ${schoolYear.remaining} dias letivos`}{' '}
        de {schoolYear.schoolDays}.
      </p>
    </Card>
  );
}

/** A month the year's answer has nothing for (before the student's first day). */
const emptyMonthV3 = (month: string): FrequencySummaryV2 => ({
  contractVersion: 2,
  state: 'ready',
  month,
  absences: null,
  justified: null,
  denominator: null,
  percentage: null,
  coverage: 'unavailable',
  observedAt: null,
  receivedAt: null,
  marks: [],
  conflicts: 0,
  days: [],
});

/** The month's name and its arrows (owner request 21/10/2026: the month bar is gone). */
function MonthHeadV3({
  month,
  canBack,
  canForward,
  go,
}: Readonly<{
  month: string;
  canBack: boolean;
  canForward: boolean;
  go: (step: number) => void;
}>) {
  return (
    <Card.Header className="pa3-card-head">
      <Card.Title aria-live="polite">{monthLabel(month)}</Card.Title>
      <div className="pa3-month-arrows">
        <Button isIconOnly size="sm" variant="secondary" aria-label="Mês anterior" isDisabled={!canBack} onPress={() => go(-1)}>
          <ChevronLeft size={18} aria-hidden="true" />
        </Button>
        <Button isIconOnly size="sm" variant="secondary" aria-label="Próximo mês" isDisabled={!canForward} onPress={() => go(1)}>
          <ChevronRight size={18} aria-hidden="true" />
        </Button>
      </div>
    </Card.Header>
  );
}

/** One month, drawn from the server's answer. */
function FrequencyMonthV3({
  data,
  totals,
  academicYear,
  today,
  month,
  current,
  firstMonth,
  onMonth,
  countdown,
  daysOff = [],
  bells = null,
  grid = [],
}: Readonly<{
  data: FrequencySummaryV2;
  /** The ring: the whole year so far. */
  totals: RingTotalsV3;
  academicYear: number;
  today: string;
  month: string;
  current: string;
  firstMonth: string;
  onMonth: (month: string) => void;
  /** The school year's countdown, under the year at a glance. */
  countdown?: ReactNode;
  /** The days without school the ADM calendar names (owner decision 23/10/2026: say why). */
  daysOff?: readonly SchoolDayOffV1[];
  /** Each lesson's time by shift and weekday (ADM) and the week's subjects, for an absence. */
  bells?: FrequencyYearSummaryV2['bells'];
  grid?: FrequencyYearSummaryV2['grid'];
}>) {
  const offByDate = useMemo(() => new Map(daysOff.map((day) => [day.date, day])), [daysOff]);
  /**
   * A lesson's time and subject on a date (owner decision 23/10/2026: "Faltou na 3ª aula
   * (08:50–09:45), MATEMATICA"): only from the day the current bells began (22/06), never for an
   * older day whose times or grid may have been different.
   */
  const lessonInfo = (date: string, shift: string, slot: number) => {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const bellShift = bellShiftOfLabelV1(shift);
    if (date < BELLS_VALID_FROM_V1 || weekday < 1 || weekday > 5 || !bellShift) return null;
    const time = bells ? bellLessonV1(bells[bellShift][weekday as 1 | 2 | 3 | 4 | 5], slot) : null;
    const subject =
      grid
        .find((item) => item.shift === bellShift)
        ?.lessons.find((lesson) => lesson.weekday === weekday && lesson.slot === slot)?.subject ?? null;
    const official = subject ? officialSubjectV1(subject) : null;
    return time || official ? { time: time ? `${time.start}–${time.end}` : null, subject: official } : null;
  };
  const monthCount = useMemo(() => frequencyCountV2(data, today), [data, today]);
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
  /**
   * The lessons of a date. A date with marks but no lesson day (a server without `days`, or a lesson
   * day the server left out) still shows its marks, as a reading not complete yet.
   */
  const lessonsAt = (date: string): ShiftLessonsV3[] | undefined => {
    const lessons = lessonsByDay.get(date);
    if (lessons) return lessons;
    const marks = marksByDay.get(date);
    if (!marks) return undefined;
    const shifts = [...new Set(marks.map((mark) => mark.shift))].sort((a, b) => a.localeCompare(b));
    return shifts.map((shift) => ({
      shift,
      slots: marks.filter((mark) => mark.shift === shift).map((mark) => mark.slot).sort((a, b) => a - b),
      complete: false,
    }));
  };
  const dayAt = (date: string) => {
    const lessons = lessonsAt(date);
    return lessons ? dayOf(lessons, marksByDay.get(date) ?? []) : null;
  };
  const [picked, setPicked] = useState<string | null>(null);
  const go = (step: number) => {
    onMonth(shiftMonth(month, step));
    setPicked(null);
  };
  // Only the calendar card swipes, like the arrows in its head.
  const swipe = useMonthSwipeV3(go, month > firstMonth, month < current);

  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const stateOf = (date: string): DayStateV3 => {
    const lessons = lessonsAt(date);
    // A holiday, a recess or an event without school (ADM calendar), past or to come: it says why.
    if (offByDate.has(date) && !lessons) return 'holiday';
    if (date > today) return 'future';
    // No lesson day: never "sem aula" for today (the first reading of the day may not have come
    // yet), and only in a month read in full for the other days.
    if (!lessons) return date !== today && monthCount.reliable ? 'off' : 'unknown';
    // A past day not read in full is only "leitura incompleta", whatever marks it has so far: a
    // colour would be worked out on part of its lessons, and the ring does not count it yet.
    if (date < today && !lessons.every((item) => item.complete)) return 'pending';
    const day = dayOf(lessons, marksByDay.get(date) ?? []);
    // Today with an absence keeps its colour (owner decision 21/10/2026); without, it is still open.
    if (day.kind !== 'clear') return day.kind;
    return date < today ? 'clear' : 'pending';
  };
  const ariaOf = (date: string, state: DayStateV3) => {
    const day = dayAt(date);
    const isDay = date === today;
    const todayNote = isDay ? ' (hoje, dia em andamento: conta a partir de amanhã)' : '';
    const text: Record<DayStateV3, string> = {
      clear: 'nenhuma falta registrada',
      missed: day ? daySentence(day, isDay) : '',
      pending: isDay ? 'aulas a confirmar' : 'leitura incompleta',
      off: 'sem aula',
      holiday: offByDate.has(date) ? `sem aula, ${schoolDayOffLabelV1(offByDate.get(date)!)}` : 'sem aula',
      unknown: isDay ? 'nenhuma aula lida até agora' : 'sem dados',
      future: 'data futura, frequência ainda não disponível',
    };
    return `${dayLabel(date)}: ${text[state]}${todayNote}`;
  };
  // Only a day with an absence, or one still open, is highlighted and opens.
  const isPickable = (state: DayStateV3) => state === 'missed' || state === 'pending';
  // A day without absence opens too (owner request 22/10/2026): a parent whose child never misses
  // can still see that day's lessons, every one "Sem falta". It is never chosen at first.
  // A day without school opens too, to say why (owner decision 23/10/2026).
  const opens = (state: DayStateV3) => isPickable(state) || state === 'clear' || state === 'holiday';
  // At first, the latest day with a mark that opens, so the page never selects a day it cannot show.
  const firstPick =
    [...marksByDay.keys()]
      .sort((a, b) => Number(a > b) - Number(a < b))
      .reverse()
      .find((date) => date <= today && isPickable(stateOf(date))) ?? null;
  const selected = picked && picked.startsWith(month) ? picked : firstPick;
  const selectedLessons = selected ? (lessonsAt(selected) ?? []) : [];
  const selectedDay = selected ? dayAt(selected) : null;
  const selectedOff = selected && !selectedDay ? (offByDate.get(selected) ?? null) : null;
  const markAt = new Map((selected ? (marksByDay.get(selected) ?? []) : []).map((mark) => [lessonKey(mark.shift, mark.slot), mark]));
  const isToday = selected === today;
  // Today, or a past day not read in full: more marks may still come, so nothing is final yet.
  const isOpen = isToday || !selectedLessons.every((group) => group.complete);

  return (
    <>

      {/*
        The year at a glance (owner requests 21–22/10/2026): a ring of the school days counted so
        far this year, by kind. No ruler and no limit here (owner decision 22/10/2026: a limit shown
        to everyone reads as freedom to miss); the limit only appears in the warning at the top,
        when there is a risk.
      */}
      <Card className="pa3-card pa3-summary">
        <DayRingV3 totals={totals} label={`Ano letivo ${academicYear}`} />
      </Card>

      {countdown}
      <Card className="pa3-card pa3-month" {...swipe}>
        <MonthHeadV3 month={month} canBack={month > firstMonth} canForward={month < current} go={go} />
        <ul className="pa3-legend" aria-label="Legenda">
          <li><span className="pa3-dot pa3-kind--missed" data-tone="3" /> Faltou o dia todo</li>
          {/* Light red (owner request 21/10/2026): absent in some of the day's lessons. */}
          <li><span className="pa3-dot pa3-kind--missed" data-tone="1" /> Faltou algumas aulas</li>
          <li><span className="pa3-dot pa3-kind--missed is-justified" data-tone="3" /> Justificada</li>
          {/* A day without absence (owner request 23/10/2026): a white square, as on the calendar. */}
          <li><span className="pa3-dot pa3-dot--clear" /> Sem falta</li>
          {/* A holiday or recess (owner decision 23/10/2026): tap it to see why there was no school. */}
          {daysOff.some((day) => day.date.startsWith(month)) ? (
            <li><span className="pa3-dot pa3-dot--holiday" /> Feriado ou recesso</li>
          ) : null}
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
            const justified = state === 'missed' && (dayAt(date)?.justified ?? false);
            return (
              <button
                key={date}
                type="button"
                className={
                  'pa3-day pa3-day--' + state + ' pa3-kind--' + state +
                  (justified ? ' is-justified' : '') +
                  (selected === date ? ' is-selected' : '') +
                  (date === today ? ' is-today' : '')
                }
                disabled={!opens(state)}
                aria-pressed={selected === date}
                aria-label={ariaOf(date, state)}
                data-tone={state === 'missed' ? toneLevelOf(dayAt(date)) : undefined}
                onClick={() => setPicked(date)}
              >
                <span className="pa3-day-number">{index + 1}</span>
                {date === today ? <span className="pa3-day-today">HOJE</span> : null}
              </button>
            );
          })}
        </div>
      </Card>

      {selected && selectedOff ? (
        <Card className="pa3-card pa3-day-detail" aria-live="polite">
          <Card.Title className="pa3-day-detail-title">{dayLabel(selected)}</Card.Title>
          <Alert status="default" className="pa3-day-off">
            <Alert.Indicator>
              <CalendarOff size={18} aria-hidden="true" />
            </Alert.Indicator>
            <Alert.Content>
              <Alert.Title>Sem aula</Alert.Title>
              <Alert.Description>{schoolDayOffLabelV1(selectedOff)}</Alert.Description>
            </Alert.Content>
          </Alert>
        </Card>
      ) : null}

      {selected && selectedDay ? (
        <Card className="pa3-card pa3-day-detail" aria-live="polite">
          <Card.Title className="pa3-day-detail-title">
            {dayTitle(selected, today)}
          </Card.Title>
          {/* Today is always open; a past day is open while its reading is incomplete. */}
          {isOpen ? (
            <Chip size="sm" variant="soft" color="warning" className="pa3-today-note">
              {isToday ? 'Dia em andamento · conta a partir de amanhã' : 'Leitura incompleta · conta quando o diário for lido'}
            </Chip>
          ) : null}
          <p className="pa3-day-detail-sub">{daySentence(selectedDay, isOpen)}</p>
          {selectedLessons.map((group) => {
            const label = shiftLabel(group.shift);
            return (
              <div key={group.shift} className="pa3-shift">
                {label && selectedLessons.length > 1 ? <h4 className="pa3-shift-title">{label}</h4> : null}
                <ol className="pa3-lessons" data-count={group.slots.length}>
                  {group.slots.map((slot) => {
                    const mark = markAt.get(lessonKey(group.shift, slot));
                    // Today, or in a reading not complete, a lesson without a mark is still to be confirmed.
                    let state: LessonStateV3;
                    if (mark?.mark === 'X') {
                      state = 'absent';
                    } else if (mark?.mark === 'J') {
                      state = 'justified';
                    } else if (isToday || !group.complete) {
                      state = 'pending';
                    } else {
                      state = 'clear';
                    }
                    // Its time and subject inside the tile (owner request 23/10/2026), when known.
                    const info = lessonInfo(selected, group.shift, slot);
                    return (
                      <li key={slot} className={'pa3-lesson pa3-lesson--' + state}>
                        <span className="pa3-lesson-icon" aria-hidden="true">
                          {LESSON_ICON[state]}
                        </span>
                        <span className="pa3-lesson-name">{slot}ª aula</span>
                        {info?.time ? <span className="pa3-lesson-time">{info.time}</span> : null}
                        {info?.subject ? <span className="pa3-lesson-subject">{info.subject}</span> : null}
                        <span className="pa3-lesson-state">
                          {LESSON_STATE_LABEL[state]}
                        </span>
                      </li>
                    );
                  })}
                </ol>
                {label && selectedLessons.length === 1 ? <p className="pa3-shift-foot">{label} · {plural(group.slots.length, 'aula', 'aulas')}</p> : null}
              </div>
            );
          })}
        </Card>
      ) : null}

      {/* The last reading of the class's diary (owner request 21/10/2026: "Atualizado em"),
          unchanged readings included; none is invented when the server has none. */}
      {data.lastReadAt ? (
        <p className="pa3-footnote">
          Atualizado em{' '}
          {new Date(data.lastReadAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bahia' })}
        </p>
      ) : null}
    </>
  );
}
