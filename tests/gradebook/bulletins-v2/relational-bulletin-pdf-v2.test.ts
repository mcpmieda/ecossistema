import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RelationalBulletinSnapshotV2 } from '../../../shared/gradebook-contracts/bulletins/relational-bulletin-v2';
import { relationalBulletinPdfFilenameV2 } from '../../../src/features/gradebook/bulletins/pdf/bulletin-pdf-actions-v2';
import {
  buildRelationalBulletinPdfLinesV2,
  inspectRelationalBulletinPdfV2,
} from '../../../src/features/gradebook/bulletins/pdf/bulletin-pdf-renderer-v2';

function fixture(): RelationalBulletinSnapshotV2 {
  return {
    snapshotId: '11111111-1111-4111-8111-111111111111',
    snapshotVersion: 3,
    dataVersion: 'data-v3',
    emittedAt: '2026-09-11T12:00:00.000Z',
    presentation: { locale: 'pt-BR', dateStyle: 'long' },
    model: {
      contractVersion: 2,
      modelVersion: 2,
      year: 2026,
      period: { kind: 'annual' },
      detail: 'detailed',
      authority: {
        officialValues: 'imported-source',
        calculatedValues: 'descriptive-comparison',
        formalDecision: 'human-recorded-only',
      },
      readAt: '2026-09-11T11:59:00.000Z',
      classGroup: { id: 10, code: '6A', name: '6º ANO A' },
      student: {
        id: 20,
        number: 7,
        name: 'ÁLVARO JOSÉ ÇÃ',
        statusCode: null,
        statusLabel: 'REGULAR',
      },
      subjects: [
        {
          offerId: 30,
          subject: { id: 40, label: 'PORTUGUÊS', abbreviation: 'P' },
          teacher: { id: 50, label: 'DOCENTE UM' },
          terms: [
            {
              term: 1,
              maximumMilli: 30_000,
              sourceAmMilli: 25_000,
              calculatedAmMilli: 24_000,
              comparison: 'mismatch',
              quantitative: {
                originalMilli: 18_000,
                parallelMilli: 20_000,
                parallelApplicable: true,
                consideredMilli: 20_000,
              },
              qualitativeMilli: 4_000,
              coverage: {
                complete: true,
                requiredSlots: [1, 2, 11],
                resolvedSlots: [1, 2, 11],
                missingSlots: [],
                reasons: [],
              },
              warningCodes: [],
              instruments: [
                {
                  id: 60,
                  term: 1,
                  slot: 1,
                  label: 'AVALIAÇÃO ESCRITA',
                  maximumMilli: 6_750,
                  valueMilli: 6_000,
                },
              ],
            },
          ],
          annual: {
            originalTotalMilli: 84_000,
            sourceUMilli: null,
            calculatedPostRecoveryMilli: null,
            comparison: 'unavailable',
            recoveryRequired: true,
            recoveryTerms: [
              { term: 1, applicable: true, source: 'NC', replacementMilli: null },
              { term: 2, applicable: false, source: null, replacementMilli: null },
              { term: 3, applicable: true, source: 12_000, replacementMilli: 40_000 },
            ],
            classification: 'failed-no-show',
            warningCodes: [],
          },
        },
      ],
      overall: {
        calculatedResult: 'REPROVADO POR NÃO COMPARECIMENTO',
        formalCouncilDecision: null,
        visibleResult: 'REPROVADO POR NÃO COMPARECIMENTO',
      },
      emissionReadiness: { ready: true, reasons: [] },
    },
  };
}

function renderedText(snapshot = fixture()): string {
  return buildRelationalBulletinPdfLinesV2(snapshot)
    .flatMap((line) => (line.kind === 'text' ? [line.text] : []))
    .join('\n');
}

describe('relational bulletin PDF V2', () => {
  it('uses only the canonical snapshot and preserves source, comparison, composition and N/C', () => {
    const text = renderedText();
    expect(inspectRelationalBulletinPdfV2(fixture())).toEqual({ status: 'ready' });
    expect(text).toContain('AM oficial: 25 · cálculo comparativo: 24 · DIVERGE');
    expect(text).toContain('quantitativo original 18');
    expect(text).toContain('U oficial: —');
    expect(text).toContain('REC: 1º N/C · 2º — · 3º 12');
    expect(text).toContain('REPROVADO POR NÃO COMPARECIMENTO');
    expect(text).toContain('AVALIAÇÃO ESCRITA · nota 6 / 6,75');
    // No internal ids or engine wording on a printed bulletin.
    expect(text).not.toContain('Snapshot:');
    expect(text).not.toContain('Autoridade:');
    expect(text).not.toContain('nativo');
  });

  it('keeps ASSISTIDO grades visible without creating a general result', () => {
    const snapshot = fixture();
    const assisted: RelationalBulletinSnapshotV2 = {
      ...snapshot,
      model: {
        ...snapshot.model,
        student: { ...snapshot.model.student, statusCode: 2, statusLabel: 'ASSISTIDO' },
        overall: { calculatedResult: null, formalCouncilDecision: null, visibleResult: null },
      },
    };
    const text = renderedText(assisted);
    expect(text).toContain('AM oficial: 25');
    expect(text).toContain('SEM RESULTADO GERAL');
    expect(text).toContain('ASSISTIDO: notas exibidas sem resultado geral.');
  });

  it('sanitizes the local filename and lazy-loads the browser renderer without HTTP', () => {
    const snapshot = fixture();
    const unsafe: RelationalBulletinSnapshotV2 = {
      ...snapshot,
      model: {
        ...snapshot.model,
        student: { ...snapshot.model.student, name: '../Álvaro\r\nPDF' },
        classGroup: { ...snapshot.model.classGroup, name: '6/A\\B:*?"<>|' },
      },
    };
    const filename = relationalBulletinPdfFilenameV2(unsafe);
    expect(filename).toMatch(/^boletim-/u);
    expect(filename).toMatch(/-anual-rec-v3\.pdf$/u);
    expect(filename).not.toMatch(/[\r\n\\/:*?"<>|]/u);
    const actions = readFileSync(
      'src/features/gradebook/bulletins/pdf/bulletin-pdf-actions-v2.ts',
      'utf8',
    );
    expect(actions).toContain("await import('./bulletin-pdf-renderer-v2')");
    expect(actions).not.toContain('/api/gradebook/');
    expect(actions).not.toContain('localStorage');
  });

  it('fails closed for an incoherent snapshot instead of rendering guessed values', () => {
    expect(inspectRelationalBulletinPdfV2({ ...fixture(), snapshotVersion: 0 })).toEqual({
      status: 'invalid-input',
      reason: 'canonical-snapshot-required',
    });
  });
});
