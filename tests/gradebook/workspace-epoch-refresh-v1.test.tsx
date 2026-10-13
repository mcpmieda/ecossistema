// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GradebookWorkspaceShell } from '../../src/platform/gradebook-workspace-shell';

const probe = vi.hoisted(() => ({
  epoch: 0,
  year: 2026,
  reads: [] as { area: string; year: number }[],
  importMounts: 0,
}));
vi.mock('../../src/platform/gradebook-year-context', () => ({
  useGradebookYear: () => ({
    year: probe.year,
    epoch: probe.epoch,
  }),
}));
vi.mock('../../src/platform/gradebook-year-provider', () => ({
  GradebookYearProvider: ({ children }: { children: ReactNode }) => children,
  GradebookYearContextBanner: () => null,
}));
vi.mock('../../src/features/gradebook/import/import-panel', async () => {
  const { useEffect } = await import('react');
  return {
    NotesImportPanel() {
      useEffect(() => {
        probe.importMounts++;
      }, []);
      return (
        <input aria-label="Importação sintética em andamento" defaultValue="lote em leitura" />
      );
    },
  };
});
vi.mock('../../src/features/gradebook/audit-workspace/gradebook-audit-surface', async () => {
  const { useEffect } = await import('react');
  return {
    GradebookAuditSurface() {
      useEffect(() => {
        probe.reads.push({ area: 'audit', year: probe.year });
      }, []);
      return <div data-testid="synthetic-audit">Auditoria sintética</div>;
    },
  };
});
vi.mock('../../src/features/gradebook/performance/relational-performance-page-v2', async () => {
  const { useEffect } = await import('react');
  return {
    RelationalPerformancePageV2() {
      useEffect(() => {
        probe.reads.push({ area: 'performance', year: probe.year });
      }, []);
      return <div data-testid="synthetic-performance">Desempenho sintético</div>;
    },
  };
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '#/banco-de-notas');
});

it('loads only the active academic area in a new year and preserves an already mounted import', async () => {
  window.history.replaceState(null, '', '#/banco-de-notas');
  const view = render(<GradebookWorkspaceShell />);
  const importInput = screen.getByLabelText(
    'Importação sintética em andamento',
  ) as HTMLInputElement;
  fireEvent.change(importInput, { target: { value: 'lote parcialmente processado' } });
  expect(screen.getByRole('region', { name: 'Importação' })).toBeTruthy();
  expect(screen.queryByRole('tablist', { name: 'Áreas do Banco de notas' })).toBeNull();
  await act(async () => {
    window.location.hash = '#/banco-de-notas?area=audit';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await waitFor(() => expect(probe.reads).toEqual([{ area: 'audit', year: 2026 }]));
  expect(screen.getByRole('tabpanel', { name: 'Auditoria' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Banco de notas' })).toBeTruthy();
  expect(importInput.closest('[hidden]')).not.toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Desempenho' }));
  await waitFor(() => expect(probe.reads).toHaveLength(2));

  await act(async () => {
    probe.year = 2027;
    probe.epoch++;
    view.rerender(<GradebookWorkspaceShell />);
  });
  await waitFor(() =>
    expect(probe.reads).toEqual([
      { area: 'audit', year: 2026 },
      { area: 'performance', year: 2026 },
      { area: 'performance', year: 2027 },
    ]),
  );
  expect(screen.queryByTestId('synthetic-audit')).toBeNull();
  expect(screen.getByLabelText('Importação sintética em andamento')).toBe(importInput);
  expect(importInput.value).toBe('lote parcialmente processado');
  expect(probe.importMounts).toBe(1);
  expect(window.location.hash).toBe('#/banco-de-notas?area=performance');

  fireEvent.click(screen.getByRole('tab', { name: 'Auditoria' }));
  await waitFor(() => expect(probe.reads).toHaveLength(4));
  expect(probe.reads.at(-1)).toEqual({ area: 'audit', year: 2027 });
  expect(probe.importMounts).toBe(1);
  expect(importInput.value).toBe('lote parcialmente processado');
  await act(async () => {
    window.location.hash = '#/banco-de-notas?area=importacao';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(screen.getByRole('region', { name: 'Importação' })).toBeTruthy();
  expect(screen.queryByRole('tablist', { name: 'Áreas do Banco de notas' })).toBeNull();
  expect(screen.getByLabelText('Importação sintética em andamento')).toBe(importInput);
  expect(importInput.closest('[hidden]')).toBeNull();
  expect(importInput.value).toBe('lote parcialmente processado');
  expect(probe.importMounts).toBe(1);
  expect(probe.reads).toHaveLength(4);
});
