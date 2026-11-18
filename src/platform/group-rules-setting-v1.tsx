import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import {
  Alert,
  AlertDialog,
  Button,
  Card,
  Checkbox,
  Chip,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  Table,
  TextField,
} from '@heroui/react';
import { ListChecks, Pencil, Plus, ScrollText, Trash2 } from 'lucide-react';
import {
  GROUP_RULE_CARGO_MAX_V1,
  GROUP_RULE_NOTE_MAX_V1,
  type GroupFlowLogV1,
  type GroupRuleActionV1,
  type GroupRulePersonV1,
  type GroupRuleStatusV1,
  type GroupRuleV1,
  type GroupViewV1,
} from '../../shared/platform-groups-v1';
import { failureTextV1, GroupsClientErrorV1, requestGroupsV1 } from './groups-client-v1';
import { formatDate } from './presentation';

const STATUS_LABELS_V1: Record<GroupRuleStatusV1, string> = {
  PENDENTE_CARGO: 'Sem cargo',
  SEM_REGRA: 'Sem regra',
  PENDENTE_GRUPO: 'Grupo pendente',
  ERRO: 'Erro',
};
/** What the flow wrote in the LOG list; an unknown code is shown as it is. */
const OPERATION_LABELS_V1: Record<string, string> = {
  ADICIONAR: 'Adicionado ao grupo',
  JA_MEMBRO: 'Já era membro',
  ALTERACAO_CARGO: 'Cargo alterado',
  SEM_REGRA: 'Sem regra',
  ANALISAR: 'Para revisar',
  IGNORAR: 'Ignorado',
  ERRO: 'Erro',
};
const RESULT_LABELS_V1: Record<string, string> = { AVISO: 'aviso', ERRO: 'erro' };
/** The list changed under the Secretaria: it is read again. */
const staleV1 = (error: unknown) =>
  error instanceof GroupsClientErrorV1 &&
  (error.state === 'rule-not-found' || error.state === 'rule-changed');

type Notice = { tone: 'success' | 'danger'; text: string } | null;
type DraftV1 = {
  ruleId?: string;
  etag?: string | null;
  cargo: string;
  action: GroupRuleActionV1;
  groupId: string | null;
  active: boolean;
  note: string;
};
const emptyDraftV1 = (cargo = ''): DraftV1 => ({
  cargo,
  action: 'ADICIONAR',
  groupId: null,
  active: true,
  note: '',
});

function NoticeV1({ notice }: Readonly<{ notice: Notice }>) {
  if (!notice) return null;
  return (
    <Alert status={notice.tone}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{notice.text}</Alert.Title>
      </Alert.Content>
    </Alert>
  );
}

type DataV1 = { rules: GroupRuleV1[]; people: GroupRulePersonV1[]; log: GroupFlowLogV1[] };

