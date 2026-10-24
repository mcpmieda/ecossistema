import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  Card,
  Chip,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
} from '@heroui/react';
import { GRADE_LABELS_V1 } from './grades-agenda-v1';
import { PolicyLayoutV1 } from './policy-layout-v1';
import { SchoolCalendarEditorV1 } from './school-calendar-editor-v1';
import { SchoolBellsEditorV1 } from './school-bells-editor-v1';
import type { EffectiveSettingsV1 } from '../../../../shared/student-portal-contracts/policy-v1';
import type { PolicyScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import {
  createLatestPortalRequestV1,
  type PortalLoadStateV1,
} from '../../student-portal/shared/latest-request-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { CustomizedSettingsV1 } from './customized-settings-v1';
import type { OpenCustomizationV1 } from './customization-values-v1';
import type { PortalAdminReadClientV2 } from '../accounts/accounts-client-v2';
import { SettingsEditorV1, SettingsValueSummaryV1 } from './settings-editors-v1';
import { parseSettingsDraftV1, settingsDraftV1 } from './settings-draft-v1';
import { createSettingsMutationV1, type SettingsMutationStateV1 } from './settings-mutation-v1';
import {
  SETTINGS_LABELS_V1,
  PERIODS_V1,
  changedPastDatesV1,
  calendarChangeLabelV1,
  ownsSettingV1,
  settingsScopeKeyV1,
  settingsScopeLabelV1,
  type SettingsFieldV1,
} from './settings-values-v1';
import { useDraftNavigationGuardV1 } from '../../../shared/forms/draft-navigation-v1';
import { LinkClosureV1 } from './link-closure-v1';
import { AccessPlanCardV1, AccessPlanSummaryV1, accessPlanOfSettingsV1 } from './access-plan-v1';
import {
  FinalResultCardV1,
  GradeShowV1,
  GradeStatusChipV1,
  GradesIntroV1,
  GradesScopeNoteV1,
  type GradeReviewIntentV1,
} from './grades-tab-v1';
import type { PublicationItemV1 } from '../publication/publication-values-v1';
import { accessOpenAtV1 } from '../../../../shared/student-portal-contracts/access-schedule-v1';
import { LiveReadNoticeV1 } from '../../../shared/live-data/live-read-notice-v1';
import { useLiveRefreshV1 } from '../../../shared/live-data/use-live-refresh-v1';
import './student-settings-v1.css';

type ReviewIntentV1 =
  | { field: SettingsFieldV1; inherit: true }
  | {
      field: SettingsFieldV1;
      inherit: false;
      value: ReturnType<typeof parseSettingsDraftV1>;
      /** A plain-language confirmation instead of the raw value (Aba Notas agendas). */
      presentation?: { title: string; body: ReactNode };
    };
type ReviewV1 = ReviewIntentV1 & { expectedVersion: number; draftKey?: string };
/** What the Notas tab adds to each publication period card. */
export type PublicationSlotsV1 = {
  periodStatus: (item: PublicationItemV1) => ReactNode;
  periodExtra: (item: PublicationItemV1) => ReactNode;
};
export interface StudentSettingsPropsV1 {
  readonly publication?: ReactNode | ((slots: PublicationSlotsV1) => ReactNode);
  readonly area?: 'all' | 'policies' | 'general';
  readonly client: PortalAdminClientV1;
  readonly reader?: PortalAdminReadClientV2;
  readonly scope: PolicyScopeV1;
  readonly canWrite: boolean;
  readonly scopeLabel?: string;
  readonly describeScope?: (scope: PolicyScopeV1) => string;
  readonly onCommitted?: () => void;
  readonly onOpenCustomization?: OpenCustomizationV1;
}
const fieldHelp: Record<SettingsFieldV1, string> = {
  accessEnabled:
    'Permite a entrada com senha ou QR. Agendamentos abrem e fecham sozinhos. O bloqueio da escola prevalece.',
  accessSchedule: 'Abrir e Fechar agendados, salvos junto com a entrada no Portal.',
  showPartials: 'O aluno vê a nota de cada avaliação e atividade, além da nota do trimestre.',
  autoUpdate:
    'Quando o Banco tiver notas mais novas de um período já publicado, elas são publicadas sem precisar clicar. A primeira publicação de cada período continua manual.',
  showFinalResult:
    'Exibe o resultado anual autorizado. Na aba Notas, use os agendamentos do Resultado anual.',
  showTermClosing: 'Exibe uma orientação por disciplina, com as frases aprovadas pela escola.',
  termClosingConclusive:
    'Escolha entre a conclusão do trimestre encerrado e a orientação durante o trimestre.',
  showFrequency:
    'Mostra ao aluno a frequência do mês. Desativada, a seção some do Portal e a consulta é recusada.',
  showSchedule:
    'Mostra ao aluno a grade semanal da turma, como está no Smecel. Desativada, a aba some do Portal e a consulta é recusada.',
  allowedPeriods:
    'Define quais notas podem aparecer. Também é necessário publicar e respeitar as datas de divulgação.',
  risk: 'Os limites de sessão e proteção são uma configuração única. A sessão curta não pode exceder a persistente; a verificação deve começar antes do bloqueio.',
  calendar:
    'Campos vazios não definem datas. Personalizar substitui todo o calendário neste nível.',
};

function sourceBadgeV1(
  settings: EffectiveSettingsV1,
  field: SettingsFieldV1,
  owns: boolean,
  sourceLabel: string,
) {
  if (owns) return settings.scope.kind === 'school' ? 'Padrão da escola' : 'Definido aqui';
  return settings.sources[field].kind === 'school'
    ? 'Padrão da escola'
    : 'Padrão de ' + sourceLabel;
}

function loadErrorLabelV1(error: PortalClientErrorV1) {
  if (error.state === 'unauthenticated') return 'Sessão expirada. Entre novamente no ADM.';
  if (error.state === 'forbidden') return 'Sem permissão para esta consulta.';
  return 'Configurações indisponíveis. Tente novamente.';
}

function mutationErrorLabelV1(error: PortalClientErrorV1) {
  if (error.state === 'conflict')
    return 'A configuração mudou em outra operação. Recarregue e revise antes de salvar novamente.';
  if (error.state === 'unauthenticated' || error.state === 'forbidden')
    return 'A operação não foi autorizada. Recarregue sua sessão e permissões.';
  return 'Não foi possível confirmar o resultado da operação. Tente a mesma operação novamente ou recarregue o estado antes de uma nova alteração.';
}

function sourceLabelV1(
  source: PolicyScopeV1,
  fixedScope: PolicyScopeV1,
  label: string,
  describeScope?: (scope: PolicyScopeV1) => string,
) {
  if (settingsScopeKeyV1(source) === settingsScopeKeyV1(fixedScope)) return label;
  return describeScope?.(source) ?? settingsScopeLabelV1(source);
}
function FieldCardV1({
  field,
  settings,
  disabled,
  canWrite,
  sourceLabel,
  review,
  onDirtyChange,
  compact = false,
}: Readonly<{
  field: SettingsFieldV1;
  settings: EffectiveSettingsV1;
  disabled: boolean;
  canWrite: boolean;
  sourceLabel: string;
  review: (review: ReviewIntentV1) => void;
  onDirtyChange: (key: string, dirty: boolean) => void;
  compact?: boolean;
}>) {
  const sourceDraft = useMemo(() => settingsDraftV1(field, settings.value), [field, settings]);
  const sourceKey = JSON.stringify(sourceDraft);
  const [draft, setDraft] = useState(sourceDraft);
  const precedingSource = useRef(sourceKey);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== sourceKey;
  useEffect(() => {
    const wasDirty = JSON.stringify(draft) !== precedingSource.current;
    precedingSource.current = sourceKey;
    if (!wasDirty) setDraft(sourceDraft);
  }, [sourceDraft, sourceKey]);
  useEffect(() => {
    onDirtyChange(field, dirty);
    return () => onDirtyChange(field, false);
  }, [dirty, field, onDirtyChange]);
  const owns = ownsSettingV1(settings, field);
  const boolean = typeof sourceDraft === 'boolean';
  // A yes/no option as a menu: on a class or shift, or the orientation type on the school.
  const asSelect =
    canWrite &&
    boolean &&
    compact &&
    (settings.scope.kind !== 'school' || field === 'termClosingConclusive');
  const [onLabel, offLabel] =
    field === 'termClosingConclusive'
      ? ['Trimestre encerrado', 'Trimestre em andamento']
      : ['Ativado', 'Desativado'];
  const defaultLabel = sourceDraft ? onLabel : offLabel;
  function prepare() {
    try {
      const value = parseSettingsDraftV1(field, draft);
      setError(null);
      review({ field, inherit: false, value });
    } catch {
      setError('Confira os valores, os limites e a ordem das datas antes de salvar.');
    }
  }
  return (
    <Card
      className={`pa-settings-card pa-settings-card--${field}${boolean ? ' pa-settings-card--boolean' : ''}`}
    >
      <Card.Header>
        <div className="pa-settings-card-heading">
          {!(compact && (field === 'calendar' || field === 'risk')) ? (
            <h3>
              {field === 'termClosingConclusive' ? 'Tipo de orientação' : SETTINGS_LABELS_V1[field]}
            </h3>
          ) : null}
          {settings.scope.kind !== 'school' ? (
            <Chip size="sm" variant="soft">
              {sourceBadgeV1(settings, field, owns, sourceLabel)}
            </Chip>
          ) : null}
          <p className="pa-settings-field-help">
            {field === 'calendar' && settings.scope.kind === 'school'
              ? 'Campos vazios não definem datas.'
              : fieldHelp[field]}
          </p>
        </div>
      </Card.Header>
      <Card.Content>
        {asSelect ? (
          <Select
            selectedKey={
              !owns && settings.scope.kind !== 'school' ? 'inherit' : String(sourceDraft)
            }
            isDisabled={disabled}
            onSelectionChange={(key) => {
              if (key === 'inherit') review({ field, inherit: true });
              else if (key === 'true' || key === 'false')
                review({
                  field,
                  inherit: false,
                  value: parseSettingsDraftV1(field, key === 'true'),
                });
            }}
          >
            <Label className="sr-only">{SETTINGS_LABELS_V1[field]}</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {settings.scope.kind !== 'school' ? (
                  <ListBox.Item id="inherit" textValue="Usar padrão">
                    {owns ? 'Usar padrão' : `Padrão · ${defaultLabel}`}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ) : null}
                <ListBox.Item id="true" textValue={onLabel}>
                  {onLabel}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item id="false" textValue={offLabel}>
                  {offLabel}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        ) : null}
        {canWrite && !asSelect ? (
          <SettingsEditorV1
            field={field}
            value={boolean ? sourceDraft : draft}
            disabled={disabled}
            compact={compact}
            onChange={(value) => {
              if (boolean) {
                review({ field, inherit: false, value: parseSettingsDraftV1(field, value) });
                return;
              }
              setDraft(value);
              setError(null);
            }}
          />
        ) : null}
        {canWrite ? null : <SettingsValueSummaryV1 field={field} value={settings.value[field]} />}
        {error ? (
          <p className="pa-settings-error" role="alert">
            {error}
          </p>
        ) : null}
      </Card.Content>
      {canWrite ? (
        <Card.Footer className="pa-settings-actions">
          {!boolean ? (
            <Button
              size="sm"
              variant="secondary"
              isDisabled={disabled || (owns && !dirty)}
              onPress={prepare}
              aria-label={`Revisar ${SETTINGS_LABELS_V1[field]}`}
            >
              {owns ? 'Salvar' : 'Personalizar'}
            </Button>
          ) : null}
          {settings.scope.kind !== 'school' && owns && !(compact && boolean) ? (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={disabled}
              onPress={() => review({ field, inherit: true })}
              aria-label={`Usar padrão de ${SETTINGS_LABELS_V1[field]}`}
            >
              Usar padrão
            </Button>
          ) : null}
        </Card.Footer>
      ) : null}
    </Card>
  );
}
function ReviewDialogV1({
  review,
  settings,
  scopeLabel,
  disabled,
  close,
  confirm,
}: Readonly<{
  review: ReviewV1;
  settings: EffectiveSettingsV1;
  scopeLabel: string;
  disabled: boolean;
  close: () => void;
  confirm: () => void;
}>) {
  const next = review.inherit ? null : review.value[review.field];
  const past =
    !review.inherit && review.field === 'calendar' && review.value.calendar
      ? changedPastDatesV1(settings.value.calendar, review.value.calendar, Date.now())
      : [];
  let title: ReactNode =
    review.field === 'accessEnabled' ? 'Entrada no Portal' : SETTINGS_LABELS_V1[review.field];
  if (!review.inherit && review.presentation) title = review.presentation.title;
  let change: ReactNode;
  if (review.inherit) {
    change = (
      <p>
        {review.field === 'accessEnabled'
          ? 'A entrada no Portal e os agendamentos voltarão a seguir o padrão aplicável.'
          : 'Esta opção voltará a seguir o padrão aplicável.'}
      </p>
    );
  } else if (review.presentation) {
    change = review.presentation.body;
  } else if (review.field === 'accessEnabled') {
    change = (
      <>
        <p>Como vai ficar:</p>
        <AccessPlanSummaryV1
          plan={{
            enabled: review.value.accessEnabled ?? false,
            schedule: review.value.accessSchedule ?? [],
          }}
          now={Date.now()}
          wasOpen={accessOpenAtV1(accessPlanOfSettingsV1(settings).plan, Date.now())}
        />
      </>
    );
  } else {
    change = (
      <>
        <p>Novo valor:</p>
        <SettingsValueSummaryV1 field={review.field} value={next!} />
      </>
    );
  }
  return (
    <Modal.Backdrop
      isOpen
      isDismissable={!disabled}
      isKeyboardDismissDisabled={disabled}
      onOpenChange={(open) => {
        if (!open && !disabled) close();
      }}
    >
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{review.inherit ? 'Usar padrão' : 'Confirmar alteração'}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="pa-settings-review">
            <p>
              <strong>{title}</strong>{' '}
              em {scopeLabel}.
            </p>
            {change}
            <p>Esta alteração pode mudar imediatamente o acesso e as notas visíveis.</p>
            {past.length ? (
              <div className="pa-settings-warning">
                <p>Há mudança ou remoção de datas que já chegaram:</p>
                <ul>
                  {past.map((key) => (
                    <li key={key}>{calendarChangeLabelV1(key)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {(review.field === 'calendar' && (review.inherit || !review.presentation)) ||
            review.field === 'autoUpdate' ? (
              <p>As notas já publicadas ou retiradas não serão restauradas por esta alteração.</p>
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" isDisabled={disabled} onPress={close}>
              Voltar
            </Button>
            <Button isDisabled={disabled} isPending={disabled} onPress={confirm}>
              {review.inherit ? 'Usar padrão' : 'Confirmar alteração'}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
function SettingsMutationFeedbackV1({
  mutation,
  canWrite,
  clock,
  retry,
  reload,
}: Readonly<{
  mutation: SettingsMutationStateV1;
  canWrite: boolean;
  clock: number;
  retry: () => void;
  reload: () => void;
}>) {
  if (mutation.state !== 'error') return null;
  return (
    <div className="pa-settings-error" role="alert">
      <p>{mutationErrorLabelV1(mutation.error)}</p>
      {mutation.retryable && canWrite ? (
        <Button size="sm" variant="secondary" isDisabled={clock < mutation.retryAt} onPress={retry}>
          Tentar novamente
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onPress={reload}>
        Recarregar
      </Button>
    </div>
  );
}

function SettingsReadyV1({
  publication,
  fieldVersions,
  area,
  data,
  mutation,
  client,
  reader,
  fixedScope,
  canWrite,
  busy,
  review,
  label,
  discardVersion,
  sourceLabel,
  onDirtyChange,
  onReview,
  onRetry,
  onReload,
  onRefresh,
  clock,
  onOpenCustomization,
  linksClosed,
  setClosing,
  onReviewClose,
  onReviewConfirm,
}: Readonly<{
  publication?: StudentSettingsPropsV1['publication'];
  fieldVersions: Partial<Record<string, number>>;
  area: 'all' | 'policies' | 'general';
  data: EffectiveSettingsV1;
  mutation: SettingsMutationStateV1;
  client: PortalAdminClientV1;
  reader?: PortalAdminReadClientV2;
  fixedScope: PolicyScopeV1;
  canWrite: boolean;
  busy: boolean;
  review: ReviewV1 | null;
  label: string;
  discardVersion: number;
  sourceLabel: (scope: PolicyScopeV1) => string;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onReview: (review: ReviewV1) => void;
  onRetry: () => void;
  onReload: () => void;
  /** Reads the settings again, keeping what is being edited (the school calendar saved its dates). */
  onRefresh: () => void;
  clock: number;
  onOpenCustomization?: OpenCustomizationV1;
  linksClosed: () => void;
  setClosing: (value: boolean) => void;
  onReviewClose: () => void;
  onReviewConfirm: () => void;
}>) {
  const fieldDisabled = busy || mutation.state === 'error' || review !== null;
  const controlledByShift = (field: SettingsFieldV1) =>
    fixedScope.kind === 'class' && data.sources[field].kind === 'shift';
  const suspendedFields = (Object.keys(SETTINGS_LABELS_V1) as SettingsFieldV1[]).filter(
    controlledByShift,
  );
  const accessDisabled =
    fieldDisabled || controlledByShift('accessEnabled') || controlledByShift('accessSchedule');
  const gradesDisabled = fieldDisabled || controlledByShift('calendar');
  const renderField = (field: SettingsFieldV1, locked = false) => {
    if (field === 'accessSchedule') return null;
    // The switch and its schedules are one unit, edited on their own card.
    if (field === 'accessEnabled')
      return (
        <AccessPlanCardV1
          key={`${discardVersion}:${field}:${fieldVersions[field] ?? 0}`}
          settings={data}
          canWrite={canWrite}
          disabled={accessDisabled}
          sourceLabel={sourceLabel(data.sources[field])}
          review={(intent) => onReview({ ...intent, expectedVersion: data.version })}
          onDirtyChange={onDirtyChange}
        />
      );
    return (
      <FieldCardV1
        key={`${discardVersion}:${field}:${fieldVersions[field] ?? 0}`}
        field={field}
        settings={data}
        canWrite={canWrite && !locked}
        disabled={fieldDisabled || controlledByShift(field)}
        compact={area === 'policies'}
        sourceLabel={sourceLabel(data.sources[field])}
        review={(intent) => onReview({ ...intent, expectedVersion: data.version })}
        onDirtyChange={onDirtyChange}
      />
    );
  };
  // A shift edits each trimester here; a class or the school reads them with the publication.
  const gradeCards = (): ReactNode => {
    if (fixedScope.kind === 'shift')
      return PERIODS_V1.map((period) => (
        <Card key={period} className="pa-settings-card pa-grade-card">
          <Card.Header>
            <h3>{GRADE_LABELS_V1[period]}</h3>
          </Card.Header>
          <Card.Content>
            <GradeShowV1
              key={`${discardVersion}:${period}:${fieldVersions['grades:' + period] ?? 0}`}
              settings={data}
              gradeKey={period}
              canWrite={canWrite}
              disabled={gradesDisabled}
              review={(intent) => onReview({ ...intent, expectedVersion: data.version })}
              onDirtyChange={onDirtyChange}
            />
          </Card.Content>
        </Card>
      ));
    if (typeof publication !== 'function') return publication;
    return publication({
      periodStatus: (item) => (
        <GradeStatusChipV1 settings={data} period={item.period} state={item.state} />
      ),
      periodExtra: (item) => (
        <GradeShowV1
          key={`${discardVersion}:${item.period}:${fieldVersions['grades:' + item.period] ?? 0}`}
          settings={data}
          gradeKey={item.period}
          canWrite={canWrite}
          disabled={gradesDisabled}
          review={(intent: GradeReviewIntentV1) =>
            onReview({ ...intent, expectedVersion: data.version })
          }
          onDirtyChange={onDirtyChange}
        />
      ),
    });
  };
  const customizations =
    reader &&
    onOpenCustomization &&
    fixedScope.kind !== 'account' &&
    fixedScope.kind !== 'shift' ? (
      <CustomizedSettingsV1
        key={settingsScopeKeyV1(fixedScope)}
        reader={reader}
        client={client}
        scope={fixedScope}
        canWrite={canWrite}
        onOpen={onOpenCustomization}
      />
    ) : null;
  return (
    <>
      <SettingsMutationFeedbackV1
        mutation={mutation}
        canWrite={canWrite}
        clock={clock}
        retry={onRetry}
        reload={onReload}
      />
      {suspendedFields.length ? (
        <p className="pa-settings-hint" role="note">
          Controlado pelo turno:{' '}
          {suspendedFields.map((field) => SETTINGS_LABELS_V1[field]).join(', ')}. As regras da turma
          foram preservadas.
        </p>
      ) : null}
      {area === 'policies' ? (
        <PolicyLayoutV1
          customizations={customizations}
          calendarEditable={canWrite && fixedScope.kind === 'school'}
          schoolCalendar={
            fixedScope.kind === 'school'
              ? (editing) => (
                  <SchoolCalendarEditorV1 client={client} canWrite={canWrite && editing} onSaved={onRefresh} />
                )
              : undefined
          }
          schoolBells={
            fixedScope.kind === 'school'
              ? (editing) => <SchoolBellsEditorV1 client={client} canWrite={canWrite && editing} />
              : undefined
          }
          field={renderField}
          shift={fixedScope.kind === 'shift'}
          grades={
            <>
              <GradesIntroV1 />
              <GradesScopeNoteV1
                settings={data}
                sourceLabel={sourceLabel(data.sources.calendar)}
                canWrite={canWrite}
                disabled={gradesDisabled}
                onInherit={() =>
                  onReview({ field: 'calendar', inherit: true, expectedVersion: data.version })
                }
              />
              {gradeCards()}
              <FinalResultCardV1
                key={`${discardVersion}:final:${fieldVersions['grades:final'] ?? 0}`}
                settings={data}
                canWrite={canWrite}
                disabled={gradesDisabled}
                review={(intent) => onReview({ ...intent, expectedVersion: data.version })}
                onDirtyChange={onDirtyChange}
              />
              <section className="pa-grades-options" aria-labelledby="pa-grades-options-title">
                <h3 id="pa-grades-options-title">Opções</h3>
                {renderField('showPartials')}
                {renderField('autoUpdate')}
              </section>
            </>
          }
          disabled={busy || review !== null}
        />
      ) : null}
      {area !== 'general' && area !== 'policies' ? (
        <div className="pa-settings-fields">
          {(Object.keys(SETTINGS_LABELS_V1) as SettingsFieldV1[]).map((name) => renderField(name))}
        </div>
      ) : null}
      {area !== 'general' && area !== 'policies' ? customizations : null}
      {area !== 'policies' && fixedScope.kind === 'school' && canWrite ? (
        <LinkClosureV1
          key={data.version}
          client={client}
          disabled={mutation.state === 'pending' || review !== null || mutation.state === 'error'}
          onClosed={linksClosed}
          onBusyChange={setClosing}
        />
      ) : null}
      {review && canWrite ? (
        <ReviewDialogV1
          review={review}
          settings={data}
          scopeLabel={label}
          disabled={busy}
          close={onReviewClose}
          confirm={onReviewConfirm}
        />
      ) : null}
    </>
  );
}

function SettingsLoadV1({
  load,
  reload,
  children,
}: Readonly<{
  load: PortalLoadStateV1<EffectiveSettingsV1>;
  reload: () => void;
  children: ReactNode;
}>) {
  if (load.state === 'idle' || load.state === 'loading')
    return (
      <output className="pa-settings-loading">
        <Spinner size="sm" />
        Carregando configurações
      </output>
    );
  if (load.state === 'error')
    return (
      <div role="alert" className="pa-settings-error">
        <p>{loadErrorLabelV1(load.error)}</p>
        <Button size="sm" variant="secondary" onPress={reload}>
          Tentar novamente
        </Button>
      </div>
    );
  return <>{children}</>;
}

function SettingsScopeV1({
  publication,
  area = 'all',
  client,
  reader,
  scope,
  canWrite,
  scopeLabel,
  describeScope,
  onCommitted,
  onOpenCustomization,
}: StudentSettingsPropsV1) {
  const [fixedScope] = useState(() => ({ ...scope }));
  const [load, setLoad] = useState<PortalLoadStateV1<EffectiveSettingsV1>>({ state: 'idle' });
  const [mutation, setMutation] = useState<SettingsMutationStateV1>({ state: 'idle' });
  const [review, setReview] = useState<ReviewV1 | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const [discardVersion, setDiscardVersion] = useState(0);
  const [fieldVersions, setFieldVersions] = useState<Partial<Record<string, number>>>({});
  const submittedField = useRef<string | null>(null);
  const [pendingReset, setPendingReset] = useState<{
    field: string;
    version: number;
  } | null>(null);
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(() => new Set());
  const request = useMemo(() => createLatestPortalRequestV1<EffectiveSettingsV1>(setLoad), []);
  const writer = useMemo(() => createSettingsMutationV1(client, setMutation), [client]);
  const label = scopeLabel ?? settingsScopeLabelV1(fixedScope);
  const reload = useCallback(
    (background = false) =>
      request.run(
        async (signal) => {
          const result = await client.query(
            { contractVersion: 1, operation: 'settings', scope: fixedScope, page: { limit: 50 } },
            signal,
          );
          if (
            result.state !== 'settings' ||
            settingsScopeKeyV1(result.settings.scope) !== settingsScopeKeyV1(fixedScope)
          )
            throw new PortalClientErrorV1('invalid-response');
          return result.settings;
        },
        { background },
      ),
    [client, fixedScope, request],
  );
  useEffect(() => {
    void reload(false);
    return () => request.clear();
  }, [reload, request]);
  useEffect(() => () => writer.clear(), [writer]);
  useEffect(() => {
    if (load.state !== 'ready') setReview(null);
  }, [load.state]);
  useEffect(() => {
    if (mutation.state !== 'error') return;
    setReview(null);
    if (mutation.error.state === 'unauthenticated' || mutation.error.state === 'forbidden') {
      request.clear();
      setLoad({ state: 'error', error: mutation.error });
    }
  }, [mutation, request]);
  useEffect(() => {
    if (mutation.state !== 'committed') return;
    const field = submittedField.current;
    if (field) setPendingReset({ field, version: mutation.version });
    setReview(null);
    setNotice('Salvo.');
    writer.clear();
    void reload(true);
    onCommitted?.();
  }, [mutation, onCommitted, reload, writer]);
  useEffect(() => {
    if (
      !pendingReset ||
      load.state !== 'ready' ||
      load.refreshing ||
      load.refreshError ||
      load.data.version < pendingReset.version
    )
      return;
    const { field } = pendingReset;
    setFieldVersions((previous) => ({ ...previous, [field]: (previous[field] ?? 0) + 1 }));
    setPendingReset(null);
    submittedField.current = null;
  }, [load, pendingReset]);
  useEffect(() => {
    if (mutation.state !== 'error' || !mutation.retryable) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [mutation]);
  useEffect(() => {
    if (!canWrite) {
      writer.clear();
      setReview(null);
    }
  }, [canWrite, writer]);
  useDraftNavigationGuardV1(dirtyFields.size > 0 || mutation.state === 'pending');
  const busy = mutation.state === 'pending' || closing;
  const onDirtyChange = useCallback((field: string, dirty: boolean) => {
    setDirtyFields((previous) => {
      if (previous.has(field) === dirty) return previous;
      const next = new Set(previous);
      if (dirty) next.add(field);
      else next.delete(field);
      return next;
    });
  }, []);
  const discardAndReload = useCallback(() => {
    writer.clear();
    setReview(null);
    setNotice(null);
    setDiscardVersion((value) => value + 1);
    setPendingReset(null);
    submittedField.current = null;
    setDirtyFields(new Set());
    void reload(false);
  }, [reload, writer]);
  const linksClosed = useCallback(() => {
    setNotice('Vínculos de 2026 encerrados. O histórico foi preservado.');
    void reload(true);
    onCommitted?.();
  }, [onCommitted, reload]);
  useLiveRefreshV1(() => reload(true), {
    domains: ['portal', 'gradebook'],
    canRefresh: () =>
      load.state === 'ready' &&
      !load.refreshing &&
      (dirtyFields.size === 0 || pendingReset !== null) &&
      review === null &&
      mutation.state === 'idle' &&
      !closing,
  });
  async function confirm() {
    if (!canWrite || busy || !review || load.state !== 'ready') return;
    const common = {
      contractVersion: 1 as const,
      scope: fixedScope,
      expectedVersion: review.expectedVersion,
      idempotencyKey: crypto.randomUUID(),
    };
    try {
      submittedField.current = review.draftKey ?? review.field;
      await writer.submit(
        review.inherit
          ? {
              ...common,
              operation: 'settings-inherit',
              // The switch and its schedules return to the default together.
              keys:
                review.field === 'accessEnabled'
                  ? ['accessEnabled', 'accessSchedule']
                  : [review.field],
            }
          : {
              ...common,
              operation: 'settings-set',
              value: review.value,
              acknowledgeImmediateEffect: true,
            },
      );
    } catch {
      setNotice('Não foi possível preparar a alteração. Recarregue e revise os valores.');
    }
  }
  const sourceLabel = (source: PolicyScopeV1) =>
    sourceLabelV1(source, fixedScope, label, describeScope);
  return (
    <section
      className={`pa-settings${area === 'policies' ? ' pa-settings--policies' : ''}`}
      aria-label="Configurações do Aluno"
    >
      <header className="pa-settings-heading">
        {area !== 'policies' ? (
          <div>
            <p>{label}</p>
          </div>
        ) : null}
        <LiveReadNoticeV1 failed={load.state === 'ready' && Boolean(load.refreshError)} />
        {pendingReset && load.state === 'ready' && load.refreshError ? (
          <Button size="sm" variant="secondary" onPress={() => void reload(true)}>
            Conferir alteração salva
          </Button>
        ) : null}
        {dirtyFields.size > 0 ? (
          <Button size="sm" variant="outline" isDisabled={busy} onPress={discardAndReload}>
            Desfazer edições
          </Button>
        ) : null}
      </header>
      {notice ? <output>{notice}</output> : null}
      <SettingsLoadV1 load={load} reload={() => void reload(false)}>
        {load.state === 'ready' ? (
          <SettingsReadyV1
            publication={publication}
            fieldVersions={fieldVersions}
            area={area}
            data={load.data}
            mutation={mutation}
            client={client}
            reader={reader}
            fixedScope={fixedScope}
            canWrite={canWrite}
            busy={busy || pendingReset !== null || Boolean(load.refreshing)}
            review={review}
            label={label}
            discardVersion={discardVersion}
            sourceLabel={sourceLabel}
            onDirtyChange={onDirtyChange}
            onReview={setReview}
            onRetry={() => void writer.retry()}
            onReload={discardAndReload}
            onRefresh={() => void reload(true)}
            clock={clock}
            onOpenCustomization={onOpenCustomization}
            linksClosed={linksClosed}
            setClosing={setClosing}
            onReviewClose={() => setReview(null)}
            onReviewConfirm={() => void confirm()}
          />
        ) : null}
      </SettingsLoadV1>
    </section>
  );
}
/** The scope key remounts before paint: stale data/drafts/previews cannot flash in a new scope. */
export function StudentSettingsV1(props: StudentSettingsPropsV1) {
  return (
    <SettingsScopeV1 key={settingsScopeKeyV1(props.scope) + ':' + props.canWrite} {...props} />
  );
}
