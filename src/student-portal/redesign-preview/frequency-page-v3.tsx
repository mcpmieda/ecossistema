import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { Tabs } from '@heroui/react';
import { CalendarX2, Check, ChevronRight, Clock3, FileCheck2, TriangleAlert, X } from 'lucide-react';
import type { FrequencySummaryV2 } from '../../../shared/attendance-contracts/frequency-v2';
import { PREVIEW_TODAY_V3, type DemoFrequencyV3 } from './demo-data-v3';

/*
 * Frequência in a page of its own (owner request 20/10/2026, preview only): one month at a time,
 * read at a glance. The ring says how present the student was; the calendar shows which days had
 * an absence; tapping a day shows in which lessons. Everything below repeats it as a list.
 */
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const WEEKDAYS_SHORT = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const WEEKDAYS_LONG = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const FIRST_MONTH = '2026-02';
/** Minimum attendance required in the year (LDB, art. 24, VI); shown as a reference line. */
const MINIMUM_PERCENT = 75;

type DayStateV3 = 'absent' | 'justified' | 'clear' | 'weekend' | 'future';
type MarkV3 = FrequencySummaryV2['marks'][number];

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

function toneOf(percentage: number | null) {
  if (percentage === null) return { tone: 'none', text: 'Frequência indisponível' } as const;
  if (percentage < MINIMUM_PERCENT) return { tone: 'low', text: 'Abaixo do mínimo' } as const;
  if (percentage < 85) return { tone: 'warn', text: 'Perto do mínimo' } as const;
  return { tone: 'good', text: 'Frequência boa' } as const;
}

