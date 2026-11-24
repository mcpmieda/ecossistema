import { useCallback, useEffect, useRef, useState } from 'react';
import {
  relationalCouncilTallyV3,
  type RelationalCouncilFailureV3,
  type RelationalCouncilResponseV3,
  type RelationalCouncilTallyV3,
  type RelationalCouncilWorkspaceV3,
} from '../../../../shared/gradebook-contracts/council/relational-council-v3';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import { useLiveRefreshScopeV1 } from '../../../shared/live-data/live-refresh-scope-v1';
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
/** Coming back to the tab reads the classes again, but not more often than this: the reading
 * costs one whole reading per class of the year. */
const READ_AGAIN_MS_V3 = 30_000;

type CouncilClass = Extract<
  RelationalCouncilResponseV3,
  { state: 'ready'; operation: 'classes' }
>['classes'][number];
/** A class of the Conselho: one with somebody to deliberate on or to take notice of. `tally` is
 * null when the class could not be read, so it is shown rather than taken for a class with
 * nobody. */
export type CouncilClassViewV3 = Omit<CouncilClass, 'tally'> & {
  readonly tally: RelationalCouncilTallyV3 | null;
};

/** The students the class brings to the Conselho: the ones it deliberates on and the ones it
 * only takes notice of. */
const listedV3 = (tally: RelationalCouncilTallyV3) =>
  tally.approved + tally.rejected + tally.pending + tally.forInformation;
/** Only the classes the Conselho has somebody to see in, plus the ones it could not read. */
const councilClassesV3 = (list: readonly CouncilClass[]): readonly CouncilClassViewV3[] =>
  list
    .map((item) => ({ ...item, tally: item.tally ?? null }))
    .filter((item) => item.tally === null || listedV3(item.tally) > 0);

/** The last classes read in each year, kept while the Centro stays open: the Conselho shows them
 * at once when it is opened again, and the reading that follows replaces them. */
const KNOWN_CLASSES_V3 = new Map<number, readonly CouncilClassViewV3[]>();

