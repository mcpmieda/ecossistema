// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  importAreaSectionsV1,
  mainNavigationAreasV1,
  serviceSectionFromHashV2,
  serviceSectionsV2,
} from '../src/platform/navigation';
import { STUDENT_PORTAL_MODULE } from '../shared/platform-contract';
import {
  portalSectionFromHash,
  withStudentPortalModule,
} from '../src/platform/student-portal-module';

describe('shell navigation of 07/10/2026', () => {
  it('lists the sections of the open service and none for a plain area', () => {
    expect(serviceSectionsV2('painel-do-aluno').map((section) => section.label)).toEqual([
      'Visão geral',
      'Alunos',
      'Políticas',
      'Sessões',
      'Auditoria',
      'Configurações',
    ]);
    expect(serviceSectionsV2('banco-de-notas').map((section) => section.id)).toEqual([
      'performance',
      'bulletins',
      'council',
      'settings',
    ]);
    // Auditoria of the Banco de notas sits under Importação, at its unchanged address.
    expect(importAreaSectionsV1().map((section) => [section.label, section.href])).toEqual([
      ['Importação', '#/banco-de-notas?area=importacao'],
      ['Auditoria', '#/banco-de-notas?area=audit'],
    ]);
    expect(serviceSectionsV2('banco-de-notas').some((section) => section.id === 'reports')).toBe(
      false,
    );
    expect(serviceSectionFromHashV2('banco-de-notas', '#/banco-de-notas?area=reports')).toBe(
      'importacao',
    );
    expect(serviceSectionsV2('configuracoes')).toEqual([]);
    // Auditoria lives inside Saúde do Sistema (owner request of 08/10/2026).
    expect(serviceSectionsV2('operacao').map((section) => [section.label, section.href])).toEqual([
      ['Saúde do Sistema', '#/operacao'],
      ['Auditoria', '#/operacao?area=audit'],
    ]);
    expect(serviceSectionFromHashV2('operacao', '#/operacao')).toBe('health');
    expect(serviceSectionFromHashV2('operacao', '#/operacao?area=audit')).toBe('audit');
  });

  it('reads the section from the address and falls back to the first one of each service', () => {
    expect(serviceSectionFromHashV2('painel-do-aluno', '#/painel-do-aluno?area=sessions')).toBe(
      'sessions',
    );
    // Existing QR addresses keep their Portal context.
    expect(serviceSectionFromHashV2('painel-do-aluno', '#/painel-do-aluno?area=credentials')).toBe(
      'accounts',
    );
    expect(serviceSectionFromHashV2('painel-do-aluno', '#/painel-do-aluno')).toBe('overview');
    expect(serviceSectionFromHashV2('banco-de-notas', '#/banco-de-notas?area=council')).toBe(
      'council',
    );
    expect(serviceSectionFromHashV2('banco-de-notas', '#/banco-de-notas?area=unknown')).toBe(
      'importacao',
    );
  });
});

describe('independent main entries', () => {
  it('preserves legacy Alunos addresses including account identifiers', () => {
    expect(
      portalSectionFromHash(
        '#/painel-do-aluno?area=accounts&aluno=11111111-1111-4111-8111-111111111111',
      ),
    ).toBe('accounts');
    expect(portalSectionFromHash('#/painel-do-aluno?area=accounts&aluno=invalid')).toBe('accounts');
  });
  it('selects only the independent area and keeps existing URLs', () => {
    for (const [route, section, expected] of [
      ['painel-do-aluno', 'reconciliation', 'Conciliação'],
      ['painel-do-aluno', 'accounts', 'Painel do Aluno'],
      ['banco-de-notas', 'importacao', 'Importação'],
      ['banco-de-notas', 'audit', 'Importação'],
      ['banco-de-notas', 'performance', 'Banco de notas'],
    ] as const) {
      const areas = mainNavigationAreasV1([STUDENT_PORTAL_MODULE], route, section);
      expect(areas.filter((area) => area.open).map((area) => area.name)).toEqual([expected]);
      expect(areas.find((area) => area.name === 'Conciliação')?.href).toBe(
        '#/painel-do-aluno?area=reconciliation',
      );
      expect(areas.find((area) => area.name === 'Importação')?.href).toBe(
        '#/banco-de-notas?area=importacao',
      );
    }
  });
  it('inherits Portal visibility and does not add Conciliação for a restricted profile', () => {
    const modules = withStudentPortalModule([STUDENT_PORTAL_MODULE], ['platform.snapshot.read']);
    expect(
      mainNavigationAreasV1(modules, 'banco-de-notas', 'importacao').some(
        (area) => area.name === 'Conciliação',
      ),
    ).toBe(false);
    expect(serviceSectionsV2('painel-do-aluno').some((item) => item.id === 'accounts')).toBe(true);
    expect(serviceSectionsV2('banco-de-notas').some((item) => item.id === 'importacao')).toBe(
      false,
    );
  });
});

describe('shell with a side column and a top bar', () => {
  const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const app = read('src/App.tsx');
  const styles = read('src/styles.css');

  it('opens the phone drawer as a dialog that takes focus, closes on Escape and gives focus back', () => {
    expect(app).toContain("role: 'dialog', 'aria-modal': true");
    expect(app).toContain("if (event.key === 'Escape') setMenuOpen(false);");
    expect(app).toContain("main?.setAttribute('inert', '');");
    expect(app).toContain('menuButtonRef.current?.focus();');
    // A window that grows past phone width closes it, so the page is never left inert.
    expect(app).toContain("window.matchMedia('(min-width: 901px)')");
  });

  // The owner-requested tab appearance is retained with route-link semantics after the audit.
  it('lists only areas in the side column and section links with tab styling in the top bar', () => {
    const navigation = read('src/platform/navigation.tsx');
    const sectionLinks = read('src/platform/section-links-v1.tsx');
    // The bar of the site holds the brand, the search and the profile; the bar of the open area
    // holds its name and its sections.
    expect(app).toMatch(
      /<div className="shell-areabar">\s+<ShellSectionTabsV1 route=\{route\} section=\{section\} modules=\{modules\} \/>/u,
    );
    expect(navigation).toContain(
      '<SectionLinksV1 label={`Seções de ${area.name}`} section={section} sections={sections} />',
    );
    expect(sectionLinks).toContain('className="tabs tabs--secondary shell-sections__tabs"');
    expect(sectionLinks).toContain('href={item.href}');
    expect(sectionLinks).toContain("aria-current={selected ? 'page' : undefined}");
    expect(sectionLinks).not.toContain('aria-controls');
    expect(navigation).not.toContain('shell-side__sections');
    expect(styles).not.toContain('.shell-side__search');
    // On a computer the bar of the site spans the window and the column sits under it.
    expect(styles).toMatch(
      /\.platform-shell--v2 \.shell-aside \{\n\s+position: relative;\n\s+top: auto;\n\s+grid-row: 1 \/ span 3;/u,
    );
  });

  it('drops a matrix search when its field is hidden on phones', () => {
    const matrix = read('src/features/gradebook/performance/performance-result-matrix-v2.tsx');
    expect(styles).toContain('.performance-matrix-filters .search-field {\n    display: none;');
    expect(matrix).toContain("window.matchMedia('(max-width: 640px)')");
    expect(matrix).toContain("if (narrow.matches) setQuery('');");
  });
});
