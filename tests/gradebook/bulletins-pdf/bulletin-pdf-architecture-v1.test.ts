// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('Boletins PDF arquitetura V1', () => {
  const service = source('server/gradebook/application/bulletins/relational-bulletin-v2.ts');
  const snapshots = source(
    'server/gradebook/persistence/postgres/relational-bulletin-snapshot-v2.ts',
  );
  const page = source('src/features/gradebook/bulletins/relational-bulletin-page-v2.tsx');
  const actions = source('src/features/gradebook/bulletins/pdf/bulletin-pdf-actions-v2.ts');
  const renderer = source('src/features/gradebook/bulletins/pdf/bulletin-pdf-renderer-v2.ts');

  it('ancora PDF oficial no snapshot V2 recebido da emissão relacional', () => {
    expect(service).toContain('snapshot: RelationalBulletinSnapshotV2');
    expect(snapshots).toContain('snapshot_json AS payload_json');
    expect(page).toContain("{ mode: 'emission', snapshot: emitted.snapshot }");
    expect(page).toContain("runPdf('download')");
    expect(page).toContain("runPdf('print')");
    expect(actions).toContain('runRelationalBulletinPdfActionV2');
    expect(renderer).toContain('buildRelationalBulletinPdfLinesV2(snapshot)');
  });

  it('mantém reimpressão histórica sem leitura/materialização acadêmica atual nem nova versão', () => {
    expect(service).toContain('dependencies.snapshots.get(');
    expect(service).toContain('request.snapshotId');
    expect(service).toContain('request.snapshotVersion');
    expect(service).toContain("source: 'historical-snapshot'");
    expect(page).toContain("{ mode: 'reprint', snapshot: response.snapshot }");
    const repositoryGet =
      snapshots
        .split('async get(snapshotId, snapshotVersion)')[1]
        ?.split('async append(input)')[0] ?? '';
    expect(repositoryGet).not.toMatch(/instrumento|nota|fechamento|materialize/u);
    expect(repositoryGet).not.toContain('INSERT');
  });

  it('não cria segundo bridge nem geração server-side para PDF', () => {
    expect(renderer).not.toContain('/api/gradebook/');
    expect(renderer).not.toContain('fetch(');
    expect(actions).toContain('URL.createObjectURL');
    expect(actions).toContain('URL.revokeObjectURL');
  });

  it('preserva os mesmos campos semânticos entre preview e PDF sem recalcular', () => {
    for (const field of [
      'sourceAmMilli',
      'calculatedAmMilli',
      'quantitative.consideredMilli',
      'qualitativeMilli',
      'sourceUMilli',
      'recoveryTerms',
      'classification',
    ]) {
      expect(page).toContain(field);
      expect(renderer).toContain(field);
    }
    expect(renderer).toContain('term.quantitative.originalMilli');
    expect(renderer).toContain('term.quantitative.parallelMilli');
  });

  it('preserva fallback: erro do renderer não destrói preview/modelo na tela', () => {
    const pdfActionSection =
      page.split('const runPdf = async')[1]?.split('const selectedStudents')[0] ?? '';
    expect(pdfActionSection).toContain('setPdfNotice(`PDF indisponível');
    expect(pdfActionSection).toContain('O snapshot permanece legível na tela');
    expect(pdfActionSection).not.toContain('setArtifact(null)');
  });
  it('codifica as páginas sem toBlob, que no ADM entrega JPEG com ~1 s de atraso', () => {
    const rasterizer = source('src/features/gradebook/bulletins/pdf/bulletin-pdf-engine.ts');
    expect(rasterizer).not.toMatch(/\.toBlob\(/u);
    expect(rasterizer).toContain("toDataURL('image/jpeg', 0.9)");
  });
});
