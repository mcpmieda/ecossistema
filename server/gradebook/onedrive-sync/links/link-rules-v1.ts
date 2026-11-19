import type { LinkRefreshOutcomeV1, LinkRefreshResultV1 } from './run-link-refresh-v1';

/**
 * State of the link refresh, kept by the coordinator: which workbooks hold links, which sources
 * they use, and when each is refreshed again. Pure functions; the coordinator stores the records.
 */
export type LinkTargetV1 = {
  readonly itemId: string;
  readonly kind: 'folder' | 'file';
  readonly path: string;
  readonly setBy: string;
  readonly setAt: number;
};

export type LinkSettingsV1 = {
  readonly enabled: boolean;
  readonly targets: Readonly<Record<string, LinkTargetV1>>;
};

export const DEFAULT_LINK_SETTINGS_V1: LinkSettingsV1 = { enabled: false, targets: {} };

export type LinkFileV1 = {
  readonly id: string;
  readonly name: string;
  /** The folder or file chosen in the panel that brought this workbook in. */
  readonly targetId: string;
  readonly state: 'idle' | 'pending' | 'working';
  readonly dueAt: number | null;
  /** When the wait started: saves that keep coming do not push the refresh past a limit. */
  readonly pendingSince?: number | null;
  /** Sources that changed since the last refresh; null refreshes every link. */
  readonly changed: readonly string[] | null;
  /** Sources that changed while a refresh was running ('all': every link): the next refresh. */
  readonly changedWhileWorking?: readonly string[] | 'all';
  readonly sources: readonly string[];
  readonly lease: string | null;
  readonly leaseUntil: number | null;
  /** Consecutive waits (open file) or failures, for the back-off. */
  readonly attempts: number;
  readonly removed: boolean;
  readonly hash: string | null;
  readonly modifiedAt: string | null;
  /** The hash of the version the refresh itself wrote (its own save, not a person's). */
  readonly ownHash: string | null;
  readonly lastOutcome: LinkRefreshOutcomeV1 | null;
  readonly lastCode: string | null;
  readonly lastCheckedAt: number | null;
  readonly lastWrittenAt: number | null;
  readonly changedCells: number | null;
  readonly unavailableLinks: number | null;
};

/** A source saved: its dependants wait this long for more saves of the same burst. */
export const LINK_SOURCE_SETTLE_MS_V1 = 60_000;
/** Saves of many sources (the Banco depends on every teacher) delay a refresh at most this long. */
export const LINK_MAX_DEFER_MS_V1 = 5 * 60_000;
/** The workbook to write must be unchanged this long (Excel for the web saves in bursts). */
export const LINK_DESTINATION_SETTLE_MS_V1 = 60_000;
export const LINK_PARALLEL_V1 = 2;
export const LINK_LEASE_MS_V1 = 4 * 60_000;
/** Open file: tried again after 2, 4, 8 and then every 15 minutes. */
const LOCKED_BACKOFF_MS_V1 = [2, 4, 8, 15].map((minutes) => minutes * 60_000);
const FAILED_BACKOFF_MS_V1 = [5, 15, 60].map((minutes) => minutes * 60_000);
/** After this many failures in a row the workbook waits for the next change or the nightly check. */
const MAX_FAILURES_V1 = 4;

const backoffV1 = (steps: readonly number[], attempts: number) =>
  steps[Math.min(attempts, steps.length - 1)]!;

export function newLinkFileV1(
  item: { id: string; name: string; hash: string | null; modifiedAt: string | null },
  targetId: string,
  now: number,
): LinkFileV1 {
  return {
    id: item.id,
    name: item.name,
    targetId,
    state: 'pending',
    dueAt: now,
    changed: null,
    sources: [],
    lease: null,
    leaseUntil: null,
    attempts: 0,
    removed: false,
    hash: item.hash,
    modifiedAt: item.modifiedAt,
    ownHash: null,
    lastOutcome: null,
    lastCode: null,
    lastCheckedAt: null,
    lastWrittenAt: null,
    changedCells: null,
    unavailableLinks: null,
  };
}

/** Graph ids, once each, in a stable order. */
function unionIdsV1(...lists: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(lists.flat())].sort((a, b) => a.localeCompare(b));
}

function mergeChangedV1(
  current: readonly string[] | null | undefined,
  more: readonly string[] | null,
): readonly string[] | null {
  if (current === null || more === null) return null;
  return unionIdsV1(current ?? [], more);
}

/**
 * Every workbook whose links use `sourceIds` (or every one, for null) is refreshed after the
 * settle. A workbook waiting because it is open keeps its wait: another save of a source only adds
 * to what it will refresh. `force` (asked in the panel, the nightly check) goes now regardless.
 */
