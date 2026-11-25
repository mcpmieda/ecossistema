// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphError } from '../../../server/graph/client';
import {
  DeltaResyncRequiredError,
  type DriveWorkbookV1,
} from '../../../server/gradebook/onedrive-sync/graph-drive-v1';
import {
  newLinkFileV1,
  type LinkFileV1,
} from '../../../server/gradebook/onedrive-sync/links/link-rules-v1';
import type { SyncFileV1 } from '../../../server/gradebook/onedrive-sync/sync-rules-v1';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const graph = vi.hoisted(() => ({
  delta: vi.fn(),
  latest: vi.fn(),
  folder: vi.fn(),
  item: vi.fn(),
}));
vi.mock('../../../server/gradebook/onedrive-sync/graph-drive-v1', async (original) => ({
  ...(await original<typeof import('../../../server/gradebook/onedrive-sync/graph-drive-v1')>()),
  graphDriveDeltaV1: graph.delta,
  graphLatestDeltaLinkV1: graph.latest,
  graphFolderWorkbooksV1: graph.folder,
  graphWorkbookItemV1: graph.item,
}));

const { NotasSyncCoordinatorV1 } =
  await import('../../../server/gradebook/onedrive-sync/sync-coordinator-v1');

// Monday at the school: a school day, so the 10 s poll lasts 25 min.
const now = Date.parse('2026-11-16T10:00:00-03:00');
const EDIT_POLL_MS = 25 * 60_000;

const workbook = (id: string, hash: string | null, parentId = 'simulados'): DriveWorkbookV1 => ({
  id,
  name: `${id.toUpperCase()} SINTETICO.xlsb`,
  size: 10,
  lastModifiedDateTime: '2026-11-16T12:59:00Z',
  eTag: `"${id}"`,
  quickXorHash: hash,
  parentId,
  deleted: false,
});
/** The Banco (a destination) uses a teacher workbook (a source of grades) and a simulado. */
const banco = (extra: Partial<LinkFileV1> = {}): LinkFileV1 => ({
  ...newLinkFileV1(
    { id: 'banco', name: 'BANCO SINTETICO.xlsb', hash: 'b1', modifiedAt: 't' },
    'destinos',
    0,
  ),
  state: 'idle',
  dueAt: null,
  changed: [],
  sources: ['simulado', 'teacher'],
  ownHash: 'b1',
  ...extra,
});

type CoordinatorV1 = { deltaCheck(now: number): Promise<void> };

function coordinatorV1(
  options: { links?: LinkFileV1[]; linksEnabled?: boolean; deltaLink?: string | null } = {},
) {
  const meta = new Map<string, string>();
  const read = (key: string, fallback?: unknown): unknown => {
    const value = meta.get(key);
    return value === undefined ? fallback : JSON.parse(value);
  };
  const setMeta = (key: string, value: unknown) => meta.set(key, JSON.stringify(value));
  setMeta('settings', { enabled: true, paused: false });
  setMeta('driveId', 'drive');
  setMeta('deltaLink', options.deltaLink === undefined ? 'old-cursor' : options.deltaLink);
  setMeta('sources', {
    notas: {
      itemId: 'notas',
      kind: 'folder',
      path: 'NOTAS 2026',
      year: 2026,
      setBy: 'A',
      setAt: 0,
    },
  });
  setMeta('linkSettings', {
    enabled: options.linksEnabled ?? true,
    targets: {
      destinos: { itemId: 'destinos', kind: 'folder', path: 'DESTINOS', setBy: 'A', setAt: 0 },
    },
  });
  setMeta('linkSourceHashes', { simulado: 's1', teacher: 't1' });
  const files = new Map<string, SyncFileV1>();
  const links = new Map((options.links ?? [banco()]).map((file) => [file.id, file]));
  const events: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  // The real coordinator, with its storage in memory.
  const self = Object.create(NotasSyncCoordinatorV1.prototype) as Record<string, unknown>;
  Object.assign(self, {
    env: {},
    meta: read,
    setMeta,
    files: () => [...files.values()],
    file: (id: string) => files.get(id) ?? null,
    saveFile: (file: SyncFileV1) => files.set(file.id, file),
    linkFiles: () => [...links.values()],
    linkFile: (id: string) => links.get(id) ?? null,
    saveLinkFile: (file: LinkFileV1) => links.set(file.id, file),
    event: (kind: string, detail: Record<string, unknown> = {}) => events.push({ kind, detail }),
  });
  return { coordinator: self as unknown as CoordinatorV1, read, links, events };
}

