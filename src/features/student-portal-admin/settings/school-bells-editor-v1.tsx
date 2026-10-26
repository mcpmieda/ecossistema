import { useCallback, useEffect, useMemo, useState } from 'react';
import { Time } from '@internationalized/date';
import { I18nProvider } from 'react-aria-components';
import { Alert, Button, Card, Chip, Spinner, TimeField, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { Coffee, Flag, Plus, Trash2 } from 'lucide-react';
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
/** "07:55" plus (or minus) minutes, kept within the day. */
const later = (time: string, minutes: number) => {
  const total = Math.max(0, Math.min(23 * 60 + 59, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/** The list with one bell's start or end replaced. */
function withTimeAtV1<T extends { start: string; end: string }>(list: readonly T[], index: number, part: 'start' | 'end', text: string): T[] {
  return list.map((each, at) => (at === index ? { ...each, [part]: text } : each));
}
function withoutAtV1<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, at) => at !== index);
}

export function SchoolBellsEditorV1({ client, canWrite }: Readonly<{ client: PortalAdminClientV1; canWrite: boolean }>) {
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
      <Card className="pa-school-bells" aria-busy="true">
        <Card.Content className="pa-school-bells__status">
          <Spinner size="sm" /> Carregando horários…
        </Card.Content>
      </Card>
    );
  if (state === 'error' || !draft || !saved)
    return (
      <Alert status="danger" className="pa-school-bells">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Não foi possível carregar os horários.</Alert.Title>
          <Alert.Description>
            <Button size="sm" variant="secondary" onPress={() => void load()}>
              Tentar de novo
            </Button>
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );

  const editable = canWrite && state === 'ready';
  /** "07:55" as the field's value, and back. */
  const timeOf = (text: string) => new Time(Number(text.slice(0, 2)), Number(text.slice(3, 5)));
  const textOf = (time: Time) => `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
  return (
    <I18nProvider locale="pt-BR">
      <Card className="pa-school-bells" aria-labelledby="pa-school-bells-title">
        <Card.Header className="pa-school-bells__head">
          <div>
            <Card.Title id="pa-school-bells-title">Horário de cada aula</Card.Title>
            <Card.Description>
              Vale para a escola inteira. O Portal mostra a hora de cada aula, o intervalo e a parada no lugar
              certo e a aula de agora. A ordem se ajusta sozinha pela hora de início.
            </Card.Description>
          </div>
          <ToggleButtonGroup
            aria-label="Turno"
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[shift]}
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (next === 'matutino' || next === 'vespertino') setShift(next);
            }}
          >
            {SHIFTS.map((item) => (
              <ToggleButton key={item.id} id={item.id}>
                {item.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Card.Header>

        <Card.Content className="pa-school-bells__body">
          {saved.version === 0 ? (
            <Alert status="accent">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>
                  Estes são os horários de 2026 (folhas de 22/06). Confira e clique em Salvar horários para
                  valerem no Portal.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}
          {message ? (
            <Alert status={message === 'Horários salvos.' ? 'success' : 'danger'}>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{message}</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          <div className="pa-school-bells__days">
            {DAYS.map(({ weekday, label }) => {
              const items = draft[shift][weekday];
              const lessons = items.filter((item) => item.kind === 'aula').length;
              const hasBreak = items.some((item) => item.kind === 'intervalo');
              // A parada (owner decision 23/10/2026) before the lessons and, at most, one after them.
              const paradas = items.filter((item) => item.kind === 'parada').length;
              const firstStart = items[0]?.start ?? (shift === 'matutino' ? '07:00' : '13:15');
              const wrong = invalid.has(`${shift}:${weekday}`);
              const lastEnd = items.at(-1)?.end ?? (shift === 'matutino' ? '07:00' : '13:15');
              return (
                <Card key={weekday} variant="secondary" className={'pa-school-bells__day' + (wrong ? ' is-wrong' : '')}>
                  <Card.Header className="pa-school-bells__day-head">
                    <Card.Title>{label}</Card.Title>
                    <Chip size="sm" variant="soft" color={wrong ? 'danger' : 'default'}>
                      {lessons} aulas
                    </Chip>
                  </Card.Header>
                  <Card.Content>
                    <ol className="pa-school-bells__list">
                      {items.map((item, index) => {
                        let name;
                        if (item.kind === 'aula') {
                          name = `${item.slot}ª aula`;
                        } else if (item.kind === 'parada') {
                          name = 'Parada';
                        } else {
                          name = 'Intervalo';
                        }
                        const setTime = (part: 'start' | 'end', value: Time | null) => {
                          if (value)
                            editDay(weekday, (list) => withTimeAtV1(list, index, part, textOf(value)));
                        };
                        const field = (part: 'start' | 'end') => (
                          <TimeField
                            aria-label={`${label}, ${name}: ${part === 'start' ? 'início' : 'fim'}`}
                            value={timeOf(item[part])}
                            onChange={(value) => setTime(part, value)}
                            onBlur={sortDay(weekday)}
                            hourCycle={24}
                            shouldForceLeadingZeros
                            isDisabled={!editable}
                            isInvalid={wrong}
                          >
                            <TimeField.Group>
                              <TimeField.Input>{(segment) => <TimeField.Segment segment={segment} />}</TimeField.Input>
                            </TimeField.Group>
                          </TimeField>
                        );
                        return (
                          <li key={index /* NOSONAR bells have no id; a key from their times would remount the field being typed in */} className={'pa-school-bells__item pa-school-bells__item--' + item.kind}>
                            <span className="pa-school-bells__name">
                              {item.kind === 'intervalo' ? <Coffee size={14} aria-hidden="true" /> : null}
                              {item.kind === 'parada' ? <Flag size={14} aria-hidden="true" /> : null}
                              {name}
                            </span>
                            <span className="pa-school-bells__times">
                              {field('start')}
                              <span aria-hidden="true">–</span>
                              {field('end')}
                            </span>
                            {editable ? (
                              <Button
                                isIconOnly
                                size="sm"
                                variant="ghost"
                                aria-label={`Remover ${name} de ${label.toLowerCase()}`}
                                onPress={() => editDay(weekday, (list) => withoutAtV1(list, index))}
                              >
                                <Trash2 size={14} aria-hidden="true" />
                              </Button>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>
                    {wrong ? (
                      <p className="pa-school-bells__error" role="alert">
                        Confira os horários: estão fora de ordem, um começa antes do outro acabar, há mais de um
                        intervalo ou uma parada entre as aulas (ela só vem antes ou depois delas).
                      </p>
                    ) : null}
                  </Card.Content>
                  {editable ? (
                    <Card.Footer className="pa-school-bells__add">
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={lessons >= 6 || items.length >= 10}
                        onPress={() =>
                          editDay(weekday, (list) => [...list, { kind: 'aula', slot: 0, start: lastEnd, end: later(lastEnd, 50) }])
                        }
                      >
                        <Plus size={14} aria-hidden="true" /> Aula
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={hasBreak || items.length >= 10}
                        onPress={() =>
                          editDay(weekday, (list) => [...list, { kind: 'intervalo', start: lastEnd, end: later(lastEnd, 15) }])
                        }
                      >
                        <Plus size={14} aria-hidden="true" /> Intervalo
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={paradas >= 2 || items.length >= 10}
                        onPress={() =>
                          // Before the lessons (the usual one); the day's order is kept by the start time.
                          editDay(weekday, (list) => [{ kind: 'parada', start: later(firstStart, -15), end: firstStart }, ...list])
                        }
                      >
                        <Plus size={14} aria-hidden="true" /> Parada
                      </Button>
                    </Card.Footer>
                  ) : null}
                </Card>
              );
            })}
          </div>
        </Card.Content>

        {canWrite ? (
          <Card.Footer className="pa-school-bells__actions">
            <Button
              variant="primary"
              onPress={() => void save()}
              isDisabled={!changed || state === 'saving' || invalid.size > 0}
            >
              {state === 'saving' ? 'Salvando…' : 'Salvar horários'}
            </Button>
            <Button
              variant="secondary"
              isDisabled={!changed || state === 'saving' || saved.version === 0}
              onPress={() => setDraft(structuredClone(saved.bells))}
            >
              Desfazer alterações
            </Button>
          </Card.Footer>
        ) : null}
      </Card>
    </I18nProvider>
  );
}
