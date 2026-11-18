import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AlertDialog,
  Button,
  Card,
  Checkbox,
  Chip,
  Input,
  Label,
  Spinner,
  TextField,
} from '@heroui/react';
import { History, KeyRound, Pencil, Trash2 } from 'lucide-react';
import { ACCESS_AREAS, type AccessArea } from '../../shared/platform-contract';
import {
  ACCESS_PATH_V1,
  type AccessFailureStateV1,
  type AccessGrantChangeRequestV1,
  type AccessGrantChangeViewV1,
  type AccessGrantsResponseV1,
  type AccessGrantViewV1,
} from '../../shared/platform-access-v1';
import { formatDate } from './presentation';

type StateV1 =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; grants: AccessGrantViewV1[]; history: AccessGrantChangeViewV1[] };

const EMAIL_V1 = /^[^\s@]{1,64}@[^\s@]{1,255}$/u;
const areaLabel = (area: AccessArea) => ACCESS_AREAS.find((item) => item.id === area)?.label;
type AccessClientStateV1 = AccessFailureStateV1 | 'session-ended';
const FAILURE_TEXT_V1: Record<AccessClientStateV1, string> = {
  'invalid-request': 'Dados inválidos.',
  refused: 'Sem permissão para alterar acessos.',
  'account-not-found': 'Nenhuma conta com esse e-mail.',
  changed: 'O acesso foi alterado por outra pessoa. Confira e salve de novo.',
  'session-ended': 'Sua sessão terminou. Entre novamente.',
  unavailable: 'Não foi possível salvar o acesso.',
};

class AccessClientErrorV1 extends Error {
  constructor(readonly state: AccessClientStateV1) {
    super(state);
  }
}

async function requestGrantsV1(init?: RequestInit): Promise<AccessGrantsResponseV1> {
  const response = await fetch(ACCESS_PATH_V1, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
  });
  if (response.status === 401) throw new AccessClientErrorV1('session-ended');
  const body = (await response.json().catch(() => null)) as
    AccessGrantsResponseV1 | { state?: AccessFailureStateV1 } | null;
  if (!response.ok || !body || !('grants' in body)) {
    const state = body && 'state' in body ? body.state : undefined;
    throw new AccessClientErrorV1(state && state in FAILURE_TEXT_V1 ? state : 'unavailable');
  }
  return body;
}

const areasText = (areas: readonly AccessArea[]) =>
  areas.length === 0 ? 'nenhuma área' : areas.map(areaLabel).join(', ');

