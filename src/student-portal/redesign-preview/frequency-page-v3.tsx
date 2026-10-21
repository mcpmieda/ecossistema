import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { Tabs } from '@heroui/react';
import { CalendarX2, Check, ChevronRight, Clock3, FileCheck2, Hourglass, TriangleAlert, X } from 'lucide-react';
import type { FrequencySummaryV2 } from '../../../shared/attendance-contracts/frequency-v2';
import { PREVIEW_TODAY_V3 } from './demo-data-v3';

/*
 * Frequência in a page of its own (owner request 20/10/2026, preview only): one month at a time,
 * read at a glance. The bar says how present the student was; the calendar shows which days had
 * an absence; tapping a day shows in which lessons. Everything below repeats it as a list.
 */
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const WEEKDAYS_SHORT = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const WEEKDAYS_LONG = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const FIRST_MONTH = '2026-02';
/**
 * Attendance required over the whole year (LDB, art. 24, VI). A month is only compared with it as
 * a reference: one month below it does not fail the year, one above it does not secure it.
 */
const MINIMUM_PERCENT = 75;
const SHIFT_LABELS: Record<string, string> = { MATUTINO: 'Manhã', VESPERTINO: 'Tarde', NOTURNO: 'Noite', INTEGRAL: 'Integral' };

/**
 * absent/justified/clear: a day with lessons, read in full; pending: lessons not fully read yet;
 * off: no lesson that day (weekend, holiday, outside the enrolment); unknown: no reliable reading;
 * future: the day has not happened yet.
 */
type DayStateV3 = 'absent' | 'justified' | 'clear' | 'pending' | 'off' | 'unknown' | 'future';
type MarkV3 = FrequencySummaryV2['marks'][number];
type ShiftLessonsV3 = { shift: string; slots: number[]; complete: boolean };

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
const lessonsText = (slots: readonly number[]) => {
  const names = slots.map((slot) => `${slot}ª`);
  return names.length === 1 ? `${names[0]} aula` : `${names.slice(0, -1).join(', ')} e ${names.at(-1)} aulas`;
};
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** The shift as people say it; an unknown value is left out rather than guessed. */
const shiftLabel = (shift: string) => SHIFT_LABELS[shift.trim().toUpperCase()] ?? null;
/** A lesson is one position of one shift: two shifts may both have a "1ª aula". */
const lessonKey = (shift: string, slot: number) => `${shift}:${slot}`;

function toneOf(data: FrequencySummaryV2) {
  // Only a reliable month has a percentage worth judging (the server gives none otherwise).
  if (data.coverage !== 'reliable' || data.percentage === null) {
    return data.coverage === 'unavailable'
      ? ({ tone: 'none', text: 'Sem dados deste mês' } as const)
      : ({ tone: 'none', text: 'Ainda em apuração' } as const);
  }
  if (data.percentage < MINIMUM_PERCENT) return { tone: 'low', text: `Abaixo de ${MINIMUM_PERCENT}% neste mês` } as const;
  if (data.percentage < 85) return { tone: 'warn', text: `Perto de ${MINIMUM_PERCENT}% neste mês` } as const;
  return { tone: 'good', text: 'Boa frequência neste mês' } as const;
}

/*
 * Presence at a glance (owner review 20/10/2026, "read as a parent"): the month's lessons as one bar,
 * green where the student was in class, amber for justified absences and red for absences, with a
 * flag at 75%. The colours tie each number below to its part of the bar, so no sentence is needed.
 */
