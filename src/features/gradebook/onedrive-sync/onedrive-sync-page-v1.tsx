import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Chip, Spinner, Surface } from '@heroui/react';
import {
  ChevronRight,
  CloudCog,
  FileSpreadsheet,
  FolderOpen,
  Link2,
  Pause,
  Play,
  Plus,
  Power,
  RefreshCcw,
  RotateCw,
  Trash2,
} from 'lucide-react';
import type {
  OneDriveSyncRequestV1,
  OneDriveSyncResponseV1,
  OneDriveSyncStatusV1,
} from '../../../../shared/gradebook-contracts/onedrive-sync/onedrive-sync-contract-v1';
import {
  localDayMonthTimeTextV1,
  PT_BR_UP_TO_1_DECIMAL_V1,
} from '../../../../shared/locale-format-v1';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import { requestOneDriveSyncV1 } from './onedrive-sync-client-v1';

type FileV1 = OneDriveSyncStatusV1['files'][number];
type PreviewV1 = Extract<OneDriveSyncResponseV1, { state: 'preview' }>['preview'];
type FolderV1 = Extract<OneDriveSyncResponseV1, { state: 'folders' }>['folders'][number];
type WorkbookEntryV1 = NonNullable<
  Extract<OneDriveSyncResponseV1, { state: 'folders' }>['files']
>[number];
type SourceV1 = NonNullable<OneDriveSyncStatusV1['sources']>[number];
type ChosenSourceV1 = {
  readonly kind: 'folder' | 'file';
  readonly itemId: string;
  readonly path: string;
};
type ChipColor = 'accent' | 'success' | 'warning' | 'danger' | 'default';

/** Reads while a file is being read or waits, after a failed read, and when nothing moves. */
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
  'links-on': 'ligou a atualização de vínculos',
  'links-off': 'desligou a atualização de vínculos',
  'links-add-target': 'adicionou uma pasta aos vínculos',
  'links-remove-target': 'removeu uma pasta dos vínculos',
  'links-check-all': 'pediu para conferir todos os vínculos',
  'links-refresh-now': 'pediu para atualizar os vínculos de um arquivo',
  'links-recalc-on': 'ligou o recálculo das células',
  'links-recalc-off': 'desligou o recálculo das células',
};