/** Configurações › Acessos (#1513): areas of the Centro opened to people outside the admin group. */
export function AccessGrantsSettingV1() {
  const [state, setState] = useState<StateV1>({ status: 'loading' });
  const [email, setEmail] = useState('');
  const [areas, setAreas] = useState<AccessArea[]>([]);
  // The grant being edited, so a change saved meanwhile by someone else is not overwritten.
  const [editing, setEditing] = useState<{ id: string; email: string; updatedAt: string } | null>(
    null,
  );
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AccessGrantViewV1 | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const emailField = useRef<HTMLInputElement>(null);

  const load = (signal?: AbortSignal) =>
    requestGrantsV1({ signal })
      .then((answer) =>
        setState({ status: 'ready', grants: answer.grants, history: answer.history }),
      )
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setState({ status: 'error' });
      });
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  /** A new grant goes by the e-mail typed; a grant shown (edit or removal) by its person's id. */
  async function save(
    target: string,
    chosen: readonly AccessArea[],
    grant?: { id: string; updatedAt?: string },
  ) {
    setSaving(target);
    setFailure(null);
    const change: AccessGrantChangeRequestV1 = {
      email: target,
      areas: [...chosen],
      ...(grant ? { id: grant.id } : {}),
      ...(grant?.updatedAt ? { expectedUpdatedAt: grant.updatedAt } : {}),
    };
    try {
      const answer = await requestGrantsV1({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      });
      setState({ status: 'ready', grants: answer.grants, history: answer.history });
      // A removal from the list leaves a form being filled for someone else as it was.
      if (chosen.length > 0 || editing?.id === grant?.id) {
        setEmail('');
        setAreas([]);
        setEditing(null);
      }
    } catch (error) {
      const state = error instanceof AccessClientErrorV1 ? error.state : 'unavailable';
      setFailure(FAILURE_TEXT_V1[state]);
      // Someone else changed it: the list shows what is there now, and an edit of it starts over.
      if (state === 'changed') {
        if (editing?.id === grant?.id) {
          setEditing(null);
          setEmail('');
          setAreas([]);
        }
        void load();
      }
    } finally {
      setSaving(null);
    }
  }

  const normalized = email.trim().toLowerCase();
  const toggle = (area: AccessArea, selected: boolean) =>
    setAreas((current) =>
      selected ? [...new Set([...current, area])] : current.filter((item) => item !== area),
    );

  return (
    <Card variant="default" className="mt-5 overflow-hidden">
      <Card.Header className="border-b border-border/60">
        <div className="flex w-full items-center gap-3">
          <KeyRound className="size-5 text-accent" aria-hidden="true" />
          <Card.Title>Acessos</Card.Title>
        </div>
      </Card.Header>
      <Card.Content className="grid gap-5 p-5 sm:p-6">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (EMAIL_V1.test(normalized) && areas.length > 0)
              void save(
                normalized,
                areas,
                editing && editing.email === normalized
                  ? { id: editing.id, updatedAt: editing.updatedAt }
                  : undefined,
              );
          }}
        >
          <TextField fullWidth>
            <Label className="text-sm font-medium">E-mail</Label>
            <Input
              ref={emailField}
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.currentTarget.value);
                if (editing && event.currentTarget.value.trim().toLowerCase() !== editing.email)
                  setEditing(null);
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </TextField>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium">Áreas</legend>
            {ACCESS_AREAS.map((area) => (
              <Checkbox
                key={area.id}
                isSelected={areas.includes(area.id)}
                onChange={(selected) => toggle(area.id, selected)}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span>
                    {area.label} <span className="text-xs text-muted">· {area.detail}</span>
                  </span>
                </Checkbox.Content>
              </Checkbox>
            ))}
          </fieldset>
          <div>
            <Button
              type="submit"
              variant="primary"
              isPending={saving === normalized}
              isDisabled={!EMAIL_V1.test(normalized) || areas.length === 0 || saving !== null}
            >
              Salvar acesso
            </Button>
          </div>
        </form>

        {failure ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{failure}</Alert.Title>
            </Alert.Content>
          </Alert>
        ) : null}

        {state.status === 'loading' ? <Spinner size="sm" aria-label="Carregando acessos" /> : null}
        {state.status === 'error' ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Acessos indisponíveis</Alert.Title>
            </Alert.Content>
          </Alert>
        ) : null}
        {state.status === 'ready' && state.grants.length > 0 ? (
          <ul
            className="grid divide-y divide-border/60 rounded-xl border border-border"
            aria-label="Acessos concedidos"
          >
            {state.grants.map((grant) => (
              <li key={grant.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{grant.email}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {grant.areas.map((area) => (
                      <Chip key={area} size="sm" variant="soft">
                        <Chip.Label>{areaLabel(area)}</Chip.Label>
                      </Chip>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {formatDate(grant.updatedAt)}
                    {grant.updatedBy ? ` · ${grant.updatedBy}` : ''}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  isIconOnly
                  aria-label={`Editar acesso de ${grant.email}`}
                  isDisabled={saving !== null}
                  onPress={() => {
                    setEmail(grant.email);
                    setAreas(grant.areas);
                    setEditing({ id: grant.id, email: grant.email, updatedAt: grant.updatedAt });
                    setFailure(null);
                    emailField.current?.focus();
                  }}
                >
                  <Pencil className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  isIconOnly
                  aria-label={`Remover acesso de ${grant.email}`}
                  isPending={saving === grant.email}
                  isDisabled={saving !== null}
                  onPress={() => {
                    setRemoving(grant);
                    setRemoveOpen(true);
                  }}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {state.status === 'ready' ? (
          <div>
            <Button size="sm" variant="ghost" onPress={() => setHistoryOpen((open) => !open)}>
              <History className="size-4" aria-hidden="true" />
              {historyOpen ? 'Ocultar histórico' : 'Histórico'}
            </Button>
            {historyOpen ? <AccessHistoryV1 history={state.history} /> : null}
          </div>
        ) : null}
      </Card.Content>

      <AlertDialog.Backdrop
        isOpen={removeOpen}
        onOpenChange={(open) => (open ? undefined : setRemoveOpen(false))}
      >
        <AlertDialog.Container size="sm" placement="center">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>Remover o acesso?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>{removing?.email}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button autoFocus variant="secondary" onPress={() => setRemoveOpen(false)}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                onPress={() => {
                  setRemoveOpen(false);
                  if (removing && saving === null)
                    void save(removing.email, [], {
                      id: removing.id,
                      updatedAt: removing.updatedAt,
                    });
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

function AccessHistoryV1({ history }: Readonly<{ history: AccessGrantChangeViewV1[] }>) {
  if (history.length === 0) return <p className="mt-2 text-sm text-muted">Nenhuma mudança.</p>;
  return (
    <ul className="mt-2 grid gap-1 text-sm" aria-label="Histórico de acessos">
      {history.map((change, index) => (
        <li key={`${change.at}-${index}`} className="flex flex-wrap gap-x-2">
          <span className="tabular-nums text-muted">{formatDate(change.at)}</span>
          <span>
            {change.actor} · {change.email}: {areasText(change.before)} → {areasText(change.after)}
          </span>
        </li>
      ))}
    </ul>
  );
}
