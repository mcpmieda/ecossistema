// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SystemHealthCapacityPanelV1 } from '../../src/platform/system-health-capacity-panel-v1';
const now = Date.parse('2026-09-22T02:00:00.000Z');
const fixture = () => ({
  version: 1,
  source: 'postgresql',
  state: 'ok',
  observedAt: new Date(now).toISOString(),
  metrics: {
    databaseBytes: 123_450_000,
    portalConnections: 5,
    portalActive: 1,
    portalWaiting: 0,
    portalConnectionLimit: 10,
    serverMaxConnections: 60,
    serverReservedConnections: 3,
  },
});
const flush = () =>
  act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
let read: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  read = vi.fn<typeof fetch>(async () => Response.json(fixture()));
  vi.stubGlobal('fetch', read);
});
afterEach(async () => {
  cleanup();
  await flush();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Ver banco e conexões' }));
  await flush();
}
it('reads only on demand and removes expired numbers without another network call', async () => {
  render(<SystemHealthCapacityPanelV1 onDenied={vi.fn()} />);
  expect(read).not.toHaveBeenCalled();
  await open();
  expect(screen.getByLabelText('Medição do banco e conexões')).toBeTruthy();
  expect(screen.getByText('123,45 MB')).toBeTruthy();
  expect(screen.getByText('5 · 1 em atividade')).toBeTruthy();
  expect(screen.queryByText('Normal')).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(read).toHaveBeenCalledWith(
    '/api/platform/system-health/capacity',
    expect.objectContaining({
      method: 'POST',
      body: '{}',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
    }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(135_000));
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('123,45 MB')).toBeNull();
  expect(screen.getByText('Medição desatualizada. Atualize os dados.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar medição' }));
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
});
it.each([401, 403])('clears a previous measurement on %i and stops retries', async (status) => {
  const denied = vi.fn();
  render(<SystemHealthCapacityPanelV1 onDenied={denied} />);
  await open();
  read.mockResolvedValue(new Response(null, { status }));
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar medição' }));
  await flush();
  expect(screen.queryByLabelText('Medição do banco e conexões')).toBeNull();
  expect(denied).toHaveBeenCalledTimes(1);
  expect(
    (screen.getByRole('button', { name: 'Atualizar medição' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(300_000));
  expect(read).toHaveBeenCalledTimes(2);
});
it.each(['unavailable', 'unconfigured'])('does not estimate zero from %s', async (state) => {
  read.mockResolvedValue(Response.json({ ...fixture(), state, metrics: null }));
  render(<SystemHealthCapacityPanelV1 onDenied={vi.fn()} />);
  await open();
  expect(screen.queryByLabelText('Medição do banco e conexões')).toBeNull();
  expect(screen.queryByText('Normal')).toBeNull();
});
it('cancels on close and does not restore a late response', async () => {
  let finish!: (response: Response) => void;
  read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<SystemHealthCapacityPanelV1 onDenied={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Fechar medição' }));
  expect(read.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  await act(async () => finish(Response.json(fixture())));
  await flush();
  expect(screen.queryByLabelText('Medição do banco e conexões')).toBeNull();
});
it('clears measurements on pagehide without an automatic read on pageshow', async () => {
  render(<SystemHealthCapacityPanelV1 onDenied={vi.fn()} />);
  await open();
  fireEvent(window, new Event('pagehide'));
  fireEvent(window, new Event('pageshow'));
  await flush();
  expect(screen.queryByText('123,45 MB')).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
});
it('rejects an unexpected field without displaying its contents', async () => {
  read.mockResolvedValue(Response.json({ ...fixture(), private: 'SYNTHETIC-PRIVATE' }));
  render(<SystemHealthCapacityPanelV1 onDenied={vi.fn()} />);
  await open();
  expect(screen.getByText('Medição indisponível. Nenhum valor foi estimado.')).toBeTruthy();
  expect(screen.queryByText('SYNTHETIC-PRIVATE')).toBeNull();
});
it('distinguishes no role-specific limit from an unlimited server', async () => {
  const value = fixture();
  read.mockResolvedValue(
    Response.json({ ...value, metrics: { ...value.metrics, portalConnectionLimit: null } }),
  );
  render(<SystemHealthCapacityPanelV1 onDenied={vi.fn()} />);
  await open();
  expect(screen.getByText('Sem limite próprio')).toBeTruthy();
  expect(screen.getByText('Limite compartilhado do servidor')).toBeTruthy();
});
