import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Chip,
  CloseButton,
  Input,
  Label,
  ProgressBar,
  Spinner,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from '@heroui/react';
import { Flag } from 'lucide-react';
import {
  SCHOOL_DAY_COUNTS_V1,
  SCHOOL_DAYS_REQUIRED_V1,
  type SchoolCalendarDayV1,
  type SchoolDayKindV1,
} from '../../../../shared/student-portal-contracts/school-calendar-v1';
import { officialCalendar2026V1 } from '../../../../shared/student-portal-contracts/school-calendar-2026-start-v1';
import type { CalendarV1 } from './settings-values-v1';
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
const COUNT_COLOR = { done: 'success', over: 'danger', short: 'warning' } as const;
/** Under the school-day count: ready, how many too many, or how many still missing. */
function countNote(tone: keyof typeof COUNT_COLOR, count: number) {
  if (tone === 'done') return 'Pronto: 200 dias letivos.';
  if (tone === 'over') return `${count - SCHOOL_DAYS_REQUIRED_V1} a mais. Desmarque para salvar.`;
  return `Faltam ${SCHOOL_DAYS_REQUIRED_V1 - count} para 200.`;
}
const pad = (value: number) => String(value).padStart(2, '0');
const dayLabel = (date: string) => `${date.slice(8)}/${date.slice(5, 7)}${date.startsWith("2026") ? "" : `/${date.slice(0, 4)}`}`;

const mapOf = (days: readonly SchoolCalendarDayV1[]) =>
  new Map<string, DayV1>(days.map((day) => [day.date, { kind: day.kind, ...(day.note ? { note: day.note } : {}) }]));
const listOf = (days: ReadonlyMap<string, DayV1>): SchoolCalendarDayV1[] =>
  [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, day]) => ({ date, kind: day.kind, ...(day.note && DESCRIBED.has(day.kind) ? { note: day.note } : {}) }));
const schoolDaysIn = (days: ReadonlyMap<string, DayV1>) =>
  [...days.values()].filter((day) => SCHOOL_DAY_COUNTS_V1[day.kind]).length;

/*
 * Datas principais (owner decision 23/10/2026): the year's main dates are marked on this calendar
 * instead of a separate form. They stay where the server reads them (the school's Calendário
 * policy: grades agenda, term closing, older access windows), as whole days in Brasília time: a
 * start at the day's first moment, an end ("Fim do 1º trimestre", its last day) at the next day's
 * first moment, as they were saved before. A date not marked is pending (a new year starts with
 * all of them pending). The enrollment usually starts in December of the year before.
 */
const MARKERS = [
  { key: 'enrollmentStartsAt', label: 'Início das matrículas', end: false },
  { key: 'yearStartsAt', label: 'Início do ano letivo e do 1º trimestre', end: false },
  { key: 't1EndsAt', label: 'Fim do 1º trimestre', end: true },
  { key: 't2StartsAt', label: 'Início do 2º trimestre', end: false },
  { key: 't2EndsAt', label: 'Fim do 2º trimestre', end: true },
  { key: 't3StartsAt', label: 'Início do 3º trimestre', end: false },
  { key: 't3EndsAt', label: 'Fim do 3º trimestre', end: true },
  { key: 'recoveriesStartAt', label: 'Início das recuperações', end: false },
  { key: 'yearEndsAt', label: 'Fim do ano letivo', end: true },
] as const;
type MarkerKeyV1 = (typeof MARKERS)[number]['key'];
type MarkersV1 = Record<MarkerKeyV1, string | null>;
const LOCAL_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
/** The school day an instant names: an end is the day before its moment (its last day). */
const dateOfInstant = (instant: string | null, end: boolean) =>
  instant ? LOCAL_DATE.format(new Date(Date.parse(instant) - Number(end))) : null;
/** Back to the instant, at the day's first moment in Brasília (UTC−3, no daylight saving). */
const instantOfDate = (date: string, end: boolean) => {
  const day = end ? new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : date;
  return `${day}T03:00:00Z`;
};
const markersOf = (calendar: CalendarV1): MarkersV1 =>
  Object.fromEntries(MARKERS.map(({ key, end }) => [key, dateOfInstant(calendar[key] ?? null, end)])) as MarkersV1;
