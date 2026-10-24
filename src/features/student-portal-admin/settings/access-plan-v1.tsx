import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Chip, Label, Switch } from '@heroui/react';
import { CalendarClock, DoorClosed, DoorOpen } from 'lucide-react';
import {
  settingsOverrideV1,
  type EffectiveSettingsV1,
} from '../../../../shared/student-portal-contracts/policy-v1';
import {
  accessOpenAtV1,
  anticipateAccessV1,
  legacyAccessPlanV1,
  nextAccessChangeV1,
  settleAccessPlanV1,
  type AccessEventV1,
  type AccessPlanV1,
} from '../../../../shared/student-portal-contracts/access-schedule-v1';
import { ownsSettingV1, scopeSubjectV1, settingsScopeKeyV1 } from './settings-values-v1';
import {
  ScheduleEditorV1,
  parseScheduleRowsV1,
  scheduleRowsKeyV1,
  scheduleRowsOfV1,
  scheduleWhenV1,
  useScheduleClockV1,
} from './schedule-editor-v1';

type OverrideV1 = ReturnType<typeof settingsOverrideV1.parse>;
export type AccessReviewIntentV1 =
  | { field: 'accessEnabled'; inherit: true }
  | { field: 'accessEnabled'; inherit: false; value: OverrideV1 };

/**
 * The plan this level follows, as the server resolves it: its own switch and schedules, or — for
 * a level that never used schedules — the old "Quando o aluno pode entrar" window of the Calendário.
 */
export function accessPlanOfSettingsV1(settings: EffectiveSettingsV1): {
  plan: AccessPlanV1;
  fromCalendar: boolean;
} {
  const { value, sources } = settings;
  const sameLevel =
    settingsScopeKeyV1(sources.accessSchedule) === settingsScopeKeyV1(sources.accessEnabled);
  if (value.accessSchedule !== null && sameLevel)
    return {
      plan: { enabled: value.accessEnabled, schedule: value.accessSchedule },
      fromCalendar: false,
    };
  const calendar = value.calendar;
  return {
    plan: legacyAccessPlanV1(
      value.accessEnabled,
      calendar.accessStartsAt ?? calendar.yearStartsAt,
      calendar.accessEndsAt ?? calendar.yearEndsAt,
    ),
    fromCalendar: true,
  };
}

export const accessWhenV1 = scheduleWhenV1;
export type PlanWordsV1 = {
  openNow: string;
  closedNow: string;
  open: string;
  close: string;
  becameOpen: string;
  becameClosed: string;
};
const ACCESS_WORDS_V1: PlanWordsV1 = {
  openNow: 'Aberto agora.',
  closedNow: 'Fechado agora.',
  open: 'Abrir',
  close: 'Fechar',
  becameOpen: 'Os alunos poderão entrar assim que você confirmar.',
  becameClosed: 'Ninguém mais poderá entrar, e quem estiver conectado sai do Portal agora.',
};

