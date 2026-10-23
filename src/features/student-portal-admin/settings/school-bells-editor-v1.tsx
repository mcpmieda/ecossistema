import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import { Coffee, Plus, Trash2 } from 'lucide-react';
import {
  bellDayV1,
  officialBells2026V1,
  type BellDayV1,
  type BellItemV1,
  type BellShiftV1,
  type SchoolBellsDaysV1,
} from '../../../../shared/student-portal-contracts/school-bells-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import './school-bells-editor-v1.css';

/*
 * Horário das aulas (owner decision 23/10/2026): the time of each lesson and of the break, per shift
 * and weekday, one for the whole school. The Portal shows each lesson with its time, the break in its
 * place, the lesson going on now and how long until the break or the end. Lessons are numbered in
 * the order they are listed (1ª, 2ª…), so the admin only types times; a day out of order, with
 * overlapping times or with two breaks is shown in red and cannot be saved (the server refuses it
 * too).
 */
const SHIFTS: readonly { id: BellShiftV1; label: string }[] = [
  { id: 'matutino', label: 'Matutino' },
  { id: 'vespertino', label: 'Vespertino' },
];
const DAYS = [
  { weekday: 1, label: 'Segunda' },
  { weekday: 2, label: 'Terça' },
  { weekday: 3, label: 'Quarta' },
  { weekday: 4, label: 'Quinta' },
  { weekday: 5, label: 'Sexta' },
] as const;
type WeekdayV1 = (typeof DAYS)[number]['weekday'];

