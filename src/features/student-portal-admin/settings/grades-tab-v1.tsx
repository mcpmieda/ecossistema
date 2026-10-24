import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Card, Chip, Label, Switch } from '@heroui/react';
import { Award, CalendarClock, Eye, EyeOff, Info } from 'lucide-react';
import {
  type EffectiveSettingsV1,
  type settingsOverrideV1,
} from '../../../../shared/student-portal-contracts/policy-v1';
import {
  accessOpenAtV1,
  anticipateAccessV1,
  nextAccessChangeV1,
  settleAccessPlanV1,
  type AccessEventV1,
  type AccessPlanV1,
} from '../../../../shared/student-portal-contracts/access-schedule-v1';
import { AccessPlanSummaryV1, type PlanWordsV1 } from './access-plan-v1';
import { ownsSettingV1 } from './settings-values-v1';
import {
  calendarWithGradePlanV1,
  gradeOfV1,
  gradePlanOfV1,
  gradesFromCalendarV1,
  type GradeKeyV1,
  type GradePeriodV1,
} from './grades-agenda-v1';
import {
  ScheduleEditorV1,
  parseScheduleRowsV1,
  scheduleRowsKeyV1,
  scheduleRowsOfV1,
  scheduleWhenV1,
  useScheduleClockV1,
} from './schedule-editor-v1';

type OverrideV1 = ReturnType<typeof settingsOverrideV1.parse>;
export type GradeReviewIntentV1 = {
  field: 'calendar';
  draftKey: string;
  inherit: false;
  value: OverrideV1;
  presentation: { title: string; body: ReactNode };
};
type PublicationStateV1 = 'no-data' | 'available' | 'published' | 'update-pending';

export const GRADE_WORDS_V1: PlanWordsV1 = {
  openNow: 'Visível para os alunos agora.',
  closedNow: 'Oculto para os alunos agora.',
  open: 'Mostrar',
  close: 'Ocultar',
  becameOpen: 'Os alunos passam a ver assim que você confirmar (se estiver publicado).',
  becameClosed: 'Os alunos deixam de ver agora.',
};

/**
 * One sentence of what students see for a period: publication and its agenda together.
 * Nothing is shown without a publication, whatever the agenda says.
 */
export function GradeStatusChipV1({
  settings,
  period,
  state,
}: Readonly<{ settings: EffectiveSettingsV1; period: GradePeriodV1; state: PublicationStateV1 }>) {
  const now = useScheduleClockV1();
  const plan = gradePlanOfV1(settings.value, period);
  if (state === 'no-data')
    return (
      <Chip size="sm" variant="soft">
        Sem notas no Banco ainda
      </Chip>
    );
  if (state === 'available')
    return (
      <Chip size="sm" variant="soft">
        Ainda não publicadas
      </Chip>
    );
  if (accessOpenAtV1(plan, now))
    return (
      <Chip size="sm" variant="soft" color="success">
        <Eye size={14} aria-hidden="true" /> Os alunos veem agora
      </Chip>
    );
  const opens = nextAccessChangeV1(plan, now, true);
  return opens !== null ? (
    <Chip size="sm" variant="soft" color="warning">
      <CalendarClock size={14} aria-hidden="true" /> Aparece em {scheduleWhenV1(opens)}
    </Chip>
  ) : (
    <Chip size="sm" variant="soft">
      <EyeOff size={14} aria-hidden="true" /> Oculto para os alunos
    </Chip>
  );
}

/**
 * "Mostrar para os alunos": the switch (state now) and its Mostrar/Ocultar, saved together into
 * the calendar. The same rule as access: before an action the grades are in its opposite state.
 */
