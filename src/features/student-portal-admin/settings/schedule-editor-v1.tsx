import { useEffect, useState, type ReactNode } from 'react';
import { Button, Label, ListBox, Select } from '@heroui/react';
import { Plus, Trash2 } from 'lucide-react';
import type { AccessEventV1 } from '../../../../shared/student-portal-contracts/access-schedule-v1';
import { DateInputV1 } from './settings-editors-v1';
import { calendarInputV1, calendarInstantV1 } from './settings-values-v1';

/*
 * The agenda editor shared by Acesso (Abrir/Fechar), Notas and Resultado anual (Mostrar/Ocultar):
 * rows of an action and a São Paulo date, validated into a time-ordered schedule.
 */
export type ScheduleRowV1 = { id: number; at: string; action: AccessEventV1['action'] };
export type ScheduleLabelsV1 = { open: string; close: string; noEffect: string };

let nextRowId = 1;
export const scheduleRowsOfV1 = (events: readonly AccessEventV1[]): ScheduleRowV1[] =>
  events.map((event) => ({ id: nextRowId++, at: calendarInputV1(event.at), action: event.action }));
export const scheduleRowsKeyV1 = (rows: readonly ScheduleRowV1[]) =>
  JSON.stringify(rows.map(({ at, action }) => [at, action]));

/**
 * Rows followed by the same action: following the agenda, the state before an action is already
 * its opposite, so the earlier of two equal actions changes nothing.
 */
function redundantRowsV1(rows: readonly ScheduleRowV1[]): Set<number> {
  const instant = (input: string) => {
    try {
      return calendarInstantV1(input);
    } catch {
      return null;
    }
  };
  const dated = rows
    .map((row) => ({ row, at: instant(row.at) }))
    .filter((item): item is { row: ScheduleRowV1; at: string } => item.at !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return new Set(
    dated
      .filter((item, index) => dated[index + 1]?.row.action === item.row.action)
      .map((item) => item.row.id),
  );
}

/** Validates the rows into a time-ordered schedule; every action must still be ahead. */
export function parseScheduleRowsV1(rows: readonly ScheduleRowV1[], now: number): AccessEventV1[] {
  const events = rows.map((row) => {
    const at = calendarInstantV1(row.at);
    if (at === null)
      throw new Error('Informe a data e o horário de cada agendamento, ou remova a linha.');
    if (Date.parse(at) <= now) throw new Error('Cada agendamento precisa estar no futuro.');
    return { at, action: row.action };
  });
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (events.some((event, index) => index > 0 && event.at === events[index - 1]!.at))
    throw new Error('Dois agendamentos não podem ter o mesmo horário.');
  if (events.length > 40) throw new Error('Use no máximo 40 agendamentos.');
  return events;
}

/** Re-renders every 15 s so "agora" and the next change stay true while the page is open. */
export function useScheduleClockV1() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const whenFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
export const scheduleWhenV1 = (at: string | number) =>
  whenFormat.format(new Date(at)).replace(',', '');

export function ScheduleEditorV1({
  rows,
  onRowsChange,
  labels,
  openNow,
  canWrite,
  disabled,
  error,
  empty,
  notice,
  actions,
}: Readonly<{
  rows: ScheduleRowV1[];
  onRowsChange: (rows: ScheduleRowV1[]) => void;
  labels: ScheduleLabelsV1;
  /** The state now, so a first new row proposes the change that makes sense. */
  openNow: boolean;
  canWrite: boolean;
  disabled: boolean;
  error: string | null;
  empty: string;
  notice?: ReactNode;
  /** Save / personalize / default buttons, after "Novo agendamento". */
  actions?: ReactNode;
}>) {
  const redundant = redundantRowsV1(rows);
  const update = (id: number, patch: Partial<ScheduleRowV1>) =>
    onRowsChange(rows.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  return (
    <div className="pa-access-schedule">
      {notice}
      {rows.length === 0 ? (
        <p className="pa-settings-hint">{empty}</p>
      ) : (
        <ol className="pa-access-rows">
          {rows.map((row, index) => (
            <li key={row.id} className="pa-access-row">
              <Select
                className="pa-access-action"
                selectedKey={row.action}
                isDisabled={disabled || !canWrite}
                onSelectionChange={(key) => {
                  if (key === 'open' || key === 'close') update(row.id, { action: key });
                }}
              >
                <Label>Ação {index + 1}</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="open" textValue={labels.open}>
                      {labels.open}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item id="close" textValue={labels.close}>
                      {labels.close}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>
              <DateInputV1
                label="Em"
                value={row.at}
                disabled={disabled || !canWrite}
                onChange={(at) => update(row.id, { at })}
              />
              {redundant.has(row.id) ? (
                <p className="pa-settings-hint pa-access-row-note">{labels.noEffect}</p>
              ) : null}
              {canWrite ? (
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  className="pa-access-remove"
                  aria-label={`Remover agendamento ${index + 1}`}
                  isDisabled={disabled}
                  onPress={() => onRowsChange(rows.filter((item) => item.id !== row.id))}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {error ? (
        <p className="pa-settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {canWrite ? (
        <div className="pa-settings-actions pa-access-actions">
          <Button
            size="sm"
            variant="tertiary"
            isDisabled={disabled || rows.length >= 40}
            onPress={() => {
              const last = rows.at(-1);
              let action: 'close' | 'open';
              if (last) {
                if (last.action === 'open') {
                  action = 'close';
                } else {
                  action = 'open';
                }
              } else if (openNow) {
                action = 'close';
              } else {
                action = 'open';
              }
              onRowsChange([...rows, { id: nextRowId++, at: '', action }]);
            }}
          >
            <Plus size={16} aria-hidden="true" />
            Novo agendamento
          </Button>
          {actions}
        </div>
      ) : null}
    </div>
  );
}
