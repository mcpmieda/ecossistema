import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Chip, Input, Label, Spinner, Surface, TextField } from '@heroui/react';
import { ChevronRight, CloudCog, FileSpreadsheet, FolderOpen, Pause, Play, Plus, Power, RefreshCcw, RotateCw, Trash2 } from 'lucide-react';
import type {
  OneDriveSyncRequestV1,
  OneDriveSyncResponseV1,
  OneDriveSyncStatusV1,
} from '../../../../shared/gradebook-contracts/onedrive-sync/onedrive-sync-contract-v1';
import { localDayMonthTimeTextV1, PT_BR_UP_TO_1_DECIMAL_V1 } from '../../../../shared/locale-format-v1';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import { requestOneDriveSyncV1 } from './onedrive-sync-client-v1';

type FileV1 = OneDriveSyncStatusV1['files'][number];
type PreviewV1 = Extract<OneDriveSyncResponseV1, { state: 'preview' }>['preview'];
type FolderV1 = Extract<OneDriveSyncResponseV1, { state: 'folders' }>['folders'][number];
type WorkbookEntryV1 = NonNullable<Extract<OneDriveSyncResponseV1, { state: 'folders' }>['files']>[number];
type SourceV1 = NonNullable<OneDriveSyncStatusV1['sources']>[number];
type ChosenSourceV1 = { readonly kind: 'folder' | 'file'; readonly itemId: string; readonly path: string };
type ChipColor = 'accent' | 'success' | 'warning' | 'danger' | 'default';

/** Reads while a file is being read or waits, after a failed read, and when nothing moves (issue #1426, 11). */
const REFRESH_BUSY_MS = 10_000;
const REFRESH_IDLE_MS = 60_000;
/** No click, key or touch for this long: the page stops reading until the next one. */
const REFRESH_PAUSE_AFTER_MS = 10 * 60_000;
const RESUME_DELAY_MS = 1_000;
const REFRESH_FAILURES_SHOWN = 3;

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
  'add-source': 'adicionou uma fonte',
  'remove-source': 'removeu uma fonte',
};

/** What each control change shows after its label. */
const CONTROL_DETAILS: Readonly<Record<string, (detail: Record<string, unknown>) => string>> = {
  'set-folder': (detail) => ` (${String(detail.year)}: ${String(detail.folderPath)})`,
  'add-source': (detail) => ` (${String(detail.year)}: ${String(detail.path)})`,
  'set-wait': (detail) => ` (${String(detail.seconds)} s)`,
  'set-parallel': (detail) => ` (${String(detail.count)})`,
};

function time(value: number | null): string {
  if (value === null) return '—';
  return localDayMonthTimeTextV1(value);
}

/** A duration in minutes and seconds only ("1 min 42 s", "8 s"). */
export function minutesSecondsV1(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes === 0 ? `${rest} s` : `${minutes.toLocaleString('pt-BR')} min ${rest} s`;
}

/** "14/11 13:12 · 1 min 42 s após salvar", or only the time when the save is not the cause. */
function arrivalTextV1(file: Pick<FileV1, 'lastAppliedAt' | 'lastSavedToWrittenMs'>): string | null {
  if (!file.lastAppliedAt) return null;
  const after = minutesSecondsV1(file.lastSavedToWrittenMs);
  return after ? `${time(file.lastAppliedAt)} · ${after} após salvar` : time(file.lastAppliedAt);
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
    const extra = CONTROL_DETAILS[action]?.(detail) ?? '';
    return `${ACTION_LABELS[action] ?? action}${extra}`;
  }
  if (event.kind === 'webhook-subscribed') return 'aviso da Graph ativado';
  if (event.kind === 'webhook-error') return 'não foi possível ativar o aviso da Graph; conferência a cada minuto';
  if (event.kind === 'breaker-open') return 'disjuntor: leitura pausada por 15 minutos após falhas seguidas';
  if (event.kind === 'graph-error') return 'falha ao consultar o OneDrive';
  if (event.kind === 'full-check') return `conferência completa da pasta (${String(detail.files)} arquivos)`;
  if (event.kind === 'parallel') return `leituras ao mesmo tempo: ${String(detail.from)} → ${String(detail.to)}`;
  if (event.kind === 'relation-changed') return `Relação mudou: ${String(detail.reread)} planilha(s) lidas de novo`;
  return event.kind;
}

