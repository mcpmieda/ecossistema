// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SystemHealthAnalysisV1 } from '../../src/platform/system-health-analysis-v1';
import { SystemHealthHistoryPanelV1 } from '../../src/platform/system-health-history-panel-v1';
import { SystemHealthSignalsPanelV1 } from '../../src/platform/system-health-signals-panel-v1';
import { SystemHealthReviewPanelV1 } from '../../src/platform/system-health-review-panel-v1';
import { SystemHealthProvidersPanelV1 } from '../../src/platform/system-health-providers-panel-v1';
import { buildHealthReviewV1 } from '../../shared/health-review-v1';
import { setupOperationsDomV1 } from '../student-portal/ui/overview/dom-v1';
const NOW = Date.parse('2026-09-22T03:00:00.000Z'),
  at = (t: number) => new Date(t).toISOString();
const point = (i: number, maintenanceState = 'normal') => ({
  bucketAt: at(NOW - i * 300_000),
  observedAt: at(NOW - i * 300_000),
  maintenanceState,
  servingEnabled: true,
  credentialsConfigured: true,
  publicationDue: 0,
  livePending: 0,
  waitingConnections: 0,
  readDurationMs: 10,
});
const history = () => ({
  schemaVersion: 1,
  generatedAt: at(NOW),
  state: 'ok',
  retentionDays: 30,
  nextBefore: null,
  points: Array.from({ length: 12 }, (_, i) =>
    point(i, i === 8 || i === 10 ? 'intervention' : 'normal'),
  ),
});
const flush = () =>
  act(async () => {
    for (let i = 0; i < 70; i++) await Promise.resolve();
  });
let read: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setupOperationsDomV1();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  read = vi.fn<typeof fetch>(async () => Response.json(buildHealthReviewV1(at(NOW), [], [])));
  vi.stubGlobal('fetch', read);
});
afterEach(async () => {
  cleanup();
  await flush();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('mounts only one native tab panel and makes no background requests for closed analyses', async () => {
  render(<SystemHealthAnalysisV1 onDenied={vi.fn()} />);
  expect(screen.getAllByRole('tab')).toHaveLength(5);
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'Histórico' }));
  await flush();
  expect(screen.queryByRole('button', { name: 'Ver resumo' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Ver histórico' })).toBeTruthy();
  expect(read).not.toHaveBeenCalled();
  let finish!: (value: Response) => void;
  read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Ver histórico' }));
  await flush();
  fireEvent.click(screen.getByRole('tab', { name: 'Banco e conexões' }));
  await flush();
  expect(read.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  await act(async () => finish(Response.json(history())));
  await flush();
  expect(screen.queryByRole('grid')).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
});
it('shows six rows at a time and filters already-classified changes without false gaps or more reads', async () => {
  read.mockImplementation(async () => Response.json(history()));
  render(<SystemHealthHistoryPanelV1 onDenied={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ver histórico' }));
  await flush();
  expect(screen.getAllByRole('rowheader')).toHaveLength(6);
  const first = screen.getAllByRole('rowheader').map((n) => n.textContent);
  fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
  await flush();
  expect(
    new Set([...first, ...screen.getAllByRole('rowheader').map((n) => n.textContent)]).size,
  ).toBe(12);
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Só alterações e atenção' }));
  await flush();
  expect(screen.getAllByRole('rowheader')).toHaveLength(4);
  expect(screen.queryByText('Intervalo sem confirmação')).toBeNull();
  expect(screen.getAllByText('Recuperação observada')).toHaveLength(2);
  expect(read).toHaveBeenCalledTimes(1);
});
it('pages observations locally and keeps refusals out of the failure filter', async () => {
  const points = Array.from({ length: 12 }, (_, i) => ({
    bucketAt: at(NOW - i * 300000),
    source: 'login',
    outcome: i === 7 ? 'failed' : i === 8 ? 'limited' : 'refused',
    samples: 1,
    totalMs: 1,
    maxMs: 1,
    slow: 0,
    capped: false,
  }));
  read.mockImplementation(async () =>
    Response.json({
      version: 1,
      generatedAt: at(NOW),
      retentionDays: 30,
      coverage: 'partial',
      state: 'ok',
      points,
      nextBefore: null,
    }),
  );
  render(<SystemHealthSignalsPanelV1 onDenied={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ver ocorrências' }));
  await flush();
  expect(screen.getAllByRole('rowheader')).toHaveLength(6);
  fireEvent.click(screen.getByRole('button', { name: 'Só falhas e limites' }));
  await flush();
  expect(screen.getAllByRole('rowheader')).toHaveLength(2);
  expect(screen.queryByText('Recusado / sem sessão')).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
});
it('renders the fixed 24-hour summary and expiry without treating missing samples as normal', async () => {
  render(<SystemHealthReviewPanelV1 onDenied={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ver resumo' }));
  await flush();
  expect(screen.getByLabelText('Resumo de 24 horas')).toBeTruthy();
  expect(screen.getAllByRole('listitem')).toHaveLength(24);
  expect(screen.getByText('0 / 288')).toBeTruthy();
  expect(screen.queryByText('Normal')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(135000));
  expect(screen.queryByLabelText('Resumo de 24 horas')).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
  expect(
    screen.getByText('Consulta desatualizada. Atualize para consultar os dados.'),
  ).toBeTruthy();
});
it.each([401, 403])(
  'clears the summary after %i and does not automatically retry',
  async (status) => {
    const denied = vi.fn();
    read.mockImplementation(async () => new Response(null, { status }));
    render(<SystemHealthReviewPanelV1 onDenied={denied} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ver resumo' }));
    await flush();
    expect(denied).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Resumo de 24 horas')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Atualizar resumo' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(read).toHaveBeenCalledTimes(1);
  },
);
it('does not convert an unavailable provider into a normal portal and never renders remote prose', async () => {
  read.mockImplementation(async () =>
    Response.json({
      version: 1,
      state: 'ok',
      source: 'public-status',
      generatedAt: at(NOW),
      providers: [
        {
          provider: 'cloudflare',
          state: 'unavailable',
          indicator: null,
          changedAt: null,
          checkedAt: at(NOW),
        },
        {
          provider: 'supabase',
          state: 'ok',
          indicator: 'none',
          changedAt: at(NOW - 86400000),
          checkedAt: at(NOW),
        },
      ],
    }),
  );
  render(<SystemHealthProvidersPanelV1 onDenied={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Consultar fornecedores' }));
  await flush();
  expect(screen.getByText('Status não confirmado')).toBeTruthy();
  expect(screen.getByText('Sem incidente global informado')).toBeTruthy();
  expect(screen.queryByText('Normal')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(300000));
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent(window, new Event('pagehide'));
  fireEvent(window, new Event('pageshow'));
  await flush();
  expect(screen.queryByText('Sem incidente global informado')).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
});
