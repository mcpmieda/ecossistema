import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AutomaticReportV1 } from '../../../../shared/student-identity/reconciliation-v1';
import { AutomaticReportPanelV1 } from '../../../../src/features/student-portal-admin/accounts/automatic-report-v1';
import type { ReconciliationClientV1 } from '../../../../src/features/student-portal-admin/shared/reconciliation-client-v1';
import { setupOperationsDomV1 } from '../overview/dom-v1';

beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const report = (outcome: AutomaticReportV1['outcome'], differences: string[]): AutomaticReportV1 => ({
  observedAt: '2026-10-29T12:07:00Z',
  changedAt: '2026-10-29T12:07:00Z',
  outcome,
  rows: 3,
  counts: null,
  differences,
  invalid: [],
});
const answer = (value: AutomaticReportV1) =>
  ({
    contractVersion: 1,
    state: 'ready',
    operation: 'automatic-report',
    report: value,
  }) as unknown as Awaited<ReturnType<ReconciliationClientV1['request']>>;

it('never says a report that applied nothing was applied, in the school time zone', async () => {
  const request = vi.fn<ReconciliationClientV1['request']>(async () =>
    answer(report('review', ['O relatório não é de 2026. Nada foi aplicado.'])),
  );
  render(<AutomaticReportPanelV1 client={{ request }} refresh={0} />);
  expect(await screen.findByText('Nada aplicado')).toBeTruthy();
  expect(screen.getByText(/Nada foi aplicado; confira abaixo o motivo\./)).toBeTruthy();
  expect(document.body.textContent).not.toContain('O que estava certo foi aplicado');
  // 12:07 UTC is 09:07 at the school, whatever the computer's clock says.
  expect(screen.getByText(/Lido no Smecel em 29\/10\/2026,? 09:07/)).toBeTruthy();
});

it('says a failed read and reads again on request', async () => {
  const request = vi.fn<ReconciliationClientV1['request']>();
  request.mockRejectedValueOnce(new Error('SYNTHETIC READ FAILED'));
  request.mockResolvedValueOnce(answer(report('applied', ['Turma sem vínculo.'])));
  render(<AutomaticReportPanelV1 client={{ request }} refresh={0} />);
  expect(await screen.findByText('Não foi possível ler o relatório automático.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
  expect(await screen.findByText('Turma sem vínculo.')).toBeTruthy();
  expect(screen.getByText(/O que estava certo foi aplicado/)).toBeTruthy();
  expect(screen.queryByText('Não foi possível ler o relatório automático.')).toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
});