export function requestLinkRefreshV1(
  file: LinkFileV1,
  sourceIds: readonly string[] | null,
  now: number,
  settleMs: number,
  force = false,
): LinkFileV1 {
  if (file.removed) return file;
  if (file.state === 'working') {
    const waiting = file.changedWhileWorking;
    return {
      ...file,
      changedWhileWorking:
        sourceIds === null || waiting === 'all' ? 'all' : unionIdsV1(waiting ?? [], sourceIds),
    };
  }
  const pending = file.state === 'pending';
  const changed = pending ? mergeChangedV1(file.changed, sourceIds) : sourceIds;
  if (!force && pending && file.lastOutcome === 'locked' && file.attempts > 0)
    return { ...file, changed };
  const since = pending ? (file.pendingSince ?? now) : now;
  return {
    ...file,
    state: 'pending',
    changed,
    dueAt: Math.min(now + settleMs, since + LINK_MAX_DEFER_MS_V1),
    pendingSince: since,
    attempts: 0,
  };
}

export function linkFilesToStartV1(
  files: readonly LinkFileV1[],
  now: number,
  enabled: boolean,
  max = LINK_PARALLEL_V1,
): LinkFileV1[] {
  if (!enabled) return [];
  const working = files.filter((file) => file.state === 'working').length;
  return files
    .filter((file) => !file.removed && file.state === 'pending' && (file.dueAt ?? 0) <= now)
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
    .slice(0, Math.max(0, max - working));
}

export function startLinkRefreshV1(file: LinkFileV1, lease: string, now: number): LinkFileV1 {
  return {
    ...file,
    state: 'working',
    lease,
    leaseUntil: now + LINK_LEASE_MS_V1,
    changedWhileWorking: undefined,
  };
}

export function expiredLinkLeasesV1(files: readonly LinkFileV1[], now: number): LinkFileV1[] {
  return files.filter(
    (file) => file.state === 'working' && file.leaseUntil !== null && file.leaseUntil <= now,
  );
}

/** Sources saved while the refresh ran: null is every link, undefined is nothing. */
function savedWhileWorkingV1(file: LinkFileV1): readonly string[] | null | undefined {
  const waiting = file.changedWhileWorking;
  if (waiting === 'all') return null;
  if (waiting && waiting.length > 0) return waiting;
  return undefined;
}

/** Outcomes that come from reading the links (the source list they report is complete). */
const READ_LINKS_V1: ReadonlySet<LinkRefreshOutcomeV1> = new Set([
  'unchanged',
  'written',
  'no-links',
  'locked',
  'changed-meanwhile',
]);

export function finishLinkRefreshV1(
  file: LinkFileV1,
  lease: string,
  result: LinkRefreshResultV1,
  now: number,
): LinkFileV1 | null {
  if (file.state !== 'working' || file.lease !== lease) return null;
  const base: LinkFileV1 = {
    ...file,
    name: result.seen?.name ?? file.name,
    lease: null,
    leaseUntil: null,
    lastOutcome: result.outcome,
    lastCode: result.code,
    lastCheckedAt: now,
    sources: READ_LINKS_V1.has(result.outcome) ? result.sources : file.sources,
    unavailableLinks: READ_LINKS_V1.has(result.outcome)
      ? result.unavailableLinks
      : file.unavailableLinks,
    hash: result.written?.hash ?? result.seen?.hash ?? file.hash,
    modifiedAt: result.written?.modifiedAt ?? result.seen?.modifiedAt ?? file.modifiedAt,
    ownHash: result.outcome === 'written' ? (result.written?.hash ?? null) : file.ownHash,
    lastWrittenAt: result.outcome === 'written' ? now : file.lastWrittenAt,
    changedCells: result.outcome === 'written' ? result.changedCells : file.changedCells,
  };
  const waiting = savedWhileWorkingV1(file);
  const retry = (delay: number, attempts: number): LinkFileV1 => ({
    ...base,
    state: 'pending',
    dueAt: now + delay,
    pendingSince: now,
    changed: waiting === undefined ? file.changed : mergeChangedV1(file.changed, waiting),
    changedWhileWorking: undefined,
    attempts,
  });
  switch (result.outcome) {
    case 'locked':
      return retry(backoffV1(LOCKED_BACKOFF_MS_V1, file.attempts), file.attempts + 1);
    case 'changed-meanwhile':
    case 'settling':
      return retry(LINK_DESTINATION_SETTLE_MS_V1, file.attempts + 1);
    case 'failed':
      if (file.attempts + 1 < MAX_FAILURES_V1)
        return retry(backoffV1(FAILED_BACKOFF_MS_V1, file.attempts), file.attempts + 1);
      break;
    case 'gone':
      return {
        ...base,
        state: 'idle',
        dueAt: null,
        pendingSince: null,
        removed: true,
        changed: [],
        changedWhileWorking: undefined,
        attempts: 0,
      };
    default:
      break;
  }
  // Done (or given up until the next change): sources saved meanwhile start a new refresh.
  if (waiting !== undefined)
    return {
      ...base,
      state: 'pending',
      dueAt: now + LINK_SOURCE_SETTLE_MS_V1,
      pendingSince: now,
      changed: waiting,
      changedWhileWorking: undefined,
      attempts: 0,
    };
  return {
    ...base,
    state: 'idle',
    dueAt: null,
    pendingSince: null,
    changed: [],
    changedWhileWorking: undefined,
    attempts: result.outcome === 'failed' ? file.attempts + 1 : 0,
  };
}

