import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, Clock3, FileCheck2, X } from 'lucide-react';
import type { FrequencySummaryV2 } from '../../../shared/attendance-contracts/frequency-v2';
import { previewTodayV3 } from './demo-data-v3';

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
 * MERGE (portal real): this page still reads the invented demo synchronously. Before it replaces
 * src/features/student-portal/frequency/student-frequency-v2.tsx, see the "MERGE" notes below and
 * the PR's checklist: real client (createStudentFrequencyClientV2, async, loading/error/session
 * states), the showFrequency gate, the school's "today" and the year's counts from the server.
 */
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const WEEKDAYS_SHORT = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const WEEKDAYS_LONG = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
/**
 * The school year shown (2026). The API only accepts months of 2026 (frequency-v2 monthly-summary);
 * after December the page stays on December instead of asking for a month it would refuse.
 * MERGE: take both ends from the student's academic year (profile.link.academicYear), not fixed.
 */
const FIRST_MONTH = '2026-02';
const LAST_MONTH = '2026-12';
/** Attendance required over the whole year (LDB, art. 24, VI), counted in lessons. */
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

/**
 * One sentence a parent reads: only counts the diary records, never what they might mean. `open`:
 * today, or a past day not read in full yet — more marks may still come, so nothing is final.
 */
function daySentence(day: DayV3, open: boolean) {
  const reason = day.justified ? ' (justificada)' : day.missed.some((mark) => mark.mark === 'J') ? ' (parte justificada)' : '';
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
const toneLevelOf = (day: DayV3 | null) => (!day || day.share <= 0 ? 0 : day.share >= 1 ? 3 : 1);

/** Lessons and absences (X) of days already over; `reliable`: nothing of them is still unknown. */
type CountV3 = { lessons: number; absences: number; reliable: boolean };
/**
 * A month's counts by the owner's rule, worked out here from the diary itself (`days` and `marks`)
 * rather than from the server's totals: lessons are the positions of the days already over (today
 * never counts), absences their X marks, a J is not taken off. Reliable when every one of those
 * days was read in full, no conflict is open and every mark of them has its lesson day.
 *
 * MERGE: the server's withLessonDaysV2 (server/attendance/service-v2.ts) still counts TODAY in
 * `denominator`/`absences`/`percentage` and lets today's unfinished reading make the whole month
 * 'incomplete'. Until the server applies this rule itself (and sends the school's today), keep
 * counting here and never show its `percentage`.
 */
function monthCountOf(data: FrequencySummaryV2, today: string): CountV3 {
  const lessonsOver = new Set(
    (data.days ?? []).filter((day) => day.date < today).flatMap((day) => day.slots.map((slot) => `${day.date}|${lessonKey(day.shift, slot)}`)),
  );
  const marksOver = data.marks.filter((mark) => mark.date < today);
  return {
    lessons: lessonsOver.size,
    absences: marksOver.filter((mark) => mark.mark === 'X').length,
    reliable:
      data.conflicts === 0 &&
      (data.days ?? []).every((day) => day.date >= today || day.complete) &&
      marksOver.every((mark) => lessonsOver.has(`${mark.date}|${lessonKey(mark.shift, mark.slot)}`)),
  };
}
/**
 * The year so far (owner request 21/10/2026: "a régua sobre o ano"). The law's 75% is over all
 * the year's lessons, so the ruler adds up every month from the first one to now. A month with
 * nothing at all (before the student arrived, after they left: 14 and 30 real students on
 * 21/10/2026) adds nothing; one month still unknown leaves the year unknown (null).
 *
 * MERGE: asking the API for every month (up to 11 requests) on each visit is too much; the server
 * should send the year's lessons and absences (same rule, today excluded) in one answer.
 */
function yearOf(read: (month: string) => FrequencySummaryV2, current: string, today: string): CountV3 | null {
  let lessons = 0;
  let absences = 0;
  for (let month = FIRST_MONTH; month <= current; month = shiftMonth(month, 1)) {
    const count = monthCountOf(read(month), today);
    if (!count.reliable) return null;
    lessons += count.lessons;
    absences += count.absences;
  }
  return lessons ? { lessons, absences, reliable: true } : null;
}
/**
 * The percentage as shown: a whole number rounded DOWN from the exact counts (owner decision
 * 20/10/2026: 74,97% never reads as 75%). Never from a figure already rounded to one decimal.
 */
const shownPercent = ({ lessons, absences }: CountV3) => Math.floor((100 * (lessons - absences)) / lessons);
/** Below the legal minimum, compared in whole numbers so no rounding can lift it. */
const belowMinimum = ({ lessons, absences }: CountV3) => 100 * (lessons - absences) < MINIMUM_PERCENT * lessons;

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
function DayRingV3({ totals, monthName }: { totals: RingTotalsV3; monthName: string }) {
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
      aria-label={`${monthName}, ${plural(totals.days, 'dia de aula contado', 'dias de aula contados')}: ${RING_KINDS_V3.map((kind) => plural(totals[kind.kind], kind.one, kind.many)).join(', ')}`}
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

/**
 * Today, kept current while the page stays open (owner request 21/10/2026): a phone left on the
 * portal overnight moves "HOJE" (and, on the 1st, the month) when the parent comes back to it, and
 * at midnight. The school's clock: America/Bahia, always UTC−3 (no daylight saving since 2012).
 * MERGE: start from the school's "today" sent by the server (the timezone of the collection
 * agenda, frequency-v2 schedule), so a phone with a wrong clock never moves "HOJE".
 */
const SCHOOL_UTC_OFFSET_MS = -3 * 3_600_000;
const DAY_MS = 86_400_000;
export function useTodayV3() {
  const [today, setToday] = useState(previewTodayV3);
  useEffect(() => {
    const check = () => setToday(previewTodayV3());
    const untilMidnight = () => DAY_MS - ((Date.now() + SCHOOL_UTC_OFFSET_MS) % DAY_MS) + 1_000;
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

export function FrequencyPageV3({ read }: { read: (month: string, today: string) => FrequencySummaryV2 }) {
  const today = useTodayV3();
  // The current month, kept inside the school year: from January 2027 the page stays on December.
  const todayMonth = today.slice(0, 7);
  const current = todayMonth > LAST_MONTH ? LAST_MONTH : todayMonth < FIRST_MONTH ? FIRST_MONTH : todayMonth;
  // null: the current month, which follows the calendar (a new month on the 1st); a month the
  // parent picked stays until they leave the page.
  const [chosenMonth, setChosenMonth] = useState<string | null>(null);
  const month = chosenMonth && chosenMonth < current ? chosenMonth : current;
  // One clock per render: the data is read with the page's own `today`, so the ring, the calendar
  // and the counts never disagree around midnight. MERGE: the real client is async
  // (createStudentFrequencyClientV2.read(month, signal)): fetch per month with loading, error,
  // expired-session (401 → sign in again) and 'unavailable' states instead of this synchronous read.
  const data = useMemo(() => read(month, today), [read, month, today]);
  const monthCount = useMemo(() => monthCountOf(data, today), [data, today]);
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
  // The days that count: over (today is still going on) and read in full.
  const countedDays = useMemo(
    () =>
      [...lessonsByDay.entries()]
        .filter(([date, lessons]) => date < today && lessons.every((item) => item.complete))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, lessons]) => ({ date, day: dayOf(lessons, marksByDay.get(date) ?? []) })),
    [lessonsByDay, marksByDay, today],
  );
  const totals: RingTotalsV3 = {
    days: countedDays.length,
    clear: countedDays.filter(({ day }) => day.kind === 'clear').length,
    full: countedDays.filter(({ day }) => day.kind === 'missed' && !day.justified && day.share >= 1).length,
    partial: countedDays.filter(({ day }) => day.kind === 'missed' && !day.justified && day.share < 1).length,
    justified: countedDays.filter(({ day }) => day.justified).length,
  };
  const yearCount = useMemo(() => yearOf((other) => read(other, today), current, today), [read, current, today]);
  const yearTone = yearCount === null ? 'none' : belowMinimum(yearCount) ? 'low' : 'good';
  const [picked, setPicked] = useState<string | null>(null);
  const go = (step: number) => {
    const next = shiftMonth(month, step);
    setChosenMonth(next >= current ? null : next);
    setPicked(null);
  };
  // Only the calendar card swipes, like the arrows in its head.
  const swipe = useMonthSwipeV3(go, month > FIRST_MONTH, month < current);

  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const stateOf = (date: string): DayStateV3 => {
    if (date > today) return 'future';
    const lessons = lessonsAt(date);
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
      unknown: isDay ? 'nenhuma aula lida até agora' : 'sem dados',
      future: 'data futura, frequência ainda não disponível',
    };
    return `${dayLabel(date)}: ${text[state]}${todayNote}`;
  };
  // Only a day with an absence, or one still open, is highlighted and opens.
  const isPickable = (state: DayStateV3) => state === 'missed' || state === 'pending';
  // At first, the latest day with a mark that opens, so the page never selects a day it cannot show.
  const firstPick =
    [...marksByDay.keys()]
      .sort()
      .reverse()
      .find((date) => date <= today && isPickable(stateOf(date))) ?? null;
  const selected = picked && picked.startsWith(month) ? picked : firstPick;
  const selectedLessons = selected ? (lessonsAt(selected) ?? []) : [];
  const selectedDay = selected ? dayAt(selected) : null;
  const markAt = new Map((selected ? (marksByDay.get(selected) ?? []) : []).map((mark) => [lessonKey(mark.shift, mark.slot), mark]));
  const isToday = selected === today;
  // Today, or a past day not read in full: more marks may still come, so nothing is final yet.
  const isOpen = isToday || !selectedLessons.every((group) => group.complete);

  return (
    <section className="pa3-frequency" aria-labelledby="pa3-frequency-title">
      <h1 id="pa3-frequency-title" className="pa3-page-title" tabIndex={-1}>
        Frequência
      </h1>

      {/*
        The month at a glance (owner request 21/10/2026: "a rosca do A com a régua do B"): a ring
        of the month's counted school days by kind, and under it a 0–100% ruler of the YEAR so far
        with the law's 75% minimum. Always the same height, data or not, so the calendar below
        never moves when the month changes (owner request 21/10/2026).
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
            {/* Whole number, rounded down from the exact counts (owner decision 20/10/2026). */}
            <strong>{yearCount === null ? 'em apuração' : `${shownPercent(yearCount)}%`}</strong>
          </p>
          <div
            className="pa3-ruler"
            role="img"
            aria-label={
              yearCount === null
                ? 'Presença do ano ainda em apuração'
                : `${shownPercent(yearCount)}% de presença nas aulas do ano até agora; o mínimo do ano é ${MINIMUM_PERCENT}%`
            }
          >
            <span
              className="pa3-ruler-fill"
              style={{ width: `${yearCount === null ? 0 : (100 * (yearCount.lessons - yearCount.absences)) / yearCount.lessons}%` }}
            />
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
          <li><span className="pa3-dot pa3-kind--missed" data-tone="3" /> Falta total</li>
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
                disabled={!isPickable(state)}
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
      </div>

      {selected && selectedDay ? (
        <div className="pa3-card pa3-day-detail" aria-live="polite">
          {/* Today and yesterday say so: "Hoje, quarta-feira, 21 de outubro" (owner request 21/10/2026), on one line. */}
          <h2 className="pa3-day-detail-title">
            {selected === today
              ? `Hoje, ${dayLabel(selected).toLowerCase()}`
              : selected === dayBefore(today)
                ? `Ontem, ${dayLabel(selected).toLowerCase()}`
                : dayLabel(selected)}
          </h2>
          {isToday ? (
            <p className="pa3-today-note">Dia em andamento · conta a partir de amanhã</p>
          ) : isOpen ? (
            <p className="pa3-today-note">Leitura incompleta · conta quando o diário for lido</p>
          ) : null}
          <p className="pa3-day-detail-sub">{daySentence(selectedDay, isOpen)}</p>
          {selectedLessons.map((group) => {
            const label = shiftLabel(group.shift);
            return (
              <div key={group.shift} className="pa3-shift">
                {label && selectedLessons.length > 1 ? <h3 className="pa3-shift-title">{label}</h3> : null}
                <ol className="pa3-lessons" data-count={group.slots.length}>
                  {group.slots.map((slot) => {
                    const mark = markAt.get(lessonKey(group.shift, slot));
                    // Today, or in a reading not complete, a lesson without a mark is still to be confirmed.
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

      {/*
        Only a time the server gave: none is invented when the month has no reading. MERGE: the
        server's receivedAt is the last time a MARK of this student changed, not the last reading
        of the diary (a month with no absence has none); send the class's last reading instead,
        or this line says "Atualizado em 07/10" for a diary read today.
      */}
      {data.receivedAt ? (
        <p className="pa3-footnote">
          Atualizado em {new Date(data.receivedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
        </p>
      ) : null}
    </section>
  );
}
