import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Performance dashboard V5 HeroUI', () => {
  const page = source('src/features/gradebook/performance/relational-performance-page-v2.tsx');
  const widgets = source('src/features/gradebook/performance/performance-dashboard-widgets-v5.tsx');
  const analysis = source('src/features/gradebook/performance/performance-analysis-panel-v3.tsx');
  const grid = source('src/features/gradebook/performance/performance-grid-v2.tsx');
  const matrix = source('src/features/gradebook/performance/performance-result-matrix-v2.tsx');
  const display = source('src/features/gradebook/performance/performance-display-v2.tsx');
  const styles = source('src/styles.css');
  const shell = source('src/platform/gradebook-workspace-shell.tsx');
  const service = source(
    'server/gradebook/application/read-models/performance/performance-dashboard-v5.ts',
  );

  it('uses HeroUI selects and keeps the lens geometry stable while loading', () => {
    expect(page).toMatch(/\bLabel,\s+ListBox,\s+Select/u);
    expect(page).toMatch(/<Select\s+ref=\{root\}\s+data-performance-select=\{id\}\s+selectedKey=/u);
    expect(page).toContain('isOpen={isOpen}');
    expect(page).toContain('onOpenChange={(open) => onOpenChange(id, open)}');
    expect(page).toContain("document.addEventListener('pointerdown', closeOutside, true)");
    expect(page).toContain("target.closest<HTMLElement>('[data-performance-select]')");
    expect(page).toContain('<Select.Popover isNonModal data-performance-select-popover={id}>');
    expect(page).not.toContain('<select');
    expect(page).toContain('performance-lens-tabs');
    expect(page).toContain('<Tabs.ListContainer className="h-10');
    expect(page).toContain('className="min-w-28"');
    expect(page).toContain('<div className="performance-lens-status"');
    expect(styles).toContain('.performance-lens-tabs > .tabs__list-container');
    expect(styles).toContain('.performance-lens-panel.tabs__panel {');
    expect(styles).toContain('margin-top: 0.25rem');
  });

  it('removes the redundant workspace hero while preserving accessible stable navigation', () => {
    expect(shell).toMatch(
      /className="sr-only">\s*\{activeSurface === 'importacao' \? 'Importação' : 'Banco de notas'\}\s*<\/h2>/u,
    );
    expect(shell).not.toContain('Áreas do Banco de notas</h2>');
    expect(shell).toContain('gradebook-area-tabs max-w-full overflow-x-auto');
    expect(shell).toContain('role="tablist"');
  });

  it('renders the requested blue/red bars and class donut from server aggregates', () => {
    for (const label of [
      'Situação por componente',
      'Panorama da turma',
      'No mínimo ou acima',
      'Abaixo do mínimo',
      'Ainda sem classificação',
    ]) {
      expect(widgets).toContain(label);
    }
    expect(widgets).toContain('value.overview.columns.map');
    expect(widgets).toContain('dashboardAnalysisV5');
    expect(widgets).not.toContain('minimumApprovalMilli');
    expect(widgets).not.toContain('valueMilli >=');
    expect(service).toContain('buildPerformanceDashboardOverviewV5');
    expect(service).toContain("bucket === 'below'");
    expect(service).toContain("buckets.every((bucket) => bucket === 'above')");
  });

  it('keeps color-independent labels and lists the students of the chosen bar without filtering the matrix', () => {
    expect(widgets).toContain('aria-label={`${title}: ${count} estudante(s)');
    expect(widgets).toContain('aria-pressed={active}');
    // Either bar lists its own students inside the card (owner request of 15/10/2026).
    expect(widgets).toContain('selectedColumn?.summary.groups[selectedBucket]');
    expect(widgets).toContain('className="performance-ranking__open"');
    expect(analysis).not.toContain('Selecione uma barra para ver');
    expect(analysis).not.toContain('dois grupos');
    expect(analysis).toContain("const ids = selection?.kind === 'group'");
    expect(page).toContain('renderResult={(ids)');
  });

  it('keeps status selection in the matrix header and partial markers out of the row flow', () => {
    expect(page).not.toContain('SlidersHorizontal');
    expect(matrix).toContain('<FilterTagsV1');
    expect(matrix).toContain('if (selected.length > 0) onStatusesChange(selected);');
    expect(matrix).toContain('performance-matrix-header');
    expect(matrix).not.toContain('Situação dos estudantes por componente curricular');
    expect(display).toContain('absolute -right-2 -top-1');
    expect(styles).toContain('height: 2.25rem');
    expect(styles).toContain('align-items: stretch');
    expect(widgets).not.toContain('Na lente Resultado');
  });

  it('keeps columns in server order and removes every manual drag/resize affordance', () => {
    expect(grid).toContain('<Table.ScrollContainer');
    expect(grid).not.toContain('ResizableContainer');
    expect(grid).not.toContain('ColumnResizer');
    expect(grid).not.toMatch(/drag|sortable|dnd/iu);
  });
});
