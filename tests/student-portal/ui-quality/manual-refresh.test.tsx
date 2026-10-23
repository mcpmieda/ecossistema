// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudentPortalApp } from '../../../src/student-portal/app';
import { clientFixtureV1, SESSION } from '../ui/auth/fixtures-v1';
import { SYNTHETIC_SELF_V1 } from '../../../shared/student-portal-contracts/fixtures-v1';
import { setupOperationsDomV1 } from '../ui/overview/dom-v1';

function resourceUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    'https://aluno.escolaieda.com',
  );
}

beforeEach(() => {
  setupOperationsDomV1();
  // The page on screen is kept in history.state (a reload stays on it): start every case on Notas.
  window.history.replaceState(null, '');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([204, 401, 503])(
  'keeps notes manual and the security channel separate from an optional photo response (%i)',
  async (status) => {
    const socket = vi.fn(function () {
      return { addEventListener: vi.fn(), close: vi.fn(), send: vi.fn() };
    });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = resourceUrl(input);
      if (url.pathname === '/api/student/photo') return new Response(null, { status });
      if (url.pathname === '/api/student/frequency')
        return Response.json({
          contractVersion: 2,
          state: 'ready',
          month: url.searchParams.get('month'),
          absences: null,
          justified: null,
          denominator: null,
          percentage: null,
          coverage: 'unavailable',
          observedAt: null,
          receivedAt: null,
          marks: [],
          conflicts: 0,
        });
      throw new Error('Unexpected synthetic Portal resource');
    });
    const photoRequests = () =>
      fetcher.mock.calls.filter(([input]) => resourceUrl(input).pathname === '/api/student/photo');
    const frequencyRequests = () =>
      fetcher.mock.calls.filter(
        ([input]) => resourceUrl(input).pathname === '/api/student/frequency',
      );
    vi.stubGlobal('WebSocket', socket);
    vi.stubGlobal('fetch', fetcher);
    const client = clientFixtureV1();
    // Política Frequência on: the attendance section is shown and read.
    client.me.mockResolvedValue({ ...SYNTHETIC_SELF_V1, showFrequency: true });
    // Keep the UI scheduler's real clock; only the synthetic session needs a future expiry.
    client.session.mockResolvedValue({
      ...SESSION,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    // Notices are read once per sign-in state, never on passive events.
    const notices = vi.fn(() => Promise.reject(new Error('offline')));
    render(<StudentPortalApp client={client} statusClient={notices} />);
    await screen.findByRole('heading', { name: 'Minhas notas' });
    await waitFor(() => expect(photoRequests()).toHaveLength(1));
    expect(photoRequests()[0]).toEqual([
      '/api/student/photo',
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      }),
    ]);
    // Frequência is a page of its own behind the menu: nothing is read until it is opened.
    expect(frequencyRequests()).toHaveLength(0);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Frequência' }));
    await screen.findByRole('heading', { level: 3, name: /de 2026$/u });
    expect(frequencyRequests()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Sair' })).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Only the security-only channel (revocation/presence) may connect; grades stay manual.
    expect(socket).toHaveBeenCalledTimes(1);
    const url = new URL(String((socket.mock.calls[0] as unknown[])[0]));
    expect(url.pathname).toBe('/api/student/live');
    expect(url.searchParams.get('purpose')).toBe('security');
    // Frequency revalidates on visibility; optional photos and academic data stay independent.
    await waitFor(() => expect(frequencyRequests()).toHaveLength(2));
    // Reading the frequency again never fetches the optional portrait, notes or notices again.
    expect(photoRequests()).toHaveLength(1);
    await act(async () => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    });
    expect(frequencyRequests()).toHaveLength(2);
    expect(photoRequests()).toHaveLength(1);
    await act(async () => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(frequencyRequests()).toHaveLength(3));
    expect(photoRequests()).toHaveLength(1);
    for (const [, init] of frequencyRequests())
      expect(init).toMatchObject({
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
    expect(notices).toHaveBeenCalledTimes(1);
    expect(client.session).toHaveBeenCalledTimes(1);
    expect(client.me).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Minhas notas' })).toBeTruthy();
    expect(document.querySelector('.pa-hero-portrait')).toBeNull();
    expect(screen.queryByText(/recuperação periódica continua ativa/u)).toBeNull();
  },
);
