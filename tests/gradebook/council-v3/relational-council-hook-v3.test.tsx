// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRelationalCouncilV3 } from '../../../src/features/gradebook/council/use-relational-council-v3';
import { requestRelationalCouncilV3 } from '../../../src/features/gradebook/council/relational-council-client-v3';
import { LiveRefreshScopeV1 } from '../../../src/shared/live-data/live-refresh-scope-v1';
import { notifyLiveChangeV1 } from '../../../src/shared/live-data/live-refresh-v1';
import { mockSecureJitterV1 } from '../../live-data/secure-jitter-fixture';

// The hook keeps the classes of each year while its module lives: every test reads a year of its own.
const shared = vi.hoisted(() => ({ year: 2100 as number | null }));
vi.mock('../../../src/platform/gradebook-year-context', () => ({
  useGradebookYear: () => ({ year: shared.year }),
}));
vi.mock('../../../src/features/gradebook/council/relational-council-client-v3');

type Answer = Awaited<ReturnType<typeof requestRelationalCouncilV3>>;
type Request = Parameters<typeof requestRelationalCouncilV3>[0];
const UNAVAILABLE: Answer = { contractVersion: 3, state: 'unavailable' };
const IDLE = { classes: false, workspace: false, command: false };
const LABELS: Record<number, string> = { 10: '6A', 11: '6B' };
const tally = (pending: number) => ({ approved: 0, rejected: 0, pending, forInformation: 0 });
let year = 2100;
/** The classes of the year, each with one student still to be deliberated on. */
const catalog = (...ids: number[]): Answer => ({
  contractVersion: 3,
  state: 'ready',
  operation: 'classes',
  year,
  classes: ids.map((id) => ({ id, label: LABELS[id]!, tally: tally(1) })),
});
/** The hook reads only the summary of a class: one student to deliberate on, still pending. */
const workspaceOf = (id: number, state: 'not-opened' | 'open' = 'not-opened') => ({
  context: { year },
  classGroup: { id, label: LABELS[id]! },
  session: { state },
  summary: {
    total: 1,
    decided: 0,
    pending: 1,
    approved: 0,
    rejected: 0,
    absence: 0,
    forInformation: 0,
  },
  students: [],
});
const read = (id: number): Answer => ({
  contractVersion: 3,
  state: 'ready',
  operation: 'workspace',
  workspace: workspaceOf(id),
});
/** An answer that only comes when the test gives it. */
function held() {
  let give!: (answer: Answer) => void;
  const answer = new Promise<Answer>((done) => {
    give = done;
  });
  return { answer, give };
}

let active = true;
const wrapper = ({ children }: { children: ReactNode }) => (
  <LiveRefreshScopeV1 active={active}>{children}</LiveRefreshScopeV1>
);
const send = vi.mocked(requestRelationalCouncilV3);
/** What the Conselho answers to each kind of request, until a test says otherwise. */
function answering(
  answers: Partial<Record<Request['operation'], (request: Request) => Answer | Promise<Answer>>>,
) {
  send.mockImplementation(async (request) => {
    const answer = answers[request.operation];
    if (!answer) throw new Error(`unexpected-council-request:${request.operation}`);
    return answer(request);
  });
}
const classId = (request: Request) => (request.operation === 'classes' ? 0 : request.classId);
const asked = () => send.mock.calls.map(([request]) => request.operation);
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const invalidate = async () => {
  await act(async () => {
    notifyLiveChangeV1('gradebook');
  });
  await advance(250);
};
/** Mounts the Conselho and waits for its classes. */
async function enter() {
  const hook = renderHook(() => useRelationalCouncilV3(), { wrapper });
  await act(async () => {});
  return hook;
}
type Hook = Awaited<ReturnType<typeof enter>>;
async function choose(hook: Hook, id: number | null) {
  await act(async () => {
    await hook.result.current.selectClass(id);
  });
}
/** The tab of the Conselho is left and shown again. */
async function comeBack(hook: Hook) {
  active = false;
  hook.rerender();
  active = true;
  hook.rerender();
  await act(async () => {});
}

