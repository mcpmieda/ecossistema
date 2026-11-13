import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Chip, Input, Label, Spinner, Surface, TextField } from '@heroui/react';
import { ChevronRight, CloudCog, FolderOpen, Pause, Play, Power, RefreshCcw, RotateCw } from 'lucide-react';
import type {
  OneDriveSyncRequestV1,
  OneDriveSyncResponseV1,
  OneDriveSyncStatusV1,
} from '../../../../shared/gradebook-contracts/onedrive-sync/onedrive-sync-contract-v1';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import { requestOneDriveSyncV1 } from './onedrive-sync-client-v1';

type FileV1 = OneDriveSyncStatusV1['files'][number];
type PreviewV1 = Extract<OneDriveSyncResponseV1, { state: 'preview' }>['preview'];
type FolderV1 = Extract<OneDriveSyncResponseV1, { state: 'folders' }>['folders'][number];
type ChipColor = 'accent' | 'success' | 'warning' | 'danger' | 'default';

const REFRESH_MS = 10_000;

const OUTCOME_LABELS: Record<NonNullable<FileV1['lastOutcome']>, [string, ChipColor]> = {
  applied: ['Lançado', 'success'],
  'no-changes': ['Sem mudança', 'default'],
  blocked: ['Nada lançado — ver Auditoria', 'warning'],
  rejected: ['Recusado pelo banco', 'danger'],
  unreadable: ['Planilha não reconhecida', 'warning'],
  ignored: ['Ignorado (não é de professor)', 'default'],
  'too-large': ['Arquivo grande demais', 'warning'],
  failed: ['Falhou — nova tentativa automática', 'danger'],
};

const ACTION_LABELS: Record<string, string> = {
  enable: 'ligou a leitura',
  disable: 'desligou a leitura',
  pause: 'pausou',
  resume: 'retomou',
  'read-all': 'pediu para ler tudo',
  'set-wait': 'mudou a espera',
  'set-parallel': 'mudou o paralelo',
  'read-now': 'pediu para ler um arquivo',
  'set-folder': 'escolheu a pasta',
};