export function GradeShowV1({
  settings,
  gradeKey,
  canWrite,
  disabled,
  review,
  onDirtyChange,
}: Readonly<{
  settings: EffectiveSettingsV1;
  gradeKey: GradeKeyV1;
  canWrite: boolean;
  disabled: boolean;
  review: (intent: GradeReviewIntentV1) => void;
  onDirtyChange: (key: string, dirty: boolean) => void;
}>) {
  const now = useScheduleClockV1();
  const plan = useMemo(() => gradePlanOfV1(settings.value, gradeKey), [settings, gradeKey]);
  const fromCalendar = gradesFromCalendarV1(settings.value, gradeKey);
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
  const dirtyKey = 'grades:' + gradeKey;
  useEffect(() => {
    onDirtyChange(dirtyKey, dirty);
    return () => onDirtyChange(dirtyKey, false);
  }, [dirty, dirtyKey, onDirtyChange]);
  const openNow = accessOpenAtV1(plan, now);
  const nextChange = nextAccessChangeV1(plan, now, !openNow);
  const submit = (next: AccessPlanV1) =>
    review({
      field: 'calendar',
      draftKey: dirtyKey,
      inherit: false,
      value: calendarWithGradePlanV1(settings.value, gradeKey, next, Date.now()),
      presentation: {
        title: gradeKey === 'final' ? 'Resultado anual' : `Notas ${gradeOfV1(gradeKey)}`,
        body: (
          <>
            <AccessPlanSummaryV1
              plan={next}
              now={Date.now()}
              wasOpen={accessOpenAtV1(plan, Date.now())}
              words={GRADE_WORDS_V1}
            />
            {settings.scope.kind !== 'school' && !ownsSettingV1(settings, 'calendar') ? (
              <p className="pa-access-consequence">
                {settings.scope.kind === 'class'
                  ? 'Esta turma'
                  : settings.scope.kind === 'shift'
                    ? 'Este turno'
                    : 'Este aluno'}{' '}
                passa a ter datas próprias: as mudanças que a escola fizer no Calendário e nas Notas
                deixam de valer aqui até alguém usar “Usar padrão”.
              </p>
            ) : null}
          </>
        ),
      },
    });
  const save = () => {
    try {
      const schedule: AccessEventV1[] = parseScheduleRowsV1(rows, Date.now());
      setError(null);
      submit({ enabled: accessOpenAtV1(plan, Date.now()), schedule });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Confira os agendamentos.');
    }
  };
  return (
    <div className="pa-grade-show">
      <div className="pa-grade-show-now">
        <div>
          <p className="pa-grade-show-state">{openNow ? 'Mostrando agora' : 'Oculto agora'}</p>
          <p className="pa-access-status-next">
            {nextChange !== null ? (
              <>
                <CalendarClock size={14} aria-hidden="true" />
                {openNow ? 'Oculta' : 'Mostra'} sozinho em {scheduleWhenV1(nextChange)}
              </>
            ) : openNow ? (
              'Fica visível até alguém ocultar.'
            ) : (
              'Fica oculto até alguém mostrar.'
            )}
          </p>
        </div>
        {canWrite ? (
          <Switch
            aria-label={`Mostrar ${gradeKey === 'final' ? 'o resultado anual' : 'as notas ' + gradeOfV1(gradeKey)} agora`}
            isSelected={openNow}
            isDisabled={disabled || dirty}
            onChange={(value) => submit(anticipateAccessV1(plan, Date.now(), value))}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Label>{openNow ? 'Mostrar' : 'Oculto'}</Label>
            </Switch.Content>
          </Switch>
        ) : null}
      </div>
      <ScheduleEditorV1
        rows={rows}
        onRowsChange={(next) => {
          setRows(next);
          setError(null);
        }}
        labels={{
          open: gradeKey === 'final' ? 'Mostrar o resultado' : 'Mostrar as notas',
          close: gradeKey === 'final' ? 'Ocultar o resultado' : 'Ocultar as notas',
          noEffect: 'Sem efeito: a ação seguinte é igual.',
        }}
        openNow={openNow}
        canWrite={canWrite}
        disabled={disabled}
        error={error}
        empty="Nenhum agendamento."
        notice={
          canWrite && dirty ? (
            <p className="pa-settings-hint">
              Salve ou desfaça os agendamentos antes de usar a chave.
            </p>
          ) : fromCalendar && saved.schedule.length ? (
            <p className="pa-settings-hint">
              Vieram das datas do Calendário. Ao salvar, passam a valer daqui.
            </p>
          ) : null
        }
        actions={
          dirty ? (
            <Button
              size="sm"
              variant="primary"
              isDisabled={disabled}
              aria-label={`Salvar agendamentos ${gradeOfV1(gradeKey)}`}
              onPress={save}
            >
              Salvar agendamentos
            </Button>
          ) : null
        }
      />
    </div>
  );
}