beforeEach(() => {
  active = true;
  year += 1;
  shared.year = year;
  sessionStorage.clear();
  vi.useFakeTimers();
  vi.resetAllMocks();
  mockSecureJitterV1(0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('relational Council V3 hook: coming back to the tab', () => {
  it('reads the classes again quietly, and not more often than every 30 s', async () => {
    answering({ classes: () => catalog(10) });
    const hook = await enter();
    expect(asked()).toEqual(['classes']);
    // Back too soon after the reading: the classes on screen are still good.
    await advance(29_000);
    await comeBack(hook);
    expect(asked()).toEqual(['classes']);
    await advance(1_000);
    const again = held();
    answering({ classes: () => again.answer });
    await comeBack(hook);
    expect(send.mock.calls.map(([request]) => request)).toEqual([
      { contractVersion: 3, operation: 'classes', year },
      { contractVersion: 3, operation: 'classes', year },
    ]);
    // Nothing says it is reading, and the classes read before stay meanwhile.
    expect(hook.result.current.busy).toEqual(IDLE);
    expect(hook.result.current.classes.map((item) => item.id)).toEqual([10]);
    await act(async () => again.give(catalog(10, 11)));
    expect(hook.result.current.classes.map((item) => item.id)).toEqual([10, 11]);
    expect(hook.result.current.stale).toBe(false);
    expect(hook.result.current.failure).toBeNull();
    // The 30 s count again from the reading that just arrived.
    await advance(29_000);
    await comeBack(hook);
    expect(asked()).toEqual(['classes', 'classes']);
    await advance(1_000);
    await comeBack(hook);
    expect(asked()).toEqual(['classes', 'classes', 'classes']);
  });

  it('does not read again while the tab only stays hidden or stays shown', async () => {
    answering({ classes: () => catalog(10) });
    const hook = await enter();
    await advance(60_000);
    hook.rerender();
    active = false;
    hook.rerender();
    await advance(60_000);
    expect(asked()).toEqual(['classes']);
  });

  it('only marks the classes stale when that reading fails, and tries them first in the background', async () => {
    answering({ classes: () => catalog(10), workspace: () => read(10) });
    const hook = await enter();
    await choose(hook, 10);
    await advance(30_000);
    send.mockClear();
    answering({ classes: () => UNAVAILABLE, workspace: () => read(10) });
    await comeBack(hook);
    await advance(3_000);
    // No alert and no progress: the classes and the open class stay as they were, marked old.
    expect(hook.result.current.stale).toBe(true);
    expect(hook.result.current.failure).toBeNull();
    expect(hook.result.current.busy).toEqual(IDLE);
    expect(hook.result.current.classes.map((item) => item.id)).toEqual([10]);
    expect(hook.result.current.workspace).toEqual(workspaceOf(10));
    // While the list is old the background tries it first, and leaves the open class for later.
    expect(asked().length).toBeGreaterThan(0);
    expect(asked()).not.toContain('workspace');

    // Reading the open class again, on request, does not make the old list new.
    await act(async () => {
      await hook.result.current.retry();
    });
    expect(asked().at(-1)).toBe('workspace');
    expect(hook.result.current.workspace).toEqual(workspaceOf(10));
    expect(hook.result.current.stale).toBe(true);

    // Once the classes can be read, they are read before the open class, and only once.
    send.mockClear();
    answering({ classes: () => catalog(10, 11), workspace: () => read(10) });
    for (let cycle = 0; cycle < 4; cycle++) await advance(30_000);
    expect(asked().slice(0, 2)).toEqual(['classes', 'workspace']);
    expect(asked().length).toBeGreaterThan(2);
    expect(asked().filter((operation) => operation === 'classes')).toHaveLength(1);
    expect(hook.result.current.stale).toBe(false);
    expect(hook.result.current.classes.map((item) => item.id)).toEqual([10, 11]);
  });

  it('closes a class that left the list, and a late answer of its reading shows nothing', async () => {
    answering({ classes: () => catalog(10, 11), workspace: () => read(10) });
    const hook = await enter();
    await choose(hook, 10);
    await advance(30_000);
    // The class is being read again when the tab comes back and the classes no longer have it.
    const late = held();
    answering({ classes: () => catalog(11), workspace: () => late.answer });
    act(() => {
      void hook.result.current.retry();
    });
    await act(async () => {});
    expect(hook.result.current.busy.workspace).toBe(true);
    await comeBack(hook);
    expect(hook.result.current.classes.map((item) => item.id)).toEqual([11]);
    expect(hook.result.current.classId).toBeNull();
    expect(hook.result.current.workspace).toBeNull();
    await act(async () => late.give(read(10)));
    expect(hook.result.current.classId).toBeNull();
    expect(hook.result.current.workspace).toBeNull();
    expect(hook.result.current.busy).toEqual(IDLE);
    expect(hook.result.current.failure).toBeNull();
  });

  it('does not read the classes twice when the tab comes back during the first reading', async () => {
    const first = held();
    answering({ classes: () => first.answer });
    const hook = await enter();
    expect(hook.result.current.busy.classes).toBe(true);
    await comeBack(hook);
    expect(asked()).toEqual(['classes']);
    await act(async () => {
      first.give(catalog(10));
    });
    expect(hook.result.current.classes.map((item) => item.id)).toEqual([10]);
    expect(hook.result.current.busy).toEqual(IDLE);
  });

  it('drops the failure of the first reading once the classes are read on coming back', async () => {
    answering({ classes: () => UNAVAILABLE });
    const hook = await enter();
    expect(hook.result.current.failure).toBe('unavailable');
    answering({ classes: () => catalog(10) });
    await comeBack(hook);
    expect(hook.result.current.classes.map((item) => item.id)).toEqual([10]);
    expect(hook.result.current.failure).toBeNull();
    expect(hook.result.current.busy).toEqual(IDLE);
  });
});

describe('relational Council V3 hook: the open class', () => {
  it('clears the failure of its reading once a later reading of it succeeds', async () => {
    answering({ classes: () => catalog(10), workspace: () => UNAVAILABLE });
    const hook = await enter();
    await choose(hook, 10);
    expect(hook.result.current.failure).toBe('unavailable');
    expect(hook.result.current.workspace).toBeNull();
    expect(hook.result.current.classId).toBe(10);
    send.mockClear();
    answering({ workspace: () => read(10) });
    await invalidate();
    expect(asked()).toEqual(['workspace']);
    expect(hook.result.current.workspace).toEqual(workspaceOf(10));
    expect(hook.result.current.failure).toBeNull();
    expect(hook.result.current.stale).toBe(false);
  });

  it('leaves nothing in progress when the class is closed while it is being read', async () => {
    send.mockImplementation(async (request, signal) => {
      if (request.operation === 'classes') return catalog(10);
      // As the browser does: this reading ends only when it is cancelled.
      return new Promise<Answer>((_done, cancel) => {
        signal?.addEventListener('abort', () => cancel(new DOMException('Aborted', 'AbortError')));
      });
    });
    const hook = await enter();
    act(() => {
      void hook.result.current.selectClass(10);
    });
    await act(async () => {});
    expect(hook.result.current.classId).toBe(10);
    expect(hook.result.current.busy.workspace).toBe(true);
    await choose(hook, null);
    expect(hook.result.current.classId).toBeNull();
    expect(hook.result.current.workspace).toBeNull();
    expect(hook.result.current.busy).toEqual(IDLE);
    expect(hook.result.current.failure).toBeNull();
  });

  it('ignores the answer to opening its meeting once another class was chosen', async () => {
    const opening = held();
    answering({
      classes: () => catalog(10, 11),
      workspace: (request) => read(classId(request)),
      open: () => opening.answer,
    });
    const hook = await enter();
    await choose(hook, 10);
    let opened: Promise<boolean> | undefined;
    act(() => {
      opened = hook.result.current.openSession();
    });
    await act(async () => {});
    expect(hook.result.current.busy.command).toBe(true);
    await choose(hook, 11);
    expect(hook.result.current.workspace).toEqual(workspaceOf(11));
    // The meeting of the first class opens after the second one is on screen.
    await act(async () =>
      opening.give({
        contractVersion: 3,
        state: 'ready',
        operation: 'open',
        workspace: workspaceOf(10, 'open'),
      }),
    );
    expect(await opened).toBe(false);
    expect(hook.result.current.classId).toBe(11);
    expect(hook.result.current.workspace).toEqual(workspaceOf(11));
    expect(hook.result.current.failure).toBeNull();
    expect(hook.result.current.busy).toEqual(IDLE);
  });

  it('says nothing of a meeting that could not be opened once another class was chosen', async () => {
    answering({ classes: () => catalog(10, 11) });
    const hook = await enter();
    // Refused by the server the first time, lost on its way the second.
    for (const lost of [false, true]) {
      const opening = held();
      answering({
        workspace: (request) => read(classId(request)),
        open: () =>
          opening.answer.then((answer) => {
            if (lost) throw new Error('synthetic-network-failure');
            return answer;
          }),
      });
      await choose(hook, 10);
      let opened: Promise<boolean> | undefined;
      act(() => {
        opened = hook.result.current.openSession();
      });
      await act(async () => {});
      await choose(hook, 11);
      await act(async () => opening.give(UNAVAILABLE));
      expect(await opened).toBe(false);
      expect(hook.result.current.failure).toBeNull();
      expect(hook.result.current.workspace).toEqual(workspaceOf(11));
      expect(hook.result.current.busy).toEqual(IDLE);
    }
  });

  it('shows the failure of opening its meeting while the class is still the one on screen', async () => {
    answering({
      classes: () => catalog(10),
      workspace: () => read(10),
      open: () => ({ contractVersion: 3, state: 'scope-too-large' }),
    });
    const hook = await enter();
    await choose(hook, 10);
    let opened = true;
    await act(async () => {
      opened = await hook.result.current.openSession();
    });
    expect(opened).toBe(false);
    expect(hook.result.current.failure).toBe('scope-too-large');
    expect(hook.result.current.workspace).toEqual(workspaceOf(10));
    expect(hook.result.current.busy).toEqual(IDLE);
  });
});

describe('relational Council V3 hook: entering', () => {
  it('waits for nothing while there is no academic year', async () => {
    shared.year = null;
    const hook = await enter();
    expect(send).not.toHaveBeenCalled();
    expect(hook.result.current.busy).toEqual(IDLE);
    expect(hook.result.current.classes).toEqual([]);
    expect(hook.result.current.failure).toBeNull();
  });

  it('reads the remembered class even when React runs the entering effect twice', async () => {
    answering({ classes: () => catalog(10), workspace: () => read(10) });
    // The classes are already known from an earlier visit, and the tab remembers the open class.
    (await enter()).unmount();
    sessionStorage.setItem(
      'ecossistema-view-v1:gradebook-council-view',
      JSON.stringify({ year, classId: 10 }),
    );
    const hook = renderHook(() => useRelationalCouncilV3(), { wrapper, reactStrictMode: true });
    await act(async () => {});
    expect(hook.result.current.classId).toBe(10);
    expect(hook.result.current.workspace).toEqual(workspaceOf(10));
    expect(hook.result.current.busy).toEqual(IDLE);
    expect(hook.result.current.failure).toBeNull();
  });
});
