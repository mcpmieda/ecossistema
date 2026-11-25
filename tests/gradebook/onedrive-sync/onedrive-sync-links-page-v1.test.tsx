// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { previewOneDriveSyncV1 } from '../../../src/adm-preview/onedrive-sync-preview-v1';
import { requestOneDriveSyncV1 } from '../../../src/features/gradebook/onedrive-sync/onedrive-sync-client-v1';
import { OneDriveSyncPageV1 } from '../../../src/features/gradebook/onedrive-sync/onedrive-sync-page-v1';

vi.mock('../../../src/platform/gradebook-year-context', () => ({
  useGradebookYear: () => ({ year: 2026 }),
}));
vi.mock('../../../src/features/gradebook/onedrive-sync/onedrive-sync-client-v1');

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.mocked(requestOneDriveSyncV1).mockImplementation(async (request) =>
    previewOneDriveSyncV1(JSON.stringify(request)),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const card = (text: string) =>
  screen.getByText(text, { exact: false }).closest('div.overflow-hidden') as HTMLElement;

it('shows the links like the reading: header with the last update, then the workbooks, latest first (#1541)', async () => {
  render(<OneDriveSyncPageV1 />);
  await screen.findByText('Vínculos entre planilhas');
  const header = card('Vínculos entre planilhas');
  expect(within(header).getByText('Ligada')).toBeTruthy();
  expect(within(header).getByText(/Última atualização:/u)).toBeTruthy();
  expect(within(header).getByText('Planilha Sintética Professora A 2026')).toBeTruthy();
  expect(
    within(header).getByText('PEDAGÓGICO/CONTROLE DE NOTAS/CONTROLE DE NOTAS 2026'),
  ).toBeTruthy();

  const list = card('Planilhas com vínculos');
  expect(within(list).getByText('(4)')).toBeTruthy();
  const rows = within(list)
    .getAllByRole('listitem')
    .map((row) => row.textContent ?? '');
  expect(rows.map((row) => row.match(/Professor[a]? [A-E]/u)?.[0])).toEqual([
    'Professora A',
    'Professora C',
    'Professor B',
    'Professor D',
  ]);
  expect(rows[0]).toContain('Atualizado');
  expect(within(list).getByText('Aberto por alguém — nova tentativa automática')).toBeTruthy();
  expect(within(list).getByText('Em dia')).toBeTruthy();

  await act(async () => {
    fireEvent.click(within(header).getByRole('button', { name: /Desligar/u }));
  });
  expect(vi.mocked(requestOneDriveSyncV1)).toHaveBeenCalledWith({ action: 'links-off' });
  expect(await within(card('Vínculos entre planilhas')).findByText('Desligada')).toBeTruthy();

  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', {
        name: /Atualizar os vínculos de Planilha Sintética Professora A/u,
      }),
    );
  });
  expect(vi.mocked(requestOneDriveSyncV1)).toHaveBeenCalledWith({
    action: 'links-refresh-now',
    fileId: 'item-1',
  });
});

it('an .xls is not offered as a links destination; the reading still offers it (#1541)', async () => {
  vi.mocked(requestOneDriveSyncV1).mockImplementation(async (request) => {
    const answer = previewOneDriveSyncV1(JSON.stringify(request));
    return answer.state === 'folders'
      ? {
          ...answer,
          files: [
            { id: 'file-xls', name: 'ANTIGA SINTETICA.xls', size: 10 },
            { id: 'file-xlsb', name: 'NOVA SINTETICA.xlsb', size: 10 },
          ],
        }
      : answer;
  });
  render(<OneDriveSyncPageV1 />);
  await screen.findByText('Vínculos entre planilhas');
  const links = screen
    .getByRole('heading', { name: 'Pastas e planilhas' })
    .closest('section') as HTMLElement;
  await act(async () => {
    fireEvent.click(within(links).getByRole('button', { name: /Adicionar/u }));
  });
  await within(links).findByText('NOVA SINTETICA.xlsb');
  expect(within(links).queryByText('ANTIGA SINTETICA.xls')).toBeNull();
  expect(within(links).getAllByRole('button', { name: 'Usar só este arquivo' })).toHaveLength(1);

  const sources = screen.getByRole('heading', { name: 'Fontes' }).closest('section') as HTMLElement;
  await act(async () => {
    fireEvent.click(within(sources).getByRole('button', { name: /Adicionar/u }));
  });
  expect(await within(sources).findByText('ANTIGA SINTETICA.xls')).toBeTruthy();
});

it('recalculation of the cells: off by default, switched on and off, with the audit of each workbook (#1541)', async () => {
  render(<OneDriveSyncPageV1 />);
  await screen.findByText('Recalcular células');
  const section = screen
    .getByRole('heading', { name: 'Recalcular células' })
    .closest('section') as HTMLElement;
  expect(within(section).getByText('Desligado')).toBeTruthy();

  const list = card('Planilhas com vínculos');
  expect(within(list).getByText(/1204 célula\(s\) recalculada\(s\)/u)).toBeTruthy();
  expect(
    within(list).getByText(
      'Recálculo: 2 fórmula(s) deixadas como estavam; principal motivo: função TEXT não calculada aqui (1, ex.: 6A1º!K1)',
    ),
  ).toBeTruthy();

  await act(async () => {
    fireEvent.click(within(section).getByRole('button', { name: /Ligar recálculo/u }));
  });
  expect(vi.mocked(requestOneDriveSyncV1)).toHaveBeenCalledWith({ action: 'links-recalc-on' });
  expect(await within(section).findByText('Ligado (teste)')).toBeTruthy();

  await act(async () => {
    fireEvent.click(within(section).getByRole('button', { name: /Desligar recálculo/u }));
  });
  expect(vi.mocked(requestOneDriveSyncV1)).toHaveBeenCalledWith({ action: 'links-recalc-off' });
  expect(await within(section).findByText('Desligado')).toBeTruthy();
});
