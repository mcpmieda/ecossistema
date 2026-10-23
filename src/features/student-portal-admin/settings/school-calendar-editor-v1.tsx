import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import {
  SCHOOL_DAY_COUNTS_V1,
  SCHOOL_DAYS_REQUIRED_V1,
  type SchoolCalendarDayV1,
  type SchoolDayKindV1,
} from '../../../../shared/student-portal-contracts/school-calendar-v1';
import { officialCalendar2026V1 } from '../../../../shared/student-portal-contracts/school-calendar-2026-start-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import './school-calendar-editor-v1.css';

/*
 * Calendário escolar (owner decision 22/10/2026): the school's days of the year, marked by hand in
 * the ADM, one calendar for the whole school. Pick a brush, click a day or drag over several, and
 * the count of school days follows at once. The rule is 200 school days and the editor never goes
 * past it (the server refuses it too): at 200, a new school day is not marked until another one is
 * cleared. Holidays, breaks and events carry a short description shown to families.
 */
type BrushV1 = SchoolDayKindV1 | 'clear';
type DayV1 = { kind: SchoolDayKindV1; note?: string };

const BRUSHES: readonly { id: BrushV1; label: string; hint: string }[] = [
  { id: 'letivo', label: 'Dia letivo', hint: 'Dia com aula' },
  { id: 'sabado-letivo', label: 'Sábado letivo', hint: 'Sábado com aula' },
  { id: 'evento-letivo', label: 'Evento com aula', hint: 'Conta como dia letivo' },
  { id: 'feriado', label: 'Feriado', hint: 'Sem aula' },
  { id: 'recesso', label: 'Recesso', hint: 'Sem aula' },
  { id: 'evento', label: 'Evento sem aula', hint: 'Jornada, matrícula…' },
  { id: 'clear', label: 'Apagar', hint: 'Dia sem marcação' },
];
const KIND_LABELS: Record<SchoolDayKindV1, string> = {
  letivo: 'Dia letivo',
  'sabado-letivo': 'Sábado letivo',
  'evento-letivo': 'Evento com aula',
  feriado: 'Feriado',
  recesso: 'Recesso',
  evento: 'Evento sem aula',
};
/** Kinds with a description of their own (a plain school day needs none). */
const DESCRIBED = new Set<SchoolDayKindV1>(['evento-letivo', 'feriado', 'recesso', 'evento']);
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const WEEKDAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const pad = (value: number) => String(value).padStart(2, '0');
const dayLabel = (date: string) => `${date.slice(8)}/${date.slice(5, 7)}`;

const mapOf = (days: readonly SchoolCalendarDayV1[]) =>
  new Map<string, DayV1>(days.map((day) => [day.date, { kind: day.kind, ...(day.note ? { note: day.note } : {}) }]));
const listOf = (days: ReadonlyMap<string, DayV1>): SchoolCalendarDayV1[] =>
  [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, day]) => ({ date, kind: day.kind, ...(day.note && DESCRIBED.has(day.kind) ? { note: day.note } : {}) }));
const schoolDaysIn = (days: ReadonlyMap<string, DayV1>) =>
  [...days.values()].filter((day) => SCHOOL_DAY_COUNTS_V1[day.kind]).length;

