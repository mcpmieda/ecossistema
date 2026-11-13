import type {
  GradebookImportDiagnosticsAuditListResponseV1,
  GradebookImportDiagnosticsAuditRecordV1,
} from '../../shared/gradebook-contracts/imports/import-diagnostics-v1';

/* Synthetic Auditoria for the local preview: invented teachers, students and cells. */
type Row = readonly [file: string, code: string, severity: 'blocking-error' | 'warning', place: string,
  student: number | null, field: string, value: string | null, cell: string];

const A = 'Planilha Sintética Professora A 2026.xlsb';
const B = 'Planilha Sintética Professor B 2026.xlsb';
const C = 'Planilha Sintética Professora C 2026.xlsb';
const rows: readonly Row[] = [
  [A, 'above-maximum', 'blocking-error', '6A|MATEMÁTICA|1º trimestre', 4, 'Avaliação quantitativa 1', '9', '6A1º!R8'],
  [A, 'above-maximum', 'blocking-error', '6A|MATEMÁTICA|1º trimestre', 11, 'Avaliação quantitativa 2', '7,5', '6A1º!S15'],
  [B, 'above-maximum', 'blocking-error', '7B|HISTÓRIA|2º trimestre', 2, 'Atividade 3 — Mapa', '2,5', '7B2º!AC6'],
  [A, 'activity-without-description', 'blocking-error', '6A|MATEMÁTICA|2º trimestre', null, 'Atividade 6', null, '6A2º!AF4'],
  [C, 'activity-without-description', 'blocking-error', '8C|CIÊNCIAS|1º trimestre', null, 'Atividade 2', null, '8C1º!AB4'],
  [B, 'activity-without-maximum', 'blocking-error', '7B|HISTÓRIA|1º trimestre', null, 'Atividade 4 — Resumo', null, '7B1º!AD3'],
  [C, 'qualitative-maxima-over-ceiling', 'blocking-error', '8C|CIÊNCIAS|2º trimestre', null, 'Máximos das atividades', '5,5', '8C2º!AK3'],
  [C, 'invalid-text', 'blocking-error', '8C|CIÊNCIAS|1º trimestre', 7, 'Avaliação quantitativa 1', 'F', '8C1º!R11'],
  [A, 'header-mismatch', 'blocking-error', '6A|MATEMÁTICA|3º trimestre', null, 'Cabeçalho', '2º trimestre', '6A3º!K4'],
  [B, 'grade-without-student', 'warning', '7B|HISTÓRIA|1º trimestre', null, 'Linha 41', '6', '7B1º!R45'],
  [B, 'grade-without-student', 'warning', '7B|HISTÓRIA|1º trimestre', null, 'Linha 42', '5', '7B1º!R46'],
];

const items: GradebookImportDiagnosticsAuditRecordV1[] = rows.map(
  ([fileName, code, severity, place, student, field, value, cell], index) => {
    const [classCode, subject, period] = place.split('|');
    const [sheetName, cellAddress] = cell.split('!');
    return {
      id: index + 1, academicYear: 2026, fileName, key: `preview-${index + 1}`,
      severity, code: code as GradebookImportDiagnosticsAuditRecordV1['code'],
      message: field, recommendedAction: 'Corrija na planilha.', fieldKind: 'assessment',
      classCode, subject, period, fieldLabel: field, sheetName, cellAddress,
      ...(student === null ? {} : { studentNumber: student }),
      ...(value === null ? {} : { foundValue: value }),
      studentName: student === null ? null : `ESTUDANTE SINTÉTICO ${String(student).padStart(2, '0')}`,
      firstObservedAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), observations: 1,
    };
  },
);

/** `?auditoria=vazia` shows the empty state. */
export function previewAuditV1(): GradebookImportDiagnosticsAuditListResponseV1 {
  const empty = new URLSearchParams(window.location.search).get('auditoria') === 'vazia';
  return { version: 1, state: 'ready', items: empty ? [] : items, nextOffset: null };
}
