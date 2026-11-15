import { describe, expect, it } from 'vitest';
import {
  boundStudentsFromNamesV1,
  holdManualNameMismatchesV1,
} from '../../../server/gradebook/application/import/unbound-students-v1';
import { studentKeyV1 } from '../../../server/gradebook/onedrive-sync/server-audit-v1';
import {
  inspectGradebookImportPersistenceRequestV9,
  isGradebookImportPersistenceResponseV9,
  type GradebookNotesImportRequestV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

/** Rule 14 (BN-DEC-046) in the manual import (#1477, owner decision of 15/11/2026). Synthetic names only. */
const row = (numero: number, value: number) => [numero, [value], value] as const;
const request = (nomes?: GradebookNotesImportRequestV9['nomes']) => ({
  transportVersion: 9, operation: 'persist-notas', granularObservationVersion: 1,
  manifest: { fileName: 'sintetica.xlsb', sha256: 'a'.repeat(64), parserVersion: 'v9' }, ano: 2026, professor: 'P',
  ofertas: [{
    turmaCodigo: 'SYN-A', disciplina: 'CIÊNCIAS',
    trimestres: [1, 2, 3].map((trimestre) => ({ trimestre, instrumentos: [], alunos: [row(12, 7000), row(13, 9000), row(14, 8000)] })),
    recuperacao: [[13, null, null, null, null]],
  }],
  ...(nomes === undefined ? {} : { nomes }),
}) as unknown as GradebookNotesImportRequestV9;
const relation = new Map([
  [studentKeyV1('SYN-A', 12), 'MARIA SINTETICA SOUZA'],
  [studentKeyV1('SYN-A', 13), 'JOAO SINTETICO PEREIRA'],
  [studentKeyV1('SYN-A', 14), 'ANA SINTETICA LIMA'],
]);

describe('rule 14 in the manual import', () => {
  it('holds the grades of two students swapped in the workbook and reports each one', () => {
    const { request: checked, warnings } = holdManualNameMismatchesV1(request([
      ['SYN-A', 12, 'JOAO SINTETICO PEREIRA'], ['SYN-A', 13, 'MARIA SINTETICA SOUZA'], ['SYN-A', 14, 'ANA S. LIMA'],
    ]), relation);
    expect(warnings).toEqual([
      { code: 'student-name-mismatch', classCode: 'SYN-A', number: 12 },
      { code: 'student-name-mismatch', classCode: 'SYN-A', number: 13 },
    ]);
    const term = checked.ofertas[0]!.trimestres[0]!.alunos;
    // Held: every value kept as the database has it; the student with the same name is written.
    expect(term.find(([numero]) => numero === 12)).toEqual([12, [['u']], ['u']]);
    expect(term.find(([numero]) => numero === 13)).toEqual([13, [['u']], ['u']]);
    expect(term.find(([numero]) => numero === 14)).toEqual([14, [8000], 8000]);
    expect(checked.ofertas[0]!.recuperacao).toEqual([[13, ['u'], ['u'], ['u'], ['u']]]);
    expect('nomes' in checked).toBe(false);
  });

  it('changes nothing for a tab that sends no names', () => {
    const original = request();
    const { request: checked, warnings } = holdManualNameMismatchesV1(original, relation);
    expect(warnings).toEqual([]);
    expect(checked).toEqual(original);
  });

  it('derives the bound numbers from the same Relação read', () => {
    expect([...boundStudentsFromNamesV1(relation)].sort()).toEqual(['SYN-A:12', 'SYN-A:13', 'SYN-A:14']);
  });

  it('accepts the names in the transport and refuses malformed ones', () => {
    const term = (trimestre: 1 | 2 | 3) => ({
      definitionSnapshotVersion: 1, trimestre,
      instrumentos: [[1, 10_000, 'SYNTHETIC AV1'], [2, 10_000, 'SYNTHETIC AV2'], [3, null]],
      alunos: [[12, [5_000, null, null], 5_000]],
    });
    const valid = (nomes?: unknown) => ({
      transportVersion: 9, operation: 'persist-notas', granularObservationVersion: 1, ano: 2026,
      manifest: { fileName: 'SYNTHETIC.xlsb', sha256: 'a'.repeat(64), parserVersion: 'synthetic' },
      professor: 'SYNTHETIC TEACHER',
      ofertas: [{ turmaCodigo: 'SYN-A', disciplina: 'SYNTHETIC SUBJECT', trimestres: [term(1), term(2), term(3)], recuperacao: null }],
      ...(nomes === undefined ? {} : { nomes }),
    });
    expect(inspectGradebookImportPersistenceRequestV9(valid())).toBe('ready');
    expect(inspectGradebookImportPersistenceRequestV9(valid([['SYN-A', 12, 'MARIA SINTETICA']]))).toBe('ready');
    for (const bad of [[['SYN-A', 0, 'MARIA']], [['', 12, 'MARIA']], [['SYN-A', 12, '']], [['SYN-A', 12]], 'MARIA'])
      expect(inspectGradebookImportPersistenceRequestV9(valid(bad))).toBe('invalid-request');
  });

  it('accepts the new warning in a written answer', () => {
    expect(isGradebookImportPersistenceResponseV9({
      transportVersion: 9, state: 'applied', summary: {},
      warnings: [{ code: 'student-name-mismatch', classCode: 'SYN-A', number: 12 }],
    })).toBe(true);
  });
});