/** Consecutive days of the same kind and description, shown as one line ("20/07 a 31/07 · Recesso"). */
function eventsOf(days: ReadonlyMap<string, DayV1>, month: number) {
  const prefix = `2026-${pad(month)}-`;
  const lines: { from: string; to: string; kind: SchoolDayKindV1; note?: string }[] = [];
  for (const [date, day] of [...days.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!date.startsWith(prefix) || !DESCRIBED.has(day.kind)) continue;
    const last = lines.at(-1);
    // Consecutive days, or a weekend between two days of the same break, stay on one line.
    const gap = last ? (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${last.to}T12:00:00Z`)) / 86_400_000 : Infinity;
    if (last && last.kind === day.kind && last.note === day.note && gap <= 3) last.to = date;
    else lines.push({ from: date, to: date, kind: day.kind, ...(day.note ? { note: day.note } : {}) });
  }
  return lines;
}

export function SchoolCalendarEditorV1({
  client,
  canWrite,
}: {
  client: PortalAdminClientV1;
  canWrite: boolean;
}) {
  const [saved, setSaved] = useState<{ version: number; days: Map<string, DayV1> } | null>(null);
  const [draft, setDraft] = useState<Map<string, DayV1> | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [brush, setBrush] = useState<BrushV1>('feriado');
  const [note, setNote] = useState('');
  const painting = useRef(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState('loading');
      try {
        const result = await client.query(
          { contractVersion: 1, operation: 'school-calendar', scope: { kind: 'school', academicYear: 2026 }, page: { limit: 1 } },
          signal,
        );
        if (result.state !== 'school-calendar') throw new PortalClientErrorV1('invalid-response');
        const days = mapOf(result.calendar?.days ?? []);
        setSaved({ version: result.calendar?.version ?? 0, days });
        // Nothing saved yet: the official calendar of 2026 is already on screen, to check and save.
        setDraft(result.calendar ? new Map(days) : mapOf(officialCalendar2026V1()));
        setState('ready');
      } catch {
        if (!signal?.aborted) setState('error');
      }
    },
    [client],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    const stop = () => {
      painting.current = false;
    };
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, []);

  const count = useMemo(() => (draft ? schoolDaysIn(draft) : 0), [draft]);
  const changed = useMemo(
    () => !!draft && !!saved && JSON.stringify(listOf(draft)) !== JSON.stringify(listOf(saved.days)),
    [draft, saved],
  );

  const paint = (date: string) => {
    if (!canWrite || state !== 'ready') return;
    setDraft((current) => {
      if (!current) return current;
      const next = new Map(current);
      const before = next.get(date);
      if (brush === 'clear') next.delete(date);
      else {
        const counts = SCHOOL_DAY_COUNTS_V1[brush] && !(before && SCHOOL_DAY_COUNTS_V1[before.kind]);
        // The rule: never more than 200 school days.
        if (counts && schoolDaysIn(current) >= SCHOOL_DAYS_REQUIRED_V1) {
          setMessage(`O limite é ${SCHOOL_DAYS_REQUIRED_V1} dias letivos. Desmarque um dia letivo antes de marcar outro.`);
          return current;
        }
        const text = note.trim();
        next.set(date, { kind: brush, ...(DESCRIBED.has(brush) && text ? { note: text.slice(0, 80) } : {}) });
      }
      setMessage(null);
      return next;
    });
  };

  const save = async () => {
    if (!draft || !saved || count > SCHOOL_DAYS_REQUIRED_V1) return;
    setState('saving');
    setMessage(null);
    try {
      await client.command({
        contractVersion: 1,
        operation: 'school-calendar-set',
        academicYear: 2026,
        expectedVersion: saved.version,
        idempotencyKey: crypto.randomUUID(),
        days: listOf(draft),
      });
      await load();
      setMessage('Calendário salvo.');
    } catch (error) {
      setState('ready');
      setMessage(
        error instanceof PortalClientErrorV1 && error.state === 'conflict'
          ? 'Outra pessoa alterou o calendário. Recarregue para ver a versão atual.'
          : 'Não foi possível salvar agora. Tente de novo.',
      );
    }
  };

  if (state === 'loading' && !draft)
    return (
      <section className="pa-school-calendar" aria-busy="true">
        <p className="pa-school-calendar__status">Carregando calendário…</p>
      </section>
    );
  if (state === 'error' || !draft || !saved)
    return (
      <section className="pa-school-calendar">
        <p className="pa-school-calendar__status" role="alert">
          Não foi possível carregar o calendário.
        </p>
        <Button size="sm" variant="secondary" onPress={() => void load()}>
          Tentar de novo
        </Button>
      </section>
    );

  const tone = count === SCHOOL_DAYS_REQUIRED_V1 ? 'done' : count > SCHOOL_DAYS_REQUIRED_V1 ? 'over' : 'short';
  return (
    <section className="pa-school-calendar" aria-labelledby="pa-school-calendar-title">
      <header className="pa-school-calendar__head">
        <div>
          <h3 id="pa-school-calendar-title">Calendário escolar 2026</h3>
          <p>Vale para a escola inteira. Escolha um pincel e clique nos dias, ou arraste para marcar vários.</p>
        </div>
        <div className={`pa-school-calendar__count pa-school-calendar__count--${tone}`} role="status">
          <strong>
            {count}
            <small> / {SCHOOL_DAYS_REQUIRED_V1}</small>
          </strong>
          <span>dias letivos</span>
          <span className="pa-school-calendar__bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (100 * count) / SCHOOL_DAYS_REQUIRED_V1)}%` }} />
          </span>
          <em>
            {tone === 'done'
              ? 'Pronto: 200 dias letivos.'
              : tone === 'over'
                ? `${count - SCHOOL_DAYS_REQUIRED_V1} a mais. Desmarque para salvar.`
                : `Faltam ${SCHOOL_DAYS_REQUIRED_V1 - count} para 200.`}
          </em>
        </div>
      </header>

      {saved.version === 0 ? (
        <div className="pa-school-calendar__start" role="note">
          <p>
            Este é o calendário oficial de 2026 da Secretaria de Educação. Confira e clique em
            Salvar calendário para ele valer no Portal.
          </p>
        </div>
      ) : null}

      <div className="pa-school-calendar__tools" role="radiogroup" aria-label="Pincel">
        {BRUSHES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={brush === item.id}
            className={`pa-school-brush pa-school-kind--${item.id}`}
            disabled={!canWrite}
            onClick={() => setBrush(item.id)}
          >
            <span className="pa-school-brush__dot" aria-hidden="true" />
            <span>
              {item.label}
              <small>{item.hint}</small>
            </span>
          </button>
        ))}
      </div>
      {brush !== 'clear' && DESCRIBED.has(brush) ? (
        <label className="pa-school-calendar__note">
          <span>Descrição dos dias marcados agora</span>
          <input
            value={note}
            maxLength={80}
            placeholder="Ex.: Padroeiro da cidade"
            disabled={!canWrite}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      ) : null}
      {message ? (
        <p className="pa-school-calendar__message" role="status">
          {message}
        </p>
      ) : null}

      <div className="pa-school-calendar__months">
        {MONTHS.map((name, index) => {
          const month = index + 1;
          const first = new Date(Date.UTC(2026, index, 1)).getUTCDay();
          const length = new Date(Date.UTC(2026, month, 0)).getUTCDate();
          const events = eventsOf(draft, month);
          const schoolDays = [...draft.entries()].filter(
            ([date, day]) => date.startsWith(`2026-${pad(month)}-`) && SCHOOL_DAY_COUNTS_V1[day.kind],
          ).length;
          return (
            <div key={name} className="pa-school-month">
              <div className="pa-school-month__head">
                <b>{name}</b>
                <small>{schoolDays ? `${schoolDays} letivos` : 'sem aula'}</small>
              </div>
              <div className="pa-school-month__grid">
                {WEEKDAYS.map((day, column) => (
                  <span key={column} className="pa-school-month__weekday" aria-hidden="true">
                    {day}
                  </span>
                ))}
                {Array.from({ length: first }, (_, blank) => (
                  <span key={'b' + blank} aria-hidden="true" />
                ))}
                {Array.from({ length }, (_, offset) => {
                  const date = `2026-${pad(month)}-${pad(offset + 1)}`;
                  const day = draft.get(date);
                  const label = `${dayLabel(date)}: ${day ? KIND_LABELS[day.kind] + (day.note ? ` — ${day.note}` : '') : 'sem marcação'}`;
                  return (
                    <button
                      key={date}
                      type="button"
                      className={'pa-school-day' + (day ? ` pa-school-kind--${day.kind}` : '')}
                      title={label}
                      aria-label={label}
                      disabled={!canWrite || state !== 'ready'}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        painting.current = true;
                        paint(date);
                      }}
                      onPointerEnter={() => {
                        if (painting.current) paint(date);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          paint(date);
                        }
                      }}
                    >
                      {offset + 1}
                    </button>
                  );
                })}
              </div>
              {events.length ? (
                <ul className="pa-school-month__events">
                  {events.map((line) => (
                    <li key={line.from}>
                      <span className={`pa-school-brush__dot pa-school-kind--${line.kind}`} aria-hidden="true" />
                      {dayLabel(line.from)}
                      {line.to !== line.from ? ` a ${dayLabel(line.to)}` : ''} · {line.note ?? KIND_LABELS[line.kind]}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>

      {canWrite ? (
        <footer className="pa-school-calendar__actions">
          <Button
            onPress={() => void save()}
            isDisabled={!changed || state === 'saving' || count > SCHOOL_DAYS_REQUIRED_V1}
          >
            {state === 'saving' ? 'Salvando…' : 'Salvar calendário'}
          </Button>
          <Button variant="secondary" isDisabled={!changed || state === 'saving'} onPress={() => setDraft(new Map(saved.days))}>
            Desfazer alterações
          </Button>
        </footer>
      ) : null}
    </section>
  );
}
