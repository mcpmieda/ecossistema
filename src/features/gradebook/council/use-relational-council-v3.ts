import { useCallback, useEffect, useRef, useState } from 'react';
import {
  relationalCouncilTallyV3,
  type RelationalCouncilFailureV3,
  type RelationalCouncilResponseV3,
  type RelationalCouncilTallyV3,
  type RelationalCouncilWorkspaceV3,
} from '../../../../shared/gradebook-contracts/council/relational-council-v3';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import { useLiveRefreshV1 } from '../../../shared/live-data/use-live-refresh-v1';
import { requestRelationalCouncilV3 } from './relational-council-client-v3';
import {
  readSessionRecordV1,
  storedIdV1,
  writeSessionViewV1,
} from '../../../shared/ui/session-view-v1';
import { useHistoryStepV1 } from '../../../shared/ui/history-step-v1';

/** The class in session, kept for the tab across a reload. */
const VIEW_KEY_V3 = 'gradebook-council-view';

type CouncilClass = Extract<
  RelationalCouncilResponseV3,
  { state: 'ready'; operation: 'classes' }
>['classes'][number];
/** A class as its button shows it: `tally` is absent until read and null when its reading failed. */
export type CouncilClassViewV3 = Omit<CouncilClass, 'tally'> & {
  readonly tally?: RelationalCouncilTallyV3 | null;
};
type TalliesV3 = Map<number, RelationalCouncilTallyV3 | null>;
const PAGE_SIZE = 100;

/** The last counts read in each year, kept while the Centro stays open: coming back to the tab
 * shows them at once, and the reading that follows replaces them. */
const KNOWN_TALLIES_V3 = new Map<number, TalliesV3>();
function knownTalliesV3(year: number): TalliesV3 {
  const known = KNOWN_TALLIES_V3.get(year) ?? new Map();
  KNOWN_TALLIES_V3.set(year, known);
  return known;
}
function withTallyV3(item: CouncilClass | CouncilClassViewV3, known: TalliesV3) {
  const { tally: _tally, ...rest } = item;
  const tally = known.get(item.id);
  return tally === undefined ? rest : { ...rest, tally };
}

