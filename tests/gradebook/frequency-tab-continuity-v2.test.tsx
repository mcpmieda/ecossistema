import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotesImportPanel } from '../../src/features/gradebook/import/import-panel';
import { setupOperationsDomV1 } from '../student-portal/ui/overview/dom-v1';

const mocks = vi.hoisted(() => ({ upload: vi.fn(async () => {}), reports: vi.fn() }));
vi.mock('../../src/features/gradebook/import/use-import-batch', () => {
  const state = {
    authorizationRequired: false,
    cancelMovementReview: vi.fn(),
    confirmMovementReview: vi.fn(),
    diagnosticAuditFailures: 0,
    error: null,
    failures: [],
    handleFiles: mocks.upload,
    loading: false,
    pendingPersistenceCount: 0,
    progress: null,
    persistence: {},
    results: [],
    resumePendingPersistence: vi.fn(),
    selectedId: null,
    selectedResult: null,
    setSelectedId: vi.fn(),
    sourceDiagnostics: {},
    timingReportSummary: { runOrdinal: null },
    getTimingReport: () => '',
    totals: { classes: 0, students: 0, gradeSheets: 0 },
  };
  return { isMasterRelationResult: () => false, useImportBatch: () => state };
});
vi.mock('../../src/features/gradebook/import/student-report-import-v1', () => ({
  StudentReportImportV1: () => {
    const [draft, setDraft] = useState('');
    mocks.reports();
    return (
      <label>
        Rascunho do relatório
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
    );
  },
}));
beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.upload.mockClear();
});

it('keeps the report draft and workbook importer mounted without triggering uploads on tab changes', async () => {
  const client = {
    status: vi.fn(async () => ({
      contractVersion: 2 as const,
      state: 'ready' as const,
      academicYear: 2026 as const,
      serverTime: '2026-10-14T13:00:00Z',
      settings: { revision: 0, paused: false, schedule: null },
      lease: null,
      classes: [],
      devices: [],
      collections: [],
      conflicts: [],
    })),
    mutate: vi.fn(async () => {}),
  };
  render(<NotesImportPanel frequencyClient={client} />);
  const user = userEvent.setup();
  expect(client.status).not.toHaveBeenCalled();
  await user.upload(
    screen.getByLabelText('Selecionar Relatório'),
    new File(['invented workbook'], 'inventado.xlsx'),
  );
  await user.type(screen.getByLabelText('Rascunho do relatório'), 'seleção inventada não enviada');
  await user.click(screen.getByRole('tab', { name: 'Frequência' }));
  await screen.findByText('Nenhum computador registrado.');
  await user.click(screen.getByRole('tab', { name: 'Planilhas e Relatório' }));
  expect((screen.getByLabelText('Rascunho do relatório') as HTMLInputElement).value).toBe(
    'seleção inventada não enviada',
  );
  expect(mocks.upload).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByText('Nenhum computador registrado.')).toBeNull());
});