/** Resultado anual: only the official result the school authorized, shown by its own agenda. */
export function FinalResultCardV1(props: Omit<Parameters<typeof GradeShowV1>[0], 'gradeKey'>) {
  return (
    <Card className="pa-settings-card pa-grade-card">
      <Card.Header>
        <div className="pa-grade-card-heading">
          <h3>
            <Award size={18} aria-hidden="true" /> Resultado anual
          </h3>
        </div>
        <p className="pa-settings-field-help">
          Aprovado, em recuperação ou reprovado, como a escola oficializou. Só aparece depois de
          autorizado no Banco.
        </p>
      </Card.Header>
      <Card.Content>
        <GradeShowV1 {...props} gradeKey="final" />
      </Card.Content>
    </Card>
  );
}

export function GradesIntroV1() {
  return (
    <div className="pa-grades-intro" role="note">
      <Info size={16} aria-hidden="true" />
      <p>
        Para o aluno ver as notas de um trimestre: <strong>1. publique</strong> a versão do Banco e{' '}
        <strong>2. mostre</strong> agora ou agende. Antes de um “Mostrar”, as notas ficam ocultas;
        antes de um “Ocultar”, ficam visíveis. Horários de Brasília.
      </p>
    </div>
  );
}

/**
 * Class or student level: whether these dates follow the school, and the way back. Grade agendas
 * live in the calendar, so saving here gives this level its own whole calendar.
 */
export function GradesScopeNoteV1({
  settings,
  sourceLabel,
  canWrite,
  disabled,
  onInherit,
}: Readonly<{
  settings: EffectiveSettingsV1;
  sourceLabel: string;
  canWrite: boolean;
  disabled: boolean;
  onInherit: () => void;
}>) {
  if (settings.scope.kind === 'school') return null;
  let level: 'Esta turma' | 'Este turno' | 'Este aluno';
  if (settings.scope.kind === 'class') {
    level = 'Esta turma';
  } else if (settings.scope.kind === 'shift') {
    level = 'Este turno';
  } else {
    level = 'Este aluno';
  }
  const owns = ownsSettingV1(settings, 'calendar');
  return (
    <div className="pa-grades-scope" role="note">
      <Chip size="sm" variant="soft" color={owns ? 'warning' : 'default'}>
        {owns
          ? 'Datas próprias'
          : settings.sources.calendar.kind === 'school'
            ? 'Padrão da escola'
            : 'Padrão de ' + sourceLabel}
      </Chip>
      <p>
        {owns
          ? `${level} tem datas próprias: mudanças da escola no Calendário e nas Notas não valem aqui.`
          : settings.scope.kind === 'class' && settings.sources.calendar.kind === 'shift'
            ? `${level} segue as datas de ${sourceLabel}.`
            : `${level} segue as datas ${settings.sources.calendar.kind === 'school' ? 'da escola' : 'de ' + sourceLabel}. Salvar um agendamento aqui cria datas próprias para ${level === 'Esta turma' ? 'ela' : 'ele'}.`}
      </p>
      {owns && canWrite ? (
        <Button
          size="sm"
          variant="ghost"
          isDisabled={disabled}
          aria-label="Usar padrão das datas"
          onPress={onInherit}
        >
          Usar padrão
        </Button>
      ) : null}
    </div>
  );
}
