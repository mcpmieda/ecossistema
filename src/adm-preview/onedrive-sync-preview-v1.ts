import type {
  OneDriveSyncResponseV1,
  OneDriveSyncStatusV1,
} from '../../shared/gradebook-contracts/onedrive-sync/onedrive-sync-contract-v1';

/*
 * Synthetic OneDrive automatic read for the local preview: invented folders and workbooks,
 * kept in memory for this page load. `?onedrive=vazio` starts with no folder chosen.
 */
const now = Date.now();
const minutes = (count: number) => now - count * 60_000;
const syntheticFiles: OneDriveSyncStatusV1['files'] = [
  ['Planilha Sintética Professora A 2026.xlsb', 'applied', 2, 1900, 6400, null],
  ['Planilha Sintética Professor B 2026.xlsb', 'no-changes', 35, 1200, null, null],
  ['Planilha Sintética Professora C 2026.xlsb', 'blocked', 12, 1600, null, 'AUDIT-BLOCKING'],
  ['Planilha Sintética Professor D 2026.xlsb', 'failed', 4, 0, null, 'GRAPH-DOWNLOAD'],
  ['Planilha Sintética Professora E 2026.xlsb', null, 0, null, null, null],
].map(([name, outcome, age, readMs, saved, code], index) => ({
  id: `item-${index + 1}`,
  name: name as string,
  size: 1_500_000 + index * 120_000,
  modifiedAt: new Date(minutes((age as number) + 1)).toISOString(),
  state: index === 4 ? 'pending' as const : 'idle' as const,
  removed: false,
  lastOutcome: outcome as OneDriveSyncStatusV1['files'][number]['lastOutcome'],
  lastCode: code as string | null,
  lastReadAt: outcome === null ? null : minutes(age as number),
  lastReadMs: readMs as number | null,
  lastSavedToWrittenMs: saved as number | null,
}));

const empty = new URLSearchParams(window.location.search).get('onedrive') === 'vazio';
const status: OneDriveSyncStatusV1 = {
  settings: { enabled: !empty, paused: false, waitSeconds: 0, maxParallel: 6 },
  activeYear: empty ? null : 2026,
  folders: empty ? [] : [{ year: 2026, folderId: 'folder-2026', folderPath: 'PEDAGÓGICO/CONTROLE DE NOTAS/CONTROLE DE NOTAS 2026',
    setBy: 'Preview Local', setAt: minutes(60 * 24) }],
  breakerUntil: null,
  webhook: { active: !empty, expiresAt: empty ? null : new Date(now + 20 * 86_400_000).toISOString() },
  lastDeltaAt: minutes(2),
  files: empty ? [] : syntheticFiles,
  events: empty ? [] : [
    { at: minutes(3), kind: 'webhook-subscribed', actor: null, detail: '{}' },
    { at: minutes(60 * 24), kind: 'control', actor: 'Preview Local', detail: JSON.stringify({ action: 'enable' }) },
    { at: minutes(60 * 24 + 1), kind: 'control', actor: 'Preview Local',
      detail: JSON.stringify({ action: 'set-folder', year: 2026, folderPath: 'PEDAGÓGICO/CONTROLE DE NOTAS/CONTROLE DE NOTAS 2026' }) },
  ],
};

const tree: Record<string, Array<{ id: string; name: string; childFolders: number }>> = {
  root: [{ id: 'folder-ped', name: 'PEDAGÓGICO', childFolders: 1 }, { id: 'folder-adm', name: 'ADMINISTRATIVO', childFolders: 0 }],
  'folder-ped': [{ id: 'folder-cn', name: 'CONTROLE DE NOTAS', childFolders: 2 }],
  'folder-cn': [{ id: 'folder-2025', name: 'CONTROLE DE NOTAS 2025', childFolders: 0 }, { id: 'folder-2026', name: 'CONTROLE DE NOTAS 2026', childFolders: 0 }],
};

function control(command: Record<string, unknown>): void {
  const action = String(command.action);
  if (action === 'enable') status.settings.enabled = true;
  if (action === 'disable') status.settings.enabled = false;
  if (action === 'pause') status.settings.paused = true;
  if (action === 'resume') status.settings.paused = false;
  if (action === 'set-wait') status.settings.waitSeconds = Number(command.seconds);
  if (action === 'set-parallel') status.settings.maxParallel = Number(command.count);
  if (action === 'set-folder') {
    const folder = { year: Number(command.year), folderId: String(command.folderId), folderPath: String(command.folderPath),
      setBy: 'Preview Local', setAt: Date.now() };
    status.folders = [folder, ...status.folders.filter((item) => item.year !== folder.year)];
    status.activeYear = folder.year;
  }
  status.events = [{ at: Date.now(), kind: 'control', actor: 'Preview Local', detail: JSON.stringify(command) }, ...status.events];
}

export function previewOneDriveSyncV1(body: string): OneDriveSyncResponseV1 {
  const request = JSON.parse(body) as Record<string, unknown>;
  if (request.action === 'folders') {
    const key = request.parentId === null ? 'root' : String(request.parentId);
    return { contractVersion: 1, state: 'folders', parentId: request.parentId as string | null, folders: tree[key] ?? [] };
  }
  if (request.action === 'preview') {
    const has = request.folderId === 'folder-2026' || request.folderId === 'folder-2025';
    return { contractVersion: 1, state: 'preview', preview: {
      workbooks: has ? 18 : 0, workbookBytes: has ? 29_200_000 : 0,
      names: has ? syntheticFiles.map((file) => file.name) : [],
      sample: has ? { outcome: 'ready', code: null, readMs: 1400, diagnostics: 380 } : { outcome: 'none', code: null, readMs: null, diagnostics: null },
      webhook: { tested: true, accepted: true },
    } };
  }
  if (request.action !== 'status') control(request);
  return { contractVersion: 1, state: 'status', status: structuredClone(status) };
}
