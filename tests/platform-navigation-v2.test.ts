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
import { notesModule, withNotesAccessV1 } from '../src/platform/notes-module';
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
      'council',
      'settings',
    ]);
    // The Importação's tabs (20/11/2026): OneDrive, Auditoria, Importação manual and Conciliação.
    expect(importAreaSectionsV1().map((section) => [section.label, section.href])).toEqual([
      ['OneDrive', '#/banco-de-notas?area=onedrive'],
      ['Auditoria', '#/banco-de-notas?area=audit'],
      ['Importação manual', '#/banco-de-notas?area=importacao'],
      ['Conciliação', '#/banco-de-notas?area=reconciliation'],
    ]);
    expect(serviceSectionsV2('banco-de-notas').some((section) => section.id === 'reports')).toBe(
      false,
    );
    expect(serviceSectionFromHashV2('banco-de-notas', '#/banco-de-notas?area=reports')).toBe(
      'importacao',
    );
    expect(serviceSectionsV2('configuracoes')).toEqual([]);
    // The platform's SharePoint Auditoria was retired (owner decision, #1473).
    expect(serviceSectionsV2('operacao').map((section) => [section.label, section.href])).toEqual([
      ['Saúde', '#/operacao'],
    ]);
    expect(serviceSectionFromHashV2('operacao', '#/operacao')).toBe('health');
    expect(serviceSectionFromHashV2('operacao', '#/operacao?area=audit')).toBe('health');
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
  it('selects only the open area: the Conciliação is a tab of the Importação', () => {
    for (const [route, section, expected] of [
      ['banco-de-notas', 'reconciliation', 'Importação'],
      ['painel-do-aluno', 'accounts', 'Painel do Aluno'],
      ['banco-de-notas', 'importacao', 'Importação'],
      ['banco-de-notas', 'audit', 'Importação'],
      ['banco-de-notas', 'performance', 'Banco de notas'],
    ] as const) {
      const areas = mainNavigationAreasV1([STUDENT_PORTAL_MODULE, notesModule], route, section);
      expect(areas.filter((area) => area.open).map((area) => area.name)).toEqual([expected]);
      expect(areas.map((area) => area.name)).toEqual([
        'Banco de notas',
        'Importação',
        'Painel do Aluno',
      ]);
      // The Importação opens on its first tab.
      expect(areas.find((area) => area.name === 'Importação')?.href).toBe(
        '#/banco-de-notas?area=onedrive',
      );
    }
  });
  it('shows the Conciliação tab only with the Painel do Aluno grant its operations require', () => {
    const modules = withNotesAccessV1(
      withStudentPortalModule([STUDENT_PORTAL_MODULE, notesModule], ['area.importacao']),
      ['area.importacao'],
    );
    const importArea = mainNavigationAreasV1(modules, 'banco-de-notas', 'importacao').find(
      (area) => area.name === 'Importação',
    );
    expect(importArea?.sections.map((item) => item.id)).toEqual([
      'onedrive',
      'audit',
      'importacao',
    ]);
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
});
