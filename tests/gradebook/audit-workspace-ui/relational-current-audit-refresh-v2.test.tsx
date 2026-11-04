// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RelationalCurrentAuditPageV2 } from '../../../src/features/gradebook/audit-workspace/relational-current-audit-page-v2';
import { listGradebookImportDiagnosticsAuditV1 } from '../../../src/features/gradebook/import/import-diagnostics-client-v1';
import { requestImportDiagnosticTreatmentV1 } from '../../../src/features/gradebook/audit-workspace/import-diagnostic-treatment-client-v1';
import { LiveRefreshAutomaticV1Provider } from '../../../src/shared/live-data/live-refresh-scope-v1';
import { mockSecureJitterV1 } from '../../live-data/secure-jitter-fixture';

vi.mock('../../../src/platform/gradebook-year-context', () => ({
  useGradebookYear: () => ({ year: 2026 }),
}));
vi.mock('../../../src/features/gradebook/import/import-diagnostics-client-v1');
vi.mock('../../../src/features/gradebook/audit-workspace/import-diagnostic-treatment-client-v1');

const finding = {
  id: 1,
  academicYear: 2026,
  fileName: 'SINTETICO.xlsx',
  studentName: null,
  firstObservedAt: '2026-10-01T12:00:00.000Z',
  lastObservedAt: '2026-10-02T12:00:00.000Z',
  observations: 1,
  key: 'synthetic-key',
  severity: 'warning',
  code: 'invalid-text',
  message: 'Texto sintético em campo de nota.',
  recommendedAction: 'Corrija a célula sintética.',
  fieldKind: 'assessment',
} as const;
const acknowledged = {
  id: 7,
  diagnosticSourceId: 1,
  academicYear: 2026,
  fileName: 'SINTETICO.xlsx',
  diagnosticHash: 'a'.repeat(64),
  key: 'synthetic-key',
  severity: 'warning',
  code: 'invalid-text',
  classCode: null,
  subject: null,
  period: null,
  studentNumber: null,
  studentName: null,
  fieldKind: 'assessment',
  fieldLabel: null,
  action: 1,
  actionLabel: 'RECONHECIDO',
  note: null,
  recordedAt: '2026-10-03T12:00:00.000Z',
  current: true,
} as const;
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
beforeEach(() => {
  vi.useFakeTimers();
  mockSecureJitterV1(0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('a background read keeps the recorded treatment on screen while it is read again', async () => {
  vi.mocked(listGradebookImportDiagnosticsAuditV1).mockResolvedValue({
    version: 1,
    state: 'ready',
    items: [finding],
    nextOffset: null,
  } as never);
  let release: (() => void) | null = null;
  vi.mocked(requestImportDiagnosticTreatmentV1).mockImplementation(
    () =>
      new Promise((resolve) => {
        const answer = () => resolve({ contractVersion: 1, state: 'ready', operation: 'context', items: [acknowledged] } as never);
        if (release === null) answer();
        else release = answer;
      }),
  );
  render(
    <LiveRefreshAutomaticV1Provider enabled={false}>
      <RelationalCurrentAuditPageV2 />
    </LiveRefreshAutomaticV1Provider>,
  );
  await advance(50);
  const chip = screen.getAllByText('Reconhecido');
  expect(chip.length).toBeGreaterThan(0);
  release = () => undefined;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await advance(300);
  expect(vi.mocked(listGradebookImportDiagnosticsAuditV1)).toHaveBeenCalledTimes(2);
  expect(vi.mocked(requestImportDiagnosticTreatmentV1)).toHaveBeenCalledTimes(2);
  // The second treatment answer is still on its way.
  expect(screen.queryByText(/Carregando o tratamento humano/)).toBeNull();
  expect(screen.getAllByText('Reconhecido')).toHaveLength(chip.length);
  expect(screen.getByRole('button', { name: /Adicionar anotação/ }).hasAttribute('disabled')).toBe(false);
  (release as () => void)();
  await advance(50);
  expect(screen.getAllByText('Reconhecido')).toHaveLength(chip.length);
});

it('a background read covers the findings already loaded instead of going back to the first 50', async () => {
  const findings = Array.from({ length: 60 }, (_, index) => ({
    ...finding,
    id: index + 1,
    key: `synthetic-key-${index + 1}`,
  }));
  vi.mocked(listGradebookImportDiagnosticsAuditV1).mockImplementation(async (input) => {
    const offset = input?.offset ?? 0,
      limit = input?.limit ?? 50;
    const items = findings.slice(offset, offset + limit);
    return {
      version: 1,
      state: 'ready',
      items,
      nextOffset: offset + limit < findings.length ? offset + limit : null,
    } as never;
  });
  vi.mocked(requestImportDiagnosticTreatmentV1).mockResolvedValue({
    contractVersion: 1,
    state: 'ready',
    operation: 'context',
    items: [],
  } as never);
  render(
    <LiveRefreshAutomaticV1Provider enabled={false}>
      <RelationalCurrentAuditPageV2 />
    </LiveRefreshAutomaticV1Provider>,
  );
  await advance(50);
  await act(async () => {
    screen.getByRole('button', { name: /Carregar mais 50/ }).click();
  });
  await advance(50);
  const loaded = () =>
    screen.getByText('achados carregados nesta sessão').previousElementSibling?.textContent;
  expect(loaded()).toBe('60');
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await advance(300);
  expect(vi.mocked(listGradebookImportDiagnosticsAuditV1).mock.lastCall?.[0]).toMatchObject({
    offset: 0,
    limit: 60,
  });
  expect(loaded()).toBe('60');
  expect(screen.queryByRole('button', { name: /Carregar mais 50/ })).toBeNull();
});
