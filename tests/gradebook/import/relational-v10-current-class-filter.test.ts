// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { GradebookNotesImportRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { filterHistoricalClassFactsV10 } from '../../../server/gradebook/application/import/import-relational-service-v10';
import { dropUnboundStudentsV1 as dropUnboundStudentsV10 } from '../../../server/gradebook/application/import/unbound-students-v1';
import { isGradebookImportPersistenceResponseV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

function request(): GradebookNotesImportRequestV9 {
  const term = (trimestre: 1 | 2 | 3) => ({
    definitionSnapshotVersion: 1 as const, trimestre,
    instrumentos: [[1, 6_750]] as const,
    alunos: [
      [1, [5_000], 10_000],
      [2, [6_000], 11_000],
    ] as const,
  });

  return {
    transportVersion: 9,
    operation: 'persist-notas', granularObservationVersion: 1 as const,
    manifest: {
      fileName: 'NOTAS TESTE 2026.xlsb',
      sha256: 'a'.repeat(64),
      parserVersion: 'test-v10',
    },
    ano: 2026,
    professor: 'PROFESSOR TESTE',
    ofertas: [
      {
        turmaCodigo: '7c',
        disciplina: 'ARTE',
        trimestres: [term(1), term(2), term(3)],
        recuperacao: [
          [1, 10_000, null, null, 20_000],
          [2, 11_000, null, null, 21_000],
        ],
      },
    ],
  };
}

describe('relational V10 current-class filter', () => {
  it('removes every academic fact for a FOI_PARA binding before persistence', () => {
    const source = request();
    const filtered = filterHistoricalClassFactsV10(source, new Set(['7C:1']));
    const offer = filtered.ofertas[0]!;

    expect(offer.trimestres.map((term) => term.alunos.map(([numero]) => numero))).toEqual([
      [2],
      [2],
      [2],
    ]);
    expect(offer.recuperacao?.map(([numero]) => numero)).toEqual([2]);

    // Filtering is a transport projection only; the canonical source request remains intact.
    expect(source.ofertas[0]!.trimestres[0].alunos.map(([numero]) => numero)).toEqual([1, 2]);
  });

  it('keeps current-class facts and does not invent fallback from the historical class', () => {
    const source = request();
    const filtered = filterHistoricalClassFactsV10(source, new Set(['8A:1']));

    expect(filtered.ofertas[0]!.trimestres[0].alunos.map(([numero]) => numero)).toEqual([1, 2]);
    expect(filtered.ofertas[0]!.recuperacao?.map(([numero]) => numero)).toEqual([1, 2]);
  });
});
describe('student missing from the system Relação (manual import)', () => {
  it('leaves only that student out and reports it; the rest of the file goes on', () => {
    const { request: present, warnings } = dropUnboundStudentsV10(request(), new Set(['7C:1']));
    expect(warnings).toEqual([{ code: 'student-not-in-relation', classCode: '7C', number: 2 }]);
    const offer = present.ofertas[0]!;
    expect(offer.trimestres.map((term) => term.alunos.map(([numero]) => numero))).toEqual([[1], [1], [1]]);
    expect(offer.recuperacao?.map(([numero]) => numero)).toEqual([1]);
  });

  it('a class the Relação does not have at all is left for the database to refuse', () => {
    const { request: present, warnings } = dropUnboundStudentsV10(request(), new Set(['8A:1']));
    expect(warnings).toEqual([]);
    expect(present).toEqual(request());
  });

  it('the response with the new warning passes the contract', () => {
    expect(isGradebookImportPersistenceResponseV9({
      transportVersion: 9, state: 'applied', summary: { writes: 1, importRecorded: true },
      warnings: [{ code: 'student-not-in-relation', classCode: '7C', number: 2 }],
    })).toBe(true);
  });
});