function StateChip({ status }: Readonly<{ status: OneDriveSyncStatusV1 }>) {
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

function FileRow({ file, busy, onRead }: Readonly<{ file: FileV1; busy: boolean; onRead: () => void }>) {
  const outcome = file.lastOutcome ? OUTCOME_LABELS[file.lastOutcome] : null;
  let state: [string, ChipColor] | null = null;
  if (file.removed) state = ['Removido da pasta', 'default'];
  else if (file.state === 'reading') state = ['Lendo', 'accent'];
  else if (file.state === 'pending') state = ['Aguardando', 'accent'];
  let [label, color] = state ?? outcome ?? ['Ainda não lido', 'default'];
  // Lançado, but some students waited for the Relação (different name, not in it): their notes
  // arrive when the Relação is fixed (issue #1426, 16).
  if (!state && file.lastOutcome === 'applied' && file.heldStudents) {
    label = `Lançado · ${file.heldStudents} aluno(s) retido(s) — ver Auditoria`;
    color = 'warning';
  }
  const arrival = arrivalTextV1(file);
  return (
    <li className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-b-0">
      <FileSpreadsheet className="size-4 shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium" title={file.name}>{file.name}</span>
          <Chip size="sm" variant="soft" color={color}><Chip.Label>{label}</Chip.Label></Chip>
        </div>
        {arrival || file.lastReadAt ? (
          <p className="mt-0.5 text-xs text-muted">
            {arrival ? `Notas chegaram ${arrival}` : `Lido ${time(file.lastReadAt)}`}
          </p>
        ) : null}
      </div>
      <Button size="sm" variant="ghost" isIconOnly aria-label={`Ler de novo ${file.name}`}
        isDisabled={busy || file.removed || file.state !== 'idle'} onPress={onRead}>
        <RotateCw className="size-4" aria-hidden="true" />
      </Button>
    </li>
  );
}

const SAMPLE_LABELS: Readonly<Record<string, string>> = { ready: 'reconhecida', none: 'nenhuma planilha' };

function webhookLabelV1(accepted: boolean | null): string {
  if (accepted === true) return 'aceito';
  if (accepted === false) return 'recusado — a pasta será conferida a cada minuto';
  return 'não testado';
}

function PreviewSummary({ preview }: Readonly<{ preview: PreviewV1 }>) {
  const { sample } = preview;
  return (
    <div className="grid gap-1 rounded-xl border border-border/70 bg-surface p-3 text-sm">
      <strong>{preview.workbooks} planilha(s) · {PT_BR_UP_TO_1_DECIMAL_V1.format(preview.workbookBytes / 1048576)} MB</strong>
      <span className="text-muted">
        Leitura de teste (sem gravar): {SAMPLE_LABELS[sample.outcome] ?? sample.outcome}
        {sample.readMs !== null && sample.readMs > 0 ? ` em ${minutesSecondsV1(sample.readMs)}` : ''}
      </span>
      <span className="text-muted">Aviso da Graph: {webhookLabelV1(preview.webhook.accepted)}</span>
      {preview.names.length > 0 ? <span className="text-xs text-muted">{preview.names.join(' · ')}</span> : null}
    </div>
  );
}

/** The workbooks of the folder shown, each one can be chosen as a source on its own (e.g. the Relação). */
function WorkbookChoices({ workbooks, year, disabled, onChoose }: Readonly<{
  workbooks: readonly WorkbookEntryV1[]; year: number; disabled: boolean; onChoose: (workbook: WorkbookEntryV1) => void;
}>) {
  return (
    <>
      {workbooks.map((workbook) => (
        <li key={workbook.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <FileSpreadsheet className="size-4 shrink-0 text-muted" aria-hidden="true" />
            <span className="truncate">{workbook.name}</span>
          </span>
          <Button size="sm" variant="secondary" isDisabled={disabled} onPress={() => onChoose(workbook)}>
            Ler só este arquivo em {year}
          </Button>
        </li>
      ))}
    </>
  );
}

/** Navigates the secretaria's OneDrive and chooses a source: the folder shown or one of its workbooks. */
function SourcePicker({ year, onChosen, onCancel }: Readonly<{
  year: number; onChosen: (source: ChosenSourceV1) => Promise<void>; onCancel: () => void;
}>) {
  const [trail, setTrail] = useState<Array<{ id: string; name: string }>>([]);
  const [folders, setFolders] = useState<FolderV1[] | null>(null);
  const [workbooks, setWorkbooks] = useState<WorkbookEntryV1[]>([]);
  const [preview, setPreview] = useState<PreviewV1 | null>(null);
  const [busy, setBusy] = useState<'list' | 'preview' | 'save' | null>('list');
  const [failure, setFailure] = useState<string | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const current = trail.at(-1) ?? null;
  const path = trail.map((item) => item.name).join('/');

  useEffect(() => {
    const controller = new AbortController();
    setBusy('list');
    setPreview(null);
    setFailure(null);
    setListFailed(false);
    void requestOneDriveSyncV1({ action: 'folders', parentId: current?.id ?? null }, controller.signal)
      .then((answer) => {
        // A failed list never leaves the previous folder's list on screen under the new path.
        setFolders(answer.state === 'folders' ? answer.folders : []);
        setWorkbooks(answer.state === 'folders' ? answer.files ?? [] : []);
        if (answer.state !== 'folders') {
          setFailure('Não foi possível listar as pastas do OneDrive.');
          setListFailed(true);
        }
      })
      .catch(() => undefined)
      .finally(() => { if (!controller.signal.aborted) setBusy(null); });
    return () => controller.abort();
  }, [current?.id, attempt]);

  // The folder on screen now: a preview that comes back after the user moved on is dropped, so
  // "Usar esta pasta" never saves a folder with the preview of another (issue #1426, 12a).
  const shown = useRef<string | null>(null);
  shown.current = current?.id ?? null;
  const runPreview = async () => {
    if (!current) return;
    const folderId = current.id;
    setBusy('preview');
    setFailure(null);
    try {
      const answer = await requestOneDriveSyncV1({ action: 'preview', folderId, testWebhook: true });
      if (shown.current !== folderId) return;
      if (answer.state === 'preview') setPreview(answer.preview);
      else setFailure('Não foi possível ver a prévia desta pasta.');
    } finally {
      if (shown.current === folderId) setBusy(null);
    }
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
          {(folders ?? []).length === 0 && workbooks.length === 0 ? <li className="text-sm text-muted">Nada aqui.</li> : null}
          {(folders ?? []).map((folder) => (
            <li key={folder.id}>
              <Button size="sm" variant="ghost" className="w-full justify-start" onPress={() => setTrail([...trail, { id: folder.id, name: folder.name }])}>
                <FolderOpen className="size-4" aria-hidden="true" />
                {folder.name}
              </Button>
            </li>
          ))}
          <WorkbookChoices workbooks={workbooks} year={year} disabled={busy !== null}
            onChoose={(workbook) => { setBusy('save'); void onChosen({ kind: 'file', itemId: workbook.id, path: path ? `${path}/${workbook.name}` : workbook.name }).finally(() => setBusy(null)); }} />
        </ul>
      )}
      {preview ? <PreviewSummary preview={preview} /> : null}
      {failure ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-danger" role="alert">
          {failure}
          {listFailed ? <Button size="sm" variant="ghost" onPress={() => setAttempt((value) => value + 1)}>Tentar de novo</Button> : null}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" isDisabled={!current || busy !== null} isPending={busy === 'preview'} onPress={() => void runPreview()}>
          Ver prévia desta pasta
        </Button>
        <Button variant="primary" isDisabled={!current || !preview || busy !== null} isPending={busy === 'save'}
          onPress={() => { if (current) { setBusy('save'); void onChosen({ kind: 'folder', itemId: current.id, path }).finally(() => setBusy(null)); } }}>
          Ler esta pasta inteira em {year}
        </Button>
        <Button variant="ghost" onPress={onCancel}>Cancelar</Button>
      </div>
    </div>
  );
}

type SendV1 = (request: OneDriveSyncRequestV1) => Promise<void>;

/** The file whose grades arrived last. */
function lastArrivalV1(files: readonly FileV1[]): FileV1 | null {
  let last: FileV1 | null = null;
  for (const file of files) {
    if (file.lastAppliedAt && (!last?.lastAppliedAt || file.lastAppliedAt > last.lastAppliedAt)) last = file;
  }
  return last;
}

/** Before the first arrival is known (kept since 15/11/2026): the last reading. */
function lastReadTextV1(files: readonly FileV1[]): string | null {
  const latest = Math.max(0, ...files.map((file) => file.lastReadAt ?? 0));
  return latest > 0 ? `Última leitura: ${time(latest)}` : null;
}

function SyncHeader({ status, busy, send }: Readonly<{
  status: OneDriveSyncStatusV1; busy: boolean; send: SendV1;
}>) {
  const { enabled, paused } = status.settings;
  const last = lastArrivalV1(status.files);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
          <CloudCog className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">Leitura automática</h3>
            <StateChip status={status} />
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {last
              ? <>Última chegada de notas: <span className="text-foreground">{last.name.replace(/\.(xlsb|xlsx|xlsm|xls)$/iu, '')}</span> · {arrivalTextV1(last)}</>
              : lastReadTextV1(status.files)}
          </p>
          {enabled && !status.webhook.active ? (
            <p className="mt-0.5 text-xs text-warning">Sem aviso do OneDrive: a pasta é conferida a cada minuto.</p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={enabled ? 'secondary' : 'primary'} isDisabled={busy || (!enabled && status.activeYear === null)}
          onPress={() => void send({ action: enabled ? 'disable' : 'enable' })}>
          <Power className="size-4" aria-hidden="true" />
          {enabled ? 'Desligar' : 'Ligar'}
        </Button>
        {enabled ? (
          <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void send({ action: paused ? 'resume' : 'pause' })}>
            {paused ? <Play className="size-4" aria-hidden="true" /> : <Pause className="size-4" aria-hidden="true" />}
            {paused ? 'Retomar' : 'Pausar'}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" isDisabled={busy || !enabled} onPress={() => void send({ action: 'read-all' })}>
          <RefreshCcw className="size-4" aria-hidden="true" />
          Conferir tudo
        </Button>
      </div>
    </div>
  );
}

/** The folders and single workbooks read, each tied to its academic year; one is added at a time. */
function SourcesSection({ sources, year, busy, send }: Readonly<{
  sources: readonly SourceV1[]; year: number | null; busy: boolean; send: SendV1;
}>) {
  const [picking, setPicking] = useState(false);
  return (
    <section className="grid min-w-0 grid-cols-1 gap-2" aria-labelledby="onedrive-sources-title">
      <div className="flex items-center justify-between gap-2">
        <h4 id="onedrive-sources-title" className="text-sm font-semibold">Fontes</h4>
        {picking ? null : (
          <Button size="sm" variant="ghost" isDisabled={busy || year === null} onPress={() => setPicking(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Adicionar
          </Button>
        )}
      </div>
      {sources.length === 0 ? <p className="text-sm text-muted">Nenhuma fonte escolhida.</p> : (
        <ul className="min-w-0 divide-y divide-border/60 rounded-xl border border-border/70">
          {sources.map((source) => (
            <li key={source.itemId} className="flex items-center gap-2 py-1 pl-3 pr-1 text-sm" title={`${source.setBy} em ${time(source.setAt)}`}>
              {source.kind === 'folder'
                ? <FolderOpen className="size-4 shrink-0 text-muted" aria-hidden="true" />
                : <FileSpreadsheet className="size-4 shrink-0 text-muted" aria-hidden="true" />}
              <Chip size="sm" variant="soft">{source.year}</Chip>
              <span className="min-w-0 flex-1 truncate">{source.path}</span>
              <Button size="sm" variant="ghost" isIconOnly isDisabled={busy} aria-label={`Remover ${source.path}`}
                onPress={() => void send({ action: 'remove-source', itemId: source.itemId })}>
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {picking && year !== null ? (
        <SourcePicker
          year={year}
          onCancel={() => setPicking(false)}
          onChosen={async (source) => {
            await send({ action: 'add-source', year, itemId: source.itemId, kind: source.kind, path: source.path.slice(0, 400) });
            setPicking(false);
          }}
        />
      ) : null}
    </section>
  );
}

function SettingsSection({ status, busy, send, wait, setWait }: Readonly<{
  status: OneDriveSyncStatusV1; busy: boolean; send: SendV1; wait: string; setWait: (value: string) => void;
}>) {
  const saved = String(status.settings.waitSeconds);
  return (
    <section className="flex min-w-0 flex-wrap items-end justify-between gap-3" aria-label="Ajustes">
      <div className="flex items-end gap-2">
        <TextField className="w-36">
          <Label className="text-sm">Espera após salvar (s)</Label>
          <Input inputMode="numeric" value={wait} onChange={(event) => setWait(event.currentTarget.value)} />
        </TextField>
        <Button size="sm" variant="secondary" isDisabled={busy || wait === saved || !/^\d{1,3}$/u.test(wait)}
          onPress={() => void send({ action: 'set-wait', seconds: Number(wait) })}>Salvar</Button>
      </div>
      <p className="text-sm text-muted">
        Leituras ao mesmo tempo: <span className="font-medium text-foreground tabular-nums">{status.settings.maxParallel}</span>
        {status.parallelCeiling ? ` de ${status.parallelCeiling}` : ''} · automático
      </p>
    </section>
  );
}

/** A status with a file being read. */
function statusMovingV1(answer: OneDriveSyncResponseV1): boolean {
  // A file waiting for a later retry is not moving: only a read in progress asks every 10 s (issue #1450, 12b).
  return answer.state !== 'status' || answer.status.files.some((file) => file.state === 'reading');
}

/**
 * Reads the status while the page is visible: every 10 s while something moves (or the last read
 * failed), every 60 s when everything is still, and not at all after 10 min without the user
 * touching the page (the next click, key or touch reads at once). A read made while the phone had
 * the page in the background can fail on its own; only repeated failures of this refresh are shown.
 */
function useStatusRefreshV1(isActive: boolean, apply: (answer: OneDriveSyncResponseV1) => void,
  loaded: { readonly current: boolean }): void {
  useEffect(() => {
    if (!isActive) return undefined;
    let controller = new AbortController();
    let misses = 0;
    let timer: number | undefined;
    let moving = true;
    let lastTouch = Date.now();
    let paused = false;
    const applyRefresh = (answer: OneDriveSyncResponseV1) => {
      moving = statusMovingV1(answer);
      if (answer.state === 'unavailable' && loaded.current && ++misses < REFRESH_FAILURES_SHOWN) return;
      if (answer.state !== 'unavailable') misses = 0;
      apply(answer);
    };
    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, ms);
    };
    function refresh() {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastTouch >= REFRESH_PAUSE_AFTER_MS) {
        paused = true;
        return;
      }
      controller.abort();
      controller = new AbortController();
      void requestOneDriveSyncV1({ action: 'status' }, controller.signal).then(applyRefresh).catch(() => undefined)
        .finally(() => { if (!controller.signal.aborted) schedule(moving ? REFRESH_BUSY_MS : REFRESH_IDLE_MS); });
    }
    const onTouch = () => {
      lastTouch = Date.now();
      if (!paused) return;
      paused = false;
      refresh();
    };
    // Back on the page: give the network a moment to wake up, then read.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        lastTouch = Date.now();
        paused = false;
        schedule(RESUME_DELAY_MS);
      } else {
        window.clearTimeout(timer);
        controller.abort();
      }
    };
    refresh();
    document.addEventListener('visibilitychange', onVisibility);
    for (const name of ['pointerdown', 'keydown'] as const) window.addEventListener(name, onTouch, { passive: true });
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const name of ['pointerdown', 'keydown'] as const) window.removeEventListener(name, onTouch);
    };
  }, [apply, isActive, loaded]);
}

export function OneDriveSyncPageV1({ isActive = true }: { isActive?: boolean } = {}) {
  const year = useGradebookYear()?.year ?? null;
  const [status, setStatus] = useState<OneDriveSyncStatusV1 | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState('');
  const loaded = useRef(false);

  const apply = useCallback((answer: OneDriveSyncResponseV1) => {
    if (answer.state === 'status') {
      setStatus(answer.status);
      setFailure(null);
      if (!loaded.current) {
        setWait(String(answer.status.settings.waitSeconds));
        loaded.current = true;
      }
    } else if (answer.state === 'not-authorized') setFailure('Sua sessão não possui autorização para esta área.');
    else setFailure('A leitura automática não respondeu agora. Tente de novo em instantes.');
  }, []);

  const send = useCallback(async (request: OneDriveSyncRequestV1) => {
    setBusy(true);
    try { apply(await requestOneDriveSyncV1(request)); } finally { setBusy(false); }
  }, [apply]);

  useStatusRefreshV1(isActive, apply, loaded);

  if (!status) {
    return failure
      ? <Alert status="danger" role="alert"><Alert.Indicator /><Alert.Content><Alert.Title>{failure}</Alert.Title></Alert.Content></Alert>
      : <Spinner aria-label="Carregando a leitura automática" />;
  }

  // Before sources existed the status only had one folder per year.
  const sources: SourceV1[] = status.sources ?? status.folders.map((item) => ({
    itemId: item.folderId, kind: 'folder' as const, path: item.folderPath, year: item.year, setBy: item.setBy, setAt: item.setAt }));
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <Surface className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface">
        <SyncHeader status={status} busy={busy} send={send} />
        <div className="grid min-w-0 grid-cols-1 gap-4 px-5 py-4">
          {failure ? <p className="text-sm text-danger" role="alert">{failure}</p> : null}
          <SourcesSection sources={sources} year={year} busy={busy} send={send} />
          <SettingsSection status={status} busy={busy} send={send} wait={wait} setWait={setWait} />
        </div>
      </Surface>

      <Surface className="overflow-hidden rounded-2xl border border-border bg-surface">
        <h4 className="border-b border-border px-4 py-3 text-sm font-semibold">
          Planilhas <span className="text-muted tabular-nums">({status.files.filter((file) => !file.removed).length})</span>
        </h4>
        {status.files.length === 0 ? <p className="p-4 text-sm text-muted">Nenhuma planilha lida ainda.</p> : (
          <ul>
            {status.files.map((file) => (
              <FileRow key={file.id} file={file} busy={busy} onRead={() => void send({ action: 'read-now', fileId: file.id })} />
            ))}
          </ul>
        )}
      </Surface>

      <details className="group overflow-hidden rounded-2xl border border-border bg-surface">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
          Histórico
        </summary>
        {status.events.length === 0 ? <p className="border-t border-border p-4 text-sm text-muted">Nenhuma alteração registrada.</p> : (
          <ul className="grid border-t border-border">
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
      </details>
    </div>
  );
}