const abortedV3 = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function useRelationalCouncilV3() {
  const sharedYear = useGradebookYear();
  const year = sharedYear?.year ?? null;
  const clearAuthorization = sharedYear?.clearAuthorization;
  const active = useLiveRefreshScopeV1();
  const [classes, setClasses] = useState<readonly CouncilClassViewV3[]>([]);
  const [classId, setClassId] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState<RelationalCouncilWorkspaceV3 | null>(null);
  const [failure, setFailure] = useState<RelationalCouncilFailureV3 | null>(null);
  // Each reading has its own stale mark: a class read again does not hide an old list.
  const [classesStale, setClassesStale] = useState(false);
  const [workspaceStale, setWorkspaceStale] = useState(false);
  const [busy, setBusy] = useState({ classes: true, workspace: false, command: false });
  const classesController = useRef<AbortController | null>(null);
  const workspaceController = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const selectedClass = useRef<number | null>(null);
  /** The class whose workspace is on screen, and whether one is being read. */
  const loadedClass = useRef<number | null>(null);
  const workspaceReading = useRef(false);
  const classesReadAt = useRef(0);
  /** Whether the classes are being read, and whether the failure on screen is of their reading. */
  const classesReading = useRef(false);
  const classesFailed = useRef(false);
  const wasActive = useRef(active);
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
    loadedClass.current = null;
    setClasses([]);
    setClassId(null);
    setWorkspace(null);
    setFailure('not-authorized');
    setBusy({ classes: false, workspace: false, command: false });
  }, [clearAuthorization, year]);

  /** The classes on screen, remembered for the next visit to the tab. */
  function showClasses(currentYear: number, list: readonly CouncilClassViewV3[]) {
    KNOWN_CLASSES_V3.set(currentYear, list);
    setClasses(list);
  }
  /** The open class leaves the screen with its workspace, and so does a reading of it under way. */
  function closeClass() {
    workspaceController.current?.abort();
    sequence.current += 1;
    selectedClass.current = null;
    loadedClass.current = null;
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
  /** A class chosen whose reading was cut short (the tab left and came back) is read again. */
  function resumeOpenClass(list: readonly CouncilClassViewV3[]) {
    const open = selectedClass.current;
    if (
      open !== null &&
      loadedClass.current !== open &&
      !workspaceReading.current &&
      list.some((item) => item.id === open)
    )
      void loadWorkspace(open);
  }

  /** What the open class just read is the newest count of that class. A class left with nobody
   * for the Conselho (a corrected grade) is no longer one of its classes. */
  function showWorkspace(currentYear: number, read: RelationalCouncilWorkspaceV3) {
    const tally = relationalCouncilTallyV3(read.summary);
    const known = KNOWN_CLASSES_V3.get(currentYear) ?? [];
    if (listedV3(tally) === 0) {
      showClasses(
        currentYear,
        known.filter((item) => item.id !== read.classGroup.id),
      );
      closeClass();
      return;
    }
    showClasses(
      currentYear,
      known.map((item) => (item.id === read.classGroup.id ? { ...item, tally } : item)),
    );
    loadedClass.current = read.classGroup.id;
    setWorkspace(read);
  }

  /** The classes of the Conselho. It costs a whole reading per class of the year, so it is read
   * on entering the tab and on coming back to it; the classes read before stay on screen
   * meanwhile. A quiet reading (coming back, or trying an old list again) shows no progress and
   * only marks the list stale when it fails. */
  const loadClasses = useCallback(
    async (quiet = false) => {
      if (year === null) {
        // Without a year there is nothing to read, and nothing to wait for.
        setBusy((current) => ({ ...current, classes: false }));
        return;
      }
      classesController.current?.abort();
      const controller = new AbortController();
      classesController.current = controller;
      classesReading.current = true;
      const known = KNOWN_CLASSES_V3.get(year);
      if (!quiet) {
        setClasses(known ?? []);
        // A class of another year does not stay open under this year's classes.
        if (!known?.some((item) => item.id === selectedClass.current)) closeClass();
        if (known) restoreStoredClass(known, year);
        setBusy((current) => ({ ...current, classes: true }));
        classesFailed.current = false;
        setFailure(null);
      }
      /** With classes on screen a failed reading only marks them stale. */
      const failed = (state: RelationalCouncilFailureV3) => {
        if (quiet || known !== undefined) setClassesStale(true);
        else {
          classesFailed.current = true;
          setFailure(state);
        }
        return false;
      };
      try {
        const response = await requestRelationalCouncilV3(
          { contractVersion: 3, operation: 'classes', year },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (response.state === 'not-authorized') {
          loseAccess();
          return false;
        }
        if (response.state !== 'ready') return failed(response.state);
        if (response.operation !== 'classes') return failed('unavailable');
        const open = (KNOWN_CLASSES_V3.get(year) ?? []).find(
          (item) => item.id === loadedClass.current,
        );
        // The open class already has the count of its own, newer, reading.
        const list = councilClassesV3(response.classes).map((item) =>
          item.id === open?.id ? open : item,
        );
        showClasses(year, list);
        if (
          selectedClass.current !== null &&
          !list.some((item) => item.id === selectedClass.current)
        )
          closeClass();
        setClassesStale(false);
        // The classes are on screen: an earlier failure of their reading is no longer true.
        if (classesFailed.current) {
          classesFailed.current = false;
          setFailure(null);
        }
        classesReadAt.current = Date.now();
        restoreStoredClass(list, year);
        resumeOpenClass(list);
        return true;
      } catch (error) {
        if (!abortedV3(error)) return failed('unavailable');
      } finally {
        // A reading cut short by another leaves the progress to the one in its place.
        if (classesController.current === controller) {
          classesReading.current = false;
          setBusy((current) => (current.classes ? { ...current, classes: false } : current));
        }
      }
    },
    [year, loseAccess],
  );

  const loadWorkspace = useCallback(
    async (target: number, background = false) => {
      if (year === null) return;
      workspaceController.current?.abort();
      const controller = new AbortController();
      workspaceController.current = controller;
      const ticket = ++sequence.current;
      workspaceReading.current = true;
      if (!background) {
        setBusy((current) => ({ ...current, workspace: true }));
        setFailure(null);
      }
      /** A background read only marks the class stale; one the user asked for shows the failure. */
      const failed = (state: RelationalCouncilFailureV3) => {
        if (background) setWorkspaceStale(true);
        else setFailure(state);
        return false;
      };
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
          if (!background) {
            loadedClass.current = null;
            setWorkspace(null);
          }
          return failed(response.state === 'ready' ? 'unavailable' : response.state);
        }
        showWorkspace(year, response.workspace);
        setWorkspaceStale(false);
        // The class is on screen again: an earlier failure of its reading is no longer true.
        setFailure(null);
        return true;
      } catch (error) {
        if (!abortedV3(error) && ticket === sequence.current) return failed('unavailable');
      } finally {
        // A read cut short with no other in its place leaves nothing in progress.
        if (workspaceController.current === controller) {
          workspaceReading.current = false;
          setBusy((current) => (current.workspace ? { ...current, workspace: false } : current));
        }
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

  // The tabs of the Banco stay mounted while hidden: coming back to the Conselho reads the
  // classes again, since a grade imported meanwhile changes who is listed.
  useEffect(() => {
    const returned = active && !wasActive.current;
    wasActive.current = active;
    if (
      returned &&
      !classesReading.current &&
      Date.now() - classesReadAt.current >= READ_AGAIN_MS_V3
    )
      void loadClasses(true);
  }, [active, loadClasses]);

  // In the background only the open class is read again, and a list that failed to read: the
  // other classes cost a reading each.
  const refresh = useCallback(async () => {
    if (busy.command || failure === 'not-authorized') return;
    if (classesStale && (await loadClasses(true)) !== true) return false;
    if (classId !== null && selectedClass.current === classId) return loadWorkspace(classId, true);
  }, [busy.command, classId, classesStale, failure, loadClasses, loadWorkspace]);
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
    loadedClass.current = null;
    setClassId(next);
    setWorkspace(null);
    setFailure(null);
    if (year !== null) writeSessionViewV1(VIEW_KEY_V3, { year, classId: next });
    if (next !== null) await loadWorkspace(next);
  }

  /** Opens the meeting of the class on screen. True once the class shows it open. */
  async function openSession() {
    if (!workspace || classId === null || year === null || busy.command) return false;
    const target = classId;
    workspaceController.current?.abort();
    sequence.current += 1;
    setBusy((current) => ({ ...current, command: true }));
    setFailure(null);
    try {
      const response = await requestRelationalCouncilV3({
        contractVersion: 3,
        operation: 'open',
        year,
        classId: target,
      });
      if (response.state === 'not-authorized') {
        loseAccess();
        return false;
      }
      // Another class was chosen meanwhile: its screen is not this answer's.
      if (selectedClass.current !== target) return false;
      if (response.state !== 'ready' || response.operation === 'classes') {
        setFailure(response.state === 'ready' ? 'unavailable' : response.state);
        return false;
      }
      showWorkspace(year, response.workspace);
      return true;
    } catch {
      if (selectedClass.current === target) setFailure('unavailable');
      return false;
    } finally {
      setBusy((current) => ({ ...current, command: false }));
    }
  }

  return {
    classes,
    classId,
    workspace,
    failure,
    stale: classesStale || workspaceStale,
    busy,
    /** Reads again what failed: the open class, or the classes when none is open. */
    retry: () => (classId === null ? loadClasses() : loadWorkspace(classId)),
    selectClass,
    openSession,
  };
}