/** What each control change shows after its label. */
const CONTROL_DETAILS: Readonly<Record<string, (detail: Record<string, unknown>) => string>> = {
  'set-folder': (detail) => ` (${String(detail.year)}: ${String(detail.folderPath)})`,
  'add-source': (detail) => ` (${String(detail.year)}: ${String(detail.path)})`,
  'links-add-target': (detail) => ` (${String(detail.path)})`,
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
function arrivalTextV1(
  file: Pick<FileV1, 'lastAppliedAt' | 'lastSavedToWrittenMs'>,
): string | null {
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
  if (event.kind === 'webhook-error')
    return 'não foi possível ativar o aviso da Graph; conferência a cada minuto';
  if (event.kind === 'breaker-open')
    return 'disjuntor: leitura pausada por 15 minutos após falhas seguidas';
  if (event.kind === 'graph-error') return 'falha ao consultar o OneDrive';
  if (event.kind === 'full-check')
    return `conferência completa da pasta (${String(detail.files)} arquivos)`;
  if (event.kind === 'parallel')
    return `leituras ao mesmo tempo: ${String(detail.from)} → ${String(detail.to)}`;
  if (event.kind === 'relation-changed')
    return `Relação mudou: ${String(detail.reread)} planilha(s) lidas de novo`;
  if (event.kind === 'links-failed')
    return `não foi possível atualizar os vínculos de ${String(detail.file)}`;
  if (event.kind === 'links-listing')
    return `vínculos: ${String(detail.files)} planilha(s) conferida(s)`;
  if (event.kind === 'links-recalc-skipped')
    return `recálculo de ${String(detail.file)}: ${String(detail.note)}`;
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

function FileRow({
  file,
  busy,
  onRead,
}: Readonly<{ file: FileV1; busy: boolean; onRead: () => void }>) {
  const outcome = file.lastOutcome ? OUTCOME_LABELS[file.lastOutcome] : null;
  let state: [string, ChipColor] | null = null;
  if (file.removed) state = ['Removido da pasta', 'default'];
  else if (file.state === 'reading') state = ['Lendo', 'accent'];
  else if (file.state === 'pending') state = ['Aguardando', 'accent'];
  let [label, color] = state ?? outcome ?? ['Ainda não lido', 'default'];
  // Lançado, but some students waited for the Relação (different name, not in it): their notes
  // arrive when the Relação is fixed.
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
          <span className="truncate text-sm font-medium" title={file.name}>
            {file.name}
          </span>
          <Chip size="sm" variant="soft" color={color}>
            <Chip.Label>{label}</Chip.Label>
          </Chip>
        </div>
        {arrival || file.lastReadAt ? (
          <p className="mt-0.5 text-xs text-muted">
            {arrival ? `Notas chegaram ${arrival}` : `Lido ${time(file.lastReadAt)}`}
          </p>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="ghost"
        isIconOnly
        aria-label={`Ler de novo ${file.name}`}
        isDisabled={busy || file.removed || file.state !== 'idle'}
        onPress={onRead}
      >
        <RotateCw className="size-4" aria-hidden="true" />
      </Button>
    </li>
  );
}

const SAMPLE_LABELS: Readonly<Record<string, string>> = {
  ready: 'reconhecida',
  none: 'nenhuma planilha',
};

function webhookLabelV1(accepted: boolean | null): string {
  if (accepted === true) return 'aceito';
  if (accepted === false) return 'recusado — a pasta será conferida a cada minuto';
  return 'não testado';
}

function PreviewSummary({ preview }: Readonly<{ preview: PreviewV1 }>) {
  const { sample } = preview;
  return (
    <div className="grid gap-1 rounded-xl border border-border/70 bg-surface p-3 text-sm">
      <strong>
        {preview.workbooks} planilha(s) ·{' '}
        {PT_BR_UP_TO_1_DECIMAL_V1.format(preview.workbookBytes / 1048576)} MB
      </strong>
      <span className="text-muted">
        Leitura de teste (sem gravar): {SAMPLE_LABELS[sample.outcome] ?? sample.outcome}
        {sample.readMs !== null && sample.readMs > 0
          ? ` em ${minutesSecondsV1(sample.readMs)}`
          : ''}
      </span>
      <span className="text-muted">Aviso da Graph: {webhookLabelV1(preview.webhook.accepted)}</span>
      {preview.names.length > 0 ? (
        <span className="text-xs text-muted">{preview.names.join(' · ')}</span>
      ) : null}
    </div>
  );
}

/** The workbooks of the folder shown, each one can be chosen as a source on its own (e.g. the Relação). */
function WorkbookChoices({
  workbooks,
  label,
  disabled,
  onChoose,
}: Readonly<{
  workbooks: readonly WorkbookEntryV1[];
  label: string;
  disabled: boolean;
  onChoose: (workbook: WorkbookEntryV1) => void;
}>) {
  return (
    <>
      {workbooks.map((workbook) => (
        <li
          key={workbook.id}
          className="flex flex-wrap items-center justify-between gap-2 px-3 py-1 text-sm"
        >
          <span className="flex min-w-0 items-center gap-2">
            <FileSpreadsheet className="size-4 shrink-0 text-muted" aria-hidden="true" />
            <span className="truncate">{workbook.name}</span>
          </span>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={disabled}
            onPress={() => onChoose(workbook)}
          >
            {label}
          </Button>
        </li>
      ))}
    </>
  );
}

/**
 * Navigates the secretaria's OneDrive and chooses the folder shown or one of its workbooks: a
 * source of the reading (after a preview) or a folder whose links are kept up to date.
 */
function SourcePicker({
  folderLabel,
  fileLabel,
  previewRequired,
  onChosen,
  onCancel,
}: Readonly<{
  folderLabel: string;
  fileLabel: string;
  previewRequired: boolean;
  onChosen: (source: ChosenSourceV1) => Promise<void>;
  onCancel: () => void;
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
    void requestOneDriveSyncV1(
      { action: 'folders', parentId: current?.id ?? null },
      controller.signal,
    )
      .then((answer) => {
        // A failed list never leaves the previous folder's list on screen under the new path.
        setFolders(answer.state === 'folders' ? answer.folders : []);
        setWorkbooks(answer.state === 'folders' ? (answer.files ?? []) : []);
        if (answer.state !== 'folders') {
          setFailure('Não foi possível listar as pastas do OneDrive.');
          setListFailed(true);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setBusy(null);
      });
    return () => controller.abort();
  }, [current?.id, attempt]);

  // The folder on screen now: a preview that comes back after the user moved on is dropped, so
  // "Usar esta pasta" never saves a folder with the preview of another.
  const shown = useRef<string | null>(null);
  shown.current = current?.id ?? null;
  const runPreview = async () => {
    if (!current) return;
    const folderId = current.id;
    setBusy('preview');
    setFailure(null);
    try {
      const answer = await requestOneDriveSyncV1({
        action: 'preview',
        folderId,
        testWebhook: true,
      });
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
        <Button size="sm" variant="ghost" onPress={() => setTrail([])}>
          OneDrive da secretaria
        </Button>
        {trail.map((item, index) => (
          <span key={item.id} className="flex items-center gap-1">
            <ChevronRight className="size-4 text-muted" aria-hidden="true" />
            <Button size="sm" variant="ghost" onPress={() => setTrail(trail.slice(0, index + 1))}>
              {item.name}
            </Button>
          </span>
        ))}
      </nav>
      {busy === 'list' ? (
        <Spinner size="sm" />
      ) : (
        <ul className="grid max-h-64 gap-1 overflow-auto">
          {(folders ?? []).length === 0 && workbooks.length === 0 ? (
            <li className="text-sm text-muted">Nada aqui.</li>
          ) : null}
          {(folders ?? []).map((folder) => (
            <li key={folder.id}>
              <Button
                size="sm"
                variant="ghost"
                className="w-full justify-start"
                onPress={() => setTrail([...trail, { id: folder.id, name: folder.name }])}
              >
                <FolderOpen className="size-4" aria-hidden="true" />
                {folder.name}
              </Button>
            </li>
          ))}
          <WorkbookChoices
            workbooks={workbooks}
            label={fileLabel}
            disabled={busy !== null}
            onChoose={(workbook) => {
              setBusy('save');
              void onChosen({
                kind: 'file',
                itemId: workbook.id,
                path: path ? `${path}/${workbook.name}` : workbook.name,
              }).finally(() => setBusy(null));
            }}
          />
        </ul>
      )}
      {preview ? <PreviewSummary preview={preview} /> : null}
      {failure ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-danger" role="alert">
          {failure}
          {listFailed ? (
            <Button size="sm" variant="ghost" onPress={() => setAttempt((value) => value + 1)}>
              Tentar de novo
            </Button>
          ) : null}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {previewRequired ? (
          <Button
            variant="secondary"
            isDisabled={!current || busy !== null}
            isPending={busy === 'preview'}
            onPress={() => void runPreview()}
          >
            Ver prévia desta pasta
          </Button>
        ) : null}
        <Button
          variant="primary"
          isDisabled={!current || (previewRequired && !preview) || busy !== null}
          isPending={busy === 'save'}
          onPress={() => {
            if (current) {
              setBusy('save');
              void onChosen({ kind: 'folder', itemId: current.id, path }).finally(() =>
                setBusy(null),
              );
            }
          }}
        >
          {folderLabel}
        </Button>
        <Button variant="ghost" onPress={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

type SendV1 = (request: OneDriveSyncRequestV1) => Promise<void>;

/** The file whose grades arrived last. */
function lastArrivalV1(files: readonly FileV1[]): FileV1 | null {
  let last: FileV1 | null = null;
  for (const file of files) {
    if (file.lastAppliedAt && (!last?.lastAppliedAt || file.lastAppliedAt > last.lastAppliedAt))
      last = file;
  }
  return last;
}

/** Before any file has an arrival (`lastAppliedAt`): the last reading. */
function lastReadTextV1(files: readonly FileV1[]): string | null {
  const latest = Math.max(0, ...files.map((file) => file.lastReadAt ?? 0));
  return latest > 0 ? `Última leitura: ${time(latest)}` : null;
}

function SyncHeader({
  status,
  busy,
  send,
}: Readonly<{
  status: OneDriveSyncStatusV1;
  busy: boolean;
  send: SendV1;
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
            {last ? (
              <>
                Última chegada de notas:{' '}
                <span className="text-foreground">
                  {last.name.replace(/\.(xlsb|xlsx|xlsm|xls)$/iu, '')}
                </span>{' '}
                · {arrivalTextV1(last)}
              </>
            ) : (
              lastReadTextV1(status.files)
            )}
          </p>
          {enabled && !status.webhook.active ? (
            <p className="mt-0.5 text-xs text-warning">
              Sem aviso do OneDrive: a pasta é conferida a cada minuto.
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={enabled ? 'secondary' : 'primary'}
          isDisabled={busy || (!enabled && status.activeYear === null)}
          onPress={() => void send({ action: enabled ? 'disable' : 'enable' })}
        >
          <Power className="size-4" aria-hidden="true" />
          {enabled ? 'Desligar' : 'Ligar'}
        </Button>
        {enabled ? (
          <Button
            size="sm"
            variant="secondary"
            isDisabled={busy}
            onPress={() => void send({ action: paused ? 'resume' : 'pause' })}
          >
            {paused ? (
              <Play className="size-4" aria-hidden="true" />
            ) : (
              <Pause className="size-4" aria-hidden="true" />
            )}
            {paused ? 'Retomar' : 'Pausar'}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          isDisabled={busy || !enabled}
          onPress={() => void send({ action: 'read-all' })}
        >
          <RefreshCcw className="size-4" aria-hidden="true" />
          Conferir tudo
        </Button>
      </div>
    </div>
  );
}

/** The folders and single workbooks read, each tied to its academic year; one is added at a time. */
function SourcesSection({
  sources,
  year,
  busy,
  send,
}: Readonly<{
  sources: readonly SourceV1[];
  year: number | null;
  busy: boolean;
  send: SendV1;
}>) {
  const [picking, setPicking] = useState(false);
  return (
    <section className="grid min-w-0 grid-cols-1 gap-2" aria-labelledby="onedrive-sources-title">
      <div className="flex items-center justify-between gap-2">
        <h4 id="onedrive-sources-title" className="text-sm font-semibold">
          Fontes
        </h4>
        {picking ? null : (
          <Button
            size="sm"
            variant="ghost"
            isDisabled={busy || year === null}
            onPress={() => setPicking(true)}
          >
            <Plus className="size-4" aria-hidden="true" />
            Adicionar
          </Button>
        )}
      </div>
      {sources.length === 0 ? (
        <p className="text-sm text-muted">Nenhuma fonte escolhida.</p>
      ) : (
        <ul className="min-w-0 divide-y divide-border/60 rounded-xl border border-border/70">
          {sources.map((source) => (
            <li
              key={source.itemId}
              className="flex items-center gap-2 py-1 pl-3 pr-1 text-sm"
              title={`${source.setBy} em ${time(source.setAt)}`}
            >
              {source.kind === 'folder' ? (
                <FolderOpen className="size-4 shrink-0 text-muted" aria-hidden="true" />
              ) : (
                <FileSpreadsheet className="size-4 shrink-0 text-muted" aria-hidden="true" />
              )}
              <Chip size="sm" variant="soft">
                {source.year}
              </Chip>
              <span className="min-w-0 flex-1 truncate">{source.path}</span>
              <Button
                size="sm"
                variant="ghost"
                isIconOnly
                isDisabled={busy}
                aria-label={`Remover ${source.path}`}
                onPress={() => void send({ action: 'remove-source', itemId: source.itemId })}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {picking && year !== null ? (
        <SourcePicker
          folderLabel={`Ler esta pasta inteira em ${year}`}
          fileLabel={`Ler só este arquivo em ${year}`}
          previewRequired
          onCancel={() => setPicking(false)}
          onChosen={async (source) => {
            await send({
              action: 'add-source',
              year,
              itemId: source.itemId,
              kind: source.kind,
              path: source.path.slice(0, 400),
            });
            setPicking(false);
          }}
        />
      ) : null}
    </section>
  );
}

function SettingsSection({ status }: Readonly<{ status: OneDriveSyncStatusV1 }>) {
  return (
    <section className="flex min-w-0 flex-wrap items-end gap-3" aria-label="Ajustes">
      <p className="text-sm text-muted">
        Leituras ao mesmo tempo:{' '}
        <span className="font-medium text-foreground tabular-nums">
          {status.settings.maxParallel}
        </span>
        {status.parallelCeiling ? ` de ${status.parallelCeiling}` : ''} · automático
      </p>
    </section>
  );
}

type LinksV1 = NonNullable<OneDriveSyncStatusV1['links']>;
type LinkFileV1 = LinksV1['files'][number];

const LINK_OUTCOME_LABELS: Record<NonNullable<LinkFileV1['lastOutcome']>, [string, ChipColor]> = {
  unchanged: ['Em dia', 'success'],
  written: ['Atualizado', 'success'],
  'no-links': ['Sem vínculos', 'default'],
  locked: ['Aberto por alguém — nova tentativa automática', 'warning'],
  'changed-meanwhile': ['Salvo durante a atualização — nova tentativa', 'accent'],
  settling: ['Aguardando o salvamento terminar', 'accent'],
  'too-large': ['Arquivo grande demais', 'warning'],
  gone: ['Removido', 'default'],
  failed: ['Falhou', 'danger'],
};

function linkChipV1(file: LinkFileV1): [string, ChipColor] {
  if (file.state === 'working') return ['Atualizando', 'accent'];
  const outcome = file.lastOutcome;
  if (file.state === 'pending') {
    if (outcome === 'failed') return ['Falhou — nova tentativa automática', 'danger'];
    if (outcome === 'locked' || outcome === 'changed-meanwhile' || outcome === 'settling')
      return LINK_OUTCOME_LABELS[outcome];
    return ['Aguardando', 'accent'];
  }
  return outcome ? LINK_OUTCOME_LABELS[outcome] : ['Ainda não conferido', 'default'];
}

function LinkFileRow({
  file,
  busy,
  onRefresh,
}: Readonly<{ file: LinkFileV1; busy: boolean; onRefresh: () => void }>) {
  const [label, color] = linkChipV1(file);
  // Like the Planilhas rows: the update when there was one, otherwise the last check.
  let shown: string | null = null;
  if (file.lastWrittenAt) shown = `Atualizado ${time(file.lastWrittenAt)}`;
  else if (file.lastCheckedAt) shown = `Conferido ${time(file.lastCheckedAt)}`;
  const detail = [
    shown,
    file.unavailableLinks ? `${file.unavailableLinks} vínculo(s) sem origem acessível` : null,
    file.recalcCells ? `${file.recalcCells} célula(s) recalculada(s)` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-b-0">
      <FileSpreadsheet className="size-4 shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium" title={file.name}>
            {file.name}
          </span>
          <Chip size="sm" variant="soft" color={color}>
            <Chip.Label>{label}</Chip.Label>
          </Chip>
        </div>
        {detail ? <p className="mt-0.5 text-xs text-muted">{detail}</p> : null}
        {file.recalcNote ? (
          <p className="mt-0.5 text-xs text-warning">Recálculo: {file.recalcNote}</p>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="ghost"
        isIconOnly
        aria-label={`Atualizar os vínculos de ${file.name}`}
        isDisabled={busy || file.state === 'working'}
        onPress={onRefresh}
      >
        <RotateCw className="size-4" aria-hidden="true" />
      </Button>
    </li>
  );
}

/**
 * Links between workbooks (#1541): the sync keeps the copy of the source cells that Excel stores
 * for each link up to date, in the folders (or workbooks) chosen here; Excel recalculates when the
 * file is opened.
 */
function LinksSection({
  status,
  busy,
  send,
}: Readonly<{ status: OneDriveSyncStatusV1; busy: boolean; send: SendV1 }>) {
  const [picking, setPicking] = useState(false);
  const links: LinksV1 = status.links ?? { enabled: false, targets: [], files: [] };
  const stopped = links.enabled && (!status.settings.enabled || status.settings.paused);
  let chip: [string, ChipColor] = ['Desligada', 'default'];
  if (stopped) chip = ['Parada — leitura automática desligada ou pausada', 'warning'];
  else if (links.enabled) chip = ['Ligada', 'success'];
  // Like the reading's header: the last update, otherwise the last check.
  const last = lastLinkUpdateV1(links.files);
  const lastCheck = Math.max(0, ...links.files.map((file) => file.lastCheckedAt ?? 0));
  let subtitle: ReactNode = null;
  if (last?.lastWrittenAt)
    subtitle = (
      <>
        Última atualização:{' '}
        <span className="text-foreground">
          {last.name.replace(/\.(xlsb|xlsx|xlsm|xls)$/iu, '')}
        </span>{' '}
        · {time(last.lastWrittenAt)}
      </>
    );
  else if (lastCheck > 0) subtitle = `Última conferência: ${time(lastCheck)}`;
  return (
    <>
      <Surface className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
              <Link2 className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold">Vínculos entre planilhas</h3>
                <Chip size="sm" variant="soft" color={chip[1]}>
                  <Chip.Label>{chip[0]}</Chip.Label>
                </Chip>
              </div>
              {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={links.enabled ? 'secondary' : 'primary'}
              isDisabled={busy}
              onPress={() => void send({ action: links.enabled ? 'links-off' : 'links-on' })}
            >
              <Power className="size-4" aria-hidden="true" />
              {links.enabled ? 'Desligar' : 'Ligar'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy || !links.enabled}
              onPress={() => void send({ action: 'links-check-all' })}
            >
              <RefreshCcw className="size-4" aria-hidden="true" />
              Conferir tudo
            </Button>
          </div>
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-4 px-5 py-4">
          <section
            className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 px-3 py-2"
            aria-labelledby="onedrive-links-recalc-title"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h4 id="onedrive-links-recalc-title" className="text-sm font-semibold">
                Recalcular células
              </h4>
              <Chip size="sm" variant="soft" color={links.recalc ? 'success' : 'default'}>
                <Chip.Label>{links.recalc ? 'Ligado (teste)' : 'Desligado'}</Chip.Label>
              </Chip>
            </div>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              onPress={() =>
                void send({ action: links.recalc ? 'links-recalc-off' : 'links-recalc-on' })
              }
            >
              <Power className="size-4" aria-hidden="true" />
              {links.recalc ? 'Desligar recálculo' : 'Ligar recálculo'}
            </Button>
          </section>
          <section
            className="grid min-w-0 grid-cols-1 gap-2"
            aria-labelledby="onedrive-links-title"
          >
            <div className="flex items-center justify-between gap-2">
              <h4 id="onedrive-links-title" className="text-sm font-semibold">
                Pastas e planilhas
              </h4>
              {picking ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={busy}
                  onPress={() => setPicking(true)}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  Adicionar
                </Button>
              )}
            </div>
            {links.targets.length === 0 ? (
              <p className="text-sm text-muted">Nenhuma pasta escolhida.</p>
            ) : (
              <ul className="min-w-0 divide-y divide-border/60 rounded-xl border border-border/70">
                {links.targets.map((target) => (
                  <li
                    key={target.itemId}
                    className="flex items-center gap-2 py-1 pl-3 pr-1 text-sm"
                    title={`${target.setBy} em ${time(target.setAt)}`}
                  >
                    {target.kind === 'folder' ? (
                      <FolderOpen className="size-4 shrink-0 text-muted" aria-hidden="true" />
                    ) : (
                      <FileSpreadsheet className="size-4 shrink-0 text-muted" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{target.path}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      isDisabled={busy}
                      aria-label={`Remover ${target.path}`}
                      onPress={() =>
                        void send({ action: 'links-remove-target', itemId: target.itemId })
                      }
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {picking ? (
              <SourcePicker
                folderLabel="Usar esta pasta"
                fileLabel="Usar só este arquivo"
                previewRequired={false}
                onCancel={() => setPicking(false)}
                onChosen={async (target) => {
                  await send({
                    action: 'links-add-target',
                    itemId: target.itemId,
                    kind: target.kind,
                    path: target.path.slice(0, 400),
                  });
                  setPicking(false);
                }}
              />
            ) : null}
          </section>
        </div>
      </Surface>

      <Surface className="overflow-hidden rounded-2xl border border-border bg-surface">
        <h4 className="border-b border-border px-4 py-3 text-sm font-semibold">
          Planilhas com vínculos{' '}
          <span className="text-muted tabular-nums">({links.files.length})</span>
        </h4>
        {links.files.length === 0 ? (
          <p className="p-4 text-sm text-muted">Nenhuma planilha conferida ainda.</p>
        ) : (
          <ul>
            {links.files.map((file) => (
              <LinkFileRow
                key={file.id}
                file={file}
                busy={busy}
                onRefresh={() => void send({ action: 'links-refresh-now', fileId: file.id })}
              />
            ))}
          </ul>
        )}
      </Surface>
    </>
  );
}

/** The workbook whose links were updated last. */
function lastLinkUpdateV1(files: readonly LinkFileV1[]): LinkFileV1 | null {
  let last: LinkFileV1 | null = null;
  for (const file of files) {
    if (file.lastWrittenAt && (!last?.lastWrittenAt || file.lastWrittenAt > last.lastWrittenAt))
      last = file;
  }
  return last;
}

/** A status with a file being read, or a workbook's links being refreshed. */
function statusMovingV1(answer: OneDriveSyncResponseV1): boolean {
  // A file waiting for a later retry is not moving: only a read in progress asks every 10 s.
  return (
    answer.state !== 'status' ||
    answer.status.files.some((file) => file.state === 'reading') ||
    (answer.status.links?.files.some((file) => file.state === 'working') ?? false)
  );
}

/**
 * Reads the status while the page is visible: every 10 s while something moves (or the last read
 * failed), every 60 s when everything is still, and not at all after 10 min without the user
 * touching the page (the next click, key or touch reads at once). A read made while the phone had
 * the page in the background can fail on its own; only repeated failures of this refresh are shown.
 */
function useStatusRefreshV1(
  isActive: boolean,
  apply: (answer: OneDriveSyncResponseV1) => void,
  loaded: { readonly current: boolean },
): void {
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
      if (answer.state === 'unavailable' && loaded.current && ++misses < REFRESH_FAILURES_SHOWN)
        return;
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
      void requestOneDriveSyncV1({ action: 'status' }, controller.signal)
        .then(applyRefresh)
        .catch(() => undefined)
        .finally(() => {
          if (!controller.signal.aborted) schedule(moving ? REFRESH_BUSY_MS : REFRESH_IDLE_MS);
        });
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
    for (const name of ['pointerdown', 'keydown'] as const)
      window.addEventListener(name, onTouch, { passive: true });
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const name of ['pointerdown', 'keydown'] as const)
        window.removeEventListener(name, onTouch);
    };
  }, [apply, isActive, loaded]);
}

export function OneDriveSyncPageV1({ isActive = true }: { isActive?: boolean } = {}) {
  const year = useGradebookYear()?.year ?? null;
  const [status, setStatus] = useState<OneDriveSyncStatusV1 | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);

  const apply = useCallback((answer: OneDriveSyncResponseV1) => {
    if (answer.state === 'status') {
      setStatus(answer.status);
      setFailure(null);
      loaded.current = true;
    } else if (answer.state === 'not-authorized')
      setFailure('Sua sessão não possui autorização para esta área.');
    else setFailure('A leitura automática não respondeu agora. Tente de novo em instantes.');
  }, []);

  const send = useCallback(
    async (request: OneDriveSyncRequestV1) => {
      setBusy(true);
      try {
        apply(await requestOneDriveSyncV1(request));
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );

  useStatusRefreshV1(isActive, apply, loaded);

  if (!status) {
    return failure ? (
      <Alert status="danger" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{failure}</Alert.Title>
        </Alert.Content>
      </Alert>
    ) : (
      <Spinner aria-label="Carregando a leitura automática" />
    );
  }

  // Before sources existed the status only had one folder per year.
  const sources: SourceV1[] =
    status.sources ??
    status.folders.map((item) => ({
      itemId: item.folderId,
      kind: 'folder' as const,
      path: item.folderPath,
      year: item.year,
      setBy: item.setBy,
      setAt: item.setAt,
    }));
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <Surface className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface">
        <SyncHeader status={status} busy={busy} send={send} />
        <div className="grid min-w-0 grid-cols-1 gap-4 px-5 py-4">
          {failure ? (
            <p className="text-sm text-danger" role="alert">
              {failure}
            </p>
          ) : null}
          <SourcesSection sources={sources} year={year} busy={busy} send={send} />
          <SettingsSection status={status} />
        </div>
      </Surface>

      <Surface className="overflow-hidden rounded-2xl border border-border bg-surface">
        <h4 className="border-b border-border px-4 py-3 text-sm font-semibold">
          Planilhas{' '}
          <span className="text-muted tabular-nums">
            ({status.files.filter((file) => !file.removed).length})
          </span>
        </h4>
        {status.files.length === 0 ? (
          <p className="p-4 text-sm text-muted">Nenhuma planilha lida ainda.</p>
        ) : (
          <ul>
            {status.files.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                busy={busy}
                onRead={() => void send({ action: 'read-now', fileId: file.id })}
              />
            ))}
          </ul>
        )}
      </Surface>

      <LinksSection status={status} busy={busy} send={send} />

      <details className="group overflow-hidden rounded-2xl border border-border bg-surface">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold">
          <ChevronRight
            className="size-4 transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
          Histórico
        </summary>
        {status.events.length === 0 ? (
          <p className="border-t border-border p-4 text-sm text-muted">
            Nenhuma alteração registrada.
          </p>
        ) : (
          <ul className="grid border-t border-border">
            {status.events.map((event, index) => (
              <li
                key={`${event.at}-${index}`}
                className="border-b border-border/60 px-4 py-2 text-sm last:border-b-0"
              >
                <span className="tabular-nums text-muted">{time(event.at)}</span>
                {' · '}
                {event.actor ? (
                  <strong>{event.actor}</strong>
                ) : (
                  <span className="text-muted">Sistema</span>
                )}{' '}
                {eventText(event)}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