/** Configurações › Regras por cargo (#1513): the rules of the flow "Grupos por Cargo". */
export function GroupRulesSettingV1() {
  const [data, setData] = useState<DataV1 | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<DraftV1 | null>(null);
  const [removing, setRemoving] = useState<GroupRuleV1 | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [logOpen, setLogOpen] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const answer = await requestGroupsV1({ operation: 'rules' }, signal);
      setData({ rules: answer.rules, people: answer.people, log: answer.log });
      setFailed(false);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function remove(rule: GroupRuleV1) {
    setNotice(null);
    setRemovingId(rule.id);
    try {
      await requestGroupsV1({ operation: 'delete-rule', ruleId: rule.id });
      setNotice({ tone: 'success', text: `Regra "${rule.cargo}" removida.` });
      await load();
    } catch (error) {
      setNotice({ tone: 'danger', text: failureTextV1(error) });
      if (staleV1(error)) await load();
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Card variant="default" className="mt-5 overflow-hidden">
      <Card.Header className="border-b border-border/60">
        <div className="flex w-full flex-wrap items-center gap-3">
          <ListChecks className="size-5 text-accent" aria-hidden="true" />
          <Card.Title>Regras por cargo</Card.Title>
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            isDisabled={!data}
            onPress={() => setDraft(emptyDraftV1())}
          >
            <Plus className="size-4" aria-hidden="true" />
            Nova regra
          </Button>
        </div>
      </Card.Header>
      <Card.Content className="grid gap-5 p-5 sm:p-6">
        <NoticeV1 notice={notice} />
        {data === null && !failed ? <Spinner size="sm" aria-label="Carregando regras" /> : null}
        {failed ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Regras indisponíveis</Alert.Title>
            </Alert.Content>
          </Alert>
        ) : null}
        {data ? (
          <>
            <Table>
              <Table.ScrollContainer className="max-h-[28rem] overflow-auto">
                <Table.Content aria-label="Regras por cargo" className="min-w-[640px]">
                  <Table.Header>
                    <Table.Column id="cargo" isRowHeader>
                      Cargo
                    </Table.Column>
                    <Table.Column id="action">Ação</Table.Column>
                    <Table.Column id="state">Situação</Table.Column>
                    <Table.Column id="review">Revisão</Table.Column>
                    <Table.Column id="actions" className="w-24">
                      <span className="sr-only">Ações</span>
                    </Table.Column>
                  </Table.Header>
                  <Table.Body items={data.rules} renderEmptyState={() => 'Nenhuma regra.'}>
                    {(rule) => (
                      <Table.Row id={rule.id} textValue={rule.cargo}>
                        <Table.Cell>
                          <span className="font-medium">{rule.cargo}</span>
                        </Table.Cell>
                        <Table.Cell>
                          {rule.action === 'IGNORAR' ? 'Ignorar' : (rule.groupName ?? '—')}
                        </Table.Cell>
                        <Table.Cell>
                          <Chip
                            size="sm"
                            variant="soft"
                            color={rule.active ? 'success' : 'default'}
                          >
                            <Chip.Label>{rule.active ? 'Ativa' : 'Inativa'}</Chip.Label>
                          </Chip>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="text-xs text-muted">
                            {rule.reviewedAt ? formatDate(rule.reviewedAt) : '—'}
                            {rule.reviewedBy ? ` · ${rule.reviewedBy}` : ''}
                          </span>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              isIconOnly
                              aria-label={`Editar regra ${rule.cargo}`}
                              isDisabled={removingId === rule.id}
                              onPress={() =>
                                setDraft({
                                  ruleId: rule.id,
                                  etag: rule.etag,
                                  cargo: rule.cargo,
                                  action: rule.action,
                                  groupId: rule.groupId,
                                  active: rule.active,
                                  note: rule.note ?? '',
                                })
                              }
                            >
                              <Pencil className="size-4" aria-hidden="true" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              isIconOnly
                              aria-label={`Remover regra ${rule.cargo}`}
                              isPending={removingId === rule.id}
                              isDisabled={removingId !== null}
                              onPress={() => {
                                setRemoving(rule);
                                setRemoveOpen(true);
                              }}
                            >
                              <Trash2 className="size-4" aria-hidden="true" />
                            </Button>
                          </div>
                        </Table.Cell>
                      </Table.Row>
                    )}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>

            {data.people.length > 0 ? (
              <section className="grid gap-2" aria-label="Pessoas para revisar">
                <h3 className="text-sm font-semibold">Pessoas para revisar</h3>
                <ul className="grid divide-y divide-border/60 rounded-xl border border-border">
                  {data.people.map((person, index) => (
                    <li
                      key={`${person.email ?? ''}-${index}`}
                      className="flex flex-wrap items-center gap-3 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {person.name ?? person.email ?? '—'}
                        </p>
                        <p className="truncate text-xs text-muted">
                          {person.email}
                          {person.cargo ? ` · ${person.cargo}` : ''}
                          {person.detail ? ` · ${person.detail}` : ''}
                        </p>
                      </div>
                      <Chip
                        size="sm"
                        variant="soft"
                        color={person.status === 'ERRO' ? 'danger' : 'warning'}
                      >
                        <Chip.Label>{STATUS_LABELS_V1[person.status]}</Chip.Label>
                      </Chip>
                      {person.status === 'SEM_REGRA' && person.cargo ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={`Criar regra para ${person.cargo}`}
                          onPress={() => setDraft(emptyDraftV1(person.cargo ?? ''))}
                        >
                          Criar regra
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <div>
              <Button size="sm" variant="ghost" onPress={() => setLogOpen((open) => !open)}>
                <ScrollText className="size-4" aria-hidden="true" />
                {logOpen ? 'Ocultar registro da automação' : 'Registro da automação'}
              </Button>
              {logOpen ? <FlowLogV1 log={data.log} /> : null}
            </div>
          </>
        ) : null}
      </Card.Content>

      {draft ? (
        <RuleEditorV1
          draft={draft}
          onClose={() => setDraft(null)}
          onSaved={(rule) => {
            setDraft(null);
            setNotice({ tone: 'success', text: `Regra "${rule.cargo}" salva.` });
            void load();
          }}
          onStale={() => void load()}
        />
      ) : null}

      <AlertDialog.Backdrop
        isOpen={removeOpen}
        onOpenChange={(open) => (open ? undefined : setRemoveOpen(false))}
      >
        <AlertDialog.Container size="sm" placement="center">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>Remover a regra?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>{removing?.cargo}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button autoFocus variant="secondary" onPress={() => setRemoveOpen(false)}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                onPress={() => {
                  setRemoveOpen(false);
                  if (removing && removingId === null) void remove(removing);
                }}
              >
                Remover
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </Card>
  );
}

function FlowLogV1({ log }: Readonly<{ log: GroupFlowLogV1[] }>) {
  if (log.length === 0) return <p className="mt-2 text-sm text-muted">Nenhum registro.</p>;
  return (
    <ul className="mt-2 grid gap-1 text-sm" aria-label="Registro da automação">
      {log.map((entry, index) => (
        <li key={`${entry.at ?? ''}-${index}`} className="flex flex-wrap gap-x-2">
          <span className="tabular-nums text-muted">{entry.at ? formatDate(entry.at) : '—'}</span>
          <span>
            {entry.name ?? entry.email ?? '—'} ·{' '}
            {entry.operation ? (OPERATION_LABELS_V1[entry.operation] ?? entry.operation) : '—'}
            {entry.groupName ? ` · ${entry.groupName}` : ''}
          </span>
          {entry.result && entry.result !== 'SUCESSO' ? (
            <span className={entry.result === 'ERRO' ? 'text-danger' : 'text-muted'}>
              ({RESULT_LABELS_V1[entry.result] ?? entry.result.toLowerCase()})
            </span>
          ) : null}
          {entry.detail ? <span className="text-muted">{entry.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function RuleEditorV1({
  draft: initial,
  onClose,
  onSaved,
  onStale,
}: Readonly<{
  draft: DraftV1;
  onClose: () => void;
  onSaved: (rule: GroupRuleV1) => void;
  onStale: () => void;
}>) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // Read when the editor opens, so a group created a moment ago is there.
  const [groups, setGroups] = useState<GroupViewV1[] | null>(null);
  const [groupsFailure, setGroupsFailure] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    requestGroupsV1({ operation: 'list' }, controller.signal)
      .then((answer) => setGroups(answer.groups.filter((group) => group.available)))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError'))
          setGroupsFailure(failureTextV1(error));
      });
    return () => controller.abort();
  }, []);
  const valid =
    draft.cargo.trim().length > 0 && (draft.action === 'IGNORAR' || draft.groupId !== null);
  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || saving || !valid) return;
    event.preventDefault();
    void save();
  };

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const answer = await requestGroupsV1({
        operation: 'save-rule',
        ...(draft.ruleId ? { ruleId: draft.ruleId } : {}),
        ...(draft.ruleId && draft.etag ? { etag: draft.etag } : {}),
        cargo: draft.cargo.trim(),
        action: draft.action,
        ...(draft.action === 'ADICIONAR' && draft.groupId ? { groupId: draft.groupId } : {}),
        active: draft.active,
        ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
      });
      onSaved(answer.rule);
    } catch (error) {
      setNotice({ tone: 'danger', text: failureTextV1(error) });
      setSaving(false);
      if (staleV1(error)) onStale();
    }
  }

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => (open || saving ? undefined : onClose())}>
      <Modal.Container size="md" placement="center">
        <Modal.Dialog aria-label={draft.ruleId ? 'Editar regra' : 'Nova regra'}>
          <Modal.Header>
            <Modal.Heading>{draft.ruleId ? 'Editar regra' : 'Nova regra'}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="grid gap-4">
            <TextField fullWidth isRequired>
              <Label>Cargo</Label>
              <Input
                autoFocus
                value={draft.cargo}
                maxLength={GROUP_RULE_CARGO_MAX_V1}
                onChange={(event) => setDraft({ ...draft, cargo: event.currentTarget.value })}
                onKeyDown={submitOnEnter}
                autoComplete="off"
              />
            </TextField>
            <Select
              selectedKey={draft.action}
              onSelectionChange={(key) =>
                setDraft({ ...draft, action: key === 'IGNORAR' ? 'IGNORAR' : 'ADICIONAR' })
              }
            >
              <Label>Ação</Label>
              <Select.Trigger className="min-h-11 w-full">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="ADICIONAR" textValue="Adicionar ao grupo">
                    Adicionar ao grupo
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                  <ListBox.Item id="IGNORAR" textValue="Ignorar">
                    Ignorar
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
            {draft.action === 'ADICIONAR' ? (
              <Select
                isRequired
                placeholder="Escolha um grupo"
                selectedKey={draft.groupId}
                onSelectionChange={(key) =>
                  setDraft({ ...draft, groupId: key === null ? null : String(key) })
                }
              >
                <Label>Grupo</Label>
                <Select.Trigger className="min-h-11 w-full">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {(groups ?? []).map((group) => (
                      <ListBox.Item key={group.id} id={group.id} textValue={group.name}>
                        {group.name}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            ) : null}
            {draft.action === 'ADICIONAR' && groups === null && !groupsFailure ? (
              <Spinner size="sm" aria-label="Carregando grupos" />
            ) : null}
            {draft.action === 'ADICIONAR' && groupsFailure ? (
              <p className="text-sm text-danger">{groupsFailure}</p>
            ) : null}
            <Checkbox
              isSelected={draft.active}
              onChange={(selected) => setDraft({ ...draft, active: selected })}
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <span>Ativa</span>
              </Checkbox.Content>
            </Checkbox>
            <TextField fullWidth>
              <Label>Observação</Label>
              <Input
                value={draft.note}
                maxLength={GROUP_RULE_NOTE_MAX_V1}
                onChange={(event) => setDraft({ ...draft, note: event.currentTarget.value })}
                onKeyDown={submitOnEnter}
                autoComplete="off"
              />
            </TextField>
            <NoticeV1 notice={notice} />
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={onClose} isDisabled={saving}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              isPending={saving}
              isDisabled={!valid}
              onPress={() => void save()}
            >
              Salvar regra
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
