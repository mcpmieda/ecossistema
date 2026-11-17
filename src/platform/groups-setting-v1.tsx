import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AlertDialog,
  Button,
  Card,
  Chip,
  Input,
  Label,
  Modal,
  SearchField,
  Spinner,
  Table,
  TextField,
} from '@heroui/react';
import { History, Plus, Trash2, UserPlus, UsersRound } from 'lucide-react';
import {
  GROUP_DESCRIPTION_MAX_V1,
  GROUP_NAME_MAX_V1,
  type GroupChangeV1,
  type GroupPersonV1,
  type GroupRoleV1,
  type GroupViewV1,
} from '../../shared/platform-groups-v1';
import { failureTextV1, requestGroupsV1 } from './groups-client-v1';
import { formatDate } from './presentation';

const ROLE_LABELS_V1: Record<GroupRoleV1, string> = {
  ADMINISTRADOR: 'Secretaria',
  PROFESSOR: 'Professores',
  ALUNO: 'Alunos',
  APOIO: 'Apoio',
  VISITANTE: 'Visitante',
};
const ACTION_LABELS_V1: Record<GroupChangeV1['action'], string> = {
  'create-group': 'Criou o grupo',
  'add-member': 'Adicionou',
  'remove-member': 'Removeu',
};
const OUTCOME_LABELS_V1: Record<GroupChangeV1['outcome'], string | null> = {
  done: null,
  unchanged: 'sem mudança',
  failed: 'falhou',
};
const EMAIL_V1 = /^[^\s@]{1,64}@[^\s@]{1,255}$/u;
const normalizedV1 = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/gu, '').toLowerCase();

type Notice = { tone: 'success' | 'danger'; text: string } | null;

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

const countText = (group: GroupViewV1) =>
  group.memberCount === null
    ? null
    : `${group.memberCount.toLocaleString('pt-BR')} ${group.memberCount === 1 ? 'membro' : 'membros'}`;

