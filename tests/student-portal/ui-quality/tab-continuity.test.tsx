import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudentPortalApp } from '../../../src/student-portal/app';
import { usePortalAdminIdentityV1 } from '../../../src/features/student-portal-admin/shared/admin-identity-v1';
import { StudentPortalAdminPage } from '../../../src/features/student-portal-admin/student-portal-admin-page';
import { PortalClientErrorV1 } from '../../../src/features/student-portal/shared/transport-v1';
import { SYNTHETIC_QR_V1 } from '../../../shared/student-portal-contracts/fixtures-v1';
import { clientFixtureV1 } from '../ui/auth/fixtures-v1';
import { setupOperationsDomV1 } from '../ui/overview/dom-v1';
import { opJsonV1, operationsMockV1 } from '../ui/overview/fixtures-v1';
import { emptyReconciliationReadV1 } from '../ui/accounts/fixtures-v1';

beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function visibility(value: DocumentVisibilityState) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(value);
  document.dispatchEvent(new Event('visibilitychange'));
}
const identity = (key = 'synthetic-tab-session', canWrite = false) => ({
  authenticated: true,
  identityKey: key,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  capabilities: ['platform.settings.read', ...(canWrite ? ['platform.settings.write'] : [])],
});

it.each([false, true])(
  'opens Alunos independently with existing write permission %s',
  async (canWrite) => {
    window.history.replaceState(null, '', '/#/painel-do-aluno?area=reconciliation');
    const mock = operationsMockV1();
    const fetcher = vi.fn(async (path: string, init: RequestInit) => {
      if (path === '/api/me') return opJsonV1(identity('synthetic-students', canWrite));
      const input = JSON.parse(String(init.body));
      if (path === '/api/student-reconciliation/v1')
        return opJsonV1(emptyReconciliationReadV1(input.operation));
      return opJsonV1(
        input.contractVersion === 2
          ? await mock.reader.query(input)
          : await mock.client.query(input),
      );
    });
    render(<StudentPortalAdminPage fetcher={fetcher} />);
    const source = await screen.findByLabelText('Fonte do nome exibido');
    expect(source.hasAttribute('disabled')).toBe(!canWrite);
    expect(screen.getByRole('heading', { name: 'Alunos' })).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Áreas do Painel do Aluno' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Acessos e QR' })).toBeNull();
    expect(fetcher.mock.calls.some(([path]) => path === '/api/student-portal/admin/command')).toBe(
      false,
    );
    const reads = fetcher.mock.calls.filter(([path]) => path === '/api/student-reconciliation/v1');
    expect(reads.map(([, init]) => JSON.parse(String(init.body)).operation).sort()).toEqual([
      'catalog',
      'list',
    ]);
  },
);

it.each(['identity', 'capability'] as const)(
  'keeps the actual admin account filter and detail until %s changes',
  async (changed) => {
    window.history.replaceState(null, '', '/#/painel-do-aluno?area=accounts');
    const mock = operationsMockV1();
    let key = 'synthetic-tab-session';
    let canWrite = true;
    const fetcher = vi.fn(async (path: string, init: RequestInit) => {
      if (path === '/api/me') return opJsonV1(identity(key, canWrite));
      const input = JSON.parse(String(init.body));
      if (path === '/api/student-reconciliation/v1')
        return opJsonV1(emptyReconciliationReadV1(input.operation));
      return opJsonV1(
        input.contractVersion === 2
          ? await mock.reader.query(input)
          : await mock.client.query(input),
      );
    });
    render(<StudentPortalAdminPage fetcher={fetcher} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Acessos e QR' }));
    const filter = await screen.findByLabelText('Buscar aluno');
    await user.type(filter, 'SYNTHETIC');
    // The search narrows the list already read: it issues no request of its own.
    await waitFor(() =>
      expect(mock.queries).toContainEqual(
        expect.objectContaining({
          operation: 'accounts-read',
        }),
      ),
    );
    expect(mock.queries.some((query) => 'nameSearch' in query)).toBe(false);
    await user.click(
      await screen.findByRole('button', { name: 'Abrir ficha de SYNTHETIC OP STUDENT 1' }),
    );
    const close = await screen.findByRole('button', { name: 'Fechar ficha' });
    await act(async () => {
      visibility('hidden');
      visibility('visible');
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByRole('button', { name: 'Fechar ficha' })).toBe(close);
    expect(screen.getByLabelText('Buscar aluno')).toBe(filter);
    expect((filter as HTMLInputElement).value).toBe('SYNTHETIC');
    if (changed === 'identity') key = 'synthetic-other-session';
    else canWrite = false;
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(screen.queryByRole('button', { name: 'Fechar ficha' })).toBeNull();
    expect(new URLSearchParams(window.location.hash.split('?')[1]).get('aluno')).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Acessos e QR' }));
    expect((screen.getByLabelText('Buscar aluno') as HTMLInputElement).value).toBe('');
  },
  15_000,
);

it('expires admin access at its deadline even with a stalled background request', async () => {
  vi.useFakeTimers();
  let resolve!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      opJsonV1({ ...identity(), expiresAt: new Date(Date.now() + 2000).toISOString() }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
  const hook = renderHook(() => usePortalAdminIdentityV1(fetcher));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(hook.result.current.state.state).toBe('ready');
  void act(() => window.dispatchEvent(new Event('focus')));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(hook.result.current.state).toMatchObject({
    state: 'error',
    error: { state: 'unauthenticated' },
  });
  await act(async () => resolve(opJsonV1(identity())));
  expect(hook.result.current.state.state).toBe('error');
});

it('preserves the student PIN step and draft through an ordinary tab switch', async () => {
  const client = clientFixtureV1();
  client.session.mockRejectedValue(new PortalClientErrorV1('unauthenticated', 401));
  render(
    <StudentPortalApp
      client={client}
      entry={{ qr: SYNTHETIC_QR_V1, route: 'access', invalidQr: false }}
    />,
  );
  const pin = await screen.findByLabelText('Ano de nascimento do aluno');
  await userEvent.setup().type(pin, '20');
  await act(async () => {
    visibility('hidden');
    visibility('visible');
    window.dispatchEvent(new Event('focus'));
  });
  expect(screen.getByLabelText('Ano de nascimento do aluno')).toBe(pin);
  expect((pin as HTMLInputElement).value).toBe('20');
  expect(client.challenge).toHaveBeenCalledTimes(1);
});

it('keeps the admin identity mounted during a delayed background check and applies a new identity', async () => {
  let resolve!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(opJsonV1(identity()))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
  const hook = renderHook(() => usePortalAdminIdentityV1(fetcher));
  await waitFor(() => expect(hook.result.current.state.state).toBe('ready'));
  const ready = hook.result.current.state;
  act(() => {
    visibility('hidden');
  });
  expect(hook.result.current.state).toBe(ready);
  act(() => {
    visibility('visible');
    window.dispatchEvent(new Event('focus'));
  });
  expect(hook.result.current.state).toBe(ready);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => resolve(opJsonV1(identity('synthetic-other-session'))));
  expect(hook.result.current.state).toMatchObject({
    state: 'ready',
    identity: { identityKey: 'synthetic-other-session' },
  });
});

it('clears the admin workspace when the background check rejects its session', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(opJsonV1(identity()))
    .mockResolvedValueOnce(opJsonV1({}, 401));
  const hook = renderHook(() => usePortalAdminIdentityV1(fetcher));
  await waitFor(() => expect(hook.result.current.state.state).toBe('ready'));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(hook.result.current.state).toMatchObject({
    state: 'error',
    error: { state: 'unauthenticated' },
  });
});
