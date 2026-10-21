import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { Tabs } from '@heroui/react';
import { CalendarX2, Check, ChevronRight, Clock3, FileCheck2, X } from 'lucide-react';
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
const shortDay = (date: string) => {
  const parsed = new Date(`${date}T12:00:00Z`);
  return `${WEEKDAYS_LONG[parsed.getUTCDay()]!.slice(0, 3)} ${pad(parsed.getUTCDate())}/${pad(parsed.getUTCMonth() + 1)}`;
};
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

function toneOf(data: FrequencySummaryV2) {
  // Only a reliable month has a percentage worth judging (the server gives none otherwise).
  if (data.coverage !== 'reliable' || data.percentage === null) {
    return data.coverage === 'unavailable'
      ? ({ tone: 'none', text: 'Sem dados deste mês' } as const)
      : ({ tone: 'none', text: 'Ainda em apuração' } as const);
  }
  if (data.percentage < MINIMUM_PERCENT) return { tone: 'low', text: `abaixo de ${MINIMUM_PERCENT}%` } as const;
  if (data.percentage < 85) return { tone: 'warn', text: `perto de ${MINIMUM_PERCENT}%` } as const;
  return { tone: 'good', text: 'boa' } as const;
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
    missed: countedDays.filter(({ day }) => day.kind === 'missed' && !day.justified).length,
    justified: countedDays.filter(({ day }) => day.justified).length,
  };
  const daysWithMarks = [...marksByDay.keys()].sort().reverse();
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked && picked.startsWith(month) ? picked : (daysWithMarks[0] ?? null);
  const tone = toneOf(data);
  const months = Array.from({ length: Number(current.slice(5)) - Number(FIRST_MONTH.slice(5)) + 1 }, (_, index) =>
    monthKey(2026, index + Number(FIRST_MONTH.slice(5))),
  );
  // Keep the chosen month centred in the bar (inline only, so the page itself never scrolls).
  const monthTabs = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    const smooth = mounted.current && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    mounted.current = true;
    const reveal = () => {
      const tab = monthTabs.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      const scroller = tab?.closest<HTMLElement>('.scroll-shadow') ?? tab?.parentElement?.parentElement;
      if (!tab || !scroller) return;
      const offset = tab.offsetLeft - (scroller.clientWidth - tab.offsetWidth) / 2;
      const left = Math.max(0, Math.min(offset, scroller.scrollWidth - scroller.clientWidth));
      scroller.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    };
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(reveal);
    });
    return () => cancelAnimationFrame(frame);
  }, [month]);
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
    const today = date === PREVIEW_TODAY_V3 ? ' (hoje, ainda não entra na conta)' : '';
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

      {/* The months as tabs, exactly like the bar of disciplines on Notas (owner request
          20/10/2026): the chosen one in white and centred, the others a tap or a scroll away. */}
      <div ref={monthTabs} className="pa-subject-bar pa3-month-bar">
        <Tabs
          selectedKey={month}
          onSelectionChange={(key) => {
            setMonth(String(key));
            setPicked(null);
          }}
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="Escolher mês">
              {months.map((key) => (
                <Tabs.Tab id={key} key={key}>
                  {MONTHS[Number(key.slice(5)) - 1]}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      </div>

      {/*
        The month in days, about ABSENCES ONLY (owner request 21/10/2026, option A). A day is "com
        falta" when the diary has at least one absence (X) that day, X and J together included, and
        "com falta justificada" when every absence of the day is justified. No threshold, so no
        absence the diary records disappears from the days. Never "dias sem falta" nor a count of
        school days: sometimes there is no lesson while the students are at school, and the portal
        must not state either (owner decision 21/10/2026). The legal figure stays below, in lessons.
      */}
      <div className={'pa3-summary pa3-summary--' + tone.tone}>
        {totals.days ? (
          <>
            <ul className="pa3-daycounts">
              <li className="pa3-daycount pa3-daycount--absent">
                <strong>{totals.missed}</strong> {totals.missed === 1 ? 'dia com falta' : 'dias com falta'}
              </li>
              {totals.justified ? (
                <li className="pa3-daycount pa3-daycount--justified">
                  <strong>{totals.justified}</strong> {totals.justified === 1 ? 'dia com falta justificada' : 'dias com falta justificada'}
                </li>
              ) : null}
            </ul>
          </>
        ) : (
          <p className="pa3-summary-note">{tone.text}</p>
        )}
        {/* The legal figure stays: the year's minimum is counted in lessons, not in days. */}
        {tone.tone !== 'none' && data.percentage !== null ? (
          <p className="pa3-summary-official">
            {/* Whole number, rounded down (owner decision 20/10/2026): 74,9% never reads as 75%. */}
            <strong>{Math.floor(data.percentage)}%</strong> de presença nas aulas
            <span className="pa3-summary-official-hint"> · o mínimo do ano é {MINIMUM_PERCENT}%</span>
          </p>
        ) : null}
        {data.conflicts > 0 ? (
          <p className="pa3-summary-note">Há {plural(data.conflicts, 'registro', 'registros')} em revisão pela escola neste mês.</p>
        ) : null}
      </div>

      <div className="pa3-card" {...swipe}>
        <div className="pa3-card-head">
          <h2>Dias do mês</h2>
        </div>
        <ul className="pa3-legend" aria-label="Legenda">
          <li><span className="pa3-dot pa3-kind--missed" data-tone="3" /> Com falta</li>
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
          <h2>{dayLabel(selected)}</h2>
          {isToday ? <p className="pa3-today-note">Hoje · entra na conta amanhã</p> : null}
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

      <div className="pa3-card">
        <h2>Dias com falta</h2>
        {daysWithMarks.length === 0 ? (
          <p className="pa3-empty">
            <CalendarX2 size={18} aria-hidden="true" />{' '}
            {reliable ? `Nenhuma falta em ${MONTHS[monthNumber - 1]!.toLowerCase()}.` : 'Nenhuma falta registrada até agora.'}
          </p>
        ) : (
          <ul className="pa3-absence-list">
            {daysWithMarks.map((date) => {
              const day = dayAt(date);
              if (!day) return null;
              return (
                <li key={date}>
                  <button
                    type="button"
                    className={'pa3-absence' + (selected === date ? ' is-selected' : '')}
                    onClick={() => setPicked(date)}
                  >
                    <span className={`pa3-absence-badge pa3-kind--${day.kind}${day.justified ? ' is-justified' : ''}`} data-tone={toneLevelOf(day)} aria-hidden="true" />
                    <span className="pa3-absence-copy">
                      <strong>
                        {shortDay(date)}
                        {date === PREVIEW_TODAY_V3 ? ' · hoje' : ''}
                      </strong>
                      <span>
                        {daySentence(day)}
                        {date === PREVIEW_TODAY_V3 ? ' Ainda não conta.' : ''}
                      </span>
                    </span>
                    <ChevronRight size={18} aria-hidden="true" className="pa3-absence-chevron" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Only a time the server gave: none is invented when the month has no reading. */}
      {data.receivedAt ? (
        <p className="pa3-footnote">
          Atualizado em {new Date(data.receivedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
        </p>
      ) : null}
    </section>
  );
}
