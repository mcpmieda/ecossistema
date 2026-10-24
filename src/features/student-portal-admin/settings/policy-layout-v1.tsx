import { useState, type ReactNode } from 'react';
import { Alert, Button, Tabs } from '@heroui/react';
import {
  CalendarCheck,
  CalendarDays,
  DoorOpen,
  GraduationCap,
  LockKeyhole,
  NotebookPen,
  PencilLine,
  ShieldCheck,
  UserCog,
} from 'lucide-react';
import type { SettingsFieldV1 } from './settings-values-v1';
import { LiveRefreshScopeV1 } from '../../../shared/live-data/live-refresh-scope-v1';

const categories = [
  {
    id: 'access',
    label: 'Acesso',
    icon: DoorOpen,
    title: 'Entrada no Portal',
    description: 'Abra ou feche o Portal agora e agende as próximas aberturas e fechamentos.',
    fields: ['accessEnabled'],
  },
  {
    id: 'grades',
    label: 'Notas',
    icon: NotebookPen,
    title: 'Notas',
    description: 'Publique as notas de cada período e escolha quando os alunos as veem.',
    fields: [],
  },
  {
    id: 'closing',
    label: 'Relatório de notas',
    icon: GraduationCap,
    title: 'Relatório de notas',
    description: 'A orientação por disciplina que o aluno lê sobre o trimestre.',
    fields: ['showTermClosing', 'termClosingConclusive'],
  },
  {
    id: 'frequency',
    label: 'Frequência',
    icon: CalendarCheck,
    title: 'Frequência',
    description: 'Escolha se os alunos veem a própria frequência no Portal.',
    fields: ['showFrequency'],
  },
  {
    id: 'calendar',
    label: 'Calendário',
    icon: CalendarDays,
    title: 'Datas e horários',
    description:
      'Dias letivos, datas principais do ano e o horário das aulas. Notas e resultado anual ficam na aba Notas.',
    // The main dates are marked on the school calendar (owner decision 23/10/2026), no form.
    fields: [],
  },
  {
    id: 'security',
    label: 'Segurança',
    icon: ShieldCheck,
    title: 'Sessões e proteção',
    description: 'Tempo de conexão e limites para tentativas de entrada.',
    fields: ['risk'],
  },
] as const;

export function PolicyLayoutV1({
  field,
  grades,
  disabled,
  shift = false,
  customizations,
  schoolCalendar,
  schoolBells,
  calendarEditable = false,
}: Readonly<{
  /** locked: shown read-only (the Calendário tab outside its edit mode). */
  field: (name: SettingsFieldV1, locked?: boolean) => ReactNode;
  /** The Notas tab: periods (publication and agenda), Resultado anual and options. */
  grades?: ReactNode;
  disabled: boolean;
  shift?: boolean;
  /** Class and student overrides of this scope: a tab of its own, mounted on first visit. */
  customizations?: ReactNode;
  /** The school's calendar of school days (school scope only), editable only in edit mode. */
  schoolCalendar?: (editing: boolean) => ReactNode;
  /** The time of each lesson and of the break (school scope only), under the Horário switch. */
  schoolBells?: (editing: boolean) => ReactNode;
  /** The person may change the Calendário tab: it shows "Editar" (owner request 23/10/2026). */
  calendarEditable?: boolean;
}>) {
  const [selected, setSelected] = useState<string>('access');
  const [publicationVisited, setPublicationVisited] = useState(false);
  const [customizationsVisited, setCustomizationsVisited] = useState(false);
  // Calendário opens read-only, so nothing changes by an accidental click (owner request
  // 23/10/2026); "Editar" unlocks it and shows the save buttons. Leaving discards unsaved changes.
  const [calendarEditing, setCalendarEditing] = useState(false);
  const [calendarSession, setCalendarSession] = useState(0);
  return (
    <Tabs
      className="pa-policy-tabs"
      selectedKey={selected}
      onSelectionChange={(key) => {
        setSelected(String(key));
        if (key === 'grades') setPublicationVisited(true);
        if (key === 'customizations') setCustomizationsVisited(true);
      }}
    >
      <Tabs.ListContainer className="pa-policy-navigation">
        <Tabs.List aria-label="Categorias de políticas">
          {categories.map(({ id, label, icon: Icon }) => (
            <Tabs.Tab key={id} id={id} isDisabled={disabled}>
              <Icon size={16} aria-hidden />
              {label}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
          {customizations ? (
            <Tabs.Tab id="customizations" isDisabled={disabled}>
              <UserCog size={16} aria-hidden />
              Políticas personalizadas
              <Tabs.Indicator />
            </Tabs.Tab>
          ) : null}
        </Tabs.List>
      </Tabs.ListContainer>
      {categories.map((category) => (
        <Tabs.Panel key={category.id} id={category.id} shouldForceMount className="pa-policy-panel">
          <header className="pa-policy-intro">
            <h2>{category.title}</h2>
            <p>
              {shift && category.id === 'grades'
                ? 'Escolha quando os alunos deste turno veem as notas publicadas.'
                : category.description}
            </p>
          </header>
          {category.fields.length ? (
            <div className="pa-settings-fields">{category.fields.map((name) => field(name))}</div>
          ) : null}
          {category.id === 'calendar' && calendarEditable ? (
            <div className="pa-policy-edit-bar">
              {calendarEditing ? (
                <>
                  <Alert status="warning" className="pa-policy-edit-bar__note">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>Modo de edição</Alert.Title>
                      <Alert.Description>
                        Salve cada parte antes de sair. O que não for salvo é descartado.
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setCalendarEditing(false);
                      setCalendarSession((value) => value + 1);
                    }}
                  >
                    <LockKeyhole size={16} aria-hidden />
                    Sair da edição
                  </Button>
                </>
              ) : (
                <Button variant="primary" onPress={() => setCalendarEditing(true)}>
                  <PencilLine size={16} aria-hidden />
                  Editar
                </Button>
              )}
            </div>
          ) : null}
          {category.id === 'calendar' ? (
            <div key={calendarSession} className="pa-policy-calendar">
              {schoolCalendar?.(calendarEditing)}
              {/* Horário das aulas inside Calendário (owner request 23/10/2026: no tab of its own):
                  the switch that shows the weekly grid in the Portal, then each lesson's time. */}
              <div className="pa-settings-fields pa-settings-fields--after">
                {field('showSchedule', calendarEditable && !calendarEditing)}
              </div>
              {schoolBells?.(calendarEditing)}
            </div>
          ) : null}
          {category.id === 'grades' && publicationVisited ? (
            <LiveRefreshScopeV1 active={selected === 'grades'}>
              <div className="pa-grades">{grades}</div>
            </LiveRefreshScopeV1>
          ) : null}
        </Tabs.Panel>
      ))}
      {customizations ? (
        <Tabs.Panel id="customizations" shouldForceMount className="pa-policy-panel">
          {customizationsVisited ? (
            <LiveRefreshScopeV1 active={selected === 'customizations'}>
              {customizations}
            </LiveRefreshScopeV1>
          ) : null}
        </Tabs.Panel>
      ) : null}
    </Tabs>
  );
}
