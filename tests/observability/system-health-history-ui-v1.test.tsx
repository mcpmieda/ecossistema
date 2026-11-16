// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SystemHealthHistoryPanelV1 } from '../../src/platform/system-health-history-panel-v1';
import { setupOperationsDomV1 } from '../student-portal/ui/overview/dom-v1';
import { historyFixtureV1, historyPointV1, HISTORY_NOW_V1 } from './history-fixtures-v1';
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  setupOperationsDomV1();
  vi.spyOn(Date, 'now').mockReturnValue(HISTORY_NOW_V1);
  fetcher = vi.fn<typeof fetch>(async () => Response.json(historyFixtureV1()));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function open(onDenied = vi.fn()) {
  const view = render(<SystemHealthHistoryPanelV1 onDenied={onDenied} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ver histórico' }));
  return view;
}
it('reads only when requested, renders aggregates and aborts when closed', async () => {
  render(<SystemHealthHistoryPanelV1 onDenied={vi.fn()} />);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Ver histórico' }));
  expect(await screen.findByText('10 ms')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    body: '{"before":null}',
    cache: 'no-store',
    redirect: 'error',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Fechar histórico' }));
  expect(screen.queryByText('10 ms')).toBeNull();
});
it.each([401, 403])(
  'clears and disables retries on %s without echoing response bodies',
  async (status) => {
    fetcher.mockResolvedValue(Response.json({ message: 'synthetic-private' }, { status }));
    const denied = vi.fn();
    open(denied);
    expect(await screen.findByText('Acesso ao histórico não autorizado.')).toBeTruthy();
    expect(denied).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole('button', { name: 'Atualizar histórico' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByText('synthetic-private')).toBeNull();
  },
);
it('rejects an unexpected private field and reports failure instead of normality', async () => {
  fetcher.mockResolvedValue(Response.json({ ...historyFixtureV1(), name: 'synthetic-private' }));
  open();
  expect(
    await screen.findByText('Histórico indisponível. Não há confirmação de normalidade.'),
  ).toBeTruthy();
  expect(screen.queryByText('10 ms')).toBeNull();
  expect(screen.queryByText('synthetic-private')).toBeNull();
});
it('does not label a collection gap as recovery', async () => {
  fetcher.mockResolvedValue(
    Response.json({
      ...historyFixtureV1(),
      points: [historyPointV1(), { ...historyPointV1(2), maintenanceState: 'intervention' }],
    }),
  );
  open();
  expect(await screen.findByText('Coleta retomada após intervalo sem confirmação.')).toBeTruthy();
  expect(screen.queryByText('Recuperação observada')).toBeNull();
});
it('shows observed recovery for consecutive samples, without an email action', async () => {
  fetcher.mockResolvedValue(
    Response.json({
      ...historyFixtureV1(),
      points: [historyPointV1(), { ...historyPointV1(1), maintenanceState: 'intervention' }],
    }),
  );
  open();
  expect(
    await screen.findByText('Os sinais voltaram ao normal na última verificação.'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: /e-mail/u })).toBeNull();
});
it('does not reuse old data as current confirmation', async () => {
  vi.mocked(Date.now).mockReturnValue(HISTORY_NOW_V1 + 601_000);
  open();
  expect(await screen.findByText('Confirmação expirada. Atualize o histórico.')).toBeTruthy();
});
it('aborts a pending request on unmount and does not retry on passive browser events', async () => {
  fetcher.mockImplementation(() => new Promise<Response>(() => undefined));
  const view = open();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  fireEvent(window, new Event('focus'));
  fireEvent(window, new Event('online'));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const signal = fetcher.mock.calls[0]?.[1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
