import { useCallback, useEffect, useRef, useState } from 'react';
import {
  relationalCouncilTallyV3,
  type RelationalCouncilFailureV3,
  type RelationalCouncilRequestV3,
  type RelationalCouncilResponseV3,
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
import { allowDraftNavigationV1 } from '../../../shared/forms/draft-navigation-v1';

/** The class in session, kept for the tab across a reload. */
const VIEW_KEY_V3 = 'gradebook-council-view';

type CouncilClass = Extract<
  RelationalCouncilResponseV3,
  { state: 'ready'; operation: 'classes' }
>['classes'][number];
type Command = Exclude<RelationalCouncilRequestV3, { operation: 'classes' | 'workspace' }>;
type CommandInput = Command extends infer Value
  ? Value extends Command
    ? Omit<Value, 'contractVersion' | 'year' | 'classId' | 'expectedVersion' | 'idempotencyKey'>
    : never
  : never;
const PAGE_SIZE = 100;

const abortedV3 = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function useRelationalCouncilV3() {
  const sharedYear = useGradebookYear();
  const year = sharedYear?.year ?? null;
  const clearAuthorization = sharedYear?.clearAuthorization;
  const [classes, setClasses] = useState<readonly CouncilClass[]>([]);
  const [classId, setClassId] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState<RelationalCouncilWorkspaceV3 | null>(null);
  const [failure, setFailure] = useState<RelationalCouncilFailureV3 | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState({ classes: true, workspace: false, command: false });
  const classesController = useRef<AbortController | null>(null);
  const talliesController = useRef<AbortController | null>(null);
  const workspaceController = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const draftProtected = useRef(false);
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

  /** Where each class stands, read after the buttons are on screen: it costs a whole reading per
   * class. A failure only leaves the buttons without their counts. */
  const loadTallies = useCallback(async () => {
    if (year === null) return;
    talliesController.current?.abort();
    const controller = new AbortController();
    talliesController.current = controller;
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
      if (controller.signal.aborted || response.state !== 'ready') return;
      if (response.operation !== 'classes') return;
      const tallies = new Map(response.classes.map((item) => [item.id, item.tally]));
      setClasses((current) =>
        current.map((item) => {
          // The open class already has the count of its own, newer, reading.
          const tally = item.id === selectedClass.current ? item.tally : tallies.get(item.id);
          return tally ? { ...item, tally } : item;
        }),
      );
    } catch {
      // Nothing to show or to retry: the next reading brings them.
    }
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
        // This reading brings no tally: each class keeps the one it has.
        setClasses((current) =>
          response.classes.map((item) => {
            const known = current.find((old) => old.id === item.id)?.tally;
            return known ? { ...item, tally: known } : item;
          }),
        );
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
      if (year === null || (background && draftProtected.current)) return;
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
        if (background && draftProtected.current) return;
        setWorkspace(response.workspace);
        const tally = relationalCouncilTallyV3(response.workspace.summary);
        setClasses((current) =>
          current.map((item) => (item.id === target ? { ...item, tally } : item)),
        );
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
    if (busy.command || draftProtected.current || failure === 'not-authorized') return;
    const refreshed = await loadClasses(true);
    if (refreshed !== true) return refreshed;
    if (classId !== null && selectedClass.current === classId && !draftProtected.current)
      return loadWorkspace(classId, true);
    return refreshed;
  }, [busy.command, classId, failure, loadClasses, loadWorkspace]);
  useLiveRefreshV1(refresh, {
    domains: ['gradebook'],
    enabled: year !== null,
    canRefresh: () => !busy.classes && !busy.workspace && !busy.command && !draftProtected.current,
  });

  // The phone's back button returns to the class open before, unless a draft would be lost.
  const correctsView = useHistoryStepV1(
    `gradebook-council-class:${year ?? 0}`,
    { classId },
    (restored) => {
      if (restored.classId === classId) return;
      // A deliberation being typed stays, as it does when another class is tapped.
      if (draftProtected.current || !allowDraftNavigationV1()) return false;
      void selectClass(restored.classId);
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

  async function command(request: CommandInput) {
    if (!workspace || classId === null || year === null || busy.command) return null;
    workspaceController.current?.abort();
    sequence.current += 1;
    const operation = request.operation;
    const commandRequest = {
      ...request,
      contractVersion: 3,
      year,
      classId,
      expectedVersion: workspace.session.version,
      idempotencyKey: `${operation}:${crypto.randomUUID()}`,
    } as Command;
    setBusy((current) => ({ ...current, command: true }));
    setFailure(null);
    try {
      const response = await requestRelationalCouncilV3(commandRequest);
      if (response.state === 'not-authorized') {
        loseAccess();
        return response;
      }
      if (response.state !== 'ready' || response.operation === 'classes') {
        const refused = response.state === 'ready' ? 'unavailable' : response.state;
        const reread =
          refused === 'version-conflict' ||
          refused === 'review-conflict' ||
          refused === 'session-closed';
        // The reread clears the last failure, so the refusal is shown again once it succeeds;
        // a reread that failed keeps its own failure (a lost access among them).
        if (!reread || (await loadWorkspace(classId)) === true) setFailure(refused);
        return response;
      }
      setWorkspace(response.workspace);
      setClasses((current) =>
        current.map((item) =>
          item.id === classId
            ? {
                ...item,
                sessionState: response.workspace.session.state,
                sessionVersion: response.workspace.session.version,
                tally: relationalCouncilTallyV3(response.workspace.summary),
              }
            : item,
        ),
      );
      return response;
    } catch {
      setFailure('unavailable');
      return null;
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
    loadClasses,
    loadWorkspace,
    protectDrafts: (value: boolean) => {
      draftProtected.current = value;
    },
    selectClass,
    command,
  };
}