/** Configurações › Grupos (#1513): the Microsoft 365 groups the Secretaria manages from the Centro. */
export function GroupsSettingV1() {
  const [groups, setGroups] = useState<GroupViewV1[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const answer = await requestGroupsV1({ operation: 'list' }, signal);
      setGroups(answer.groups);
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

  const current = groups?.find((group) => group.id === selected) ?? null;
  const updateCount = useCallback((groupId: string, delta: number) => {
    setGroups(
      (list) =>
        list?.map((group) =>
          group.id === groupId && group.memberCount !== null
            ? { ...group, memberCount: Math.max(0, group.memberCount + delta) }
            : group,
        ) ?? null,
    );
  }, []);

  return (
    <Card variant="default" className="mt-5 overflow-hidden">
      <Card.Header className="border-b border-border/60">
        <div className="flex w-full flex-wrap items-center gap-3">
          <UsersRound className="size-5 text-accent" aria-hidden="true" />
          <Card.Title>Grupos</Card.Title>
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            onPress={() => setCreating(true)}
          >
            <Plus className="size-4" aria-hidden="true" />
            Novo grupo
          </Button>
        </div>
      </Card.Header>
      <Card.Content className="grid gap-5 p-5 sm:p-6">
        {groups === null && !failed ? <Spinner size="sm" aria-label="Carregando grupos" /> : null}
        {failed ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Grupos indisponíveis</Alert.Title>
            </Alert.Content>
          </Alert>
        ) : null}
        {groups ? (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Grupos">
            {groups.map((group) => (
              <li key={group.id}>
                <Button
                  variant={group.id === selected ? 'primary' : 'secondary'}
                  className="h-auto w-full flex-col items-start gap-1 whitespace-normal px-4 py-3 text-left"
                  aria-pressed={group.id === selected}
                  onPress={() => setSelected(group.id === selected ? null : group.id)}
                >
                  <span className="font-medium">{group.name}</span>
                  <span className="flex flex-wrap items-center gap-2 text-xs font-normal opacity-80">
                    {group.role ? ROLE_LABELS_V1[group.role] : 'Criado no Centro'}
                    {countText(group) ? <span>· {countText(group)}</span> : null}
                    {group.available ? null : <span>· indisponível</span>}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {current ? (
          <GroupDetailV1 key={current.id} group={current} onCountChange={updateCount} />
        ) : null}
      </Card.Content>
      <CreateGroupV1
        isOpen={creating}
        onClose={() => setCreating(false)}
        onCreated={(group) => {
          setGroups((list) => [...(list ?? []), group]);
          setSelected(group.id);
          setCreating(false);
        }}
      />
    </Card>
  );
}

function CreateGroupV1({
  isOpen,
  onClose,
  onCreated,
}: Readonly<{ isOpen: boolean; onClose: () => void; onCreated: (group: GroupViewV1) => void }>) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const close = () => {
    if (saving) return;
    setName('');
    setDescription('');
    setNotice(null);
    onClose();
  };
  async function create() {
    setSaving(true);
    setNotice(null);
    try {
      const answer = await requestGroupsV1({
        operation: 'create-group',
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setName('');
      setDescription('');
      onCreated(answer.group);
    } catch (error) {
      setNotice({ tone: 'danger', text: failureTextV1(error) });
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => (open ? undefined : close())}>
      <Modal.Container size="md" placement="center">
        <Modal.Dialog aria-label="Novo grupo">
          <Modal.Header>
            <Modal.Heading>Novo grupo</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="grid gap-4">
            <TextField fullWidth isRequired>
              <Label>Nome</Label>
              <Input
                value={name}
                maxLength={GROUP_NAME_MAX_V1}
                onChange={(event) => setName(event.currentTarget.value)}
                autoComplete="off"
              />
            </TextField>
            <TextField fullWidth>
              <Label>Descrição</Label>
              <Input
                value={description}
                maxLength={GROUP_DESCRIPTION_MAX_V1}
                onChange={(event) => setDescription(event.currentTarget.value)}
                autoComplete="off"
              />
            </TextField>
            <NoticeV1 notice={notice} />
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={close} isDisabled={saving}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              isPending={saving}
              isDisabled={name.trim().length === 0}
              onPress={() => void create()}
            >
              Criar grupo
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function GroupDetailV1({
  group,
  onCountChange,
}: Readonly<{ group: GroupViewV1; onCountChange: (groupId: string, delta: number) => void }>) {
  const [members, setMembers] = useState<GroupPersonV1[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [removing, setRemoving] = useState<GroupPersonV1 | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    requestGroupsV1({ operation: 'members', groupId: group.id }, controller.signal)
      .then((answer) => setMembers(answer.members))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
      });
    return () => controller.abort();
  }, [group.id]);

  const memberIds = useMemo(() => new Set(members?.map((member) => member.id)), [members]);
  const shown = useMemo(() => {
    const text = normalizedV1(filter.trim());
    if (!members || !text) return members ?? [];
    return members.filter((member) =>
      normalizedV1(`${member.name ?? ''} ${member.email ?? ''} ${member.jobTitle ?? ''}`).includes(
        text,
      ),
    );
  }, [members, filter]);

  async function add(email: string) {
    setBusy(email);
    setNotice(null);
    try {
      const answer = await requestGroupsV1({ operation: 'add-member', groupId: group.id, email });
      const name = answer.person.name ?? answer.person.email ?? email;
      if (answer.result === 'added') {
        setMembers((list) => [...(list ?? []), answer.person]);
        onCountChange(group.id, 1);
        setNotice({ tone: 'success', text: `${name} adicionado.` });
      } else setNotice({ tone: 'success', text: `${name} já está no grupo.` });
      setHistoryVersion((value) => value + 1);
    } catch (error) {
      setNotice({ tone: 'danger', text: failureTextV1(error) });
    } finally {
      setBusy(null);
    }
  }

  async function remove(person: GroupPersonV1) {
    setBusy(person.id);
    setNotice(null);
    try {
      const answer = await requestGroupsV1({
        operation: 'remove-member',
        groupId: group.id,
        personId: person.id,
      });
      setMembers((list) => list?.filter((member) => member.id !== person.id) ?? null);
      if (answer.result === 'removed') onCountChange(group.id, -1);
      setNotice({ tone: 'success', text: `${person.name ?? person.email ?? ''} removido.` });
      setHistoryVersion((value) => value + 1);
    } catch (error) {
      setNotice({ tone: 'danger', text: failureTextV1(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="grid gap-4 rounded-2xl border border-border p-4" aria-label={group.name}>
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{group.name}</h3>
        <Chip size="sm" variant="soft">
          <Chip.Label>{group.role ? ROLE_LABELS_V1[group.role] : 'Criado no Centro'}</Chip.Label>
        </Chip>
        {group.mail ? <span className="text-xs text-muted">{group.mail}</span> : null}
      </header>
      {group.description ? <p className="text-sm text-muted">{group.description}</p> : null}

      <AddPersonV1 memberIds={memberIds} busy={busy} onAdd={(email) => void add(email)} />
      <NoticeV1 notice={notice} />

      {members === null && !failed ? <Spinner size="sm" aria-label="Carregando membros" /> : null}
      {failed ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Membros indisponíveis</Alert.Title>
          </Alert.Content>
        </Alert>
      ) : null}
      {members ? (
        <>
          {members.length > 8 ? (
            <SearchField
              aria-label={`Filtrar membros de ${group.name}`}
              value={filter}
              onChange={setFilter}
              className="max-w-sm"
            >
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Filtrar membros" />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
          ) : null}
          <Table>
            <Table.ScrollContainer className="max-h-[28rem] overflow-auto">
              <Table.Content aria-label={`Membros de ${group.name}`} className="min-w-[560px]">
                <Table.Header>
                  <Table.Column id="name" isRowHeader>
                    Nome
                  </Table.Column>
                  <Table.Column id="email">E-mail</Table.Column>
                  <Table.Column id="job">Cargo</Table.Column>
                  <Table.Column id="actions" className="w-12">
                    <span className="sr-only">Ações</span>
                  </Table.Column>
                </Table.Header>
                <Table.Body items={shown} renderEmptyState={() => 'Nenhum membro.'}>
                  {(member) => (
                    <Table.Row id={member.id} textValue={member.name ?? member.email ?? member.id}>
                      <Table.Cell>
                        <span className="font-medium">{member.name ?? '—'}</span>
                        {member.enabled === false ? (
                          <Chip size="sm" variant="soft" color="warning" className="ml-2">
                            <Chip.Label>Conta desativada</Chip.Label>
                          </Chip>
                        ) : null}
                      </Table.Cell>
                      <Table.Cell>{member.email ?? '—'}</Table.Cell>
                      <Table.Cell>{member.jobTitle ?? '—'}</Table.Cell>
                      <Table.Cell>
                        <Button
                          size="sm"
                          variant="ghost"
                          isIconOnly
                          aria-label={`Remover ${member.name ?? member.email ?? ''} de ${group.name}`}
                          isPending={busy === member.id}
                          isDisabled={busy !== null}
                          onPress={() => setRemoving(member)}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </Button>
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </>
      ) : null}

      <div>
        <Button size="sm" variant="ghost" onPress={() => setHistoryOpen((open) => !open)}>
          <History className="size-4" aria-hidden="true" />
          {historyOpen ? 'Ocultar histórico' : 'Histórico'}
        </Button>
        {historyOpen ? <GroupHistoryV1 groupId={group.id} version={historyVersion} /> : null}
      </div>

      <AlertDialog.Backdrop
        isOpen={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
      >
        <AlertDialog.Container size="sm" placement="center">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>Remover do grupo?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>
                {removing?.name ?? removing?.email} sai de {group.name}.
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button autoFocus variant="secondary" onPress={() => setRemoving(null)}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                onPress={() => {
                  const person = removing;
                  setRemoving(null);
                  if (person) void remove(person);
                }}
              >
                Remover
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </section>
  );
}

/** Finds a person by the start of the name or e-mail, or takes a whole e-mail as typed. */
function AddPersonV1({
  memberIds,
  busy,
  onAdd,
}: Readonly<{
  memberIds: ReadonlySet<string>;
  busy: string | null;
  onAdd: (email: string) => void;
}>) {
  const [text, setText] = useState('');
  const [people, setPeople] = useState<GroupPersonV1[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const query = text.trim();
    if (timer.current) clearTimeout(timer.current);
    if (query.length < 2) {
      setPeople([]);
      return;
    }
    const controller = new AbortController();
    timer.current = setTimeout(() => {
      requestGroupsV1({ operation: 'find-people', query }, controller.signal)
        .then((answer) => setPeople(answer.people))
        .catch(() => setPeople([]));
    }, 300);
    return () => {
      controller.abort();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [text]);

  const typed = text.trim().toLowerCase();
  const typedIsListed = people.some((person) => person.email?.toLowerCase() === typed);

  return (
    <div className="grid gap-2">
      <TextField fullWidth>
        <Label className="text-sm font-medium">Adicionar pessoa</Label>
        <Input
          value={text}
          placeholder="Nome ou e-mail"
          onChange={(event) => setText(event.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </TextField>
      {people.length > 0 || (EMAIL_V1.test(typed) && !typedIsListed) ? (
        <ul className="grid divide-y divide-border/60 rounded-xl border border-border">
          {people.map((person) => {
            const email = person.email ?? '';
            const member = memberIds.has(person.id);
            return (
              <li key={person.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{person.name ?? email}</p>
                  <p className="truncate text-xs text-muted">
                    {email}
                    {person.jobTitle ? ` · ${person.jobTitle}` : ''}
                  </p>
                </div>
                {member ? (
                  <Chip size="sm" variant="soft">
                    <Chip.Label>No grupo</Chip.Label>
                  </Chip>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Adicionar ${person.name ?? email}`}
                    isPending={busy === email}
                    isDisabled={busy !== null || !email}
                    onPress={() => {
                      onAdd(email);
                      setText('');
                    }}
                  >
                    <UserPlus className="size-4" aria-hidden="true" />
                    Adicionar
                  </Button>
                )}
              </li>
            );
          })}
          {EMAIL_V1.test(typed) && !typedIsListed ? (
            <li className="flex flex-wrap items-center gap-3 px-3 py-2">
              <p className="min-w-0 flex-1 truncate text-sm">{typed}</p>
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Adicionar ${typed}`}
                isPending={busy === typed}
                isDisabled={busy !== null}
                onPress={() => {
                  onAdd(typed);
                  setText('');
                }}
              >
                <UserPlus className="size-4" aria-hidden="true" />
                Adicionar
              </Button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function GroupHistoryV1({ groupId, version }: Readonly<{ groupId: string; version: number }>) {
  const [changes, setChanges] = useState<GroupChangeV1[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    requestGroupsV1({ operation: 'history', groupId }, controller.signal)
      .then((answer) => {
        setChanges(answer.changes);
        setFailed(false);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
      });
    return () => controller.abort();
  }, [groupId, version]);

  if (failed) return <p className="mt-2 text-sm text-danger">Histórico indisponível.</p>;
  if (changes === null) return <Spinner size="sm" aria-label="Carregando histórico" />;
  if (changes.length === 0) return <p className="mt-2 text-sm text-muted">Nenhuma mudança.</p>;
  return (
    <ul className="mt-2 grid gap-1 text-sm" aria-label="Histórico do grupo">
      {changes.map((change, index) => {
        const outcome = OUTCOME_LABELS_V1[change.outcome];
        return (
          <li key={`${change.at}-${index}`} className="flex flex-wrap gap-x-2">
            <span className="tabular-nums text-muted">{formatDate(change.at)}</span>
            <span>
              {change.actor} · {ACTION_LABELS_V1[change.action]}
              {change.target ? ` ${change.target}` : ''}
            </span>
            {outcome ? (
              <span className={change.outcome === 'failed' ? 'text-danger' : 'text-muted'}>
                ({outcome})
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
