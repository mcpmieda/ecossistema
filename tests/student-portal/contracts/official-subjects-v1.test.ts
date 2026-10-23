import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_SUBJECTS_2026_V1,
  officialSubjectV1,
} from '../../../shared/student-portal-contracts/official-subjects-v1';
import { subjectStyleV3, SUBJECT_TONES_V3 } from '../../../src/features/student-portal/redesign/subject-style-v3';

/*
 * The Portal shows the school's official subject names (owner decision 23/10/2026), the Notas'
 * ones, for the names the Smecel's "Grade de horários" writes. The Smecel's names below are the ones
 * its grid had on 23/10/2026 (18 classes).
 */
describe('official subject names', () => {
  it("turns every name of the Smecel's grid into the official one", () => {
    expect(
      Object.fromEntries(
        [
          'LINGUA PORTUGUESA',
          'MATEMATICA',
          'CIENCIAS',
          'HISTORIA',
          'GEOGRAFIA',
          'ARTE',
          'EDUCACAO FISICA',
          'LINGUA INGLESA',
          'ENSINO RELIGIOSO',
          'REDACAO',
          'ETICA E CIDADANIA',
          'INFORMATICA/COMPUTACAO',
        ].map((name) => [name, officialSubjectV1(name)]),
      ),
    ).toEqual({
      'LINGUA PORTUGUESA': 'PORTUGUÊS',
      MATEMATICA: 'MATEMÁTICA',
      CIENCIAS: 'CIÊNCIAS',
      HISTORIA: 'HISTÓRIA',
      GEOGRAFIA: 'GEOGRAFIA',
      ARTE: 'ARTE',
      'EDUCACAO FISICA': 'ED. FÍSICA',
      'LINGUA INGLESA': 'INGLÊS',
      'ENSINO RELIGIOSO': 'RELIGIÃO',
      REDACAO: 'REDAÇÃO',
      'ETICA E CIDADANIA': 'ÉTICA',
      'INFORMATICA/COMPUTACAO': 'COMPUTAÇÃO',
    });
  });

  it('keeps the Smecel name of a subject that is not official (integral, AEE)', () => {
    for (const name of [
      'ATIVIDADE DE VIDA DIÁRIA / PRÁTICA',
      'COMUNICACAO E LINGUAGENS',
      'COORDENAÇÃO MOTORA',
      'EDUCACAO SOCIOEMOCIONAL',
      'RACIOCÍNIO LÓGICO',
    ])
      expect(officialSubjectV1(name)).toBe(name);
  });

  it('gives each official subject a colour of its own', () => {
    const tones = OFFICIAL_SUBJECTS_2026_V1.map((name) => subjectStyleV3(name).tone);
    expect(new Set(tones).size).toBe(OFFICIAL_SUBJECTS_2026_V1.length);
    expect(tones.every((tone) => tone >= 0 && tone < SUBJECT_TONES_V3)).toBe(true);
    // The same colour for the Smecel's name and the official one.
    expect(subjectStyleV3('MATEMATICA').tone).toBe(subjectStyleV3('MATEMÁTICA').tone);
    expect(subjectStyleV3('ENSINO RELIGIOSO').tone).toBe(subjectStyleV3('RELIGIÃO').tone);
    // Matemática and Religião are far apart (owner request 23/10/2026).
    expect(subjectStyleV3('MATEMÁTICA').tone).not.toBe(subjectStyleV3('RELIGIÃO').tone);
  });
});