const shortDate = (date: string) => `${date.slice(8)}/${date.slice(5, 7)}${date.startsWith('2026') ? '' : `/${date.slice(0, 4)}`}`;

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
  onSaved,
}: Readonly<{
  client: PortalAdminClientV1;
  canWrite: boolean;
  /** The main dates were saved in the school's policy: the settings on screen read it again. */
  onSaved?: () => void;
}>) {
  const [saved, setSaved] = useState<{ version: number; days: Map<string, DayV1> } | null>(null);
  const [draft, setDraft] = useState<Map<string, DayV1> | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [brush, setBrush] = useState<BrushV1>('feriado');
  const [note, setNote] = useState('');
  const painting = useRef(false);
  // The school's Calendário policy as read (its version guards the write) and the main dates.
  const [policy, setPolicy] = useState<{ version: number; calendar: CalendarV1; markers: MarkersV1 } | null>(null);
  const [markers, setMarkers] = useState<MarkersV1 | null>(null);
  const [armed, setArmed] = useState<MarkerKeyV1 | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState('loading');
      try {
        const result = await client.query(
          { contractVersion: 1, operation: 'school-calendar', scope: { kind: 'school', academicYear: 2026 }, page: { limit: 1 } },
          signal,
        );
        if (result.state !== 'school-calendar') throw new PortalClientErrorV1('invalid-response');
        const settings = await client.query(
          { contractVersion: 1, operation: 'settings', scope: { kind: 'school', academicYear: 2026 }, page: { limit: 1 } },
          signal,
        );
        if (settings.state !== 'settings') throw new PortalClientErrorV1('invalid-response');
        const read = markersOf(settings.settings.value.calendar);
        setPolicy({ version: settings.settings.version, calendar: settings.settings.value.calendar, markers: read });
        setMarkers({ ...read });
        setArmed(null);
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
  const daysChanged = useMemo(
    () => !!draft && !!saved && JSON.stringify(listOf(draft)) !== JSON.stringify(listOf(saved.days)),
    [draft, saved],
  );
  const markersChanged = !!markers && !!policy && MARKERS.some(({ key }) => markers[key] !== policy.markers[key]);
  const changed = daysChanged || markersChanged;
  const pending = markers ? MARKERS.filter(({ key }) => !markers[key]) : [];
  // In the year's order, as the server requires (an end may share the day of the next start).
  const outOfOrder = useMemo(() => {
    if (!markers) return null;
    let previous = -Infinity;
    for (const { key, label, end } of MARKERS) {
      const date = markers[key];
      if (!date) continue;
      const at = Date.parse(instantOfDate(date, end));
      if (at < previous) return label;
      previous = at;
    }
    return null;
  }, [markers]);
  const markersAt = (date: string) => (markers ? MARKERS.filter(({ key }) => markers[key] === date) : []);
  /** With a main date chosen, a click marks it on that day instead of painting. */
  const place = (date: string) => {
    if (!armed || !canWrite || state !== 'ready') return false;
    if (armed !== 'enrollmentStartsAt' && !date.startsWith('2026-')) return true;
    setMarkers((current) => (current ? { ...current, [armed]: date } : current));
    setMessage(null);
    // The next pending one is ready to be marked, so a new year is filled in one go.
    const next = MARKERS.find(({ key }) => key !== armed && markers && !markers[key]);
    setArmed(next ? next.key : null);
    return true;
  };

  const paint = (date: string) => {
    if (place(date)) return;
    if (!canWrite || state !== 'ready' || !date.startsWith('2026-')) return;
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
    if (!draft || !saved || !markers || !policy || count > SCHOOL_DAYS_REQUIRED_V1 || outOfOrder) return;
    setState('saving');
    setMessage(null);
    try {
      if (daysChanged)
        await client.command({
          contractVersion: 1,
          operation: 'school-calendar-set',
          academicYear: 2026,
          expectedVersion: saved.version,
          idempotencyKey: crypto.randomUUID(),
          days: listOf(draft),
        });
      if (markersChanged) {
        // Only the dates moved here change; every other part of the policy stays as read.
        const calendar = { ...policy.calendar };
        for (const { key, end } of MARKERS) {
          const date = markers[key];
          if (date !== policy.markers[key]) calendar[key] = date ? instantOfDate(date, end) : null;
        }
        await client.command({
          contractVersion: 1,
          operation: 'settings-set',
          scope: { kind: 'school', academicYear: 2026 },
          expectedVersion: policy.version,
          idempotencyKey: crypto.randomUUID(),
          value: { calendar },
          acknowledgeImmediateEffect: true,
        });
        onSaved?.();
      }
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
      <Card className="pa-school-calendar" aria-busy="true">
        <Card.Content className="pa-school-calendar__status">
          <Spinner size="sm" /> Carregando calendário…
        </Card.Content>
      </Card>
    );
  if (state === 'error' || !draft || !saved)
    return (
      <Alert status="danger" className="pa-school-calendar">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Não foi possível carregar o calendário.</Alert.Title>
          <Alert.Description>
            <Button size="sm" variant="secondary" onPress={() => void load()}>
              Tentar de novo
            </Button>
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );

  /** One month: its days (painted with the brush, or marked with a main date) and its lines. */
  const monthOf = (year: number, month: number, name: string) => {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const prefix = `${year}-${pad(month)}-`;
    const events = year === 2026 ? eventsOf(draft, month) : [];
    const marked = MARKERS.flatMap(({ key, label }) => {
      const date = markers?.[key];
      return date?.startsWith(prefix) ? [{ date, label }] : [];
    }).sort((left, right) => left.date.localeCompare(right.date));
    const schoolDays = [...draft.entries()].filter(
      ([date, day]) => date.startsWith(prefix) && SCHOOL_DAY_COUNTS_V1[day.kind],
    ).length;
    // Before the year, only the enrollment can be marked, and only while it is the one chosen.
    const before = year !== 2026;
    let monthNote = 'só matrículas';
    if (!before) monthNote = schoolDays ? `${schoolDays} letivos` : 'sem aula';
    return (
      <Card key={prefix} variant="secondary" className={'pa-school-month' + (before ? ' pa-school-month--before' : '')}>
        <div className="pa-school-month__head">
          <b>{name}</b>
          <Chip size="sm" variant="soft" color={!before && schoolDays ? 'success' : 'default'}>
            {monthNote}
          </Chip>
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
            const date = `${prefix}${pad(offset + 1)}`;
            const day = draft.get(date);
            const flags = markersAt(date);
            const note = day?.note ? ` — ${day.note}` : '';
            const label =
              `${dayLabel(date)}: ${day ? KIND_LABELS[day.kind] + note : 'sem marcação'}` +
              flags.map((flag) => ` · ${flag.label}`).join('');
            return (
              <button
                key={date}
                type="button"
                className={
                  'pa-school-day' + (day ? ` pa-school-kind--${day.kind}` : '') + (flags.length ? ' has-mark' : '')
                }
                title={label}
                aria-label={label}
                disabled={!canWrite || state !== 'ready' || (before && armed !== 'enrollmentStartsAt')}
                onPointerDown={(event) => {
                  event.preventDefault();
                  painting.current = !armed;
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
        {events.length || marked.length ? (
          <ul className="pa-school-month__events">
            {marked.map((line) => (
              <li key={line.label} className="pa-school-month__mark">
                <Flag size={12} aria-hidden="true" />
                {dayLabel(line.date)} · {line.label}
              </li>
            ))}
            {events.map((line) => (
              <li key={line.from}>
                <span className={`pa-school-brush__dot pa-school-kind--${line.kind}`} aria-hidden="true" />
                {dayLabel(line.from)}
                {line.to !== line.from ? ` a ${dayLabel(line.to)}` : ''} · {line.note ?? KIND_LABELS[line.kind]}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    );
  };

  let tone: 'done' | 'over' | 'short';
  if (count === SCHOOL_DAYS_REQUIRED_V1) {
    tone = 'done';
  } else if (count > SCHOOL_DAYS_REQUIRED_V1) {
    tone = 'over';
  } else {
    tone = 'short';
  }
  const armedLabel = MARKERS.find(({ key }) => key === armed)?.label;
  return (
    <Card className="pa-school-calendar" aria-labelledby="pa-school-calendar-title">
      <Card.Header className="pa-school-calendar__head">
        <div>
          <Card.Title id="pa-school-calendar-title">Calendário escolar 2026</Card.Title>
          <Card.Description>
            Vale para a escola inteira. Escolha um pincel e clique nos dias, ou arraste para marcar vários.
          </Card.Description>
        </div>
        <ProgressBar
          className="pa-school-calendar__count"
          aria-label="Dias letivos marcados"
          value={Math.min(count, SCHOOL_DAYS_REQUIRED_V1)}
          maxValue={SCHOOL_DAYS_REQUIRED_V1}
          color={COUNT_COLOR[tone]}
        >
          <Label>
            <strong>{count}</strong> / {SCHOOL_DAYS_REQUIRED_V1} dias letivos
          </Label>
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
          <span className={`pa-school-calendar__count-note pa-school-calendar__count-note--${tone}`} role="status">
            {countNote(tone, count)}
          </span>
        </ProgressBar>
      </Card.Header>

      <Card.Content className="pa-school-calendar__body">
        {saved.version === 0 ? (
          <Alert status="accent">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>
                Este é o calendário oficial de 2026 da Secretaria de Educação. Confira e clique em Salvar
                calendário para ele valer no Portal.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        {/* Datas principais (owner decision 23/10/2026): pick one, then click its day below. */}
        <Card variant="secondary" className="pa-school-marks">
          <Card.Header>
            <Card.Title>Datas principais</Card.Title>
            <Card.Description>
              {armedLabel
                ? `Clique no dia de: ${armedLabel}.`
                : 'Escolha uma data e clique no dia dela no calendário.'}
            </Card.Description>
          </Card.Header>
          <Card.Content className="pa-school-marks__body">
            {pending.length ? (
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>
                    {pending.length === 1 ? 'Falta marcar 1 data' : `Faltam marcar ${pending.length} datas`}
                  </Alert.Title>
                  <Alert.Description>{pending.map(({ label }) => label).join(', ')}.</Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
            {outOfOrder ? (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>
                    As datas principais estão fora de ordem: confira {outOfOrder}. Corrija para salvar.
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
            <ul className="pa-school-marks__list">
              {MARKERS.map(({ key, label }) => {
                const date = markers?.[key] ?? null;
                return (
                  <li key={key} className="pa-school-mark">
                    <ToggleButton
                      className="pa-school-mark__pick"
                      size="sm"
                      isSelected={armed === key}
                      isDisabled={!canWrite || state !== 'ready'}
                      onChange={(selected) => setArmed(selected ? key : null)}
                    >
                      <Flag size={14} aria-hidden="true" />
                      <span className="pa-school-mark__label">{label}</span>
                      <Chip size="sm" variant="soft" color={date ? 'accent' : 'warning'}>
                        {date ? shortDate(date) : 'Pendente'}
                      </Chip>
                    </ToggleButton>
                    {date && canWrite ? (
                      <CloseButton
                        aria-label={`Apagar ${label}`}
                        isDisabled={state !== 'ready'}
                        onPress={() => setMarkers((current) => (current ? { ...current, [key]: null } : current))}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Card.Content>
        </Card>

        <ToggleButtonGroup
          className="pa-school-calendar__tools"
          aria-label="Pincel"
          size="sm"
          isDetached
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[brush]}
          isDisabled={!canWrite}
          onSelectionChange={(keys) => {
            const next = [...keys][0];
            if (typeof next === 'string') setBrush(next as BrushV1);
          }}
        >
          {BRUSHES.map((item) => (
            <ToggleButton key={item.id} id={item.id} className={`pa-school-brush pa-school-kind--${item.id}`}>
              <span className="pa-school-brush__dot" aria-hidden="true" />
              <span className="pa-school-brush__text">
                {item.label}
                <small>{item.hint}</small>
              </span>
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {brush !== 'clear' && DESCRIBED.has(brush) ? (
          <TextField
            className="pa-school-calendar__note"
            value={note}
            maxLength={80}
            isDisabled={!canWrite}
            onChange={setNote}
          >
            <Label>Descrição dos dias marcados agora</Label>
            <Input placeholder="Ex.: Padroeiro da cidade" />
          </TextField>
        ) : null}
        {message ? (
          <Alert status={message === 'Calendário salvo.' ? 'success' : 'warning'}>
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{message}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        <div className="pa-school-calendar__months">
          {/* December of the year before: only the enrollment's start is marked there. */}
          {monthOf(2025, 12, 'Dezembro de 2025')}
          {MONTHS.map((name, index) => monthOf(2026, index + 1, name))}
        </div>
      </Card.Content>

      {canWrite ? (
        <Card.Footer className="pa-school-calendar__actions">
          <Button
            variant="primary"
            onPress={() => void save()}
            isDisabled={!changed || state === 'saving' || count > SCHOOL_DAYS_REQUIRED_V1 || !!outOfOrder}
          >
            {state === 'saving' ? 'Salvando…' : 'Salvar calendário'}
          </Button>
          <Button
            variant="secondary"
            isDisabled={!changed || state === 'saving'}
            onPress={() => {
              setDraft(new Map(saved.days));
              setMarkers(policy ? { ...policy.markers } : null);
              setArmed(null);
            }}
          >
            Desfazer alterações
          </Button>
        </Card.Footer>
      ) : null}
    </Card>
  );
}
