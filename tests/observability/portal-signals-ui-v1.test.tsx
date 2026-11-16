// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SystemHealthSignalsPanelV1 } from '../../src/platform/system-health-signals-panel-v1';
const now = Date.parse('2026-09-22T01:00:00.000Z');
const fixture = () => ({
  version: 1,
  generatedAt: new Date(now).toISOString(),
  retentionDays: 30,
  coverage: 'partial',
  state: 'ok',
  nextBefore: null,
  points: [
    {
      bucketAt: new Date(now).toISOString(),
      source: 'login',
      outcome: 'refused',
      samples: 2,
      totalMs: 100,
      maxMs: 80,
      slow: 0,
      capped: false,
    },
    {
      bucketAt: new Date(now).toISOString(),
      source: 'browser-render',
      outcome: 'failed',
      samples: 1,
      totalMs: 0,
      maxMs: 0,
      slow: 0,
      capped: false,
    },
  ],
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
it('loads only on explicit opening and keeps refusal distinct from untrusted browser reports', async () => {
  render(<SystemHealthSignalsPanelV1 onDenied={vi.fn()} />);
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Ver ocorrências' }));
  await flush();
  expect(screen.getByRole('grid', { name: 'Ocorrências de entrada e carregamento' })).toBeTruthy();
  expect(screen.getByText('Recusado / sem sessão')).toBeTruthy();
  expect(screen.getByText('Relato do navegador')).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(300_000));
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Consulta desatualizada. Atualize as ocorrências.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar ocorrências' }));
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
});
it.each([401, 403])('clears everything on %i without automatic retry', async (status) => {
  const denied = vi.fn();
  read.mockResolvedValue(new Response(null, { status }));
  render(<SystemHealthSignalsPanelV1 onDenied={denied} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ver ocorrências' }));
  await flush();
  expect(denied).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('grid')).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Atualizar ocorrências' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(300_000));
  expect(read).toHaveBeenCalledTimes(1);
});
it('cancels a pending read on closing and discards a late response', async () => {
  let finish!: (response: Response) => void;
  read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<SystemHealthSignalsPanelV1 onDenied={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ver ocorrências' }));
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Fechar ocorrências' }));
  expect(read.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  await act(async () => finish(Response.json(fixture())));
  await flush();
  expect(screen.queryByRole('grid')).toBeNull();
});
it('does not classify an empty sample as a healthy service', async () => {
  read.mockResolvedValue(Response.json({ ...fixture(), points: [] }));
  render(<SystemHealthSignalsPanelV1 onDenied={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ver ocorrências' }));
  await flush();
  expect(
    screen.getByText('Nenhuma observação disponível. Isso não confirma ausência de falhas.'),
  ).toBeTruthy();
  expect(screen.queryByText('Normal')).toBeNull();
});