/** Lessons numbered by their order in the list, so a removed or added one never leaves a gap. */
const renumbered = (items: readonly BellItemV1[]): BellDayV1 => {
  let slot = 0;
  return items.map((item) => (item.kind === 'aula' ? { ...item, slot: ++slot } : item));
};
/** "07:55" plus minutes, kept within the day. */
const later = (time: string, minutes: number) => {
  const total = Math.min(23 * 60 + 59, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

export function SchoolBellsEditorV1({ client, canWrite }: { client: PortalAdminClientV1; canWrite: boolean }) {
  const [saved, setSaved] = useState<{ version: number; bells: SchoolBellsDaysV1 } | null>(null);
  const [draft, setDraft] = useState<SchoolBellsDaysV1 | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [shift, setShift] = useState<BellShiftV1>('matutino');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState('loading');
      try {
        const result = await client.query(
          { contractVersion: 1, operation: 'school-bells', scope: { kind: 'school', academicYear: 2026 }, page: { limit: 1 } },
          signal,
        );
        if (result.state !== 'school-bells') throw new PortalClientErrorV1('invalid-response');
        const bells = result.bells?.bells ?? officialBells2026V1();
        setSaved({ version: result.bells?.version ?? 0, bells });
        // Nothing saved yet: the school's official sheets of 2026 are already on screen, to save.
        setDraft(structuredClone(bells));
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

  const invalid = useMemo(() => {
    const days = new Set<string>();
    if (!draft) return days;
    for (const { id } of SHIFTS)
      for (const { weekday } of DAYS) if (!bellDayV1.safeParse(draft[id][weekday]).success) days.add(`${id}:${weekday}`);
    return days;
  }, [draft]);
  const changed = !!draft && !!saved && (saved.version === 0 || JSON.stringify(draft) !== JSON.stringify(saved.bells));

  const editDay = (weekday: WeekdayV1, change: (items: BellItemV1[]) => BellItemV1[]) => {
    if (!canWrite || state !== 'ready') return;
    setMessage(null);
    setDraft((current) =>
      current
        ? { ...current, [shift]: { ...current[shift], [weekday]: renumbered(change([...current[shift][weekday]])) } }
        : current,
    );
  };

  // In the order of their start once a time is typed (never while typing: the row would jump).
  const sortDay = (weekday: WeekdayV1) => () =>
    editDay(weekday, (list) => [...list].sort((left, right) => left.start.localeCompare(right.start)));

  const save = async () => {
    if (!draft || !saved || invalid.size) return;
    setState('saving');
    setMessage(null);
    try {
      await client.command({
        contractVersion: 1,
        operation: 'school-bells-set',
        academicYear: 2026,
        expectedVersion: saved.version,
        idempotencyKey: crypto.randomUUID(),
        bells: draft,
      });
      await load();
      setMessage('Horários salvos.');
    } catch (error) {
      setState('ready');
      setMessage(
        error instanceof PortalClientErrorV1 && error.state === 'conflict'
          ? 'Outra pessoa alterou os horários. Recarregue para ver a versão atual.'
          : 'Não foi possível salvar agora. Tente de novo.',
      );
    }
  };

  if (state === 'loading' && !draft)
    return (
      <section className="pa-school-bells" aria-busy="true">
        <p className="pa-school-bells__status">Carregando horários…</p>
      </section>
    );
  if (state === 'error' || !draft || !saved)
    return (
      <section className="pa-school-bells">
        <p className="pa-school-bells__status" role="alert">
          Não foi possível carregar os horários.
        </p>
        <Button size="sm" variant="secondary" onPress={() => void load()}>
          Tentar de novo
        </Button>
      </section>
    );

  const editable = canWrite && state === 'ready';
  return (
    <section className="pa-school-bells" aria-labelledby="pa-school-bells-title">
      <header className="pa-school-bells__head">
        <div>
          <h3 id="pa-school-bells-title">Horário de cada aula</h3>
          <p>Vale para a escola inteira. O Portal mostra a hora de cada aula, o intervalo no lugar certo e a aula de agora.
            A ordem se ajusta sozinha pela hora de início.</p>
        </div>
        <div className="pa-school-bells__shifts" role="radiogroup" aria-label="Turno">
          {SHIFTS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={shift === item.id}
              className="pa-school-bells__shift"
              onClick={() => setShift(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      {saved.version === 0 ? (
        <p className="pa-school-bells__start" role="note">
          Estes são os horários de 2026 (folhas de 22/06). Confira e clique em Salvar horários para valerem no Portal.
        </p>
      ) : null}
      {message ? (
        <p className="pa-school-bells__message" role="status">
          {message}
        </p>
      ) : null}

      <div className="pa-school-bells__days">
        {DAYS.map(({ weekday, label }) => {
          const items = draft[shift][weekday];
          const hasBreak = items.some((item) => item.kind === 'intervalo');
          const wrong = invalid.has(`${shift}:${weekday}`);
          const lastEnd = items.at(-1)?.end ?? (shift === 'matutino' ? '07:00' : '13:15');
          return (
            <div key={weekday} className={'pa-school-bells__day' + (wrong ? ' is-wrong' : '')}>
              <h4>
                {label}
                <small>{items.filter((item) => item.kind === 'aula').length} aulas</small>
              </h4>
              <ol>
                {items.map((item, index) => {
                  const name = item.kind === 'aula' ? `${item.slot}ª aula` : 'Intervalo';
                  const setTime = (part: 'start' | 'end', value: string) => {
                    if (/^\d\d:\d\d$/u.test(value))
                      editDay(weekday, (list) => list.map((each, at) => (at === index ? { ...each, [part]: value } : each)));
                  };
                  return (
                    <li key={index} className={'pa-school-bells__item pa-school-bells__item--' + item.kind}>
                      <span className="pa-school-bells__name">
                        {item.kind === 'intervalo' ? <Coffee size={14} aria-hidden="true" /> : null}
                        {name}
                      </span>
                      <span className="pa-school-bells__times">
                        <input
                          type="time"
                          value={item.start}
                          aria-label={`${label}, ${name}: início`}
                          disabled={!editable}
                          onChange={(event) => setTime('start', event.target.value)}
                          onBlur={sortDay(weekday)}
                        />
                        <span aria-hidden="true">–</span>
                        <input
                          type="time"
                          value={item.end}
                          aria-label={`${label}, ${name}: fim`}
                          disabled={!editable}
                          onChange={(event) => setTime('end', event.target.value)}
                          onBlur={sortDay(weekday)}
                        />
                      </span>
                      {editable ? (
                        <button
                          type="button"
                          className="pa-school-bells__remove"
                          aria-label={`Remover ${name} de ${label.toLowerCase()}`}
                          onClick={() => editDay(weekday, (list) => list.filter((_, at) => at !== index))}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
              {wrong ? (
                <p className="pa-school-bells__error" role="alert">
                  Confira os horários: estão fora de ordem, um começa antes do outro acabar ou há mais de um intervalo.
                </p>
              ) : null}
              {editable ? (
                <div className="pa-school-bells__add">
                  <button
                    type="button"
                    disabled={items.filter((item) => item.kind === 'aula').length >= 6 || items.length >= 8}
                    onClick={() =>
                      editDay(weekday, (list) => [...list, { kind: 'aula', slot: 0, start: lastEnd, end: later(lastEnd, 50) }])
                    }
                  >
                    <Plus size={14} aria-hidden="true" /> Aula
                  </button>
                  <button
                    type="button"
                    disabled={hasBreak || items.length >= 8}
                    onClick={() =>
                      editDay(weekday, (list) => [...list, { kind: 'intervalo', start: lastEnd, end: later(lastEnd, 15) }])
                    }
                  >
                    <Plus size={14} aria-hidden="true" /> Intervalo
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {canWrite ? (
        <footer className="pa-school-bells__actions">
          <Button onPress={() => void save()} isDisabled={!changed || state === 'saving' || invalid.size > 0}>
            {state === 'saving' ? 'Salvando…' : 'Salvar horários'}
          </Button>
          <Button
            variant="secondary"
            isDisabled={!changed || state === 'saving' || saved.version === 0}
            onPress={() => setDraft(structuredClone(saved.bells))}
          >
            Desfazer alterações
          </Button>
        </footer>
      ) : null}
    </section>
  );
}
