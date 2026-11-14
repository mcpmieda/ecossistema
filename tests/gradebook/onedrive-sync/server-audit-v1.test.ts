import { describe, expect, it } from 'vitest';
import type { GradebookNotesImportRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { holdNameMismatchesV1, sameStudentNameV1, studentKeyV1 } from '../../../server/gradebook/onedrive-sync/server-audit-v1';

describe('student name check against the Relação (rule 14)', () => {
  it('accepts the same person written differently', () => {
    expect(sameStudentNameV1('Maria Sintética da Silva', 'MARIA SINTETICA DA SILVA')).toBe(true);
    expect(sameStudentNameV1('MARIA S. SILVA', 'MARIA SOUZA SILVA')).toBe(true);
    expect(sameStudentNameV1('MARIA SILVA', 'MARIA SOUZA SILVA')).toBe(true);
    expect(sameStudentNameV1('MARIA SOUZA S.', 'MARIA SOUZA SILVA')).toBe(true);
    expect(sameStudentNameV1('MARIA', 'MARIA SOUZA SILVA')).toBe(true);
  });

  it('flags another person', () => {
    expect(sameStudentNameV1('JOÃO SINTÉTICO SILVA', 'MARIA SOUZA SILVA')).toBe(false);
    expect(sameStudentNameV1('MARIA SOUZA COSTA', 'MARIA SOUZA SILVA')).toBe(false);
  });

  it('does not judge an empty name', () => {
    expect(sameStudentNameV1('', 'MARIA SOUZA SILVA')).toBe(true);
  });
});

describe('student missing from the system Relação', () => {
  const row = (numero: number) => [numero, [7], 7] as const;
  const request = {
    transportVersion: 9, operation: 'persist-notas', granularObservationVersion: 1, manifest: {}, ano: 2026, professor: 'P',
    ofertas: [{
      turmaCodigo: '6A', disciplina: 'CIÊNCIAS',
      trimestres: [1, 2, 3].map((trimestre) => ({ trimestre, instrumentos: [], alunos: [row(1), row(2)] })),
      recuperacao: [[2, null, null, null, null]],
    }],
  } as unknown as GradebookNotesImportRequestV9;
  const names = new Map([[studentKeyV1('6A', 1), 'ANA SINTETICA'], [studentKeyV1('6A', 2), 'BIA SINTETICA']]);

  it('leaves only that student out, so the rest of the file is written', () => {
    const { request: checked, items } = holdNameMismatchesV1(request, names, new Map([[studentKeyV1('6A', 1), 'ANA SINTETICA']]));
    expect(items.map((item) => [item.code, item.studentNumber])).toEqual([['student-not-in-relation', 2]]);
    const offer = checked.ofertas[0]!;
    expect(offer.trimestres.map((term) => term.alunos.map(([numero]) => numero))).toEqual([[1], [1], [1]]);
    expect(offer.recuperacao).toEqual([]);
  });

  it('does nothing when the year has no Relação at all (the database explains it)', () => {
    expect(holdNameMismatchesV1(request, names, new Map()).items).toEqual([]);
  });
});
