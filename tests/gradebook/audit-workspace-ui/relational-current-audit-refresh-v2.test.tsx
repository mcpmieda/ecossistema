// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RelationalCurrentAuditPageV2 } from '../../../src/features/gradebook/audit-workspace/relational-current-audit-page-v2';
import { listGradebookImportDiagnosticsAuditV1 } from '../../../src/features/gradebook/import/import-diagnostics-client-v1';
import { LiveRefreshAutomaticV1Provider } from '../../../src/shared/live-data/live-refresh-scope-v1';
import { mockSecureJitterV1 } from '../../live-data/secure-jitter-fixture';

vi.mock('../../../src/platform/gradebook-year-context', () => ({
  useGradebookYear: () => ({ year: 2026 }),
}));
vi.mock('../../../src/features/gradebook/import/import-diagnostics-client-v1');

const finding = {
  id: 1,
  academicYear: 2026,
  fileName: 'SINTETICO.xlsb',
  studentName: null,
  firstObservedAt: '2026-10-01T12:00:00.000Z',
  lastObservedAt: '2026-10-02T12:00:00.000Z',
  observations: 1,
  key: 'synthetic-key',
  severity: 'blocking-error',
  code: 'invalid-text',
  message: 'Texto sintético em campo de nota.',
  recommendedAction: 'Corrija a célula sintética.',
  fieldKind: 'assessment',
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function serve(findings: readonly object[]) {
  vi.mocked(listGradebookImportDiagnosticsAuditV1).mockImplementation(async (input) => {
    const offset = input?.offset ?? 0,
      limit = input?.limit ?? 50;
    return {
      version: 1,
      state: 'ready',
      items: findings.slice(offset, offset + limit),
      nextOffset: offset + limit < findings.length ? offset + limit : null,
    } as never;
  });
}

it('reads every page and shows one tab per problem with its count', async () => {
  serve([
    ...Array.from({ length: 230 }, (_, index) => ({ ...finding, id: index + 1, key: `k${index}` })),
    { ...finding, id: 999, key: 'w', severity: 'warning', code: 'grade-without-student' },
  ]);
  render(
    <LiveRefreshAutomaticV1Provider enabled={false}>
      <RelationalCurrentAuditPageV2 />
    </LiveRefreshAutomaticV1Provider>,
  );
  await advance(50);
  expect(vi.mocked(listGradebookImportDiagnosticsAuditV1)).toHaveBeenCalledTimes(2);
  const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
  expect(tabs).toEqual(['Texto no lugar de nota230', 'Nota sem aluno1']);
  expect(screen.getByText('230 não lançado(s)')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Mostrar mais \(130\)/ })).toBeTruthy();
});

it('a background read keeps the list and refreshes it in place', async () => {
  serve([finding]);
  render(
    <LiveRefreshAutomaticV1Provider enabled={false}>
      <RelationalCurrentAuditPageV2 />
    </LiveRefreshAutomaticV1Provider>,
  );
  await advance(50);
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  serve([]);
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await advance(300);
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
  expect(screen.getByText('Nenhum problema')).toBeTruthy();
});