function time(value: number | null): string {
  if (value === null) return '—';
  return new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function seconds(ms: number | null): string {
  return ms === null || ms <= 0 ? '—' : `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;
}

function eventText(event: OneDriveSyncStatusV1['events'][number]): string {
  let detail: Record<string, unknown>;
  try {
    detail = JSON.parse(event.detail) as Record<string, unknown>;
  } catch {
    detail = {};
  }
  if (event.kind === 'control') {
    const action = typeof detail.action === 'string' ? detail.action : '';
    const extra = action === 'set-folder' ? ` (${String(detail.year)}: ${String(detail.folderPath)})`
      : action === 'set-wait' ? ` (${String(detail.seconds)} s)`
      : action === 'set-parallel' ? ` (${String(detail.count)})` : '';
    return `${ACTION_LABELS[action] ?? action}${extra}`;
  }
  if (event.kind === 'webhook-subscribed') return 'aviso da Graph ativado';
  if (event.kind === 'webhook-error') return 'não foi possível ativar o aviso da Graph; conferência a cada minuto';
  if (event.kind === 'breaker-open') return 'disjuntor: leitura pausada por 15 minutos após falhas seguidas';
  if (event.kind === 'graph-error') return 'falha ao consultar o OneDrive';
  if (event.kind === 'full-check') return `conferência completa da pasta (${String(detail.files)} arquivos)`;
  return event.kind;
}

function StateChip({ status }: { status: OneDriveSyncStatusV1 }) {
  const { enabled, paused } = status.settings;
  let label = 'Desligada';
  let color: ChipColor = 'default';
  if (enabled && status.activeYear === null) [label, color] = ['Ligada, sem pasta', 'warning'];
  else if (enabled && status.breakerUntil !== null && status.breakerUntil > Date.now())
    [label, color] = [`Disjuntor até ${time(status.breakerUntil)}`, 'danger'];
  else if (enabled && paused) [label, color] = ['Pausada', 'warning'];
  else if (enabled) [label, color] = ['Ligada', 'success'];
  return (
    <Chip size="sm" variant="soft" color={color}>
      <Chip.Label>{label}</Chip.Label>
    </Chip>
  );
}

function FileRow({ file, busy, onRead }: { file: FileV1; busy: boolean; onRead: () => void }) {
  const outcome = file.lastOutcome ? OUTCOME_LABELS[file.lastOutcome] : null;
  let state: [string, ChipColor] | null = null;
  if (file.removed) state = ['Removido da pasta', 'default'];
  else if (file.state === 'reading') state = ['Lendo', 'accent'];
  else if (file.state === 'pending') state = ['Aguardando', 'accent'];
  const [label, color] = state ?? outcome ?? ['Ainda não lido', 'default'];
  return (
    <li className="grid gap-2 border-b border-border/60 px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium" title={file.name}>{file.name}</span>
          <Chip size="sm" variant="soft" color={color}><Chip.Label>{label}</Chip.Label></Chip>
        </div>
        <p className="mt-1 text-xs text-muted">
          Salvo {time(Date.parse(file.modifiedAt) || null)} · lido {time(file.lastReadAt)} · leitura {seconds(file.lastReadMs)}
          {file.lastSavedToWrittenMs !== null ? ` · do salvamento ao lançamento ${seconds(file.lastSavedToWrittenMs)}` : ''}
          {file.lastCode ? ` · ${file.lastCode}` : ''}
        </p>
      </div>
      <Button size="sm" variant="ghost" isDisabled={busy || file.removed || file.state !== 'idle'} onPress={onRead}>
        <RotateCw className="size-4" aria-hidden="true" />
        Ler de novo
      </Button>
    </li>
  );
}

function FolderPicker({ year, onChosen, onCancel }: {
  year: number; onChosen: (folderId: string, folderPath: string) => Promise<void>; onCancel: () => void;
}) {
  const [trail, setTrail] = useState<Array<{ id: string; name: string }>>([]);
  const [folders, setFolders] = useState<FolderV1[] | null>(null);
  const [preview, setPreview] = useState<PreviewV1 | null>(null);
  const [busy, setBusy] = useState<'list' | 'preview' | 'save' | null>('list');
  const [failure, setFailure] = useState<string | null>(null);
  const current = trail.at(-1) ?? null;
  const path = trail.map((item) => item.name).join('/');

  useEffect(() => {
    const controller = new AbortController();
    setBusy('list');
    setPreview(null);
    void requestOneDriveSyncV1({ action: 'folders', parentId: current?.id ?? null }, controller.signal)
      .then((answer) => {
        if (answer.state === 'folders') setFolders(answer.folders);
        else setFailure('Não foi possível listar as pastas do OneDrive.');
      })
      .catch(() => undefined)
      .finally(() => { if (!controller.signal.aborted) setBusy(null); });
    return () => controller.abort();
  }, [current?.id]);

  const runPreview = async () => {
    if (!current) return;
    setBusy('preview');
    setFailure(null);
    const answer = await requestOneDriveSyncV1({ action: 'preview', folderId: current.id, testWebhook: true });
    if (answer.state === 'preview') setPreview(answer.preview);
    else setFailure('Não foi possível ver a prévia desta pasta.');
    setBusy(null);
  };

  return (
    <div className="grid gap-3 rounded-2xl border border-border p-4">
      <nav aria-label="Caminho da pasta" className="flex flex-wrap items-center gap-1 text-sm">
        <Button size="sm" variant="ghost" onPress={() => setTrail([])}>OneDrive da secretaria</Button>
        {trail.map((item, index) => (
          <span key={item.id} className="flex items-center gap-1">
            <ChevronRight className="size-4 text-muted" aria-hidden="true" />
            <Button size="sm" variant="ghost" onPress={() => setTrail(trail.slice(0, index + 1))}>{item.name}</Button>
          </span>
        ))}
      </nav>
      {busy === 'list' ? <Spinner size="sm" /> : (
        <ul className="grid max-h-64 gap-1 overflow-auto">
          {(folders ?? []).length === 0 ? <li className="text-sm text-muted">Nenhuma subpasta aqui.</li> : null}
          {(folders ?? []).map((folder) => (
            <li key={folder.id}>
              <Button size="sm" variant="ghost" className="w-full justify-start" onPress={() => setTrail([...trail, { id: folder.id, name: folder.name }])}>
                <FolderOpen className="size-4" aria-hidden="true" />
                {folder.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {preview ? (
        <div className="grid gap-1 rounded-xl border border-border/70 bg-surface p-3 text-sm">
          <strong>{preview.workbooks} planilha(s) · {(preview.workbookBytes / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB</strong>
          <span className="text-muted">
            Leitura de teste (sem gravar): {preview.sample.outcome === 'ready' ? 'reconhecida' : preview.sample.outcome === 'none' ? 'nenhuma planilha' : preview.sample.outcome}
            {preview.sample.readMs !== null ? ` em ${seconds(preview.sample.readMs)}` : ''}
          </span>
          <span className="text-muted">
            Aviso da Graph: {preview.webhook.accepted === true ? 'aceito' : preview.webhook.accepted === false ? 'recusado — a pasta será conferida a cada minuto' : 'não testado'}
          </span>
          {preview.names.length > 0 ? <span className="text-xs text-muted">{preview.names.join(' · ')}</span> : null}
        </div>
      ) : null}
      {failure ? <p className="text-sm text-danger" role="alert">{failure}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" isDisabled={!current || busy !== null} isPending={busy === 'preview'} onPress={() => void runPreview()}>
          Ver prévia desta pasta
        </Button>
        <Button variant="primary" isDisabled={!current || !preview || busy !== null} isPending={busy === 'save'}
          onPress={() => { if (current) { setBusy('save'); void onChosen(current.id, path).finally(() => setBusy(null)); } }}>
          Usar esta pasta para {year}
        </Button>
        <Button variant="ghost" onPress={onCancel}>Cancelar</Button>
      </div>
    </div>
  );
}

export function OneDriveSyncPageV1({ isActive = true }: { isActive?: boolean } = {}) {
  const year = useGradebookYear()?.year ?? null;
  const [status, setStatus] = useState<OneDriveSyncStatusV1 | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [wait, setWait] = useState('');
  const [parallel, setParallel] = useState('');
  const loaded = useRef(false);

  const apply = useCallback((answer: OneDriveSyncResponseV1) => {
    if (answer.state === 'status') {
      setStatus(answer.status);
      setFailure(null);
      if (!loaded.current) {
        setWait(String(answer.status.settings.waitSeconds));
        setParallel(String(answer.status.settings.maxParallel));
        loaded.current = true;
      }
    } else if (answer.state === 'not-authorized') setFailure('Sua sessão não possui autorização para esta área.');
    else setFailure('A leitura automática não respondeu agora. Tente de novo em instantes.');
  }, []);

  const send = useCallback(async (request: OneDriveSyncRequestV1) => {
    setBusy(true);
    try { apply(await requestOneDriveSyncV1(request)); } finally { setBusy(false); }
  }, [apply]);

  useEffect(() => {
    if (!isActive) return undefined;
    let controller = new AbortController();
    const refresh = () => {
      controller.abort();
      controller = new AbortController();
      void requestOneDriveSyncV1({ action: 'status' }, controller.signal).then(apply).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [apply, isActive]);

  if (!status) {
    return failure
      ? <Alert status="danger" role="alert"><Alert.Indicator /><Alert.Content><Alert.Title>{failure}</Alert.Title></Alert.Content></Alert>
      : <Spinner aria-label="Carregando a leitura automática" />;
  }

  const folder = status.folders.find((item) => item.year === year) ?? null;
  const active = status.activeYear !== null ? status.folders.find((item) => item.year === status.activeYear) : null;
  const { enabled, paused } = status.settings;

  return (
    <div className="grid gap-4">
      <Surface className="overflow-hidden rounded-2xl border border-border bg-surface">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-5">
          <div className="flex min-w-0 gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
              <CloudCog className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold">Leitura automática do OneDrive</h3>
                <StateChip status={status} />
              </div>
              <p className="mt-1 max-w-3xl text-sm text-muted">
                Cada planilha salva na pasta é lida e lançada em segundos, com a mesma Auditoria da importação. Problemas seguram só a nota, o resultado ou a turma afetada.
              </p>
              <p className="mt-1 text-xs text-muted">
                {status.webhook.active ? `Aviso da Graph ativo até ${time(Date.parse(status.webhook.expiresAt ?? '') || null)}` : 'Sem aviso da Graph: a pasta é conferida a cada minuto'}
                {active ? ` · lendo ${active.year}: ${active.folderPath}` : ''}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant={enabled ? 'secondary' : 'primary'} isDisabled={busy || (!enabled && status.activeYear === null)}
              onPress={() => void send({ action: enabled ? 'disable' : 'enable' })}>
              <Power className="size-4" aria-hidden="true" />
              {enabled ? 'Desligar' : 'Ligar'}
            </Button>
            {enabled ? (
              <Button variant="secondary" isDisabled={busy} onPress={() => void send({ action: paused ? 'resume' : 'pause' })}>
                {paused ? <Play className="size-4" aria-hidden="true" /> : <Pause className="size-4" aria-hidden="true" />}
                {paused ? 'Retomar' : 'Pausar'}
              </Button>
            ) : null}
            <Button variant="ghost" isDisabled={busy || !enabled} onPress={() => void send({ action: 'read-all' })}>
              <RefreshCcw className="size-4" aria-hidden="true" />
              Conferir tudo agora
            </Button>
          </div>
        </div>

        <div className="grid gap-4 p-5">
          {failure ? <p className="text-sm text-danger" role="alert">{failure}</p> : null}
          <section className="grid gap-2" aria-labelledby="onedrive-folder-title">
            <h4 id="onedrive-folder-title" className="font-semibold">Pasta do ano letivo {year ?? '—'}</h4>
            <p className="text-sm text-muted">
              {folder ? `${folder.folderPath} — escolhida por ${folder.setBy} em ${time(folder.setAt)}` : 'Nenhuma pasta escolhida para este ano.'}
            </p>
            {picking && year !== null ? (
              <FolderPicker
                year={year}
                onCancel={() => setPicking(false)}
                onChosen={async (folderId, folderPath) => {
                  await send({ action: 'set-folder', year, folderId, folderPath });
                  setPicking(false);
                }}
              />
            ) : (
              <div>
                <Button variant="secondary" isDisabled={busy || year === null} onPress={() => setPicking(true)}>
                  <FolderOpen className="size-4" aria-hidden="true" />
                  {folder ? 'Trocar pasta' : 'Escolher pasta'}
                </Button>
              </div>
            )}
          </section>

          <section className="grid gap-2" aria-labelledby="onedrive-settings-title">
            <h4 id="onedrive-settings-title" className="font-semibold">Ajustes</h4>
            <div className="flex flex-wrap items-end gap-3">
              <TextField className="w-40">
                <Label className="text-sm">Espera após salvar (s)</Label>
                <Input inputMode="numeric" value={wait} onChange={(event) => setWait(event.currentTarget.value)} />
              </TextField>
              <Button variant="secondary" isDisabled={busy || !/^\d{1,3}$/u.test(wait)}
                onPress={() => void send({ action: 'set-wait', seconds: Number(wait) })}>Salvar espera</Button>
              <TextField className="w-40">
                <Label className="text-sm">Arquivos em paralelo</Label>
                <Input inputMode="numeric" value={parallel} onChange={(event) => setParallel(event.currentTarget.value)} />
              </TextField>
              <Button variant="secondary" isDisabled={busy || !/^(?:[1-9]|10)$/u.test(parallel)}
                onPress={() => void send({ action: 'set-parallel', count: Number(parallel) })}>Salvar paralelo</Button>
            </div>
          </section>
        </div>
      </Surface>

      <Surface className="overflow-hidden rounded-2xl border border-border bg-surface">
        <h4 className="border-b border-border px-4 py-3 font-semibold">Planilhas ({status.files.filter((file) => !file.removed).length})</h4>
        {status.files.length === 0 ? <p className="p-4 text-sm text-muted">Nenhuma planilha lida ainda.</p> : (
          <ul>
            {status.files.map((file) => (
              <FileRow key={file.id} file={file} busy={busy} onRead={() => void send({ action: 'read-now', fileId: file.id })} />
            ))}
          </ul>
        )}
      </Surface>

      <Surface className="overflow-hidden rounded-2xl border border-border bg-surface">
        <h4 className="border-b border-border px-4 py-3 font-semibold">Histórico de alterações</h4>
        {status.events.length === 0 ? <p className="p-4 text-sm text-muted">Nenhuma alteração registrada.</p> : (
          <ul className="grid">
            {status.events.map((event, index) => (
              <li key={`${event.at}-${index}`} className="border-b border-border/60 px-4 py-2 text-sm last:border-b-0">
                <span className="tabular-nums text-muted">{time(event.at)}</span>
                {' · '}
                {event.actor ? <strong>{event.actor}</strong> : <span className="text-muted">Sistema</span>}
                {' '}
                {eventText(event)}
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </div>
  );
}
