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

it('shows the links of each workbook and switches the refresh off and on (#1541)', async () => {
  render(<OneDriveSyncPageV1 />);
  const title = await screen.findByText('Vínculos entre planilhas');
  // The whole card of the links (its outer surface).
  const section = title.closest('div.overflow-hidden') as HTMLElement;
  expect(within(section).getByText('Ligada')).toBeTruthy();
  expect(
    within(section).getByText('PEDAGÓGICO/CONTROLE DE NOTAS/CONTROLE DE NOTAS 2026'),
  ).toBeTruthy();
  expect(within(section).getByText('Aberto por alguém — nova tentativa automática')).toBeTruthy();
  expect(within(section).getByText('Em dia')).toBeTruthy();

  await act(async () => {
    fireEvent.click(within(section).getByRole('button', { name: /Desligar/u }));
  });
  expect(vi.mocked(requestOneDriveSyncV1)).toHaveBeenCalledWith({ action: 'links-off' });
  expect(await within(section).findByText('Desligada')).toBeTruthy();

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
