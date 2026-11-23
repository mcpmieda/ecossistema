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
/** A class of the Conselho: one with eligible students. `tally` is null when the class could not
 * be read, so it is shown rather than taken for a class with nobody. */
export type CouncilClassViewV3 = Omit<CouncilClass, 'tally'> & {
  readonly tally: RelationalCouncilTallyV3 | null;
};
const PAGE_SIZE = 100;

const eligibleV3 = (tally: RelationalCouncilTallyV3) =>
  tally.approved + tally.rejected + tally.pending;
/** Only the classes the Conselho has something to discuss in, plus the ones it could not read. */
const councilClassesV3 = (list: readonly CouncilClass[]): readonly CouncilClassViewV3[] =>
  list
    .map((item) => ({ ...item, tally: item.tally ?? null }))
    .filter((item) => item.tally === null || eligibleV3(item.tally) > 0);

/** The last classes read in each year, kept while the Centro stays open: coming back to the tab
 * shows them at once, and the reading that follows replaces them. */
const KNOWN_CLASSES_V3 = new Map<number, readonly CouncilClassViewV3[]>();

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
    if (year !== null) KNOWN_CLASSES_V3.delete(year);
    selectedClass.current = null;
    setClasses([]);
    setClassId(null);
    setWorkspace(null);
    setFailure('not-authorized');
    setBusy({ classes: false, workspace: false, command: false });
  }, [clearAuthorization, year]);

  /** A background read only marks the screen stale; a read the user asked for shows the failure. */
  function readFailed(background: boolean, state: RelationalCouncilFailureV3 | 'ready') {
    if (background) setStale(true);
    else setFailure(state === 'ready' ? 'unavailable' : state);
    return false;
  }
  /** The classes on screen, remembered for the next visit to the tab. */
  function showClasses(currentYear: number, list: readonly CouncilClassViewV3[]) {
    KNOWN_CLASSES_V3.set(currentYear, list);
    setClasses(list);
  }
  /** The open class leaves the screen with its workspace. */
  function closeClass() {
    selectedClass.current = null;
    setClassId(null);
    setWorkspace(null);
  }
  /** The class saved for this year reopens once, if nothing was chosen meanwhile and it is listed. */
  function restoreStoredClass(list: readonly CouncilClassViewV3[], currentYear: number) {
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
  /** What the open class just read is the newest count of that class. A class left with nobody
   * eligible (a corrected grade) is no longer a class of the Conselho. */
  function showWorkspace(currentYear: number, read: RelationalCouncilWorkspaceV3) {
    const tally = relationalCouncilTallyV3(read.summary);
    const known = KNOWN_CLASSES_V3.get(currentYear) ?? [];
    if (eligibleV3(tally) === 0) {
      showClasses(
        currentYear,
        known.filter((item) => item.id !== read.classGroup.id),
      );
      closeClass();
      return;
    }
    showClasses(
      currentYear,
      known.map((item) =>
        item.id === read.classGroup.id
          ? { ...item, sessionState: read.session.state, tally }
          : item,
      ),
    );
    setWorkspace(read);
  }

  /** The classes with eligible students. It costs a whole reading per class of the year, so it
   * is read on entering the tab; the classes read before stay on screen meanwhile. */
  const loadClasses = useCallback(async () => {
    if (year === null) return;
    classesController.current?.abort();
    const controller = new AbortController();
    classesController.current = controller;
    const known = KNOWN_CLASSES_V3.get(year);
    setClasses(known ?? []);
    // A class of another year does not stay open under this year's classes.
    if (!known?.some((item) => item.id === selectedClass.current)) closeClass();
    if (known) restoreStoredClass(known, year);
    setBusy((current) => ({ ...current, classes: true }));
    setFailure(null);
    try {
      const response = await requestRelationalCouncilV3(
        { contractVersion: 3, operation: 'classes', year, offset: 0, limit: PAGE_SIZE },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (response.state === 'not-authorized') {
        loseAccess();
        return;
      }
      if (response.state !== 'ready' || response.operation !== 'classes') {
        readFailed(known !== undefined, response.state);
        return;
      }
      const open = (KNOWN_CLASSES_V3.get(year) ?? []).find(
        (item) => item.id === selectedClass.current,
      );
      // The open class already has the count of its own, newer, reading.
      const list = councilClassesV3(response.classes).map((item) =>
        item.id === open?.id ? open : item,
      );
      showClasses(year, list);
      if (selectedClass.current !== null && !list.some((item) => item.id === selectedClass.current))
        closeClass();
      setStale(false);
      restoreStoredClass(list, year);
    } catch (error) {
      if (!abortedV3(error)) readFailed(known !== undefined, 'unavailable');
    } finally {
      if (!controller.signal.aborted) setBusy((current) => ({ ...current, classes: false }));
    }
  }, [year, loseAccess]);

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
        showWorkspace(year, response.workspace);
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
      workspaceController.current?.abort();
      sequence.current += 1;
    };
  }, [loadClasses]);

  // In the background only the open class is read again: the others cost a reading each.
  const refresh = useCallback(async () => {
    if (busy.command || failure === 'not-authorized') return;
    if (classId !== null && selectedClass.current === classId) return loadWorkspace(classId, true);
  }, [busy.command, classId, failure, loadWorkspace]);
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
      showWorkspace(year, response.workspace);
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
    /** Reads again what failed: the open class, or the classes when none is open. */
    retry: () => (classId === null ? loadClasses() : loadWorkspace(classId)),
    selectClass,
    openSession,
  };
}
