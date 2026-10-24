import { useCallback, useState } from 'react';
import { Button, Card, Chip, Input, Table, Tooltip } from '@heroui/react';
import { Pencil, Trash2 } from 'lucide-react';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import type { CustomizationRowV1 } from '../../../../shared/student-portal-contracts/customizations-v1';
import type { PortalAdminReadClientV2 } from '../accounts/accounts-client-v2';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { AccountsErrorV1 } from '../accounts/accounts-presentation-v1';
import { ContinuousEndV1, useContinuousReadV1 } from '../shared/continuous-read-v1';
import { InfoV1 } from '../shared/info-v1';
import { StudentAvatarV1 } from '../shared/student-avatar-v1';
import { LiveReadNoticeV1 } from '../../../shared/live-data/live-read-notice-v1';
import { SETTINGS_LABELS_V1, settingsScopeKeyV1, type SettingsFieldV1 } from './settings-values-v1';
import { allowDraftNavigationV1 } from '../../../shared/forms/draft-navigation-v1';
import { CustomizationResetV1 } from './customization-reset-v1';
import { useDebouncedSearchV1 } from '../shared/debounced-search-v1';
import {
  customizationPeriodV1,
  customizationResetChoicesV1,
  publicationDifferenceV1,
  type OpenCustomizationV1,
} from './customization-values-v1';

