import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(path, 'utf8');

describe('relational current Audit UI V2', () => {
  const surface = source('src/features/gradebook/audit-workspace/gradebook-audit-surface.tsx');
  const page = source(
    'src/features/gradebook/audit-workspace/relational-current-audit-page-v2.tsx',
  );

  it('mounts only the current relational diagnostic experience', () => {
    expect(surface).toContain('<RelationalCurrentAuditPageV2 />');
    expect(surface).not.toContain('AuditWorkspacePage');
    expect(surface).not.toContain('ImportDiagnosticsAuditPanelV1');
    expect(page).toContain('listGradebookImportDiagnosticsAuditV1');
    expect(page).toContain('academicYear: year');
    expect(page).toContain("Ano letivo {year ?? '—'}");
    expect(page).toContain('useGradebookYear');
  });

  it('is read only: the next import clears a problem, the screen corrects nothing', () => {
    expect(page).toContain('a próxima importação tira o problema da lista');
    expect(page).not.toContain('requestImportDiagnosticTreatmentV1');
    expect(page).not.toContain('Reconhecer');
    expect(page).not.toContain('requestAuditWorkspaceResolutionV1');
    expect(page).not.toContain('requestDeterministicCorrectionExecutionV2');
    expect(page).not.toContain('Marcar como resolvido');
  });

  it('uses HeroUI tabs without a native select or academic browser storage', () => {
    expect(page).toContain("from '@heroui/react'");
    expect(page).toContain('<Tabs');
    expect(page).not.toMatch(/<select\b/u);
    expect(page).not.toContain('localStorage');
    expect(page).not.toContain('sessionStorage');
  });
});