/*
 * Presence at a glance (owner review 20/10/2026, "read as a parent"): the month's lessons as one bar,
 * green where the student was in class, amber for justified absences and red for absences, with a
 * flag at the yearly minimum. The colours tie each number below to its part of the bar, so no
 * sentence is needed to read it.
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
      <div className="pa3-bar" role="img" aria-label={`${clear} aulas sem falta, ${justified} faltas justificadas e ${absences} faltas, de ${lessons} aulas; o mínimo é ${MINIMUM_PERCENT}%`}>
        <span className="pa3-bar-part pa3-bar-part--present" style={{ width: `${share(clear)}%` }} />
        <span className="pa3-bar-part pa3-bar-part--justified" style={{ width: `${share(justified)}%` }} />
        <span className="pa3-bar-part pa3-bar-part--absent" style={{ width: `${share(absences)}%` }} />
        <span className="pa3-bar-minimum" style={{ left: `${MINIMUM_PERCENT}%` }} aria-hidden="true">
          <span className="pa3-bar-flag">mínimo</span>
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

export function FrequencyPageV3({ read }: { read: (month: string) => DemoFrequencyV3 }) {
  const current = PREVIEW_TODAY_V3.slice(0, 7);
  const [month, setMonth] = useState(current);
  const data = useMemo(() => read(month), [read, month]);
  const byDay = useMemo(() => {
    const map = new Map<string, MarkV3[]>();
    for (const mark of data.marks) map.set(mark.date, [...(map.get(mark.date) ?? []), mark]);
    for (const list of map.values()) list.sort((a, b) => a.slot - b.slot);
    return map;
  }, [data]);
  const daysWithMarks = [...byDay.keys()].sort().reverse();
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked && picked.startsWith(month) ? picked : (daysWithMarks[0] ?? null);
  const tone = toneOf(data.percentage);
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
  const canBack = month > FIRST_MONTH;
  const canForward = month < current;
  const go = (step: number) => {
    setMonth((value) => shiftMonth(value, step));
    setPicked(null);
  };
  // A sideways swipe on the month moves to the previous or next one, like the trimesters.
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);
  const swipe = {
    onTouchStart: (event: TouchEvent) => {
      const touch = event.touches[0];
      setTouchStart(touch ? { x: touch.clientX, y: touch.clientY } : null);
    },
    onTouchEnd: (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touchStart || !touch) return;
      const dx = touch.clientX - touchStart.x;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(touch.clientY - touchStart.y) * 1.5) {
        if (dx < 0 && canForward) go(1);
        if (dx > 0 && canBack) go(-1);
      }
      setTouchStart(null);
    },
  };

  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  // Lessons of each day, straight from the Smecel diary (data.days): 5 or 6, none on weekends,
  // holidays or outside the enrolment. No configuration anywhere.
  const lessonsOf = new Map((data.days ?? []).map((day) => [day.date, day.slots]));
  const stateOf = (date: string): DayStateV3 => {
    if (date > PREVIEW_TODAY_V3) return 'future';
    if (!lessonsOf.has(date)) return 'weekend';
    const marks = byDay.get(date);
    if (!marks) return 'clear';
    return marks.some((mark) => mark.mark === 'X') ? 'absent' : 'justified';
  };
  const selectedMarks = selected ? (byDay.get(selected) ?? []) : [];
  const selectedLessons = selected ? (lessonsOf.get(selected) ?? []) : [];

  return (
    <section className="pa3-frequency" aria-labelledby="pa3-frequency-title" {...swipe}>
      <h1 id="pa3-frequency-title" className="pa3-page-title">
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
            {tone.tone === 'good' ? <Check size={22} strokeWidth={3} /> : tone.tone === 'warn' ? <TriangleAlert size={20} strokeWidth={2.6} /> : <X size={22} strokeWidth={3} />}
          </span>
          <span className="pa3-summary-value">
            {data.percentage === null ? '—' : `${Math.floor(data.percentage)}%`}
            <small>de presença</small>
          </span>
          <span className="pa3-summary-status">{tone.text}</span>
        </div>
        {data.denominator ? <PresenceBarV3 data={data} /> : null}
      </div>

      <div className="pa3-card">
        <div className="pa3-card-head">
          <h2>Dias do mês</h2>
          <ul className="pa3-legend" aria-label="Legenda">
            <li><span className="pa3-dot pa3-dot--absent" /> Falta</li>
            <li><span className="pa3-dot pa3-dot--justified" /> Justificada</li>
            <li><span className="pa3-dot pa3-dot--clear" /> Sem falta</li>
          </ul>
        </div>
        <div className="pa3-calendar" role="grid" aria-label={`Dias de ${monthLabel(month)}`}>
          {WEEKDAYS_SHORT.map((day, index) => (
            <span key={index} className="pa3-weekday" role="columnheader" aria-hidden="true">
              {day}
            </span>
          ))}
          {Array.from({ length: firstWeekday }, (_, index) => (
            <span key={'blank' + index} aria-hidden="true" />
          ))}
          {Array.from({ length: daysInMonth }, (_, index) => {
            const date = `${month}-${pad(index + 1)}`;
            const state = stateOf(date);
            const count = byDay.get(date)?.length ?? 0;
            const pickable = state === 'absent' || state === 'justified' || state === 'clear';
            return (
              <button
                key={date}
                type="button"
                role="gridcell"
                className={'pa3-day pa3-day--' + state + (selected === date ? ' is-selected' : '') + (date === PREVIEW_TODAY_V3 ? ' is-today' : '')}
                disabled={!pickable}
                aria-pressed={selected === date}
                aria-label={`${dayLabel(date)}: ${state === 'absent' ? `${count} falta(s)` : state === 'justified' ? 'falta justificada' : state === 'clear' ? 'sem falta' : 'sem aula'}`}
                onClick={() => setPicked(date)}
              >
                <span className="pa3-day-number">{index + 1}</span>
                {state === 'absent' || state === 'justified' ? <span className="pa3-day-count">{count}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      {selected ? (
        <div className="pa3-card pa3-day-detail" aria-live="polite">
          <h2>{dayLabel(selected)}</h2>
          {selected === PREVIEW_TODAY_V3 ? (
            <p className="pa3-today-note">Hoje · entra na conta amanhã</p>
          ) : null}
          <p className="pa3-day-detail-sub">
            {selectedMarks.length === 0
              ? 'Nenhuma falta registrada neste dia.'
              : `${selectedMarks.length === selectedLessons.length ? 'Faltou o dia todo' : `Faltou em ${selectedMarks.length} de ${selectedLessons.length} aulas`} · Manhã`}
          </p>
          <ol className="pa3-lessons">
            {selectedLessons.map((slot, index) => {
              const mark = selectedMarks.find((item) => item.slot === slot);
              // Today a lesson without a mark is still to be confirmed (the roll call may come later).
              const state =
                mark?.mark === 'X' ? 'absent' : mark?.mark === 'J' ? 'justified' : selected === PREVIEW_TODAY_V3 ? 'pending' : 'clear';
              return (
                <li key={index} className={'pa3-lesson pa3-lesson--' + state}>
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
        </div>
      ) : null}

      <div className="pa3-card">
        <h2>Dias com falta</h2>
        {daysWithMarks.length === 0 ? (
          <p className="pa3-empty">
            <CalendarX2 size={18} aria-hidden="true" /> Nenhuma falta em {MONTHS[monthNumber - 1]!.toLowerCase()}.
          </p>
        ) : (
          <ul className="pa3-absence-list">
            {daysWithMarks.map((date) => {
              const marks = byDay.get(date)!;
              const justified = marks.every((mark) => mark.mark === 'J');
              return (
                <li key={date}>
                  <button
                    type="button"
                    className={'pa3-absence' + (selected === date ? ' is-selected' : '')}
                    onClick={() => setPicked(date)}
                  >
                    <span className={'pa3-absence-badge pa3-absence-badge--' + (justified ? 'justified' : 'absent')}>
                      {marks.length}
                    </span>
                    <span className="pa3-absence-copy">
                      <strong>{shortDay(date)}</strong>
                      <span>
                        {marks.length === (lessonsOf.get(date)?.length ?? 0) ? 'Dia todo' : lessonsText(marks.map((mark) => mark.slot))}
                        {justified ? ' · justificada' : ''}
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

      <p className="pa3-footnote">
        Atualizado em {new Date(data.receivedAt ?? `${PREVIEW_TODAY_V3}T12:00:00-03:00`).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
      </p>
    </section>
  );
}
