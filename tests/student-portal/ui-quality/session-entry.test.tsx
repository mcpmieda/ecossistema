import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudentPortalApp } from '../../../src/student-portal/app';
import { createPortalSelfClientV1 } from '../../../src/features/student-portal/shared/self-client-v1';
import {
  SYNTHETIC_ID_V1,
  SYNTHETIC_QR_V1,
  SYNTHETIC_SELF_V1,
} from '../../../shared/student-portal-contracts/fixtures-v1';
import { setupOperationsDomV1 } from '../ui/overview/dom-v1';
import { clientFixtureV1, REQUIRED, SESSION } from '../ui/auth/fixtures-v1';

const meta = { contractVersion: 1, requestId: SYNTHETIC_ID_V1 };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('keeps the anonymous file input mounted when the native picker returns focus', async () => {
  const fetcher = vi.fn(async () => json({ ...meta, state: 'unauthenticated' }, 401));
  render(<StudentPortalApp client={createPortalSelfClientV1({ fetch: fetcher })} />);
  await screen.findByRole('button', { name: 'Selecionar QR da galeria' });
  const input = document.querySelector('input[type="file"]');
  expect(input).toBeTruthy();
  await act(async () => {
    fireEvent(window, new Event('blur'));
    fireEvent(window, new Event('focus'));
  });
  expect(document.querySelector('input[type="file"]')).toBe(input);
  expect(input?.isConnected).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(['focus', 'pageshow', 'popstate'])(
  'ignores passive %s and refuses revoked access on explicit reload',
  async (event) => {
    let revoked = false;
    const fetcher = vi.fn(async (path: string) =>
      path === '/api/student/session'
        ? revoked
          ? json({ ...meta, state: 'unauthenticated' }, 401)
          : json({
              ...meta,
              state: 'authenticated',
              persistent: false,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            })
        : json(SYNTHETIC_SELF_V1),
    );
    const client = createPortalSelfClientV1({ fetch: fetcher });
    const view = render(<StudentPortalApp client={client} />);
    await screen.findByText(SYNTHETIC_SELF_V1.profile.name);
    revoked = true;
    await act(async () => {
      fireEvent(window, new Event(event));
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByText(SYNTHETIC_SELF_V1.profile.name)).toBeTruthy();
    // A full reload creates a new application lifetime, not a passive focus event.
    view.unmount();
    render(<StudentPortalApp client={client} />);
    expect(screen.queryByText(SYNTHETIC_SELF_V1.profile.name)).toBeNull();
    await screen.findByRole('button', { name: 'Selecionar QR da galeria' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/student/me')).toHaveLength(1);
    expect(screen.queryByText(SYNTHETIC_SELF_V1.profile.name)).toBeNull();
  },
);

it.each([false, true])(
  'clears protected history, reverifies on return and sends a revoked session straight to login (persisted=%s)',
  async (persisted) => {
    const restoredSession = deferredResponse();
    let restoring = false;
    const fetcher = vi.fn((path: string) => {
      if (path === '/api/student/session') {
        if (restoring) return restoredSession.promise;
        return Promise.resolve(json({
          ...meta,
          state: 'authenticated',
          persistent: false,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }));
      }
      return Promise.resolve(json(SYNTHETIC_SELF_V1));
    });
    render(<StudentPortalApp client={createPortalSelfClientV1({ fetch: fetcher })} />);
    await screen.findByText(SYNTHETIC_SELF_V1.profile.name);
    act(() => {
      fireEvent(window, new Event('pagehide'));
      expect(screen.queryByText(SYNTHETIC_SELF_V1.profile.name)).toBeNull();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    restoring = true;
    const show = new Event('pageshow');
    Object.defineProperty(show, 'persisted', { value: persisted });
    await act(async () => { fireEvent(window, show); });
    // Stable login: the return re-verifies on its own; no retry button, no protected content yet.
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(SYNTHETIC_SELF_V1.profile.name)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    await act(async () => restoredSession.resolve(json({ ...meta, state: 'unauthenticated' }, 401)));
    // Revoked: straight to the login form, without any error message.
    await screen.findByRole('button', { name: 'Selecionar QR da galeria' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Sessão expirada')).toBeNull();
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/student/me')).toHaveLength(1);
    expect(screen.queryByText(SYNTHETIC_SELF_V1.profile.name)).toBeNull();
  },
);

beforeEach(() => {
  setupOperationsDomV1();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps the current account when another QR is opened and does not challenge it', async () => {
  const client = clientFixtureV1();
  client.session.mockResolvedValue({
    ...SESSION,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  render(
    <StudentPortalApp
      client={client}
      entry={{ qr: SYNTHETIC_QR_V1, route: 'access', invalidQr: false }}
    />,
  );
  expect(screen.getByText('Verificando acesso…')).toBeTruthy();
  expect(await screen.findByText('Você já está conectado')).toBeTruthy();
  expect(client.challenge).not.toHaveBeenCalled();
  expect(screen.queryByText(SYNTHETIC_SELF_V1.profile.name)).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Continuar nesta conta' }));
  expect(await screen.findByText(SYNTHETIC_SELF_V1.profile.name)).toBeTruthy();
  expect(client.logout).not.toHaveBeenCalled();
  expect(client.challenge).not.toHaveBeenCalled();
});

it('logs out the current account before challenging the second QR and accepts its new session', async () => {
  const client = clientFixtureV1();
  const second = {
    ...SYNTHETIC_SELF_V1,
    profile: {
      ...SYNTHETIC_SELF_V1.profile,
      accountId: '00000000-0000-4000-8000-000000000099',
      name: 'Outra conta de exemplo',
    },
  };
  client.session.mockResolvedValue({
    ...SESSION,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  client.me.mockResolvedValueOnce(SYNTHETIC_SELF_V1).mockResolvedValueOnce(second);
  client.challenge.mockResolvedValueOnce(REQUIRED('password'));
  let finishLogout!: (value: Awaited<ReturnType<typeof client.logout>>) => void;
  client.logout.mockImplementationOnce(() => new Promise((resolve) => { finishLogout = resolve; }));
  render(
    <StudentPortalApp
      client={client}
      entry={{ qr: SYNTHETIC_QR_V1, route: 'access', invalidQr: false }}
    />,
  );
  expect(await screen.findByText('Você já está conectado')).toBeTruthy();
  expect(client.challenge).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Trocar de aluno' }));
  expect(client.challenge).not.toHaveBeenCalled();
  await act(async () => finishLogout({ contractVersion: 1, requestId: SYNTHETIC_ID_V1, state: 'logged-out' }));
  const password = await screen.findByLabelText('Senha de 6 números');
  expect(client.logout).toHaveBeenCalledOnce();
  expect(client.logout.mock.invocationCallOrder[0]).toBeLessThan(client.challenge.mock.invocationCallOrder[0]!);
  await userEvent.setup().type(password, '001234');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Entrar' }));
  expect(await screen.findByText(second.profile.name)).toBeTruthy();
  expect(screen.queryByText(SYNTHETIC_SELF_V1.profile.name)).toBeNull();
});

it('does not challenge another QR when the current logout fails', async () => {
  const client = clientFixtureV1();
  client.session.mockResolvedValue({
    ...SESSION,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  client.logout.mockRejectedValueOnce(new Error('Synthetic logout failure'));
  render(
    <StudentPortalApp
      client={client}
      entry={{ qr: SYNTHETIC_QR_V1, route: 'access', invalidQr: false }}
    />,
  );
  await screen.findByText('Você já está conectado');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Trocar de aluno' }));
  expect(await screen.findByText('Não foi possível confirmar a saída')).toBeTruthy();
  expect(client.challenge).not.toHaveBeenCalled();
});

it('does not challenge another QR while the existing session cannot be checked', async () => {
  const client = clientFixtureV1();
  client.session.mockRejectedValueOnce(new TypeError('Synthetic network failure'));
  render(
    <StudentPortalApp
      client={client}
      entry={{ qr: SYNTHETIC_QR_V1, route: 'access', invalidQr: false }}
    />,
  );
  expect(await screen.findByText('Não foi possível carregar seus dados')).toBeTruthy();
  expect(client.challenge).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Sair' }));
  expect(await screen.findByLabelText('Ano de nascimento do aluno')).toBeTruthy();
  expect(client.logout).toHaveBeenCalledOnce();
});

it.each([401, 503])(
  'shows a neutral initial state and never requests a profile when session returns %s',
  async (status) => {
    const session = deferredResponse();
    const fetcher = vi.fn((path: string) => {
      if (path !== '/api/student/session') throw new Error('Unexpected private request');
      return session.promise;
    });
    render(<StudentPortalApp client={createPortalSelfClientV1({ fetch: fetcher })} />);
    // A status (an <output>, role status by default) carries the waiting text.
    expect(screen.getByText('Verificando acesso…').closest('output')).not.toBeNull();
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Perfil do aluno' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Minhas notas' })).toBeNull();
    await act(async () =>
      session.resolve(
        json({ ...meta, state: status === 401 ? 'unauthenticated' : 'unavailable' }, status),
      ),
    );
    if (status === 401)
      expect(await screen.findByRole('button', { name: 'Ler QR com câmera' })).toBeTruthy();
    else expect(await screen.findByText('Portal temporariamente indisponível')).toBeTruthy();
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/student/session');
    expect(screen.queryByText(SYNTHETIC_SELF_V1.profile.name)).toBeNull();
  },
);

it('reveals the complete student page only after both server session and private profile succeed', async () => {
  const session = deferredResponse(),
    profile = deferredResponse();
  const paths: string[] = [];
  const client = createPortalSelfClientV1({
    fetch: (path) => {
      paths.push(path);
      return path === '/api/student/session' ? session.promise : profile.promise;
    },
  });
  render(<StudentPortalApp client={client} />);
  expect(paths).toEqual(['/api/student/session']);
  await act(async () =>
    session.resolve(
      json({
        ...meta,
        state: 'authenticated',
        persistent: false,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    ),
  );
  await waitFor(() => expect(paths).toEqual(['/api/student/session', '/api/student/me']));
  expect(screen.queryByRole('banner')).toBeNull();
  expect(screen.queryByText(SYNTHETIC_SELF_V1.profile.name)).toBeNull();
  await act(async () => profile.resolve(json(SYNTHETIC_SELF_V1)));
  expect(await screen.findByText(SYNTHETIC_SELF_V1.profile.name)).toBeTruthy();
  expect(screen.getByRole('banner')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sair' })).toBeTruthy();
});

it.each(['unavailable', 'network-error'] as const)(
  'does not send a session to login on reload failure %s and recovers by explicit retry',
  async (failure) => {
    let failing = false;
    const client = createPortalSelfClientV1({
      fetch: async (path) => {
        if (path === '/api/student/session') {
          if (failing && failure === 'network-error') throw new TypeError('Synthetic offline');
          if (failing) return json({ ...meta, state: 'unavailable' }, 503);
          return json({
            ...meta,
            state: 'authenticated',
            persistent: false,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          });
        }
        return json(SYNTHETIC_SELF_V1);
      },
    });
    const view = render(<StudentPortalApp client={client} />);
    await screen.findByText(SYNTHETIC_SELF_V1.profile.name);
    failing = true;
    view.unmount();
    render(<StudentPortalApp client={client} />);
    expect(await screen.findByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
    expect(screen.queryByText(SYNTHETIC_SELF_V1.profile.name)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Acessar minhas notas' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Entrar' })).toBeNull();
    failing = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    });
    expect(await screen.findByText(SYNTHETIC_SELF_V1.profile.name)).toBeTruthy();
  },
);

it('sends a signed-in student whose access closed back to the login countdown, not a bare error', async () => {
  const fetcher = vi.fn(async () => json({ ...meta, state: 'access-closed' }, 403));
  const opensAt = new Date(Date.now() + 3 * 3600_000).toISOString();
  const statusClient = vi.fn(async () => ({
    contractVersion: 1 as const,
    requestId: SYNTHETIC_ID_V1,
    state: 'status' as const,
    scope: 'school' as const,
    serverNow: new Date().toISOString(),
    notices: { access: 'closed' as const, accessOpensAt: opensAt, gradesReleaseAt: null, disclosureEnded: null },
  }));
  render(<StudentPortalApp client={createPortalSelfClientV1({ fetch: fetcher })} statusClient={statusClient} />);

  expect(await screen.findByText('Portal fechado no momento')).toBeTruthy();
  expect(screen.getByText(/O Portal abre em/u)).toBeTruthy();
  expect(screen.queryByText('Acesso ao Portal fechado')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Selecionar QR da galeria' })).toBeNull();
});
