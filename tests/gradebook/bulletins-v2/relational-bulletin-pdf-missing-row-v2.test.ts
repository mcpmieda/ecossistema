import { describe, expect, it } from 'vitest';
import type { RelationalBulletinSnapshotV2 } from '../../../shared/gradebook-contracts/bulletins/relational-bulletin-v2';
import { buildRelationalBulletinPdfLinesV2 } from '../../../src/features/gradebook/bulletins/pdf/bulletin-pdf-renderer-v2';

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

describe('an instrument without the student row in the detailed PDF (A23)', () => {
  type Instruments =
    RelationalBulletinSnapshotV2['model']['subjects'][number]['terms'][number]['instruments'];
  function withInstruments(instruments: Instruments): RelationalBulletinSnapshotV2 {
    const snapshot = fixture();
    const subject = snapshot.model.subjects[0]!;
    return {
      ...snapshot,
      model: {
        ...snapshot.model,
        subjects: [{ ...subject, terms: [{ ...subject.terms[0]!, instruments }] }],
      },
    };
  }
  const base = { term: 1 as const, maximumMilli: 5_000 };

  it('prints "Sem registro" instead of "nota —", apart from "Não fez" and zero', () => {
    const text = renderedText(
      withInstruments([
        { ...base, id: 61, slot: 2, label: 'AV2', valueMilli: null },
        { ...base, id: 62, slot: 3, label: 'AV3', valueMilli: null, notDone: true },
        { ...base, id: 63, slot: 4, label: 'AV4', valueMilli: 0 },
        { ...base, id: 64, slot: 5, label: 'AV5', valueMilli: 4_000 },
      ]),
    );
    expect(text).toContain('AV2 · Sem registro / 5');
    expect(text).toContain('AV3 · Não fez / 5');
    expect(text).toContain('AV4 · Tirou zero / 5');
    expect(text).toContain('AV5 · nota 4 / 5');
    expect(text).not.toContain('nota —');
  });
});