beforeEach(() => {
  for (const mock of Object.values(graph)) mock.mockReset();
  graph.latest.mockResolvedValue('latest-cursor');
  graph.folder.mockResolvedValue([workbook('teacher', 't1', 'notas')]);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('a saved link source opens the 10 s poll (#1541, 2)', () => {
  it('a simulado that is not a source of grades opens it, like a teacher workbook', async () => {
    graph.delta.mockResolvedValue({ changes: [workbook('simulado', 's2')], deltaLink: 'next' });
    const { coordinator, read, links } = coordinatorV1();
    await coordinator.deltaCheck(now);
    expect(read('editPollUntil')).toBe(now + EDIT_POLL_MS);
    expect(links.get('banco')).toMatchObject({ state: 'pending', changed: ['simulado'] });
    expect(read('linkSourceHashes')).toMatchObject({ simulado: 's2' });
    expect(read('deltaLink')).toBe('next');

    graph.delta.mockResolvedValue({
      changes: [workbook('teacher', 't2', 'notas')],
      deltaLink: 'next',
    });
    const grades = coordinatorV1();
    await grades.coordinator.deltaCheck(now);
    expect(grades.read('editPollUntil')).toBe(now + EDIT_POLL_MS);
  });

  it('not for the refresh’s own write, the same content again or with the links off', async () => {
    // The Banco is itself a source of a report card: its own write is not a save of a person.
    const boletim = {
      ...banco({ sources: ['banco'], ownHash: null }),
      id: 'boletim',
      name: 'BOLETIM SINTETICO.xlsb',
    };
    graph.delta.mockResolvedValue({
      changes: [workbook('banco', 'b1', 'destinos'), workbook('simulado', 's1')],
      deltaLink: 'next',
    });
    const quiet = coordinatorV1({ links: [banco(), boletim] });
    await quiet.coordinator.deltaCheck(now);
    expect(quiet.read('editPollUntil')).toBeUndefined();
    expect(quiet.links.get('boletim')).toMatchObject({ state: 'idle' });
    expect(quiet.read('deltaLink')).toBe('next');

    graph.delta.mockResolvedValue({ changes: [workbook('simulado', 's2')], deltaLink: 'next' });
    const off = coordinatorV1({ linksEnabled: false });
    await off.coordinator.deltaCheck(now);
    expect(off.read('editPollUntil')).toBeUndefined();
  });
});

describe('Graph forgot the delta cursor (#1541, 3)', () => {
  it('asks for the link sources no source lists and refreshes what uses a changed one', async () => {
    graph.delta.mockRejectedValue(new DeltaResyncRequiredError());
    graph.item.mockResolvedValue(workbook('simulado', 's2'));
    const { coordinator, read, links, events } = coordinatorV1();
    await coordinator.deltaCheck(now);
    // The teacher workbook came in the listing of the grades' folder: only the simulado is asked.
    expect(graph.item).toHaveBeenCalledTimes(1);
    expect(graph.item).toHaveBeenCalledWith({}, 'drive', 'simulado');
    expect(links.get('banco')).toMatchObject({ state: 'pending', changed: ['simulado'] });
    expect(read('deltaLink')).toBe('latest-cursor');
    expect(read('linkSourcesCheck')).toBe(false);
    expect(events.map((event) => event.kind)).toEqual(['delta-resync', 'source-listing']);
  });

  it('nothing is refreshed when the source did not change, or with the links off', async () => {
    graph.delta.mockRejectedValue(new DeltaResyncRequiredError());
    graph.item.mockResolvedValue(workbook('simulado', 's1'));
    const unchanged = coordinatorV1();
    await unchanged.coordinator.deltaCheck(now);
    expect(unchanged.links.get('banco')).toMatchObject({ state: 'idle' });

    graph.item.mockClear();
    const off = coordinatorV1({ linksEnabled: false });
    await off.coordinator.deltaCheck(now);
    expect(graph.item).not.toHaveBeenCalled();
    expect(off.read('linkSourcesCheck')).toBe(false);
    expect(off.read('deltaLink')).toBe('latest-cursor');
  });

  it('a Graph error while asking does not stop the delta: the links only wait', async () => {
    graph.delta.mockRejectedValue(new DeltaResyncRequiredError());
    graph.item.mockRejectedValue(new GraphError(429, 'synthetic', 120));
    const { coordinator, read, links, events } = coordinatorV1();
    await expect(coordinator.deltaCheck(now)).resolves.toBeUndefined();
    expect(read('deltaLink')).toBe('latest-cursor');
    expect(read('deltaRequested')).toBe(false);
    expect(read('linkSourcesCheck')).toBe(false);
    expect(read('linksBackoffUntil')).toBe(now + 120_000);
    expect(events.at(-1)).toEqual({ kind: 'graph-error', detail: { status: 429, links: true } });
    expect(links.get('banco')).toMatchObject({ state: 'idle' });
  });

  it('a listing that fails keeps the check for the next listing', async () => {
    graph.delta.mockRejectedValue(new DeltaResyncRequiredError());
    graph.folder.mockRejectedValueOnce(new Error('synthetic network failure'));
    graph.item.mockResolvedValue(workbook('simulado', 's2'));
    const { coordinator, read, links } = coordinatorV1();
    await expect(coordinator.deltaCheck(now)).rejects.toThrow('synthetic network failure');
    expect(read('deltaLink')).toBeNull();
    expect(read('linkSourcesCheck')).toBe(true);
    expect(graph.item).not.toHaveBeenCalled();
    // The next look starts without a cursor: the listing and then the check.
    await coordinator.deltaCheck(now);
    expect(graph.item).toHaveBeenCalledWith({}, 'drive', 'simulado');
    expect(links.get('banco')).toMatchObject({ state: 'pending', changed: ['simulado'] });
    expect(read('linkSourcesCheck')).toBe(false);
  });

  it('a listing without a lost cursor (the panel switched it on) asks nothing', async () => {
    const { coordinator, read } = coordinatorV1({ deltaLink: null });
    await coordinator.deltaCheck(now);
    expect(graph.item).not.toHaveBeenCalled();
    expect(read('deltaLink')).toBe('latest-cursor');
  });
});