/** A lease that ran out (the refresh died): tried again like a failure. */
export function expiredLinkResultV1(): LinkRefreshResultV1 {
  return {
    outcome: 'failed',
    code: 'LEASE-EXPIRED',
    sources: [],
    sourceHashes: {},
    unavailableLinks: 0,
    changedCells: 0,
    seen: null,
    written: null,
    ms: 0,
  };
}

/**
 * The list of workbooks with links, like the Planilhas list: the latest update first, by the date
 * the row shows (updated, otherwise checked); one never checked goes last, by name.
 */
export function linkFilesByRecentV1<
  T extends Pick<LinkFileV1, 'name' | 'lastWrittenAt' | 'lastCheckedAt'>,
>(files: readonly T[], compareNames: (left: string, right: string) => number): T[] {
  const shown = (file: T) => file.lastWrittenAt ?? file.lastCheckedAt ?? null;
  return [...files].sort((left, right) => {
    const a = shown(left);
    const b = shown(right);
    if (a !== b) {
      if (a === null) return 1;
      if (b === null) return -1;
      return b - a;
    }
    return compareNames(left.name, right.name);
  });
}

/**
 * A workbook OneDrive reports: a deleted one, or one moved out of the chosen folders, leaves the
 * list; a new one of a chosen folder joins it (its links are read at once); a renamed one keeps
 * its record. Null when nothing changes.
 */
export function observedLinkFileV1(
  current: LinkFileV1 | null,
  item: {
    readonly id: string;
    readonly name: string;
    readonly quickXorHash: string | null;
    readonly lastModifiedDateTime: string;
    readonly deleted: boolean;
  },
  target: LinkTargetV1 | null,
  now: number,
): LinkFileV1 | null {
  if (item.deleted || !target) {
    if (!current || current.removed) return null;
    return {
      ...current,
      removed: true,
      state: current.state === 'working' ? 'working' : 'idle',
      dueAt: null,
    };
  }
  if (!current || current.removed)
    return newLinkFileV1(
      {
        id: item.id,
        name: item.name,
        hash: item.quickXorHash,
        modifiedAt: item.lastModifiedDateTime,
      },
      target.itemId,
      now,
    );
  return current.name === item.name ? null : { ...current, name: item.name };
}

/**
 * When the coordinator must wake for links: a refresh due, or a running one whose lease ends. With
 * every slot taken, a due one waits for a lease (it could not start before).
 */
export function nextLinkWakeV1(
  files: readonly LinkFileV1[],
  max = LINK_PARALLEL_V1,
): number | null {
  const live = files.filter((file) => !file.removed);
  const leases = live
    .filter((file) => file.state === 'working' && file.leaseUntil !== null)
    .map((file) => file.leaseUntil!);
  const due = live
    .filter((file) => file.state === 'pending' && file.dueAt !== null)
    .map((file) => file.dueAt!);
  const working = live.filter((file) => file.state === 'working').length;
  const candidates = working >= max ? leases : [...leases, ...due];
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/** The chosen folder or file a workbook belongs to: itself, or its folder (direct children only). */
export function linkTargetOfV1(
  item: { id: string; parentId: string | null },
  targets: Readonly<Record<string, LinkTargetV1>>,
): LinkTargetV1 | null {
  const own = targets[item.id];
  if (own?.kind === 'file') return own;
  const folder = item.parentId === null ? undefined : targets[item.parentId];
  return folder?.kind === 'folder' ? folder : null;
}

/**
 * Which saved workbooks count as a change of a source: a new content hash, not the refresh's own
 * write and not the same content seen before (a rename or a share is not a change).
 */
export function changedSourcesV1(
  items: readonly { id: string; hash: string | null; deleted: boolean }[],
  known: Readonly<Record<string, string | null>>,
  ownHashes: ReadonlyMap<string, string | null>,
): { changed: string[]; seen: Record<string, string | null> } {
  const changed: string[] = [];
  const seen: Record<string, string | null> = {};
  for (const item of items) {
    if (item.deleted) continue;
    const own = ownHashes.get(item.id);
    seen[item.id] = item.hash;
    if (item.hash !== null && own === item.hash) continue;
    if (item.hash !== null && known[item.id] === item.hash) continue;
    changed.push(item.id);
  }
  return { changed, seen };
}