/** Plain-language reading of a plan, used on the card and in the confirmation. */
export function AccessPlanSummaryV1({
  plan,
  now,
  wasOpen,
  words = ACCESS_WORDS_V1,
}: Readonly<{
  plan: AccessPlanV1;
  now: number;
  /** The state before this change, to say what happens to students right away. */
  wasOpen?: boolean;
  words?: PlanWordsV1;
}>) {
  const open = accessOpenAtV1(plan, now);
  const upcoming = plan.schedule.filter((event) => Date.parse(event.at) > now);
  return (
    <div className="pa-access-summary">
      {wasOpen === false && open ? (
        <p className="pa-access-consequence">{words.becameOpen}</p>
      ) : null}
      {wasOpen === true && !open ? (
        <p className="pa-access-consequence">{words.becameClosed}</p>
      ) : null}
      <p>
        <strong>{open ? words.openNow : words.closedNow}</strong>{' '}
        {upcoming.length ? 'Depois disso:' : 'Nenhuma mudança agendada.'}
      </p>
      {upcoming.length ? (
        <ul>
          {upcoming.map((event) => (
            <li key={event.at}>
              <strong>{event.action === 'open' ? words.open : words.close}</strong> em{' '}
              {accessWhenV1(event.at)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Entrada no Portal: the switch (state now) and its scheduled Abrir/Fechar, edited and saved
 * together as one unit for this level.
 */
export function AccessPlanCardV1({
  settings,
  canWrite,
  disabled,
  sourceLabel,
  review,
  onDirtyChange,
}: Readonly<{
  settings: EffectiveSettingsV1;
  canWrite: boolean;
  disabled: boolean;
  sourceLabel: string;
  review: (intent: AccessReviewIntentV1) => void;
  onDirtyChange: (field: 'accessEnabled', dirty: boolean) => void;
}>) {
  const now = useScheduleClockV1();
  const school = settings.scope.kind === 'school';
  const owns = ownsSettingV1(settings, 'accessEnabled');
  const { plan, fromCalendar } = useMemo(() => accessPlanOfSettingsV1(settings), [settings]);
  // Settled when the card loads: the switch is the state now and the rows are what is still ahead.
  const saved = useMemo(() => settleAccessPlanV1(plan, Date.now()), [plan]);
  const sourceRows = useMemo(() => scheduleRowsOfV1(saved.schedule), [saved]);
  const [rows, setRows] = useState(sourceRows);
  const sourceKey = scheduleRowsKeyV1(sourceRows);
  const precedingSource = useRef(sourceKey);
  useEffect(() => {
    const wasDirty = scheduleRowsKeyV1(rows) !== precedingSource.current;
    precedingSource.current = sourceKey;
    if (!wasDirty) setRows(sourceRows);
  }, [sourceRows, sourceKey]);
  const [error, setError] = useState<string | null>(null);
  const dirty = scheduleRowsKeyV1(rows) !== scheduleRowsKeyV1(sourceRows);
  useEffect(() => {
    onDirtyChange('accessEnabled', dirty);
    return () => onDirtyChange('accessEnabled', false);
  }, [dirty, onDirtyChange]);

  const openNow = accessOpenAtV1(plan, now);
  // The next real change (an Abrir while already open changes nothing).
  const nextChange = nextAccessChangeV1(plan, now, !openNow);
  const submit = (enabled: boolean, schedule: AccessEventV1[]) =>
    review({
      field: 'accessEnabled',
      inherit: false,
      value: settingsOverrideV1.parse({ accessEnabled: enabled, accessSchedule: schedule }),
    });
  const saveSchedule = () => {
    try {
      const schedule = parseScheduleRowsV1(rows, Date.now());
      setError(null);
      submit(accessOpenAtV1(plan, Date.now()), schedule);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Confira os agendamentos.');
    }
  };

  let origin = 'Definido aqui';
  if (!owns)
    origin =
      settings.sources.accessEnabled.kind === 'school'
        ? 'Padrão da escola'
        : 'Padrão de ' + sourceLabel;
  const steadyText = openNow ? 'Fica aberto até alguém fechar.' : 'Fica fechado até alguém abrir.';
  return (
    <Card className="pa-settings-card pa-settings-card--access">
      <Card.Header>
        <div className="pa-settings-card-heading">
          {/* The policies page already titles the section at school level. */}
          <h3 className={school ? 'sr-only' : undefined}>Entrada no Portal</h3>
          {!school ? (
            <Chip size="sm" variant="soft">
              {origin}
            </Chip>
          ) : null}
        </div>
      </Card.Header>
      <Card.Content className="pa-access">
        <output className={'pa-access-status pa-access-status--' + (openNow ? 'open' : 'closed')}>
          {openNow ? (
            <DoorOpen size={22} aria-hidden="true" />
          ) : (
            <DoorClosed size={22} aria-hidden="true" />
          )}
          <div>
            <p className="pa-access-status-title">
              {openNow ? 'O Portal está aberto agora' : 'O Portal está fechado agora'}
              {school ? '' : ` para ${scopeSubjectV1(settings.scope.kind).toLowerCase()}`}
            </p>
            <p className="pa-access-status-next">
              {nextChange === null ? (
                steadyText
              ) : (
                <>
                  <CalendarClock size={14} aria-hidden="true" />
                  {openNow ? 'Fecha' : 'Abre'} sozinho em{' '}
                  {accessWhenV1(new Date(nextChange).toISOString())}
                </>
              )}
            </p>
          </div>
          {canWrite ? (
            <Switch
              className="pa-access-switch"
              aria-label="Portal aberto agora"
              isSelected={openNow}
              isDisabled={disabled || dirty}
              onChange={(value) => {
                const anticipated = anticipateAccessV1(plan, Date.now(), value);
                submit(anticipated.enabled, [...anticipated.schedule]);
              }}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Label>{openNow ? 'Aberto' : 'Fechado'}</Label>
              </Switch.Content>
            </Switch>
          ) : null}
        </output>
        {canWrite && dirty ? (
          <p className="pa-settings-hint">
            Salve ou desfaça os agendamentos antes de usar a chave.
          </p>
        ) : null}

        <section aria-labelledby="pa-access-schedule-title">
          <h4 id="pa-access-schedule-title" className="pa-access-schedule-title">
            Agendamentos
          </h4>
          <ScheduleEditorV1
            rows={rows}
            onRowsChange={(next) => {
              setRows(next);
              setError(null);
            }}
            labels={{
              open: 'Abrir o Portal',
              close: 'Fechar o Portal',
              noEffect:
                'Sem efeito: a ação seguinte é igual, então o Portal só muda no horário dela.',
            }}
            openNow={openNow}
            canWrite={canWrite}
            disabled={disabled}
            error={error}
            empty="Nenhum agendamento. O Portal fica como a chave estiver."
            notice={
              fromCalendar && owns && saved.schedule.length ? (
                <p className="pa-settings-hint">
                  Estes horários vieram de “Quando o aluno pode entrar”, do Calendário. Ao salvar,
                  eles passam a valer daqui.
                </p>
              ) : null
            }
            actions={
              <>
                {/* Saving shows only while there is something to save. */}
                {!owns || dirty || (fromCalendar && saved.schedule.length > 0) ? (
                  <Button
                    size="sm"
                    variant={owns ? 'primary' : 'secondary'}
                    isDisabled={disabled}
                    aria-label={owns ? 'Salvar agendamentos' : 'Personalizar Entrada no Portal'}
                    onPress={saveSchedule}
                  >
                    {owns ? 'Salvar agendamentos' : 'Personalizar'}
                  </Button>
                ) : null}
                {!school && owns ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={disabled}
                    aria-label="Usar padrão de Entrada no Portal"
                    onPress={() => review({ field: 'accessEnabled', inherit: true })}
                  >
                    Usar padrão
                  </Button>
                ) : null}
              </>
            }
          />
        </section>

        <div className="pa-access-help">
          <p className="pa-access-help-title">Como funciona</p>
          <ul>
            <li>
              O Portal segue a agenda. Antes de um <strong>Abrir</strong>, ele fica fechado; antes
              de um <strong>Fechar</strong>, fica aberto. Isso vale assim que você salvar.
            </li>
            <li>
              Exemplo: com o Portal aberto, agendar “Abrir às 10:00” fecha agora e abre às 10:00.
              Com ele fechado, agendar “Fechar às 18:00” abre agora e fecha às 18:00.
            </li>
            <li>
              Depois do último agendamento, o Portal fica como ele deixou, até alguém usar a chave.
            </li>
            <li>
              A chave mostra o estado agora. Usá-la antecipa o próximo agendamento, e os seguintes
              continuam valendo.
            </li>
            <li>
              Enquanto o Portal estiver fechado com uma abertura agendada, os alunos veem a contagem
              regressiva na tela de entrada.
            </li>
            <li>No horário de Fechar, quem estiver conectado sai do Portal.</li>
            {school ? (
              <li>
                Turmas e alunos podem ter a própria chave e os próprios agendamentos, mas só entram
                quando a escola também estiver aberta.
              </li>
            ) : (
              <li>
                A escola prevalece: {scopeSubjectV1(settings.scope.kind).toLowerCase()} só entra
                enquanto a escola também estiver aberta.
              </li>
            )}
            <li>Horários de Brasília.</li>
          </ul>
        </div>
      </Card.Content>
    </Card>
  );
}
