import { StrictMode } from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudentPortalAdminPage } from '../../../src/features/student-portal-admin/student-portal-admin-page';
import {
  authorizationAwareFetchV1,
  usePortalAdminIdentityV1,
} from '../../../src/features/student-portal-admin/shared/admin-identity-v1';
import {
  withStudentPortalModule,
  portalSectionFromHash,
} from '../../../src/platform/student-portal-module';
import { buildSearchItems } from '../../../src/platform/search-model';
import {
  PortalClientErrorV1,
  type PortalFetchV1,
} from '../../../src/features/student-portal/shared/transport-v1';
import type { PlatformSnapshotContract } from '../../../shared/platform-contract';
import type { AdminReadQueryV2 } from '../../../shared/student-portal-contracts/admin-read-v2';
import type { AdminQueryV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { operationsMockV1, opJsonV1 } from '../ui/overview/fixtures-v1';
import { setupOperationsDomV1 } from '../ui/overview/dom-v1';
import { emptyReconciliationReadV1 } from '../ui/accounts/fixtures-v1';

const identity = (write = true, key = 'synthetic-757-session') => ({
  authenticated: true,
  identityKey: key,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  capabilities: ['platform.settings.read', ...(write ? ['platform.settings.write'] : [])],
});
const originalAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
  setupOperationsDomV1();
  window.history.replaceState(null, '', '/#/painel-do-aluno');
});
afterEach(() => {
  cleanup();
  if (originalAnimations)
    Object.defineProperty(Element.prototype, 'getAnimations', originalAnimations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('waits for the actual server deadline across capped timers and a pending background refresh', async () => {
  vi.useFakeTimers();
  const deadline = Date.now() + 2147483647 + 1000;
  const fetcher = vi
    .fn<PortalFetchV1>()
    .mockResolvedValueOnce(opJsonV1({ ...identity(), expiresAt: new Date(deadline).toISOString() }))
    .mockImplementation(() => new Promise(() => {}));
  const hook = renderHook(() => usePortalAdminIdentityV1(fetcher));
  await act(async () => {});
  expect(hook.result.current.state.state).toBe('ready');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2147483647);
  });
  expect(hook.result.current.state.state).toBe('ready');
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(999);
  });
  expect(hook.result.current.state.state).toBe('ready');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(hook.result.current.state).toMatchObject({
    state: 'error',
    error: { state: 'unauthenticated' },
  });
});
it('inherits exact capabilities and rechecks a new identity after protected history is cleared', async () => {
  let current = identity();
  const fetcher = vi
    .fn<PortalFetchV1>()
    .mockImplementation(async () =>
      opJsonV1(current, 200, { 'Cache-Control': 'no-store, no-cache, must-revalidate, private' }),
    );
  const hook = renderHook(() => usePortalAdminIdentityV1(fetcher));
  await waitFor(() => expect(hook.result.current.state.state).toBe('ready'));
  void act(() => window.dispatchEvent(new Event('pagehide')));
  expect(hook.result.current.state.state).toBe('paused');
  current = identity(false, 'synthetic-new-757-session');
  await act(async () => {
    window.dispatchEvent(new Event('pageshow'));
  });
  await waitFor(() =>
    expect(hook.result.current.state).toMatchObject({
      state: 'ready',
      identity: { identityKey: current.identityKey, capabilities: ['platform.settings.read'] },
    }),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  });
});
it.each([401, 403, 503])('fails closed for an authoritative identity HTTP%s', async (status) => {
  const fetcher = vi.fn<PortalFetchV1>().mockResolvedValue(opJsonV1({}, status));
  const hook = renderHook(() => usePortalAdminIdentityV1(fetcher));
  await waitFor(() => expect(hook.result.current.state.state).toBe('error'));
});
it.each([401, 403, 503, 'network', 'expired'] as const)(
  'only redirects to institutional login for confirmed authentication loss: %s',
  async (result) => {
    const onLogin = vi.fn();
    const fetcher: PortalFetchV1 = async () => {
      if (result === 'network') throw new TypeError('Synthetic network failure');
      return result === 'expired'
        ? opJsonV1({ ...identity(), expiresAt: new Date(Date.now() - 1000).toISOString() })
        : opJsonV1({}, result);
    };
    render(<StudentPortalAdminPage fetcher={fetcher} onLogin={onLogin} />);
    if (result === 401 || result === 'expired') {
      await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('status').textContent).toContain('Abrindo entrada institucional');
      expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    } else {
      expect(await screen.findByText('Acesso administrativo indisponível')).toBeTruthy();
      expect(onLogin).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
    }
  },
);
it('rejects missing capability, expired identity and cached identity without exposing a workspace', async () => {
  const cases = [
    opJsonV1({ ...identity(), capabilities: [] }),
    opJsonV1({ ...identity(), expiresAt: new Date(Date.now() - 1000).toISOString() }),
    new Response(JSON.stringify(identity()), { headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const response of cases) {
    const fetcher: PortalFetchV1 = async () => response;
    const hook = renderHook(() => usePortalAdminIdentityV1(fetcher));
    await waitFor(() => expect(hook.result.current.state.state).toBe('error'));
    hook.unmount();
  }
});
it('ignores a late identity response from a prior generation and observes both authorization statuses', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi
    .fn<PortalFetchV1>()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue(opJsonV1(identity(false, 'new')));
  const hook = renderHook(() => usePortalAdminIdentityV1(fetcher));
  await act(async () => {
    await hook.result.current.refresh();
  });
  await act(async () => {
    resolve(opJsonV1(identity(true, 'old')));
  });
  expect(hook.result.current.state).toMatchObject({
    state: 'ready',
    identity: { identityKey: 'new' },
  });
  const lost = vi.fn();
  for (const status of [401, 403]) {
    const send = authorizationAwareFetchV1(lost, async () => opJsonV1({}, status));
    await send('/api/student-portal/admin/query', {});
  }
  expect(lost.mock.calls.map(([error]) => (error as PortalClientErrorV1).state)).toEqual([
    'unauthenticated',
    'forbidden',
  ]);
  const controller = new AbortController();
  controller.abort();
  await authorizationAwareFetchV1(lost, async () => opJsonV1({}, 401))(
    '/api/student-portal/admin/query',
    { signal: controller.signal },
  );
  expect(lost).toHaveBeenCalledTimes(2);
});
it('mounts actual operational modules, keeps 2026 independent of the BN hash and clears all names on 403', async () => {
  const mock = operationsMockV1();
  let denied = false;
  const calls: string[] = [];
  const fetcher: PortalFetchV1 = async (path, init) => {
    calls.push(path);
    if (path === '/api/me') return opJsonV1(identity(false));
    if (denied) return opJsonV1({ contractVersion: 1, state: 'forbidden' }, 403);
    const input = JSON.parse(String(init.body));
    if (path === '/api/student-reconciliation/v1')
      return opJsonV1(emptyReconciliationReadV1(input.operation));
    return opJsonV1(
      input.contractVersion === 2
        ? await mock.reader.query(input as AdminReadQueryV2, init.signal ?? undefined)
        : await mock.client.query(input as AdminQueryV1, init.signal ?? undefined),
    );
  };
  window.history.replaceState(null, '', '/#/painel-do-aluno?year=2025');
  render(
    <StrictMode>
      <StudentPortalAdminPage fetcher={fetcher} />
    </StrictMode>,
  );
  expect(await screen.findByText('Somente leitura')).toBeTruthy();
  expect(await screen.findByText('Operando normalmente')).toBeTruthy();
  await userEvent.setup().click(screen.getByRole('tab', { name: 'Alunos' }));
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Acessos e QR' }));
  expect(await screen.findByText('SYNTHETIC OP STUDENT 1')).toBeTruthy();
  expect(mock.queries.every((query) => query.scope.academicYear === 2026)).toBe(true);
  expect(mock.writes).toHaveLength(0);
  denied = true;
  await userEvent.setup().click(screen.getByRole('tab', { name: 'Sessões' }));
  expect(await screen.findByText('Acesso administrativo indisponível')).toBeTruthy();
  expect(screen.queryByText('SYNTHETIC OP STUDENT 1')).toBeNull();
  expect(screen.queryByRole('navigation', { name: 'Áreas do Painel do Aluno' })).toBeNull();
  expect(
    calls.every((path) =>
      ['/api/me', '/api/student-portal/admin/query', '/api/student-reconciliation/v1'].includes(path),
    ),
  ).toBe(true);
});
it('registers one permission-filtered module and searches its sections without changing existing navigation', () => {
  const modules = withStudentPortalModule([], ['platform.settings.read']);
  expect(withStudentPortalModule(modules, ['platform.settings.read'])).toHaveLength(1);
  expect(withStudentPortalModule(modules, [])).toHaveLength(0);
  const snapshot = {
    coreModules: modules,
    registeredModules: [],
    configurations: [],
  } as unknown as PlatformSnapshotContract;
  expect(
    buildSearchItems(snapshot).filter((item) => item.id.startsWith('student-portal:')),
  ).toHaveLength(7);
  expect(
    buildSearchItems({ ...snapshot, coreModules: [] }).some((item) =>
      item.id.startsWith('student-portal:'),
    ),
  ).toBe(false);
  expect(portalSectionFromHash('#/painel-do-aluno?area=audit&year=2025')).toBe('audit');
  expect(portalSectionFromHash('#/painel-do-aluno?area=invalid')).toBe('overview');
});

it('shares the last class tab across panel areas and resets it for another identity', async () => {
  const mock = operationsMockV1();
  let key = 'synthetic-class-819';
  const fetcher: PortalFetchV1 = async (path, init) => {
    if (path === '/api/me') return opJsonV1(identity(false, key));
    const input = JSON.parse(String(init.body));
    if (path === '/api/student-reconciliation/v1')
      return opJsonV1(emptyReconciliationReadV1(input.operation));
    return opJsonV1(
      input.contractVersion === 2 ? await mock.reader.query(input) : await mock.client.query(input),
    );
  };
  const catalogResponse = {
    contractVersion: 2,
    state: 'ready',
    operation: 'search',
    context: { year: 2026, minimumApprovalMilli: 60000, maxCouncilComponents: 2 },
    items: [
      {
        entity: { kind: 'class-group', id: 756001, label: 'SYNTHETIC OP CLASS' },
        description: null,
      },
    ],
    nextOffset: null,
  };
  // The class catalog is the existing Gradebook HTTP boundary, separate from the Portal client.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => opJsonV1(catalogResponse)),
  );
  window.history.replaceState(null, '', '/#/painel-do-aluno?area=accounts');
  render(<StudentPortalAdminPage fetcher={fetcher} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Acessos e QR' }));
  await user.click(await screen.findByRole('tab', { name: 'SYNTHETIC OP CLASS' }));
  await screen.findByText('SYNTHETIC OP STUDENT 1');
  expect(
    screen.getByRole('tab', { name: 'SYNTHETIC OP CLASS' }).getAttribute('aria-selected'),
  ).toBe('true');
  await user.click(screen.getByRole('tab', { name: 'Sessões' }));
  await screen.findByRole('grid', { name: 'Sessões ativas' });
  // Sessions are read for the whole school; the class chosen elsewhere is kept for the return.
  expect(mock.queries.filter((q) => q.operation === 'sessions-read').at(-1)?.scope).toEqual({
    kind: 'school',
    academicYear: 2026,
  });
  await user.click(screen.getByRole('tab', { name: 'Alunos' }));
  expect(
    screen.getByRole('tab', { name: 'SYNTHETIC OP CLASS' }).getAttribute('aria-selected'),
  ).toBe('true');
  key = 'synthetic-other-819';
  await act(async () => window.dispatchEvent(new Event('focus')));
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Todas as turmas' }).getAttribute('aria-selected')).toBe(
      'true',
    ),
  );
});
