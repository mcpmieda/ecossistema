import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Chip,
  Input,
  Label,
  Spinner,
  TextField,
} from '@heroui/react';
import { KeyRound, Pencil, Trash2 } from 'lucide-react';
import { ACCESS_AREAS, type AccessArea } from '../../shared/platform-contract';
import {
  ACCESS_PATH_V1,
  type AccessGrantsResponseV1,
  type AccessGrantViewV1,
} from '../../shared/platform-access-v1';
import { formatDate } from './presentation';

type StateV1 =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; grants: AccessGrantViewV1[] };

const EMAIL_V1 = /^[^\s@]{1,64}@[^\s@]{1,255}$/u;
const areaLabel = (area: AccessArea) => ACCESS_AREAS.find((item) => item.id === area)?.label;

async function requestGrantsV1(init?: RequestInit): Promise<AccessGrantViewV1[]> {
  const response = await fetch(ACCESS_PATH_V1, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
  });
  if (!response.ok) throw new Error(String(response.status));
  return ((await response.json()) as AccessGrantsResponseV1).grants;
}

/** Configurações › Acessos (#1513): areas of the Centro opened to people outside the admin group. */
export function AccessGrantsSettingV1() {
  const [state, setState] = useState<StateV1>({ status: 'loading' });
  const [email, setEmail] = useState('');
  const [areas, setAreas] = useState<AccessArea[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    requestGrantsV1({ signal: controller.signal })
      .then((grants) => setState({ status: 'ready', grants }))
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setState({ status: 'error' });
      });
    return () => controller.abort();
  }, []);

  async function save(target: string, chosen: readonly AccessArea[]) {
    setSaving(target);
    setFailure(null);
    try {
      const grants = await requestGrantsV1({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: target, areas: chosen }),
      });
      setState({ status: 'ready', grants });
      if (target === email.trim().toLowerCase()) {
        setEmail('');
        setAreas([]);
      }
    } catch {
      setFailure('Não foi possível salvar o acesso.');
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
            if (EMAIL_V1.test(normalized) && areas.length > 0) void save(normalized, areas);
          }}
        >
          <TextField fullWidth>
            <Label className="text-sm font-medium">E-mail</Label>
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
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
          <ul className="grid divide-y divide-border/60 rounded-xl border border-border">
            {state.grants.map((grant) => (
              <li key={grant.email} className="flex flex-wrap items-center gap-3 px-4 py-3">
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
                  onPress={() => void save(grant.email, [])}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </Card.Content>
    </Card>
  );
}
