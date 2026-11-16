// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cellMeaningV1 } from '../../../src/features/gradebook/audit-workspace/cell-meaning-v1';
import { gradedStudentsV1 } from '../../../src/features/gradebook/import/audit-rules-v1';

describe('Auditoria: what the cell means', () => {
  it.each([
    ['qualitative-maxima-over-ceiling', 'AK3', 'Total do qualitativo'],
    ['activity-without-maximum', 'AE3', 'Qualitativo · máximo da atividade 5'],
    ['activity-without-description', 'AD4', 'Qualitativo · descrição da atividade 4'],
    ['header-mismatch', 'K3', 'Turma no cabeçalho'],
    ['header-mismatch', 'K4', 'Trimestre no cabeçalho'],
    ['qualitative-over-ceiling', 'AA12:AJ12', 'Qualitativo · soma das atividades'],
    ['work-without-weight', 'U9:X9', 'Trabalhos'],
    ['one-assessment-mode', 'S7', 'AV2'],
    ['manual-term-result', 'AM15', 'Média do trimestre'],
    ['recovery-above-maximum', 'S8', 'Recuperação do 2º trimestre'],
    ['grade-without-student', 'J31', 'Linha 31 sem aluno'],
    ['above-maximum', 'AC10', 'Qualitativo · atividade 3'],
  ])('%s %s', (code, cell, meaning) => {
    expect(cellMeaningV1(code, cell)).toBe(meaning);
  });

  it('keeps unknown cells unnamed', () => {
    expect(cellMeaningV1('invalid-text', 'BZ9')).toBeNull();
    expect(cellMeaningV1('invalid-text', undefined)).toBeNull();
  });

  it('names who has a grade in a column that was not launched', () => {
    const student = (number: string, name: string) => ({ number, name }) as never;
    expect(gradedStudentsV1([student('09', 'Aluno Sintético A')])).toBe('Nota de 09. Aluno Sintético A');
    expect(gradedStudentsV1(['1', '2', '3', '4', '5'].map((n) => student(n, `Aluno ${n}`))))
      .toBe('Nota de 1. Aluno 1, 2. Aluno 2, 3. Aluno 3 e mais 2');
  });
});
