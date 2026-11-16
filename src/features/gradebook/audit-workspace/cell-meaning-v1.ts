/**
 * What a cell of the teachers' spreadsheet means, read from its address in the fixed layout of the
 * "Agenda do Professor" (row 3 maxima, row 4 descriptions, students from row 5). The Auditoria shows
 * this instead of the bare address, so the teacher knows which cell to fix.
 */
const QUALITATIVE_COLUMNS_V1 = [
  'AA',
  'AB',
  'AC',
  'AD',
  'AE',
  'AF',
  'AG',
  'AH',
  'AI',
  'AJ',
] as const;
const TERM_RECOVERY_V1: Readonly<Record<string, string>> = { R: '1º', S: '2º', T: '3º' };

function activityV1(column: string): number | null {
  const index = QUALITATIVE_COLUMNS_V1.indexOf(column as (typeof QUALITATIVE_COLUMNS_V1)[number]);
  return index < 0 ? null : index + 1;
}

function headerCellV1(column: string, row: number): string | null {
  if (column === 'K' && row === 3) return 'Turma no cabeçalho';
  if (column === 'K' && row === 4) return 'Trimestre no cabeçalho';
  if (column === 'AK' && row === 3) return 'Total do qualitativo';
  if (column === 'R' && row === 3) return 'Máximo da AV1';
  if (column === 'S' && row === 3) return 'Máximo da AV2';
  if (column === 'T' && row === 3) return 'Total do quantitativo';
  if (column === 'Y' && row === 3) return 'Total dos trabalhos';
  const activity = activityV1(column);
  if (activity === null) return null;
  if (row === 3) return `Qualitativo · máximo da atividade ${activity}`;
  if (row === 4) return `Qualitativo · descrição da atividade ${activity}`;
  return null;
}

function studentCellV1(code: string, column: string, row: number): string | null {
  if (code === 'recovery-above-maximum' && TERM_RECOVERY_V1[column])
    return `Recuperação do ${TERM_RECOVERY_V1[column]} trimestre`;
  if (code === 'grade-without-student') return `Linha ${row} sem aluno`;
  if (column === 'J') return 'Número do aluno';
  if (column === 'R') return 'AV1';
  if (column === 'S') return 'AV2';
  if (column === 'T') return 'Total do quantitativo';
  if (column === 'Z') return 'Avaliação paralela';
  if (column === 'AK') return 'Total do qualitativo';
  if (column === 'AM') return 'Média do trimestre';
  const activity = activityV1(column);
  return activity === null ? null : `Qualitativo · atividade ${activity}`;
}

function rangeV1(start: string, end: string): string | null {
  if (start === 'AA' && end === 'AJ') return 'Qualitativo · soma das atividades';
  if (start === 'U' && end === 'X') return 'Trabalhos';
  return null;
}

export function cellMeaningV1(code: string, cellAddress: string | undefined): string | null {
  if (!cellAddress) return null;
  const range = /^([A-Z]{1,3})\d+:([A-Z]{1,3})\d+$/u.exec(cellAddress);
  if (range) return rangeV1(range[1] ?? '', range[2] ?? '');
  const single = /^([A-Z]{1,3})(\d+)$/u.exec(cellAddress);
  if (!single) return null;
  const column = single[1] ?? '';
  const row = Number(single[2]);
  return row <= 4 ? headerCellV1(column, row) : studentCellV1(code, column, row);
}
