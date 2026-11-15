import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotesImportPanel } from '../../../src/features/gradebook/import/import-panel';
import { setupOperationsDomV1 } from '../../student-portal/ui/overview/dom-v1';

/** Issue #1450, 109: after a manual import, one line per workbook saying whether grades went in. */
const { writes, result } = vi.hoisted(() => ({
  writes: (academicRecordVersions: number) => ({
    logicalSources: 0, sourceFileVersions: 0, importBatchVersions: 1, assessmentComponentVersions: 0,
    academicRecordVersions, logicalSourceRecordAssociationVersions: 0, total: academicRecordVersions + 1,
  }),
  result: (id: string) => ({ id, manifest: { fileName: `${id}.xlsb`, sha256: 'a'.repeat(64) }, summary: { fileName: `${id}.xlsb` } }),
}));

vi.mock('../../../src/features/gradebook/import/use-import-batch', () => {
  // One object for every render, like the real hook's stable state.
  const state = {
    authorizationRequired: false,
    cancelMovementReview: vi.fn(),
    confirmMovementReview: vi.fn(),
    diagnosticAuditFailures: {},
    error: null,
    failures: [{ id: 'f', fileName: 'quebrada.xlsx', message: 'Arquivo ilegível.', stage: 'recognition', diagnostic: { code: 'x' } }],
    handleFiles: vi.fn(),
    loading: false,
    pendingPersistenceCount: 0,
    progress: null,
    persistence: {
      novas: { state: 'completed', response: { transportVersion: 9, state: 'applied', summary: { committedWrites: writes(12) } } },
      iguais: { state: 'completed', response: { transportVersion: 9, state: 'no-changes', summary: { committedWrites: writes(0) } } },
      fora: {
        state: 'completed',
        response: {
          transportVersion: 9, state: 'applied', summary: { committedWrites: writes(3) },
          warnings: [{ code: 'student-not-in-relation', classCode: 'SYN-A', number: 7 }],
        },
      },
    },
    results: [result('novas'), result('iguais'), result('fora')],
    resumePendingPersistence: vi.fn(),
    sourceDiagnostics: {
      iguais: [
        { severity: 'blocking-error', code: 'activity-without-maximum', key: 'k1' },
        { severity: 'warning', code: 'source-unavailable', key: 'k2' },
      ],
    },
    timingReportSummary: { runOrdinal: null },
    getTimingReport: () => '',
  };
  return { isMasterRelationResult: () => false, useImportBatch: () => state };
});

beforeEach(setupOperationsDomV1);
afterEach(cleanup);

it('shows one line per workbook and only a link to the Auditoria for its problems', () => {
  render(<NotesImportPanel frequencyClient={{ status: vi.fn(), mutate: vi.fn() } as never} />);
  const rows = Array.from(screen.getByRole('list', { name: 'Planilhas importadas' }).children);
  expect(rows).toHaveLength(4);
  expect(rows[0]?.textContent).toContain('novas.xlsb');
  expect(rows[0]?.textContent).toContain('Notas novas (12)');
  expect(rows[0]?.textContent).not.toContain('Auditoria');
  expect(rows[1]?.textContent).toContain('Sem mudança');
  // Only what the Auditoria keeps is counted: the technical warning is not.
  expect(rows[1]?.textContent).toContain('1 problema · ver na Auditoria');
  expect(rows[1]?.querySelector('a')?.getAttribute('href')).toBe('#/banco-de-notas?area=audit');
  expect(rows[2]?.textContent).toContain('Notas novas (3)');
  expect(rows[2]?.textContent).toContain('1 problema · ver na Auditoria');
  expect(rows[2]?.textContent).not.toContain('Aluno nº 7');
  expect(screen.queryByText(/precisam ser corrigidos|para corrigir/u)).toBeNull();
  expect(rows[3]?.textContent).toContain('quebrada.xlsx');
  expect(rows[3]?.textContent).toContain('Erro');
  expect(screen.queryByText(/SHA-256 /u)).toBeNull();
  expect(screen.queryByText(/lote atômico/u)).toBeNull();
});
