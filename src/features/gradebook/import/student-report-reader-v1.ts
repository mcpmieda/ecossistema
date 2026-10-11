import {
  REPORT_MAX_ROWS_V1,
  type ReportRowV1,
} from '../../../../shared/student-identity/reconciliation-v1';
import {
  classifyReportClassV1,
  normalizeStudentNameV1,
  type ReportClassClassificationV1,
} from '../../../../shared/student-identity/reconciliation-normalization-v1';
import type { SheetJs, Workbook, Worksheet } from './spreadsheet-recognizer';

export const STUDENT_REPORT_HEADERS_V1 = {
  name: 'Nome do aluno',
  classLabel: 'Turma',
  shift: 'Turno',
  stageLabel: 'Etapa',
  status: 'Situação da matrícula',
  enrolledAt: 'Data da matrícula',
  transferredAt: 'Data da transferência',
  enrollmentHash: 'Hash da matrícula',
  inep: 'Código INEP',
  birthDate: 'Nascimento',
  filiation1: 'Filiação 1',
} as const;
type ReportFieldV1 = keyof typeof STUDENT_REPORT_HEADERS_V1;
export interface StudentReportClassV1 {
  readonly key: string;
  readonly classLabel: string;
  readonly stageLabel: string;
  readonly shift: string;
  readonly classification: ReportClassClassificationV1;
}
export interface ReadStudentReportV1 {
  readonly rows: ReportRowV1[];
  readonly classes: StudentReportClassV1[];
  readonly date1904: boolean;
  readonly sourceYear: number | null;
}

export function reportClassKeyV1(classLabel: string, stageLabel: string, shift: string): string {
  return JSON.stringify([classLabel, stageLabel, shift]);
}

function columnV1(index: number): string {
  let current = index + 1;
  let result = '';
  while (current > 0) {
    current--;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

function scalarV1(sheet: Worksheet, column: number, row: number): string | number | null {
  const cell = sheet[`${columnV1(column)}${row}`];
  if (!cell || typeof cell === 'string') return null;
  if (
    cell.t === 'e' ||
    cell.f ||
    (cell.v !== undefined &&
      cell.v !== null &&
      typeof cell.v !== 'string' &&
      typeof cell.v !== 'number')
  ) {
    throw new Error(
      `Conteúdo inválido na linha ${row}. Reenvie o relatório exportado pelo Smecel.`,
    );
  }
  return cell.v === undefined || cell.v === null ? null : (cell.v as string | number);
}

function textV1(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value !== 'string') throw new Error('Formato de texto inválido no relatório.');
  return value.trim();
}

function headersV1(sheet: Worksheet, columns: number): Map<ReportFieldV1, number> {
  const supported = new Map(
    Object.entries(STUDENT_REPORT_HEADERS_V1).map(([field, header]) => [
      normalizeStudentNameV1(header),
      field as ReportFieldV1,
    ]),
  );
  const headers = new Map<ReportFieldV1, number>();
  for (let index = 0; index < columns; index++) {
    const cell = sheet[`${columnV1(index)}1`];
    const value = typeof cell === 'object' && typeof cell.v === 'string' ? cell.v : '';
    const field = supported.get(normalizeStudentNameV1(value));
    if (!field) continue;
    if (headers.has(field))
      throw new Error(`Coluna repetida: ${STUDENT_REPORT_HEADERS_V1[field]}.`);
    headers.set(field, index);
  }
  return headers;
}

export function isStudentReportWorkbookV1(workbook: Workbook, xlsx: SheetJs): boolean {
  if (workbook.SheetNames.length !== 1) return false;
  const sheet = workbook.Sheets[workbook.SheetNames[0]!];
  if (!sheet?.['!ref']) return false;
  const headers = headersV1(sheet, xlsx.utils.decode_range(sheet['!ref']).e.c + 1);
  return headers.has('enrollmentHash') && headers.has('birthDate') && headers.has('name');
}

/** Reads only the allowlist. Excluded classes are discarded before their personal cells are read. */
export function readStudentReportWorkbookV1(
  workbook: Workbook,
  xlsx: SheetJs,
): ReadStudentReportV1 {
  if (workbook.SheetNames.length !== 1) throw new Error('O relatório deve conter uma única aba.');
  const sheet = workbook.Sheets[workbook.SheetNames[0]!];
  if (!sheet?.['!ref']) throw new Error('Relatório vazio.');
  const range = xlsx.utils.decode_range(sheet['!ref']);
  if (range.s.r !== 0 || range.e.r > REPORT_MAX_ROWS_V1 || range.e.c > 300) {
    throw new Error('Dimensões do relatório fora do limite permitido.');
  }
  const headers = headersV1(sheet, range.e.c + 1);
  const missing = (Object.keys(STUDENT_REPORT_HEADERS_V1) as ReportFieldV1[]).filter(
    (field) => !headers.has(field),
  );
  if (missing.length)
    throw new Error(
      `Colunas ausentes: ${missing.map((field) => STUDENT_REPORT_HEADERS_V1[field]).join(', ')}.`,
    );
  const metadata = (workbook as Workbook & { Workbook?: { WBProps?: { date1904?: boolean } } })
    .Workbook?.WBProps?.date1904;
  if (metadata !== undefined && typeof metadata !== 'boolean')
    throw new Error('Época de datas Excel inválida.');
  const rows: ReportRowV1[] = [];
  const classes = new Map<string, StudentReportClassV1>();
  const years = new Set<number>();
  for (let number = 2; number <= range.e.r + 1; number++) {
    const value = (field: ReportFieldV1) => scalarV1(sheet, headers.get(field)!, number);
    const classLabel = textV1(value('classLabel'));
    const stageLabel = textV1(value('stageLabel'));
    const shift = textV1(value('shift'));
    const classification = classifyReportClassV1(classLabel, stageLabel, shift);
    if (classification.kind === 'excluded') continue;
    if (!classLabel && !stageLabel && !shift && value('name') === null) continue;
    if (classification.kind === 'regular') years.add(classification.academicYear);
    const key = reportClassKeyV1(classLabel, stageLabel, shift);
    classes.set(key, { key, classLabel, stageLabel, shift, classification });
    rows.push({
      sourceRow: number,
      name: textV1(value('name')),
      classLabel,
      stageLabel,
      shift,
      status: textV1(value('status')),
      enrollmentHash: textV1(value('enrollmentHash')),
      filiation1: textV1(value('filiation1')) || null,
      inep: value('inep'),
      birthDate: value('birthDate'),
      enrolledAt: value('enrolledAt'),
      transferredAt: value('transferredAt'),
    });
  }
  if (rows.length === 0) throw new Error('Nenhuma turma elegível no relatório.');
  if (years.size > 1 || (years.size === 1 && !years.has(2026)))
    throw new Error('O relatório não corresponde ao ano de 2026.');
  return {
    rows,
    classes: [...classes.values()],
    date1904: metadata === true,
    sourceYear: [...years][0] ?? null,
  };
}

export async function readStudentReportV1(file: File, xlsx: SheetJs): Promise<ReadStudentReportV1> {
  if (!/\.(xlsx|xls|xlsb)$/iu.test(file.name) || file.size === 0 || file.size > 25 * 1024 * 1024) {
    throw new Error('Selecione um relatório Excel de até 25 MB.');
  }
  const workbook = xlsx.read(await file.arrayBuffer(), {
    type: 'array',
    cellDates: false,
    cellFormula: true,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    cellText: false,
  });
  return readStudentReportWorkbookV1(workbook, xlsx);
}