function PresenceBarV3({ data }: { data: FrequencySummaryV2 }) {
  const lessons = data.denominator ?? 0;
  const absences = data.absences ?? 0;
  const justified = data.justified ?? 0;
  // Lessons without a recorded absence: the Smecel point means "lesson planned or present", so this is
  // "sem falta", never a confirmed presence (owner decision 20/10/2026).
  const clear = Math.max(0, lessons - absences - justified);
  const share = (count: number) => (lessons ? (count / lessons) * 100 : 0);
  return (
    <div className="pa3-bar-wrap">
      <div className="pa3-bar" role="img" aria-label={`${clear} aulas sem falta, ${justified} faltas justificadas e ${absences} faltas, de ${lessons} aulas no mês; a referência do ano é ${MINIMUM_PERCENT}%`}>
        <span className="pa3-bar-part pa3-bar-part--present" style={{ width: `${share(clear)}%` }} />
        <span className="pa3-bar-part pa3-bar-part--justified" style={{ width: `${share(justified)}%` }} />
        <span className="pa3-bar-part pa3-bar-part--absent" style={{ width: `${share(absences)}%` }} />
        <span className="pa3-bar-minimum" style={{ left: `${MINIMUM_PERCENT}%` }} aria-hidden="true">
          <span className="pa3-bar-flag">{MINIMUM_PERCENT}%</span>
        </span>
      </div>
      <ul className="pa3-counts">
        <li className="pa3-count pa3-count--present"><strong>{clear}</strong> sem falta</li>
        <li className="pa3-count pa3-count--justified"><strong>{justified}</strong> {justified === 1 ? 'justificada' : 'justificadas'}</li>
        <li className="pa3-count pa3-count--absent"><strong>{absences}</strong> {absences === 1 ? 'falta' : 'faltas'}</li>
      </ul>
    </div>
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
  // Lessons of each day, straight from the Smecel diary (data.days), kept per shift: 5 or 6, none on
  // weekends, holidays or outside the enrolment. No configuration anywhere.
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
  const byDay = useMemo(() => {
    const map = new Map<string, MarkV3[]>();
    for (const mark of data.marks) map.set(mark.date, [...(map.get(mark.date) ?? []), mark]);
    for (const list of map.values()) list.sort((a, b) => a.shift.localeCompare(b.shift) || a.slot - b.slot);
    return map;
  }, [data]);
  const countsOf = (date: string) => {
    const marks = byDay.get(date) ?? [];
    return { absent: marks.filter((mark) => mark.mark === 'X').length, justified: marks.filter((mark) => mark.mark === 'J').length };
  };
  const lessonCount = (date: string) => (lessonsByDay.get(date) ?? []).reduce((total, item) => total + item.slots.length, 0);
  const daysWithMarks = [...byDay.keys()].sort().reverse();
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
  // Only the days area swipes: the month bar scrolls sideways on its own (scrolling it to reach a
  // far month must never change the month by itself).
  const swipe = useMonthSwipeV3(go, month > FIRST_MONTH, month < current);

  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const stateOf = (date: string): DayStateV3 => {
    if (date > PREVIEW_TODAY_V3) return 'future';
    const lessons = lessonsByDay.get(date);
    if (!lessons) return reliable ? 'off' : byDay.has(date) ? 'pending' : 'unknown';
    const { absent, justified } = countsOf(date);
    if (absent) return 'absent';
    if (justified) return 'justified';
    // A day only reads "sem falta" when every lesson of it was read and the day is over.
    return date < PREVIEW_TODAY_V3 && lessons.every((item) => item.complete) ? 'clear' : 'pending';
  };
  const ariaOf = (date: string, state: DayStateV3) => {
    const { absent, justified } = countsOf(date);
    const parts = [absent ? plural(absent, 'falta', 'faltas') : '', justified ? plural(justified, 'falta justificada', 'faltas justificadas') : ''].filter(Boolean);
    const today = date === PREVIEW_TODAY_V3 ? ' (hoje, ainda não entra na conta)' : '';
    const text: Record<DayStateV3, string> = {
      absent: parts.join(' e '),
      justified: parts.join(' e '),
      clear: 'sem falta',
      pending: 'leitura incompleta',
      off: 'sem aula',
      unknown: 'sem dados',
      future: 'data futura, frequência ainda não disponível',
    };
    return `${dayLabel(date)}: ${text[state]}${today}`;
  };
  const selectedLessons = selected ? (lessonsByDay.get(selected) ?? []) : [];
  const selectedMarks = selected ? (byDay.get(selected) ?? []) : [];
  const markAt = new Map(selectedMarks.map((mark) => [lessonKey(mark.shift, mark.slot), mark]));
  const selectedTotal = selected ? lessonCount(selected) : 0;
  const selectedCounts = selected ? countsOf(selected) : { absent: 0, justified: 0 };
  const isToday = selected === PREVIEW_TODAY_V3;
  const detailSummary = () => {
    const missed = selectedCounts.absent + selectedCounts.justified;
    if (missed === 0) return 'Nenhuma falta registrada neste dia.';
    const kinds = [
      selectedCounts.absent ? plural(selectedCounts.absent, 'falta', 'faltas') : '',
      selectedCounts.justified ? plural(selectedCounts.justified, 'justificada', 'justificadas') : '',
    ].filter(Boolean).join(' e ');
    return selectedTotal && missed === selectedTotal ? `Todas as ${selectedTotal} aulas: ${kinds}` : `${kinds} em ${plural(selectedTotal, 'aula', 'aulas')}`;
  };

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

      <div className={'pa3-summary pa3-summary--' + tone.tone}>
        <div className="pa3-summary-head">
          <span className="pa3-summary-icon" aria-hidden="true">
            {tone.tone === 'good' ? <Check size={22} strokeWidth={3} /> : tone.tone === 'warn' ? <TriangleAlert size={20} strokeWidth={2.6} /> : tone.tone === 'low' ? <X size={22} strokeWidth={3} /> : <Hourglass size={20} strokeWidth={2.4} />}
          </span>
          <span className="pa3-summary-value">
            {/* Whole number, rounded down (owner decision 20/10/2026): 74,9% never reads as 75%. */}
            {tone.tone === 'none' || data.percentage === null ? '—' : `${Math.floor(data.percentage)}%`}
            <small>de presença</small>
          </span>
          <span className="pa3-summary-status">{tone.text}</span>
        </div>
        {reliable && data.denominator ? <PresenceBarV3 data={data} /> : null}
        {data.conflicts > 0 ? (
          <p className="pa3-summary-note">Há {plural(data.conflicts, 'registro', 'registros')} em revisão pela escola neste mês.</p>
        ) : null}
      </div>

      <div className="pa3-card" {...swipe}>
        <div className="pa3-card-head">
          <h2>Dias do mês</h2>
          <ul className="pa3-legend" aria-label="Legenda">
            <li><span className="pa3-dot pa3-dot--absent" /> Falta</li>
            <li><span className="pa3-dot pa3-dot--justified" /> Justificada</li>
            <li><span className="pa3-dot pa3-dot--clear" /> Sem falta</li>
          </ul>
        </div>
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
            const { absent, justified } = countsOf(date);
            const pickable = state === 'absent' || state === 'justified' || state === 'clear' || state === 'pending';
            return (
              <button
                key={date}
                type="button"
                className={'pa3-day pa3-day--' + state + (selected === date ? ' is-selected' : '') + (date === PREVIEW_TODAY_V3 ? ' is-today' : '')}
                disabled={!pickable}
                aria-pressed={selected === date}
                aria-label={ariaOf(date, state)}
                onClick={() => setPicked(date)}
              >
                <span className="pa3-day-number">{index + 1}</span>
                {/* The badge counts absences only; a day with justified ones only shows those. */}
                {state === 'absent' ? <span className="pa3-day-count">{absent}</span> : state === 'justified' ? <span className="pa3-day-count">{justified}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      {selected ? (
        <div className="pa3-card pa3-day-detail" aria-live="polite">
          <h2>{dayLabel(selected)}</h2>
          {isToday ? <p className="pa3-today-note">Hoje · entra na conta amanhã</p> : null}
          <p className="pa3-day-detail-sub">{detailSummary()}</p>
          {selectedLessons.map((group) => {
            const label = shiftLabel(group.shift);
            return (
              <div key={group.shift} className="pa3-shift">
                {label && selectedLessons.length > 1 ? <h3 className="pa3-shift-title">{label}</h3> : null}
                <ol className="pa3-lessons" data-count={group.slots.length}>
                  {group.slots.map((slot) => {
                    const mark = markAt.get(lessonKey(group.shift, slot));
                    // Today a lesson without a mark is still to be confirmed (the roll call may come
                    // later); a mark already in the Smecel is shown, and the note above says it does
                    // not count until tomorrow.
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
                {label && selectedLessons.length === 1 ? <p className="pa3-shift-foot">{label}</p> : null}
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
              const marks = byDay.get(date)!;
              const { absent, justified } = countsOf(date);
              const total = lessonCount(date);
              const slots = marks.map((mark) => mark.slot);
              return (
                <li key={date}>
                  <button
                    type="button"
                    className={'pa3-absence' + (selected === date ? ' is-selected' : '')}
                    onClick={() => setPicked(date)}
                  >
                    <span className={'pa3-absence-badge pa3-absence-badge--' + (absent ? 'absent' : 'justified')}>
                      {absent || justified}
                    </span>
                    <span className="pa3-absence-copy">
                      <strong>{shortDay(date)}{date === PREVIEW_TODAY_V3 ? ' · hoje' : ''}</strong>
                      <span>
                        {total && marks.length === total ? 'Dia todo' : lessonsText([...new Set(slots)])}
                        {absent && justified ? ` · ${plural(absent, 'falta', 'faltas')} e ${plural(justified, 'justificada', 'justificadas')}` : justified ? ' · justificada' : ''}
                        {date === PREVIEW_TODAY_V3 ? ' · ainda não conta' : ''}
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