type Props = {
  reader: PortalAdminReadClientV2;
  client: PortalAdminClientV1;
  canWrite: boolean;
  scope: ScopeV1;
  onOpen: OpenCustomizationV1;
};
const valueLabel = (value: unknown) => {
  if (typeof value === 'boolean') {
    if (value) {
      return 'Ativado';
    }
    return 'Desativado';
  }
  if (Array.isArray(value) && value.some((item) => typeof item === 'object')) {
    return `${value.length} ${value.length === 1 ? 'agendamento' : 'agendamentos'}`;
  }
  if (Array.isArray(value)) {
    return (
      value.map((period) => customizationPeriodV1(String(period))).join(', ') || 'Nenhum período'
    );
  }
  return 'Personalizado';
};
function CustomizedSettingsScopeV1({ reader, client, canWrite, scope, onOpen }: Readonly<Props>) {
  const key = settingsScopeKeyV1(scope);
  const [search, setSearch] = useState('');
  const nameSearch = useDebouncedSearchV1(search);
  const load = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const result = await reader.query(
        {
          contractVersion: 2,
          operation: 'customizations-read',
          scope,
          ...(nameSearch ? { nameSearch } : {}),
          page: { limit: 100, ...(cursor ? { cursor } : {}) },
        },
        signal,
      );
      if (result.state !== 'customizations-read' || settingsScopeKeyV1(result.scope) !== key)
        throw new PortalClientErrorV1('invalid-response');
      return result;
    },
    [reader, key, nameSearch],
  );
  const read = useContinuousReadV1(load, 'id');
  const [reset, setReset] = useState<CustomizationRowV1 | null>(null);
  const data = read.state.state === 'ready' ? read.state.data : null;
  const open = (row: CustomizationRowV1) => {
    if (allowDraftNavigationV1()) onOpen(row, row.publications.length ? 'publication' : 'settings');
  };
  const endReset = () => {
    setReset(null);
    read.reload();
  };
  return (
    <Card className="pa-custom-settings">
      <Card.Header className="flex-row items-center justify-between">
        <h3>Políticas personalizadas</h3>
        <InfoV1 label="Sobre as políticas personalizadas">
          Somente diferenças atuais definidas para alunos ou turmas. Quem apenas segue o padrão não
          aparece. A lixeira desfaz a opção escolhida e volta ao padrão aplicável; não apaga
          pessoas, notas ou auditoria.
        </InfoV1>
      </Card.Header>
      <Card.Content>
        <Input
          aria-label="Buscar personalizações por aluno ou turma"
          placeholder="Buscar aluno ou turma"
          className="max-w-md"
          maxLength={200}
          value={search}
          onChange={(event) => {
            if (allowDraftNavigationV1()) setSearch(event.target.value);
          }}
        />
        {read.state.state === 'loading' || read.state.state === 'idle' ? (
          <p role="status">Consultando personalizações…</p>
        ) : null}
        {read.state.state === 'error' ? (
          <AccountsErrorV1
            error={read.state.error}
            canReload={read.canReload}
            onReload={read.reload}
          />
        ) : null}
        <LiveReadNoticeV1 failed={Boolean(read.refreshError)} />
        {data && data.items.length === 0 && !data.nextCursor ? (
          <p className="text-sm text-muted">
            {nameSearch
              ? 'Nenhuma personalização corresponde à busca.'
              : 'Nenhuma personalização atual. Alunos e turmas seguem o padrão.'}
          </p>
        ) : null}
        {data && data.items.length > 0 ? (
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label="Políticas personalizadas">
                <Table.Header>
                  <Table.Column isRowHeader>Aluno ou turma</Table.Column>
                  <Table.Column>Situação</Table.Column>
                  <Table.Column>Política diferenciada</Table.Column>
                  <Table.Column>Ações</Table.Column>
                </Table.Header>
                <Table.Body items={data.items}>
                  {(row) => (
                    <Table.Row id={row.id} key={row.id}>
                      <Table.Cell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="pa-student-name h-auto text-left"
                          aria-label={`Abrir personalizações de ${row.label}`}
                          onPress={() => open(row)}
                        >
                          <StudentAvatarV1 id={row.id} />
                          <span className="pa-custom-owner">
                            <strong>{row.label}</strong>
                            <small>{ownerNoteV1(row)}</small>
                          </span>
                        </Button>
                      </Table.Cell>
                      <Table.Cell>
                        <Chip size="sm" variant="soft" color={rowColorV1(row)}>
                          <Chip.Label>{rowStateV1(row)}</Chip.Label>
                        </Chip>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="grid min-w-60 max-w-xl gap-1 text-xs">
                          {row.publications.map((item) => (
                            <p key={item.period}>{publicationDifferenceV1(item, row.scope)}</p>
                          ))}
                          {(Object.keys(row.value ?? {}) as SettingsFieldV1[]).map((field) => (
                            <p key={field}>
                              <strong>{SETTINGS_LABELS_V1[field]}:</strong>{' '}
                              {valueLabel(row.value![field])}
                              {' · Padrão aplicável: '}
                              {valueLabel(row.inheritedValue![field])}
                            </p>
                          ))}
                          {row.blocked ? (
                            <p>
                              <strong>Bloqueio manual de acesso.</strong> Definido individualmente.
                            </p>
                          ) : null}
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex items-center gap-1">
                          <Tooltip>
                            <Tooltip.Trigger>
                              <Button
                                isIconOnly
                                size="sm"
                                variant="ghost"
                                aria-label={`Editar personalizações de ${row.label}`}
                                onPress={() => open(row)}
                              >
                                <Pencil size={16} />
                              </Button>
                            </Tooltip.Trigger>
                            <Tooltip.Content>
                              Abrir a ficha na configuração correspondente
                            </Tooltip.Content>
                          </Tooltip>
                          <Tooltip>
                            <Tooltip.Trigger>
                              <Button
                                isIconOnly
                                size="sm"
                                variant="danger-soft"
                                aria-label={`Voltar ao padrão de ${row.label}`}
                                isDisabled={!canWrite || read.refreshing}
                                onPress={() => {
                                  if (allowDraftNavigationV1()) setReset(row);
                                }}
                              >
                                <Trash2 size={16} />
                              </Button>
                            </Tooltip.Trigger>
                            <Tooltip.Content>
                              Desfazer uma personalização e voltar ao padrão
                            </Tooltip.Content>
                          </Tooltip>
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        ) : null}
        {data ? (
          <ContinuousEndV1
            more={read.more}
            busy={read.refreshing}
            failed={Boolean(read.refreshError)}
            loadMore={read.loadMore}
            retry={read.reload}
          />
        ) : null}
      </Card.Content>
      {reset && data && canWrite ? (
        <CustomizationResetV1
          client={client}
          label={reset.label}
          choices={customizationResetChoicesV1(reset)}
          canWrite={canWrite}
          onClose={endReset}
          onCommitted={endReset}
        />
      ) : null}
    </Card>
  );
}
/** Under the name: "Turma", "Turno", or the student's class. */
function ownerNoteV1(row: CustomizationRowV1) {
  if (row.scope.kind === 'class') return 'Turma';
  if (row.scope.kind === 'shift') return 'Turno';
  return row.classLabel;
}

function rowColorV1(row: CustomizationRowV1) {
  if (row.blocked) return 'danger';
  return row.accountState === 'active' ? 'success' : 'accent';
}

/** The state chip: blocked, a class or shift, or the student's account. */
function rowStateV1(row: CustomizationRowV1) {
  if (row.blocked) return 'Bloqueado';
  if (row.scope.kind === 'class') return 'Turma';
  if (row.scope.kind === 'shift') return 'Turno';
  if (row.accountState === 'active') return 'Ativa';
  return row.accountState === 'reset-required' ? 'Redefinição pendente' : 'Primeiro acesso';
}

export function CustomizedSettingsV1(props: Readonly<Props>) {
  return (
    <CustomizedSettingsScopeV1
      key={settingsScopeKeyV1(props.scope) + ':' + props.canWrite}
      {...props}
    />
  );
}
