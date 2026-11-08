import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('Boletins relacionais HeroUI V2', () => {
  const page = source('src/features/gradebook/bulletins/relational-bulletin-page-v2.tsx');
  const client = source('src/features/gradebook/bulletins/relational-bulletin-client-v2.ts');
  const service = source('server/gradebook/application/bulletins/relational-bulletin-v2.ts');
  const snapshots = source(
    'server/gradebook/persistence/postgres/relational-bulletin-snapshot-v2.ts',
  );
  const actions = source('src/features/gradebook/bulletins/pdf/bulletin-pdf-actions-v2.ts');
  const shell = source('src/platform/gradebook-workspace-shell.tsx');
  const functions = source('functions/[[path]].ts');

  it('usa o ano global e mantém seleção explícita de turma, aluno, período e detalhe', () => {
    expect(page).toContain('useGradebookYear');
    expect(page).toContain('year: year!');
    expect(page).toContain('Selecione a turma');
    expect(page).toContain('Aluno da prévia');
    expect(page).toContain('1º trimestre');
    expect(page).toContain('Anual + REC');
    expect(page).toContain('Com instrumentos');
    expect(page).not.toMatch(/ano anterior|criar ano|comparação entre anos/iu);
  });

  it('apresenta AM/U importadas ao lado do cálculo nativo descritivo sem fórmulas no browser', () => {
    expect(service).toContain("officialValues: 'imported-source'");
    expect(service).toContain("calculatedValues: 'descriptive-comparison'");
    expect(page).toContain('AM oficial');
    expect(page).toContain('sourceAmMilli');
    expect(page).toContain('calculatedAmMilli');
    expect(page).toContain('sourceUMilli');
    expect(page).toContain('recoveryTerms');
    expect(page).not.toContain('maximum *');
    expect(page).not.toContain('cutoff');
  });

  it('emite individual/lote limitados e reimprime apenas o snapshot histórico', () => {
    expect(page).toContain('Emitir individual');
    expect(page).toContain('Emitir lote');
    expect(page).toContain('RELATIONAL_BULLETIN_LIMITS_V2.batchStudents');
    expect(page).toContain("operation: 'history'");
    expect(page).toContain("operation: 'reprint'");
    expect(service).toContain("source: 'historical-snapshot'");
    expect(snapshots).toContain('ORDER BY versao DESC');
  });

  it('usa controles HeroUI estáveis, foco, anúncios e nenhum contrato de arraste', () => {
    expect(page).toContain("from '@heroui/react'");
    expect(page).toContain('<Select');
    expect(page).not.toContain('<select');
    expect(page).toContain('<Table');
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain('tabIndex={-1}');
    expect(page).toContain('artifactHeading.current?.focus()');
    expect(page).not.toContain('draggable=');
    expect(page).toContain('AbortController');
  });

  it('oferece PDF oficial apenas para snapshot persistido por renderer lazy no browser', () => {
    expect(page).toContain("artifact.mode !== 'preview'");
    expect(page).toContain('Baixar PDF oficial');
    expect(page).toContain('Imprimir PDF oficial');
    expect(actions).toContain("await import('./bulletin-pdf-renderer-v2')");
    expect(actions).not.toContain('/api/gradebook/');
  });

  it('mantém o shell lazy e o bridge autorizado/no-store existente', () => {
    expect(client).toContain("const ENDPOINT = '/api/gradebook/bulletins'");
    expect(client).toContain("cache: 'no-store'");
    expect(shell).toContain("import('../features/gradebook/bulletins/relational-bulletin-page-v2')");
    expect(functions.match(/handleBulletinRequestV1/gu)).toHaveLength(2);
  });
});
