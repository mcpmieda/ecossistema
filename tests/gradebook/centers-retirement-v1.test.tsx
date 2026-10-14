// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GradebookWorkspaceShell,
  GRADEBOOK_WORKSPACE_SURFACES,
} from '../../src/platform/gradebook-workspace-shell';
import { notesSections } from '../../src/platform/notes-module';

vi.mock('../../src/platform/gradebook-year-context', () => ({
  useGradebookYear: () => ({ year: 2026, epoch: 1 }),
}));
vi.mock('../../src/platform/gradebook-year-provider', () => ({
  GradebookYearProvider: ({ children }: { children: ReactNode }) => children,
  GradebookYearContextBanner: () => <span>Ano letivo global sintético</span>,
}));
vi.mock('../../src/features/gradebook/import/import-panel', () => ({
  NotesImportPanel: () => (
    <input aria-label="Importação sintética" defaultValue="lote em andamento" />
  ),
}));
vi.mock('../../src/features/gradebook/audit-workspace/gradebook-audit-surface', () => ({
  GradebookAuditSurface: () => <span>Auditoria sintética</span>,
}));
vi.mock('../../src/features/gradebook/performance/relational-performance-page-v2', () => ({
  RelationalPerformancePageV2: () => <span>Desempenho sintético</span>,
}));
vi.mock('../../src/features/gradebook/settings/gradebook-settings-page-v1', () => ({
  GradebookSettingsPageV1: () => <span>Configurações sintéticas</span>,
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '#/banco-de-notas');
});

describe('retirada da superfície Centrais', () => {
  it('mantém menus e catálogo de navegação consistentes, sem a área removida', () => {
    expect(notesSections.map((section) => section.id)).toEqual(
      GRADEBOOK_WORKSPACE_SURFACES.map((surface) => surface.id),
    );
    expect(
      notesSections.some((section) =>
        /Centrais|Relatórios|area=(?:operational|reports)/u.test(
          `${section.label} ${section.href}`,
        ),
      ),
    ).toBe(false);
    for (const path of [
      'src/platform/gradebook-operational-surface.tsx',
      'src/features/gradebook/operational-workspace/relational-workspace-page-v2.tsx',
      'src/features/gradebook/operational-workspace/use-relational-workspace-v2.ts',
    ])
      expect(existsSync(path), path).toBe(false);
    const detail = readFileSync(
      'src/features/gradebook/performance/performance-student-detail-v2.tsx',
      'utf8',
    );
    expect(detail).not.toMatch(/openCenter|Ver cadastro nas Centrais/u);
  });

  it.each([
    '#/banco-de-notas?area=operational',
    '#/banco-de-notas?area=reports',
    '#banco-de-notas?area=reports',
  ])('abre o favorito antigo %s na Importação sem criar outra entrada no histórico', (hash) => {
    window.history.replaceState(null, '', hash);
    const historyLength = window.history.length;
    render(<GradebookWorkspaceShell />);
    expect(screen.getByRole('region', { name: 'Importação' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Importação' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Centrais' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Relatórios' })).toBeNull();
    expect(window.location.hash).toBe('#/banco-de-notas');
    expect(window.history.length).toBe(historyLength);
  });

  it.each(['operational', 'reports'])(
    'normaliza %s em hashchange simulado sem desmontar a importação em andamento',
    async (retired) => {
      window.history.replaceState(null, '', '#/banco-de-notas');
      render(<GradebookWorkspaceShell />);
      const input = screen.getByLabelText('Importação sintética') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'lote parcialmente processado' } });
      for (const area of ['performance', 'audit']) {
        await act(async () => {
          window.history.replaceState(null, '', `#/banco-de-notas?area=${area}`);
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        });
        expect(
          screen
            .getByRole('tab', { name: area === 'performance' ? 'Desempenho' : 'Auditoria' })
            .getAttribute('aria-selected'),
        ).toBe('true');
        await act(async () => {
          window.history.replaceState(null, '', `#/banco-de-notas?area=${retired}`);
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        });
        expect(window.location.hash).toBe('#/banco-de-notas');
        expect(screen.getByRole('region', { name: 'Importação' })).toBeTruthy();
        expect(screen.getByLabelText('Importação sintética')).toBe(input);
        expect(input.value).toBe('lote parcialmente processado');
        expect(screen.queryByRole('tab', { name: 'Centrais' })).toBeNull();
        expect(screen.queryByRole('tab', { name: 'Relatórios' })).toBeNull();
      }
    },
  );

  it.each(['operational', 'reports'])(
    'não reescreve o endereço de outro módulo com parâmetro %s',
    async (retired) => {
      window.history.replaceState(null, '', '#/banco-de-notas');
      render(<GradebookWorkspaceShell />);
      await act(async () => {
        window.history.replaceState(null, '', `#/painel-do-aluno?area=${retired}`);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      expect(window.location.hash).toBe(`#/painel-do-aluno?area=${retired}`);
    },
  );

  it('preserva o teclado entre as áreas restantes sem foco órfão', async () => {
    // Order of 13/10/2026: Desempenho first, Auditoria beside Configurações.
    window.history.replaceState(null, '', '#/banco-de-notas?area=performance');
    render(<GradebookWorkspaceShell />);
    const first = screen.getByRole('tab', { name: 'Desempenho' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    const next = screen.getByRole('tab', { name: 'Boletins' });
    await waitFor(() => expect(document.activeElement).toBe(next));
    expect(next.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(next, { key: 'End' });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Configurações' })),
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    await waitFor(() => expect(document.activeElement).toBe(first));
  });
});