const abortedV3 = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function useRelationalCouncilV3() {
  const sharedYear = useGradebookYear();
  const year = sharedYear?.year ?? null;
  const clearAuthorization = sharedYear?.clearAuthorization;
  const [classes, setClasses] = useState<readonly CouncilClassViewV3[]>([]);
  const [classId, setClassId] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState<RelationalCouncilWorkspaceV3 | null>(null);
  const [failure, setFailure] = useState<RelationalCouncilFailureV3 | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState({ classes: true, workspace: false, command: false });
  const classesController = useRef<AbortController | null>(null);
  const talliesController = useRef<AbortController | null>(null);
  const workspaceController = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const selectedClass = useRef<number | null>(null);
  const [restoreClass] = useState(() => {
    const stored = readSessionRecordV1(VIEW_KEY_V3);
    return {
      current: stored
        ? { year: storedIdV1(stored.year), classId: storedIdV1(stored.classId) }
        : null,
    };
  });

  const loseAccess = useCallback(() => {
    clearAuthorization?.();
    selectedClass.current = null;
    setClasses([]);
    setClassId(null);
    setWorkspace(null);
    setFailure('not-authorized');
    setBusy({ classes: false, workspace: false, command: false });
  }, [clearAuthorization]);

  /** A background read only marks the screen stale; a read the user asked for shows the failure. */
  function readFailed(background: boolean, state: RelationalCouncilFailureV3 | 'ready') {
    if (background) setStale(true);
    else setFailure(state === 'ready' ? 'unavailable' : state);
    return false;
  }
  /** A selected class that left the list is dropped with its workspace. */
  function keepSelectedClass(list: readonly CouncilClass[]) {
    if (selectedClass.current !== null && !list.some((item) => item.id === selectedClass.current)) {
      selectedClass.current = null;
      setClassId(null);
      setWorkspace(null);
    }
  }
  /** The class saved for this year reopens once, if nothing was chosen meanwhile and it still exists. */
  function restoreStoredClass(list: readonly CouncilClass[], currentYear: number) {
    const stored = restoreClass.current;
    restoreClass.current = null;
    if (
      stored?.year === currentYear &&
      selectedClass.current === null &&
      list.some((item) => item.id === stored.classId)
    ) {
      correctsView();
      selectedClass.current = stored.classId;
      setClassId(stored.classId);
      void loadWorkspace(stored.classId!);
    }
  }

  /** A read the user asked for shows its progress and clears the last failure. */
  function beginWorkspaceRead(background: boolean) {
    if (!background) {
      setBusy((current) => ({ ...current, workspace: true }));
      setFailure(null);
    }
  }
  /** What the open class just read is the newest count of that class. */
  function rememberWorkspaceV3(currentYear: number, read: RelationalCouncilWorkspaceV3) {
    const known = knownTalliesV3(currentYear);
    known.set(read.classGroup.id, relationalCouncilTallyV3(read.summary));
    setWorkspace(read);
    setClasses((current) =>
      current.map((item) =>
        item.id === read.classGroup.id
          ? withTallyV3({ ...item, sessionState: read.session.state }, known)
          : item,
      ),
    );
  }

  /** Where each class stands, read after the buttons are on screen: it costs a whole reading per
   * class. A class that could not be read is marked so, never shown as a class with nobody. */
  const loadTallies = useCallback(async () => {
    if (year === null) return;
    talliesController.current?.abort();
    const controller = new AbortController();
    talliesController.current = controller;
    const known = knownTalliesV3(year);
    let read: readonly CouncilClass[] | null = null;
    try {
      const response = await requestRelationalCouncilV3(
        {
          contractVersion: 3,
          operation: 'classes',
          year,
          offset: 0,
          limit: PAGE_SIZE,
          tally: true,
        },
        controller.signal,
      );
      if (response.state === 'ready' && response.operation === 'classes') read = response.classes;
    } catch {
      // Counted below as a reading that did not come.
    }
    if (controller.signal.aborted) return;
    for (const item of read ?? []) {
      // The open class already has the count of its own, newer, reading.
      if (item.id === selectedClass.current && known.get(item.id)) continue;
      known.set(item.id, item.tally ?? null);
    }
    // A reading that did not come leaves the counts already known and marks the ones never read.
    setClasses((current) =>
      current.map((item) =>
        read || known.has(item.id) ? withTallyV3(item, known) : { ...item, tally: null },
      ),
    );
  }, [year]);

  const loadClasses = useCallback(
    async (background = false) => {
      if (year === null) return;
      classesController.current?.abort();
      const controller = new AbortController();
      classesController.current = controller;
      if (!background) {
        setBusy((current) => ({ ...current, classes: true }));
        setFailure(null);
      }
      try {
        const response = await requestRelationalCouncilV3(
          { contractVersion: 3, operation: 'classes', year, offset: 0, limit: PAGE_SIZE },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (response.state === 'not-authorized') {
          loseAccess();
          return false;
        }
        if (response.state !== 'ready' || response.operation !== 'classes')
          return readFailed(background, response.state);
        // This reading brings no count: each class shows the one already known.
        const known = knownTalliesV3(year);
        setClasses(response.classes.map((item) => withTallyV3(item, known)));
        keepSelectedClass(response.classes);
        setStale(false);
        restoreStoredClass(response.classes, year);
        if (!background) void loadTallies();
        return true;
      } catch (error) {
        if (!abortedV3(error)) return readFailed(background, 'unavailable');
      } finally {
        if (!background && !controller.signal.aborted)
          setBusy((current) => ({ ...current, classes: false }));
      }
    },
    [year, loseAccess, loadTallies],
  );

  const loadWorkspace = useCallback(
    async (target: number, background = false) => {
      if (year === null) return;
      workspaceController.current?.abort();
      const controller = new AbortController();
      workspaceController.current = controller;
      const ticket = ++sequence.current;
      beginWorkspaceRead(background);
      try {
        const response = await requestRelationalCouncilV3(
          { contractVersion: 3, operation: 'workspace', year, classId: target },
          controller.signal,
        );
        if (controller.signal.aborted || ticket !== sequence.current) return;
        if (response.state === 'not-authorized') {
          loseAccess();
          return false;
        }
        if (response.state !== 'ready' || response.operation === 'classes') {
          if (!background) setWorkspace(null);
          return readFailed(background, response.state);
        }
        rememberWorkspaceV3(year, response.workspace);
        setStale(false);
        return true;
      } catch (error) {
        if (!abortedV3(error) && ticket === sequence.current)
          return readFailed(background, 'unavailable');
      } finally {
        if (!background && !controller.signal.aborted && ticket === sequence.current)
          setBusy((current) => ({ ...current, workspace: false }));
      }
    },
    [year, loseAccess],
  );

  useEffect(() => {
    void loadClasses();
    return () => {
      classesController.current?.abort();
      talliesController.current?.abort();
      workspaceController.current?.abort();
      sequence.current += 1;
    };
  }, [loadClasses]);

  const refresh = useCallback(async () => {
    if (busy.command || failure === 'not-authorized') return;
    const refreshed = await loadClasses(true);
    if (refreshed !== true) return refreshed;
    if (classId !== null && selectedClass.current === classId) return loadWorkspace(classId, true);
    return refreshed;
  }, [busy.command, classId, failure, loadClasses, loadWorkspace]);
  useLiveRefreshV1(refresh, {
    domains: ['gradebook'],
    enabled: year !== null,
    canRefresh: () => !busy.classes && !busy.workspace && !busy.command,
  });

  // The phone's back button returns to the class open before.
  const correctsView = useHistoryStepV1(
    `gradebook-council-class:${year ?? 0}`,
    { classId },
    (restored) => {
      if (restored.classId !== classId) void selectClass(restored.classId);
    },
    (value) =>
      value !== null && typeof value === 'object' && 'classId' in value
        ? { classId: storedIdV1((value as { classId: unknown }).classId) }
        : null,
  );
  async function selectClass(next: number | null) {
    workspaceController.current?.abort();
    sequence.current += 1;
    selectedClass.current = next;
    setClassId(next);
    setWorkspace(null);
    setFailure(null);
    if (year !== null) writeSessionViewV1(VIEW_KEY_V3, { year, classId: next });
    if (next !== null) await loadWorkspace(next);
  }

  /** Opens the meeting of the class on screen. True once the class shows it open. */
  async function openSession() {
    if (!workspace || classId === null || year === null || busy.command) return false;
    workspaceController.current?.abort();
    sequence.current += 1;
    setBusy((current) => ({ ...current, workspace: false, command: true }));
    setFailure(null);
    try {
      const response = await requestRelationalCouncilV3({
        contractVersion: 3,
        operation: 'open',
        year,
        classId,
      });
      if (response.state === 'not-authorized') {
        loseAccess();
        return false;
      }
      if (response.state !== 'ready' || response.operation === 'classes') {
        setFailure(response.state === 'ready' ? 'unavailable' : response.state);
        return false;
      }
      rememberWorkspaceV3(year, response.workspace);
      return true;
    } catch {
      setFailure('unavailable');
      return false;
    } finally {
      setBusy((current) => ({ ...current, command: false }));
    }
  }

  return {
    year,
    classes,
    classId,
    workspace,
    failure,
    stale,
    busy,
    loadWorkspace,
    selectClass,
    openSession,
  };
}
